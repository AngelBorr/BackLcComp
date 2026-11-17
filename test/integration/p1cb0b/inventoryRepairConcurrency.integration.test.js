/* eslint-env mocha */
import assert from 'node:assert/strict'
import mongoose from 'mongoose'
import { MongoReplicaSetHarness } from '../helpers/mongoReplicaSet.js'
import { OrderInventoryRepairReadService } from '../../../src/services/orderInventoryRepairRead.service.js'
import { buildInventoryRepairPlan } from '../../../src/services/orderInventoryRepairPlanner.service.js'
import { OrderInventoryRepairSelectorService } from '../../../src/services/orderInventoryRepairSelector.service.js'
import { OrderInventoryRepairWriterService } from '../../../src/services/orderInventoryRepairWriter.service.js'

const repairAtA = new Date('2026-11-14T14:00:00.000Z')
const repairAtB = new Date('2026-11-14T14:01:00.000Z')
const futureExpiration = new Date('2026-11-15T14:00:00.000Z')

const asId = (value) => String(value).toLowerCase()
const epoch = (value) => value == null ? null : new Date(value).getTime()

const deferred = () => {
  let settled = false
  let resolvePromise
  let rejectPromise
  const promise = new Promise((resolve, reject) => {
    resolvePromise = resolve
    rejectPromise = reject
  })
  promise.catch(() => {})

  return {
    promise,
    get settled () { return settled },
    resolve (value) {
      if (settled) return
      settled = true
      resolvePromise(value)
    },
    reject (error) {
      if (settled) return
      settled = true
      rejectPromise(error)
    }
  }
}

const observeOrFail = async (signal, participant, label) => Promise.race([
  signal.promise,
  participant.then(
    () => { throw new Error(`${label} completed before reaching the barrier`) },
    (error) => { throw error }
  )
])

const transientDiagnostics = (error) => ({
  name: error?.name,
  constructorName: error?.constructor?.name,
  code: error?.code,
  errorLabels: [...(error?.errorLabels || [])]
})

