/* eslint-env mocha */
import assert from 'node:assert/strict'
import mongoose from 'mongoose'
import { MongoReplicaSetHarness } from '../helpers/mongoReplicaSet.js'

const deferred = () => {
  let resolveGate
  let rejectGate
  const promise = new Promise((resolve, reject) => {
    resolveGate = resolve
    rejectGate = reject
  })
  return { promise, resolve: resolveGate, reject: rejectGate }
}

describe('P1C-B0A original reservation persistence', function () {
  const harness = new MongoReplicaSetHarness()
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

  it('A: commits Order, OrderItem, Payment, reservation, stock and immutable ledger', async function () {
    const context = await fixtures.createSyntheticCommerceContext()
    const checkout = fixtures.createCheckoutService()
    const result = await checkout.createCheckout(fixtures.createCheckoutInput(context))

    const order = await fixtures.OrderModel.findById(result.order.id).lean()
    const items = await fixtures.OrderItemModel.find({ orderId: order._id }).sort({ createdAt: 1 }).lean()
    const payment = await fixtures.PaymentModel.findOne({ orderId: order._id }).lean()
    const unit = await fixtures.ProductUnitModel.findById(context.units[0]._id).lean()
    const product = await fixtures.ProductModel.findById(context.product._id).lean()

    assert.ok(order)
    assert.equal(items.length, 1)
    assert.ok(payment)
    assert.equal(unit.status, 'reserved')
    assert.equal(String(unit.orderId), String(order._id))
    assert.equal(String(unit.orderItemId), String(items[0]._id))
    assert.equal(String(unit.reservedByOrderId), String(order._id))
    assert.equal(product.prodStock, 0)
    assert.ok(items[0].originalReservation.capturedAt instanceof Date)
    assert.equal(items[0].originalReservation.units.length, items[0].quantity)
    assert.deepEqual(
      fixtures.canonicalLedger(items[0].originalReservation).units,
      [{ productUnitId: String(unit._id), serial: unit.serialNumber }]
    )
  })

  it('B: rolls the entire ledger back when Payment creation fails after capture', async function () {
    const context = await fixtures.createSyntheticCommerceContext()
    const failure = new Error('intentional payment failure after ledger')
    let observedLedgerBeforeFailure = false
    const failingPaymentService = {
      async createPayment ({ orderId }, { session }) {
        const [item, unit, product] = await Promise.all([
          fixtures.OrderItemModel.findOne({ orderId }).session(session).lean(),
          fixtures.ProductUnitModel.findOne({ orderId }).session(session).lean(),
          fixtures.ProductModel.findById(context.product._id).session(session).lean()
        ])
        observedLedgerBeforeFailure = Boolean(
          item?.originalReservation && unit?.status === 'reserved' && product?.prodStock === 0
        )
        throw failure
      }
    }
    const checkout = fixtures.createCheckoutService({ paymentService: failingPaymentService })

    await assert.rejects(
      checkout.createCheckout(fixtures.createCheckoutInput(context)),
      (error) => error.code === 'CHECKOUT_FAILED' && error.details?.cause === failure.message
    )
    assert.equal(observedLedgerBeforeFailure, true)

    const [orders, items, payments, unit, product] = await Promise.all([
      fixtures.OrderModel.find({ userId: context.buyer._id }).lean(),
      fixtures.OrderItemModel.find({}).lean(),
      fixtures.PaymentModel.find({}).lean(),
      fixtures.ProductUnitModel.findById(context.units[0]._id).lean(),
      fixtures.ProductModel.findById(context.product._id).lean()
    ])

    assert.equal(orders.length, 0)
    assert.equal(items.length, 0)
    assert.equal(payments.length, 0)
    assert.equal(unit.status, 'available')
    assert.equal(unit.orderId, null)
    assert.equal(unit.orderItemId, null)
    assert.equal(unit.reservedByOrderId, null)
    assert.equal(unit.reservedAt, null)
    assert.equal(unit.reservationExpiresAt, null)
    assert.equal(product.prodStock, 1)
  })

  it('C: rejects a second capture and preserves the first ledger byte-for-value', async function () {
    const context = await fixtures.createSyntheticCommerceContext()
    const result = await fixtures.createCheckoutService()
      .createCheckout(fixtures.createCheckoutInput(context))
    const firstItem = await fixtures.OrderItemModel.findOne({ orderId: result.order.id }).lean()
    const firstLedger = fixtures.canonicalLedger(firstItem.originalReservation)
    const session = await harness.startSession()

    try {
      await assert.rejects(
        session.withTransaction(() => fixtures.OrderItemManager.captureOriginalReservation(
          {
            orderItemId: firstItem._id,
            orderId: firstItem.orderId,
            productId: firstItem.productId,
            quantity: firstItem.quantity,
            originalReservation: {
              capturedAt: new Date(),
              units: [{ productUnitId: new mongoose.Types.ObjectId(), serial: 'REPLACEMENT' }]
            }
          },
          { session }
        ), fixtures.transactionOptions),
        (error) => error.code === 'ORIGINAL_RESERVATION_CAPTURE_CONFLICT'
      )
    } finally {
      await harness.endSession(session)
    }

    const persisted = await fixtures.OrderItemModel.findById(firstItem._id).lean()
    assert.deepEqual(fixtures.canonicalLedger(persisted.originalReservation), firstLedger)
  })

  it('D: resolves a real CAS race as one capture and one domain conflict', async function () {
    const context = await fixtures.createSyntheticCommerceContext({ unitCount: 0 })
    const { order, item } = await fixtures.createBareOrderWithItem(context)
    const bothReady = deferred()
    const winnerCommitted = deferred()
    let readyCount = 0

    const runCapture = async (label) => {
      const session = await harness.startSession()
      let attempt = 0
      try {
        await session.withTransaction(async () => {
          attempt += 1
          if (attempt === 1) {
            const observed = await fixtures.OrderItemModel.findById(item._id).session(session).lean()
            assert.equal(Object.hasOwn(observed, 'originalReservation'), false)
            readyCount += 1
            if (readyCount === 2) bothReady.resolve()
            await bothReady.promise
            if (label === 'B') await winnerCommitted.promise
          }

          await fixtures.OrderItemManager.captureOriginalReservation({
            orderItemId: item._id,
            orderId: order._id,
            productId: context.product._id,
            quantity: 1,
            originalReservation: {
              capturedAt: new Date('2026-11-10T16:00:00.000Z'),
              units: [{ productUnitId: new mongoose.Types.ObjectId(), serial: `CAS-${label}` }]
            }
          }, { session })
        }, fixtures.transactionOptions)
        return { label, success: true }
      } catch (error) {
        return { label, success: false, error }
      } finally {
        await harness.endSession(session)
      }
    }

    const winnerPromise = runCapture('A')
    winnerPromise.then((result) => {
      if (result.success) winnerCommitted.resolve()
      else winnerCommitted.reject(result.error)
    })
    const loserPromise = runCapture('B')
    const results = await Promise.all([winnerPromise, loserPromise])
    const successes = results.filter((result) => result.success)
    const conflicts = results.filter((result) => result.error?.code === 'ORIGINAL_RESERVATION_CAPTURE_CONFLICT')

    assert.equal(successes.length, 1)
    assert.equal(conflicts.length, 1)
    const persisted = await fixtures.OrderItemModel.findById(item._id).lean()
    assert.deepEqual(fixtures.canonicalLedger(persisted.originalReservation).units, [
      { productUnitId: String(persisted.originalReservation.units[0].productUnitId), serial: 'CAS-A' }
    ])
  })

  it('E: uses real reservation writes in-session while external reads stay isolated', async function () {
    const context = await fixtures.createSyntheticCommerceContext()
    const { order, item } = await fixtures.createBareOrderWithItem(context)
    const session = await harness.startSession()
    session.startTransaction(fixtures.transactionOptions)

    try {
      const reservation = await fixtures.ProductUnitService.reserveAvailableUnits({
        productId: context.product._id,
        quantity: 1,
        orderId: order._id,
        orderItemId: item._id,
        reservationExpiresAt: order.reservationExpiresAt
      }, { session })
      const inSessionUnit = await fixtures.ProductUnitModel.findById(context.units[0]._id).session(session).lean()
      assert.equal(inSessionUnit.status, 'reserved')

      await fixtures.OrderItemManager.captureOriginalReservation({
        orderItemId: item._id,
        orderId: order._id,
        productId: context.product._id,
        quantity: 1,
        originalReservation: fixtures.buildOriginalReservation(reservation)
      }, { session })

      const [externalUnit, externalItem] = await Promise.all([
        fixtures.ProductUnitModel.findById(context.units[0]._id).lean(),
        fixtures.OrderItemModel.findById(item._id).lean()
      ])
      assert.equal(externalUnit.status, 'available')
      assert.equal(Object.hasOwn(externalItem, 'originalReservation'), false)

      await session.commitTransaction()
    } finally {
      if (session.inTransaction()) await session.abortTransaction()
      await harness.endSession(session)
    }

    const [persistedUnit, persistedItem] = await Promise.all([
      fixtures.ProductUnitModel.findById(context.units[0]._id).lean(),
      fixtures.OrderItemModel.findById(item._id).lean()
    ])
    assert.equal(persistedUnit.status, 'reserved')
    assert.equal(fixtures.canonicalLedger(persistedItem.originalReservation).units[0].serial, persistedUnit.serialNumber)
  })

  it('F: releases the real reservation while preserving the committed ledger', async function () {
    const context = await fixtures.createSyntheticCommerceContext()
    const result = await fixtures.createCheckoutService()
      .createCheckout(fixtures.createCheckoutInput(context))
    const order = await fixtures.OrderModel.findById(result.order.id).lean()
    const beforeItem = await fixtures.OrderItemModel.findOne({ orderId: order._id }).lean()
    const ledger = fixtures.canonicalLedger(beforeItem.originalReservation)
    const session = await harness.startSession()

    try {
      await session.withTransaction(async () => {
        const released = await fixtures.ProductUnitService.releaseOrderReservationsForExpiration({
          orderId: order._id,
          expirationLimit: new Date(order.reservationExpiresAt.getTime() + 1)
        }, { session })
        assert.equal(released.releasedCount, 1)
      }, fixtures.transactionOptions)
    } finally {
      await harness.endSession(session)
    }

    const [unit, item, product] = await Promise.all([
      fixtures.ProductUnitModel.findById(context.units[0]._id).lean(),
      fixtures.OrderItemModel.findById(beforeItem._id).lean(),
      fixtures.ProductModel.findById(context.product._id).lean()
    ])
    assert.equal(unit.status, 'available')
    assert.equal(unit.orderId, null)
    assert.equal(unit.orderItemId, null)
    assert.equal(unit.reservedByOrderId, null)
    assert.equal(unit.reservedAt, null)
    assert.equal(unit.reservationExpiresAt, null)
    assert.equal(product.prodStock, 1)
    assert.deepEqual(fixtures.canonicalLedger(item.originalReservation), ledger)
  })

  it('G: marks a legitimately reserved unit sold while preserving the ledger', async function () {
    const context = await fixtures.createSyntheticCommerceContext()
    const result = await fixtures.createCheckoutService()
      .createCheckout(fixtures.createCheckoutInput(context))
    const order = await fixtures.OrderModel.findById(result.order.id).lean()
    const itemBefore = await fixtures.OrderItemModel.findOne({ orderId: order._id }).lean()
    const ledger = fixtures.canonicalLedger(itemBefore.originalReservation)
    const payment = await fixtures.PaymentModel.findById(result.payment.id).lean()
    const paymentService = new fixtures.PaymentServiceClass()
    await paymentService.transitionPaymentStatus({
      paymentId: payment._id,
      nextStatus: 'approved',
      providerStatus: 'processed',
      providerPaymentId: `PAY-${payment._id}`,
      checkedAt: new Date()
    })
    const session = await harness.startSession()

    try {
      await session.withTransaction(() => fixtures.ProductUnitService.confirmReservedUnitsSold({
        orderId: order._id,
        paymentId: payment._id,
        soldAt: new Date()
      }, { session }), fixtures.transactionOptions)
    } finally {
      await harness.endSession(session)
    }

    const [unit, itemAfter] = await Promise.all([
      fixtures.ProductUnitModel.findById(context.units[0]._id).lean(),
      fixtures.OrderItemModel.findById(itemBefore._id).lean()
    ])
    assert.equal(unit.status, 'sold')
    assert.equal(String(unit.soldByOrderId), String(order._id))
    assert.ok(unit.soldAt instanceof Date)
    assert.deepEqual(fixtures.canonicalLedger(itemAfter.originalReservation), ledger)
  })

  it('H: prevents two transactional checkouts from sharing one ProductUnit', async function () {
    const context = await fixtures.createSyntheticCommerceContext()
    const bothReady = deferred()
    const winnerCommitted = deferred()
    const contenders = ['A', 'B'].map((label) => ({
      label,
      orderId: new mongoose.Types.ObjectId(),
      orderItemId: new mongoose.Types.ObjectId()
    }))
    let readyCount = 0

    const contend = async (contender) => {
      const session = await harness.startSession()
      let attempt = 0
      try {
        await session.withTransaction(async () => {
          attempt += 1
          const created = await fixtures.createBareOrderWithItem({
            ...context,
            orderId: contender.orderId,
            orderItemId: contender.orderItemId,
            orderNumber: `LC-2099-RACE-${contender.label}`
          }, { session })

          if (attempt === 1) {
            const available = await fixtures.ProductUnitModel.findOne({
              productId: context.product._id,
              status: 'available'
            }).session(session).lean()
            assert.ok(available)
            readyCount += 1
            if (readyCount === 2) bothReady.resolve()
            await bothReady.promise
            if (contender.label === 'B') await winnerCommitted.promise
          }

          const reservation = await fixtures.ProductUnitService.reserveAvailableUnits({
            productId: context.product._id,
            quantity: 1,
            orderId: created.order._id,
            orderItemId: created.item._id,
            reservationExpiresAt: created.order.reservationExpiresAt
          }, { session })
          await fixtures.OrderItemManager.captureOriginalReservation({
            orderItemId: created.item._id,
            orderId: created.order._id,
            productId: context.product._id,
            quantity: 1,
            originalReservation: fixtures.buildOriginalReservation(reservation)
          }, { session })
        }, fixtures.transactionOptions)
        return { contender, success: true }
      } catch (error) {
        return { contender, success: false, error }
      } finally {
        await harness.endSession(session)
      }
    }

    const winnerPromise = contend(contenders[0])
    winnerPromise.then((result) => {
      if (result.success) winnerCommitted.resolve()
      else winnerCommitted.reject(result.error)
    })
    const loserPromise = contend(contenders[1])
    const outcomes = await Promise.all([winnerPromise, loserPromise])
    const successes = outcomes.filter((outcome) => outcome.success)
    const rejected = outcomes.filter((outcome) => !outcome.success)

    assert.equal(successes.length, 1)
    assert.equal(rejected.length, 1)
    assert.ok([
      'INSUFFICIENT_SERIALIZED_STOCK',
      'RESERVATION_CONFLICT',
      'RESERVE_PRODUCT_UNITS_FAILED'
    ].includes(rejected[0].error?.code))
    const [orders, items, units, product] = await Promise.all([
      fixtures.OrderModel.find({ _id: { $in: contenders.map((entry) => entry.orderId) } }).lean(),
      fixtures.OrderItemModel.find({ _id: { $in: contenders.map((entry) => entry.orderItemId) } }).lean(),
      fixtures.ProductUnitModel.find({ productId: context.product._id }).lean(),
      fixtures.ProductModel.findById(context.product._id).lean()
    ])
    assert.equal(orders.length, 1)
    assert.equal(items.length, 1)
    assert.equal(units.length, 1)
    assert.equal(units[0].status, 'reserved')
    assert.equal(String(units[0].orderId), String(orders[0]._id))
    assert.equal(String(units[0].orderItemId), String(items[0]._id))
    assert.deepEqual(fixtures.canonicalLedger(items[0].originalReservation).units, [{
      productUnitId: String(units[0]._id),
      serial: units[0].serialNumber
    }])
    assert.equal(product.prodStock, 0)
  })

  it('reads legacy absent/null ledgers without treating null as capturable', async function () {
    const context = await fixtures.createSyntheticCommerceContext({ unitCount: 0 })
    const { order, item } = await fixtures.createBareOrderWithItem(context)
    const absent = await fixtures.OrderItemModel.findById(item._id).lean()
    assert.equal(Object.hasOwn(absent, 'originalReservation'), false)

    const legacyId = new mongoose.Types.ObjectId()
    await fixtures.OrderItemModel.collection.insertOne({
      ...absent,
      _id: legacyId,
      originalReservation: null,
      createdAt: new Date(),
      updatedAt: new Date()
    })
    const legacy = await fixtures.OrderItemModel.findById(legacyId).lean()
    assert.equal(legacy.originalReservation, null)

    const session = await harness.startSession()
    try {
      await assert.rejects(
        session.withTransaction(() => fixtures.OrderItemManager.captureOriginalReservation({
          orderItemId: legacyId,
          orderId: order._id,
          productId: context.product._id,
          quantity: 1,
          originalReservation: {
            capturedAt: new Date(),
            units: [{ productUnitId: new mongoose.Types.ObjectId(), serial: 'LEGACY' }]
          }
        }, { session }), fixtures.transactionOptions),
        (error) => error.code === 'ORIGINAL_RESERVATION_CAPTURE_CONFLICT'
      )
    } finally {
      await harness.endSession(session)
    }
    const unchanged = await fixtures.OrderItemModel.findById(legacyId).lean()
    assert.equal(unchanged.originalReservation, null)
  })
})