describe('P1C-B0B F2D-B real Mongo inventory repair concurrency', function () {
  const harness = new MongoReplicaSetHarness()
  const readService = new OrderInventoryRepairReadService()
  const selectorService = new OrderInventoryRepairSelectorService()
  const writerService = new OrderInventoryRepairWriterService()
  let fixtures

  before(async function () {
    await harness.start()
    fixtures = await import('../helpers/commerceFixtures.js')
    await fixtures.initializeCommerceModels()
  })

  afterEach(async function () {
    await harness.cleanupCollections()
  })

  after(async function () {
    await harness.stop()
  })

  const abortAndEnd = async (session) => {
    if (!session) return
    if (session.inTransaction()) await session.abortTransaction()
    await harness.endSession(session)
  }

  const assertTransient = (error) => {
    assert.equal(error?.hasErrorLabel?.('TransientTransactionError'), true)
    assert.ok(error.errorLabels.includes('TransientTransactionError'))
  }

  const assertStock = async (productId, expected) => {
    const [product, available] = await Promise.all([
      fixtures.ProductModel.findById(productId).lean(),
      fixtures.ProductUnitModel.countDocuments({
        productId,
        status: 'available',
        isDeleted: false
      })
    ])
    assert.equal(product.prodStock, expected)
    assert.equal(product.prodStock, available)
  }

  const assertSoldOwnership = (unit, repairCase, expectedRepairAt) => {
    assert.equal(unit.status, 'sold')
    assert.equal(unit.isDeleted, false)
    assert.equal(asId(unit.orderId), asId(repairCase.order._id))
    assert.equal(asId(unit.orderItemId), asId(repairCase.item._id))
    assert.equal(asId(unit.reservedByOrderId), asId(repairCase.order._id))
    assert.equal(asId(unit.soldByOrderId), asId(repairCase.order._id))
    assert.equal(epoch(unit.reservedAt), expectedRepairAt.getTime())
    assert.equal(epoch(unit.soldAt), expectedRepairAt.getTime())
    assert.equal(epoch(unit.reservationExpiresAt), epoch(repairCase.order.reservationExpiresAt))
  }

  const assertReservedOwnership = (unit, checkoutResult, checkoutItem) => {
    assert.equal(unit.status, 'reserved')
    assert.equal(unit.isDeleted, false)
    assert.equal(asId(unit.orderId), asId(checkoutResult.order.id))
    assert.equal(asId(unit.orderItemId), asId(checkoutItem._id))
    assert.equal(asId(unit.reservedByOrderId), asId(checkoutResult.order.id))
    assert.ok(unit.reservedAt instanceof Date)
    assert.ok(unit.reservationExpiresAt instanceof Date)
    assert.equal(unit.soldByOrderId, null)
    assert.equal(unit.soldAt, null)
  }

  const createApprovedCase = async ({
    buyer,
    product,
    ledgerUnits,
    quantity = ledgerUnits.length,
    orderId = new mongoose.Types.ObjectId(),
    orderItemId = new mongoose.Types.ObjectId(),
    orderNumber,
    reservationExpiresAt = futureExpiration
  }) => {
    const created = await fixtures.createBareOrderWithItem({
      buyer,
      product,
      quantity,
      orderId,
      orderItemId,
      orderNumber,
      reservationExpiresAt
    })
    await fixtures.captureSyntheticOriginalReservation({
      item: created.item,
      units: ledgerUnits
    })
    await fixtures.markSyntheticOrderRequiresInventoryAttention({ order: created.order })
    const payment = await fixtures.createSyntheticApprovedPayment({ order: created.order })
    const item = await fixtures.OrderItemModel.findById(created.item._id).lean()
    return { ...created, item, payment }
  }

  const createMultiItemApprovedCase = async ({ buyer, entries }) => {
    const [firstEntry, ...rest] = entries
    const first = await fixtures.createBareOrderWithItem({
      buyer,
      product: firstEntry.product,
      quantity: 1,
      reservationExpiresAt: futureExpiration
    })
    await fixtures.captureSyntheticOriginalReservation({
      item: first.item,
      units: [firstEntry.unit]
    })
    const items = [first.item]
    for (const entry of rest) {
      const item = await fixtures.createBareOrderItem({
        order: first.order,
        product: entry.product,
        quantity: 1
      })
      await fixtures.captureSyntheticOriginalReservation({ item, units: [entry.unit] })
      items.push(item)
    }
    await fixtures.markSyntheticOrderRequiresInventoryAttention({ order: first.order })
    const payment = await fixtures.createSyntheticApprovedPayment({ order: first.order })
    return { order: first.order, items, payment }
  }

  const prepareRepair = async ({ orderId, paymentId, session, repairAt = repairAtA }) => {
    const [order, payment, orderItems] = await Promise.all([
      fixtures.OrderModel.findById(orderId).session(session).lean(),
      fixtures.PaymentModel.findById(paymentId).session(session).lean(),
      fixtures.OrderItemModel.find({ orderId })
        .sort({ createdAt: 1, _id: 1 })
        .session(session)
        .lean()
    ])
    const originalProductUnitIds = orderItems.flatMap((item) => (
      item.originalReservation.units.map((entry) => entry.productUnitId)
    ))
    const authoritativeInputs = await readService.loadAuthoritativeInputs({
      orderId,
      originalProductUnitIds
    }, { session })
    const plan = buildInventoryRepairPlan({
      order,
      payment,
      orderItems: authoritativeInputs.orderItems,
      originalProductUnits: authoritativeInputs.originalProductUnits,
      currentProductUnits: authoritativeInputs.relatedProductUnits,
      externalOrderItemsById: authoritativeInputs.externalOrderItemsById
    })
    assert.equal(plan.outcome, 'PLAN_READY')
    assert.equal(plan.repairable, true)
    const selection = await selectorService.selectCandidates(plan, { session })
    return {
      order,
      payment,
      authoritativeInputs,
      plan,
      selection,
      input: { order, authoritativeInputs, plan, selection, repairAt }
    }
  }

  const manualWriterInput = ({ order, item, product, unit, repairAt = repairAtA }) => ({
    order,
    authoritativeInputs: {
      orderItems: [item],
      originalProductUnits: [unit]
    },
    plan: {
      outcome: 'PLAN_READY',
      repairable: true,
      orderId: asId(order._id),
      items: [{
        orderItemId: asId(item._id),
        productId: asId(product._id),
        quantity: 1,
        preserveReserved: [],
        alreadySold: [],
        reclaimAvailableOriginals: [{ productUnitId: asId(unit._id) }],
        replaceableDeficitOriginals: [],
        replacementCount: 0,
        blocked: []
      }],
      replacementCount: 0,
      blocked: []
    },
    selection: {
      orderId: asId(order._id),
      byOrderItem: [{
        orderItemId: asId(item._id),
        productId: asId(product._id),
        reclaimUnitIds: [asId(unit._id)],
        newReplacementCandidates: [],
        newReplacementCandidateIds: [],
        replacementCount: 0
      }],
      selectedNewProductUnitIds: []
    },
    repairAt
  })

  const observingProxy = (target, methodNames, onError) => new Proxy(target, {
    get (object, property) {
      const value = Reflect.get(object, property)
      if (typeof value !== 'function') return value
      return async (...args) => {
        try {
          return await value.apply(object, args)
        } catch (error) {
          if (methodNames.has(property)) onError(error, property)
          throw error
        }
      }
    }
  })

  it('observes a real Mongo write conflict with the transient label and preserves diagnostics', async function () {
    const context = await fixtures.createSyntheticCommerceContext()
    const sessionA = await harness.startSession()
    const sessionB = await harness.startSession()
    let observed

    try {
      sessionA.startTransaction(fixtures.transactionOptions)
      await fixtures.ProductUnitModel.findById(context.units[0]._id).session(sessionA).lean()

      sessionB.startTransaction(fixtures.transactionOptions)
      await fixtures.ProductUnitModel.updateOne(
        { _id: context.units[0]._id },
        { $set: { status: 'inactive' } },
        { session: sessionB }
      )
      await fixtures.ProductModel.updateOne(
        { _id: context.product._id },
        { $set: { prodStock: 0 } },
        { session: sessionB }
      )
      await sessionB.commitTransaction()

      try {
        await fixtures.ProductUnitModel.updateOne(
          { _id: context.units[0]._id },
          { $set: { status: 'warranty' } },
          { session: sessionA }
        )
        assert.fail('stale transaction unexpectedly wrote U1')
      } catch (error) {
        observed = error
      }
      assertTransient(observed)
      const diagnostics = transientDiagnostics(observed)
      assert.equal(typeof diagnostics.name, 'string')
      assert.equal(typeof diagnostics.constructorName, 'string')
      assert.ok(diagnostics.code !== undefined)
    } finally {
      await abortAndEnd(sessionA)
      await abortAndEnd(sessionB)
    }

    const persisted = await fixtures.ProductUnitModel.findById(context.units[0]._id).lean()
    assert.equal(persisted.status, 'inactive')
    assert.equal(persisted.orderId, null)
    assert.equal(persisted.orderItemId, null)
    assert.equal(persisted.reservedByOrderId, null)
    assert.equal(persisted.reservedAt, null)
    assert.equal(persisted.reservationExpiresAt, null)
    assert.equal(persisted.soldByOrderId, null)
    assert.equal(persisted.soldAt, null)
    assert.equal(persisted.isDeleted, false)
    await assertStock(context.product._id, 0)
  })

  it('lets only one repair own U1 and F2C rethrows the exact Mongo error object', async function () {
    const context = await fixtures.createSyntheticCommerceContext()
    const repairA = await createApprovedCase({ ...context, ledgerUnits: [context.units[0]] })
    const repairB = await createApprovedCase({ ...context, ledgerUnits: [context.units[0]] })
    const ledgerA = fixtures.canonicalLedger(repairA.item.originalReservation)
    const ledgerB = fixtures.canonicalLedger(repairB.item.originalReservation)
    const sessionA = await harness.startSession()
    const sessionB = await harness.startSession()
    let f2cDependencyError
    let writerError

    const managerProxy = observingProxy(
      fixtures.ProductUnitManager,
      new Set(['markExactAvailableUnitsSoldForRepair']),
      (error) => { f2cDependencyError = error }
    )
    const serviceProxy = observingProxy(
      fixtures.ProductUnitService,
      new Set(['acquireInventoryRepairGuards']),
      (error) => { f2cDependencyError = error }
    )
    const observedWriter = new OrderInventoryRepairWriterService({
      productUnitManager: managerProxy,
      productUnitService: serviceProxy
    })

    try {
      sessionA.startTransaction(fixtures.transactionOptions)
      sessionB.startTransaction(fixtures.transactionOptions)
      const [preparedA, preparedB] = await Promise.all([
        prepareRepair({ orderId: repairA.order._id, paymentId: repairA.payment._id, session: sessionA, repairAt: repairAtA }),
        prepareRepair({ orderId: repairB.order._id, paymentId: repairB.payment._id, session: sessionB, repairAt: repairAtB })
      ])
      assert.deepEqual(preparedA.selection.selectedNewProductUnitIds, [])
      assert.deepEqual(preparedB.selection.selectedNewProductUnitIds, [])
      assert.deepEqual(preparedA.plan.items[0].reclaimAvailableOriginals.map((entry) => entry.productUnitId), [asId(context.units[0]._id)])
      assert.deepEqual(preparedB.plan.items[0].reclaimAvailableOriginals.map((entry) => entry.productUnitId), [asId(context.units[0]._id)])

      await writerService.writeRepair(preparedA.input, { session: sessionA })
      await sessionA.commitTransaction()

      try {
        await observedWriter.writeRepair(preparedB.input, { session: sessionB })
        assert.fail('losing repair unexpectedly persisted stale evidence')
      } catch (error) {
        writerError = error
      }
      assert.equal(writerError, f2cDependencyError)
      assertTransient(writerError)
      assert.notEqual(writerError.code, 'INVENTORY_REPAIR_CAS_CONFLICT')
      assert.deepEqual(transientDiagnostics(writerError), transientDiagnostics(f2cDependencyError))
    } finally {
      await abortAndEnd(sessionA)
      await abortAndEnd(sessionB)
    }

    const [unit, itemA, itemB] = await Promise.all([
      fixtures.ProductUnitModel.findById(context.units[0]._id).lean(),
      fixtures.OrderItemModel.findById(repairA.item._id).lean(),
      fixtures.OrderItemModel.findById(repairB.item._id).lean()
    ])
    assertSoldOwnership(unit, repairA, repairAtA)
    assert.deepEqual(fixtures.canonicalLedger(itemA.originalReservation), ledgerA)
    assert.deepEqual(fixtures.canonicalLedger(itemB.originalReservation), ledgerB)
    await assertStock(context.product._id, 0)
  })

  it('retries the complete repair callback and reselects U2 after U1 is sold', async function () {
    const context = await fixtures.createSyntheticCommerceContext({ unitCount: 2 })
    const repairA = await createApprovedCase({ ...context, ledgerUnits: [context.units[0]] })
    const repairB = await createApprovedCase({ ...context, ledgerUnits: [context.units[0]] })
    const ledgerA = fixtures.canonicalLedger(repairA.item.originalReservation)
    const ledgerB = fixtures.canonicalLedger(repairB.item.originalReservation)
    const firstAttemptReady = deferred()
    const releaseFirstAttempt = deferred()
    const sessionB = await harness.startSession()
    const attempts = []
    let f2aCalls = 0
    let plannerCalls = 0
    let f2bCalls = 0
    let f2cCalls = 0
    let repairBResult

    const participantB = sessionB.withTransaction(async () => {
      const attemptNumber = attempts.length + 1
      const [order, payment, orderItems] = await Promise.all([
        fixtures.OrderModel.findById(repairB.order._id).session(sessionB).lean(),
        fixtures.PaymentModel.findById(repairB.payment._id).session(sessionB).lean(),
        fixtures.OrderItemModel.find({ orderId: repairB.order._id }).sort({ createdAt: 1, _id: 1 }).session(sessionB).lean()
      ])
      const originalProductUnitIds = orderItems.flatMap((item) => item.originalReservation.units.map((entry) => entry.productUnitId))
      f2aCalls += 1
      const authoritativeInputs = await readService.loadAuthoritativeInputs({
        orderId: repairB.order._id,
        originalProductUnitIds
      }, { session: sessionB })
      plannerCalls += 1
      const plan = buildInventoryRepairPlan({
        order,
        payment,
        orderItems: authoritativeInputs.orderItems,
        originalProductUnits: authoritativeInputs.originalProductUnits,
        currentProductUnits: authoritativeInputs.relatedProductUnits,
        externalOrderItemsById: authoritativeInputs.externalOrderItemsById
      })
      f2bCalls += 1
      const selection = await selectorService.selectCandidates(plan, { session: sessionB })
      attempts.push({
        attemptNumber,
        authoritativeInputs,
        plan,
        selection,
        selectedIds: plan.items[0].reclaimAvailableOriginals.length > 0
          ? plan.items[0].reclaimAvailableOriginals.map((entry) => entry.productUnitId)
          : selection.selectedNewProductUnitIds,
        repairAtEpoch: repairAtB.getTime()
      })
      if (attemptNumber === 1) {
        firstAttemptReady.resolve()
        await releaseFirstAttempt.promise
      }
      f2cCalls += 1
      repairBResult = await writerService.writeRepair({
        order,
        authoritativeInputs,
        plan,
        selection,
        repairAt: repairAtB
      }, { session: sessionB })
    }, fixtures.transactionOptions)

    try {
      await observeOrFail(firstAttemptReady, participantB, 'repair B')
      const sessionA = await harness.startSession()
      try {
        await sessionA.withTransaction(async () => {
          const preparedA = await prepareRepair({
            orderId: repairA.order._id,
            paymentId: repairA.payment._id,
            session: sessionA,
            repairAt: repairAtA
          })
          await writerService.writeRepair(preparedA.input, { session: sessionA })
        }, fixtures.transactionOptions)
      } finally {
        await abortAndEnd(sessionA)
      }
      releaseFirstAttempt.resolve()
      await participantB
    } finally {
      releaseFirstAttempt.reject(new Error('test cleanup'))
      firstAttemptReady.reject(new Error('test cleanup'))
      await participantB.catch(() => {})
      await abortAndEnd(sessionB)
    }

    assert.equal(f2aCalls, 2)
    assert.equal(plannerCalls, 2)
    assert.equal(f2bCalls, 2)
    assert.equal(f2cCalls, 2)
    assert.equal(attempts.length, 2)
    assert.notEqual(attempts[0].authoritativeInputs, attempts[1].authoritativeInputs)
    assert.notEqual(attempts[0].plan, attempts[1].plan)
    assert.notEqual(attempts[0].selection, attempts[1].selection)
    assert.deepEqual(attempts[0].selectedIds, [asId(context.units[0]._id)])
    assert.deepEqual(attempts[1].selectedIds, [asId(context.units[1]._id)])
    assert.equal(attempts[0].repairAtEpoch, attempts[1].repairAtEpoch)
    assert.deepEqual(repairBResult.selectedNewProductUnitIds, [asId(context.units[1]._id)])

    const [unit1, unit2, itemA, itemB] = await Promise.all([
      fixtures.ProductUnitModel.findById(context.units[0]._id).lean(),
      fixtures.ProductUnitModel.findById(context.units[1]._id).lean(),
      fixtures.OrderItemModel.findById(repairA.item._id).lean(),
      fixtures.OrderItemModel.findById(repairB.item._id).lean()
    ])
    assertSoldOwnership(unit1, repairA, repairAtA)
    assertSoldOwnership(unit2, repairB, repairAtB)
    assert.deepEqual(fixtures.canonicalLedger(itemA.originalReservation), ledgerA)
    assert.deepEqual(fixtures.canonicalLedger(itemB.originalReservation), ledgerB)
    await assertStock(context.product._id, 0)
  })

  it('does not auto-retry a domain CAS conflict without a transient Mongo label', async function () {
    const context = await fixtures.createSyntheticCommerceContext()
    const repairCase = await createApprovedCase({ ...context, ledgerUnits: [context.units[0]] })
    const staleUnit = await fixtures.ProductUnitModel.findById(context.units[0]._id).lean()
    await fixtures.ProductUnitModel.collection.updateOne(
      { _id: context.units[0]._id },
      { $unset: { soldAt: '' } }
    )
    const session = await harness.startSession()
    let callbackCount = 0
    let observed

    try {
      await session.withTransaction(async () => {
        callbackCount += 1
        await writerService.writeRepair(manualWriterInput({
          order: repairCase.order.toObject(),
          item: repairCase.item,
          product: context.product,
          unit: staleUnit
        }), { session })
      }, fixtures.transactionOptions)
      assert.fail('domain CAS conflict unexpectedly committed')
    } catch (error) {
      observed = error
    } finally {
      await abortAndEnd(session)
    }

    assert.equal(callbackCount, 1)
    assert.equal(observed.code, 'INVENTORY_REPAIR_CAS_CONFLICT')
    assert.notEqual(observed?.hasErrorLabel?.('TransientTransactionError'), true)
    const persisted = await fixtures.ProductUnitModel.findById(context.units[0]._id).lean()
    assert.equal(persisted.status, 'available')
    assert.equal(persisted.orderId, null)
    assert.equal(persisted.orderItemId, null)
    assert.equal(persisted.reservedByOrderId, null)
    assert.equal(persisted.reservedAt, null)
    assert.equal(persisted.reservationExpiresAt, null)
    assert.equal(persisted.soldByOrderId, null)
    assert.equal(Object.hasOwn(persisted, 'soldAt'), false)
    assert.equal(persisted.isDeleted, false)
    await assertStock(context.product._id, 1)
  })

  it('keeps repair ownership when checkout loses and documents current checkout error wrapping', async function () {
    const repairBuyer = await fixtures.createSyntheticBuyer()
    const inventory = await fixtures.createSerializedInventory({ buyerId: repairBuyer._id, unitCount: 1 })
    const repairCase = await createApprovedCase({
      buyer: repairBuyer,
      product: inventory.product,
      ledgerUnits: [inventory.units[0]]
    })
    const checkoutBuyer = await fixtures.createSyntheticBuyer()
    const repairSession = await harness.startSession()
    repairSession.startTransaction(fixtures.transactionOptions)
    const preparedRepair = await prepareRepair({
      orderId: repairCase.order._id,
      paymentId: repairCase.payment._id,
      session: repairSession,
      repairAt: repairAtA
    })
    const snapshotReady = deferred()
    const releaseCheckout = deferred()
    let wrapperCalls = 0
    let rawMongoError
    const originalManagerReserve = fixtures.ProductUnitManager.reserveAvailableUnits

    const checkoutProductUnitService = {
      async reserveAvailableUnits (input, { session }) {
        wrapperCalls += 1
        const observed = await fixtures.ProductUnitManager.findAvailableUnits(
          input.productId,
          input.quantity,
          { session }
        )
        assert.deepEqual(observed.map((unit) => asId(unit._id)), [asId(inventory.units[0]._id)])
        snapshotReady.resolve()
        await releaseCheckout.promise
        return fixtures.ProductUnitService.reserveAvailableUnits(input, { session })
      }
    }

    fixtures.ProductUnitManager.reserveAvailableUnits = async function (...args) {
      try {
        return await originalManagerReserve.apply(fixtures.ProductUnitManager, args)
      } catch (error) {
        rawMongoError = error
        throw error
      }
    }

    const checkoutService = fixtures.createCheckoutService({
      productUnitService: checkoutProductUnitService
    })
    const checkoutInput = fixtures.createCheckoutInput({
      buyer: checkoutBuyer,
      product: inventory.product
    })
    const checkoutParticipant = checkoutService.createCheckout(checkoutInput)
    let checkoutError

    try {
      await observeOrFail(snapshotReady, checkoutParticipant, 'checkout')
      await writerService.writeRepair(preparedRepair.input, { session: repairSession })
      await repairSession.commitTransaction()
      releaseCheckout.resolve()
      try {
        await checkoutParticipant
        assert.fail('checkout unexpectedly committed stale availability')
      } catch (error) {
        checkoutError = error
      }
    } finally {
      fixtures.ProductUnitManager.reserveAvailableUnits = originalManagerReserve
      releaseCheckout.reject(new Error('test cleanup'))
      snapshotReady.reject(new Error('test cleanup'))
      await checkoutParticipant.catch(() => {})
      await abortAndEnd(repairSession)
    }

    assert.equal(wrapperCalls, 1)
    assertTransient(rawMongoError)
    assert.notEqual(checkoutError, rawMongoError)
    assert.equal(checkoutError.code, 'RESERVE_PRODUCT_UNITS_FAILED')
    assert.equal(checkoutError.status, 500)
    assert.equal(checkoutError.details.cause, rawMongoError.message)
    assert.equal(checkoutError.errorLabels, undefined)
    assert.equal(checkoutError.hasErrorLabel, undefined)
    assert.notEqual(checkoutError.code, rawMongoError.code)

    const [unit, checkoutOrders, checkoutItems, checkoutPayments] = await Promise.all([
      fixtures.ProductUnitModel.findById(inventory.units[0]._id).lean(),
      fixtures.OrderModel.find({ userId: checkoutBuyer._id }).lean(),
      fixtures.OrderItemModel.find({}).populate({ path: 'orderId', match: { userId: checkoutBuyer._id } }).lean(),
      fixtures.PaymentModel.find({}).populate({ path: 'orderId', match: { userId: checkoutBuyer._id } }).lean()
    ])
    assertSoldOwnership(unit, repairCase, repairAtA)
    assert.equal(checkoutOrders.length, 0)
    assert.equal(checkoutItems.filter((item) => item.orderId).length, 0)
    assert.equal(checkoutPayments.filter((payment) => payment.orderId).length, 0)
    await assertStock(inventory.product._id, 0)
  })

  it('keeps checkout reservation coherent when a stale repair loses', async function () {
    const repairBuyer = await fixtures.createSyntheticBuyer()
    const inventory = await fixtures.createSerializedInventory({ buyerId: repairBuyer._id, unitCount: 1 })
    const repairCase = await createApprovedCase({
      buyer: repairBuyer,
      product: inventory.product,
      ledgerUnits: [inventory.units[0]]
    })
    const repairLedger = fixtures.canonicalLedger(repairCase.item.originalReservation)
    const checkoutBuyer = await fixtures.createSyntheticBuyer()
    const repairSession = await harness.startSession()
    repairSession.startTransaction(fixtures.transactionOptions)
    const preparedRepair = await prepareRepair({
      orderId: repairCase.order._id,
      paymentId: repairCase.payment._id,
      session: repairSession,
      repairAt: repairAtA
    })
    let repairError
    let checkoutResult

    try {
      checkoutResult = await fixtures.createCheckoutService().createCheckout(
        fixtures.createCheckoutInput({ buyer: checkoutBuyer, product: inventory.product })
      )
      try {
        await writerService.writeRepair(preparedRepair.input, { session: repairSession })
        assert.fail('stale repair unexpectedly replaced checkout ownership')
      } catch (error) {
        repairError = error
      }
      assertTransient(repairError)
    } finally {
      await abortAndEnd(repairSession)
    }

    const [unit, repairItem, checkoutItem] = await Promise.all([
      fixtures.ProductUnitModel.findById(inventory.units[0]._id).lean(),
      fixtures.OrderItemModel.findById(repairCase.item._id).lean(),
      fixtures.OrderItemModel.findOne({ orderId: checkoutResult.order.id }).lean()
    ])
    assertReservedOwnership(unit, checkoutResult, checkoutItem)
    assert.deepEqual(fixtures.canonicalLedger(repairItem.originalReservation), repairLedger)
    await assertStock(inventory.product._id, 0)
  })

  it('acquires multi-product guards in the same sorted order for inverse logical item order', async function () {
    const buyer = await fixtures.createSyntheticBuyer()
    const inventoryX = await fixtures.createSerializedInventory({ buyerId: buyer._id, unitCount: 2 })
    const inventoryY = await fixtures.createSerializedInventory({ buyerId: buyer._id, unitCount: 2 })
    const repairA = await createMultiItemApprovedCase({
      buyer,
      entries: [
        { product: inventoryX.product, unit: inventoryX.units[0] },
        { product: inventoryY.product, unit: inventoryY.units[0] }
      ]
    })
    const repairB = await createMultiItemApprovedCase({
      buyer,
      entries: [
        { product: inventoryY.product, unit: inventoryY.units[1] },
        { product: inventoryX.product, unit: inventoryX.units[1] }
      ]
    })
    const observedOrders = []
    const productServiceProxy = new Proxy(fixtures.ProductUnitService, {
      get (target, property) {
        const value = Reflect.get(target, property)
        if (typeof value !== 'function') return value
        if (property === 'acquireInventoryRepairGuards') {
          return async (productIds, options) => {
            observedOrders.push(productIds.map(asId))
            return value.apply(target, [productIds, options])
          }
        }
        return value.bind(target)
      }
    })
    const observedWriter = new OrderInventoryRepairWriterService({
      productUnitManager: fixtures.ProductUnitManager,
      productUnitService: productServiceProxy
    })

    for (const [repairCase, repairAt] of [[repairA, repairAtA], [repairB, repairAtB]]) {
      const session = await harness.startSession()
      try {
        await session.withTransaction(async () => {
          const prepared = await prepareRepair({
            orderId: repairCase.order._id,
            paymentId: repairCase.payment._id,
            session,
            repairAt
          })
          await observedWriter.writeRepair(prepared.input, { session })
        }, fixtures.transactionOptions)
      } finally {
        await abortAndEnd(session)
      }
    }

    const sorted = [asId(inventoryX.product._id), asId(inventoryY.product._id)].sort()
    assert.deepEqual(observedOrders, [sorted, sorted])
    await assertStock(inventoryX.product._id, 0)
    await assertStock(inventoryY.product._id, 0)
  })

  it('serializes disjoint units of the same Product conservatively without corruption', async function () {
    const context = await fixtures.createSyntheticCommerceContext({ unitCount: 2 })
    const repairA = await createApprovedCase({ ...context, ledgerUnits: [context.units[0]] })
    const repairB = await createApprovedCase({ ...context, ledgerUnits: [context.units[1]] })
    const sessionA = await harness.startSession()
    const sessionB = await harness.startSession()
    let repairBError

    try {
      sessionA.startTransaction(fixtures.transactionOptions)
      sessionB.startTransaction(fixtures.transactionOptions)
      const [preparedA, preparedB] = await Promise.all([
        prepareRepair({ orderId: repairA.order._id, paymentId: repairA.payment._id, session: sessionA, repairAt: repairAtA }),
        prepareRepair({ orderId: repairB.order._id, paymentId: repairB.payment._id, session: sessionB, repairAt: repairAtB })
      ])
      await writerService.writeRepair(preparedA.input, { session: sessionA })
      await sessionA.commitTransaction()
      try {
        await writerService.writeRepair(preparedB.input, { session: sessionB })
        assert.fail('second same-product repair unexpectedly bypassed the product guard')
      } catch (error) {
        repairBError = error
      }
      assertTransient(repairBError)
    } finally {
      await abortAndEnd(sessionA)
      await abortAndEnd(sessionB)
    }

    const [unit1, unit2] = await Promise.all([
      fixtures.ProductUnitModel.findById(context.units[0]._id).lean(),
      fixtures.ProductUnitModel.findById(context.units[1]._id).lean()
    ])
    assertSoldOwnership(unit1, repairA, repairAtA)
    assert.equal(unit2.status, 'available')
    assert.equal(unit2.orderId, null)
    assert.equal(unit2.orderItemId, null)
    assert.equal(unit2.reservedByOrderId, null)
    assert.equal(unit2.reservedAt, null)
    assert.equal(unit2.reservationExpiresAt, null)
    assert.equal(unit2.soldByOrderId, null)
    assert.equal(unit2.soldAt, null)
    assert.equal(unit2.isDeleted, false)
    await assertStock(context.product._id, 1)
  })
})
