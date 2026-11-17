/* eslint-env mocha */
import assert from 'node:assert/strict'
import mongoose from 'mongoose'
import { MongoReplicaSetHarness } from '../helpers/mongoReplicaSet.js'
import { OrderInventoryRepairReadService } from '../../../src/services/orderInventoryRepairRead.service.js'
import { buildInventoryRepairPlan } from '../../../src/services/orderInventoryRepairPlanner.service.js'
import { OrderInventoryRepairSelectorService } from '../../../src/services/orderInventoryRepairSelector.service.js'
import { OrderInventoryRepairWriterService } from '../../../src/services/orderInventoryRepairWriter.service.js'

const repairAt = new Date('2026-11-12T18:00:00.000Z')
const reservedAt = new Date('2026-11-10T15:00:00.000Z')
const expiredAt = new Date('2026-11-11T15:00:00.000Z')
const futureExpiration = new Date('2026-11-13T15:00:00.000Z')

const epoch = (value) => value == null ? null : new Date(value).getTime()
const asId = (value) => String(value).toLowerCase()

const unitState = (unit) => ({
  status: unit.status,
  isDeleted: unit.isDeleted,
  orderId: unit.orderId == null ? null : asId(unit.orderId),
  orderItemId: unit.orderItemId == null ? null : asId(unit.orderItemId),
  reservedByOrderId: unit.reservedByOrderId == null ? null : asId(unit.reservedByOrderId),
  reservedAt: epoch(unit.reservedAt),
  reservationExpiresAt: epoch(unit.reservationExpiresAt),
  soldByOrderId: unit.soldByOrderId == null ? null : asId(unit.soldByOrderId),
  soldAt: epoch(unit.soldAt)
})

describe('P1C-B0B F2D-A real Mongo inventory repair correctness', function () {
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

  const setUnit = async (unit, values, { session } = {}) => {
    const query = fixtures.ProductUnitModel.findByIdAndUpdate(
      unit._id,
      { $set: values },
      { new: true, runValidators: true }
    ).lean()
    if (session) query.session(session)
    return query
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
    return { ...created, payment }
  }

  const prepareIntegratedRepair = async ({ orderId, paymentId, session }) => {
    const [order, payment, orderItems] = await Promise.all([
      fixtures.OrderModel.findById(orderId).session(session).lean(),
      fixtures.PaymentModel.findById(paymentId).session(session).lean(),
      fixtures.OrderItemModel.find({ orderId }).sort({ createdAt: 1, _id: 1 }).session(session).lean()
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
      input: { order, authoritativeInputs, plan, selection, repairAt },
      orderItems
    }
  }

  const manualWriterInput = ({ order, entries }) => {
    const items = entries.map(({ item, product, availableUnits = [], reservedUnits = [], alreadySoldUnits = [] }) => ({
      orderItemId: asId(item._id),
      productId: asId(product._id),
      quantity: availableUnits.length + reservedUnits.length + alreadySoldUnits.length,
      preserveReserved: reservedUnits.map((unit) => ({ productUnitId: asId(unit._id) })),
      alreadySold: alreadySoldUnits.map((unit) => ({ productUnitId: asId(unit._id) })),
      reclaimAvailableOriginals: availableUnits.map((unit) => ({ productUnitId: asId(unit._id) })),
      replaceableDeficitOriginals: [],
      replacementCount: 0,
      blocked: []
    }))
    return {
      order,
      authoritativeInputs: {
        orderItems: entries.map(({ item }) => item),
        originalProductUnits: entries.flatMap(({ availableUnits = [], reservedUnits = [], alreadySoldUnits = [] }) => (
          [...availableUnits, ...reservedUnits, ...alreadySoldUnits]
        ))
      },
      plan: {
        outcome: 'PLAN_READY',
        repairable: true,
        orderId: asId(order._id),
        items,
        replacementCount: 0,
        blocked: []
      },
      selection: {
        orderId: asId(order._id),
        byOrderItem: items.map((item) => ({
          orderItemId: item.orderItemId,
          productId: item.productId,
          reclaimUnitIds: item.reclaimAvailableOriginals.map((entry) => entry.productUnitId),
          newReplacementCandidates: [],
          newReplacementCandidateIds: [],
          replacementCount: 0
        })),
        selectedNewProductUnitIds: []
      },
      repairAt
    }
  }

  const abortAndEnd = async (session) => {
    if (session.inTransaction()) await session.abortTransaction()
    await harness.endSession(session)
  }

  it('commits a real available-to-sold CAS with exact repair metadata', async function () {
    const context = await fixtures.createSyntheticCommerceContext()
    const { order, item } = await fixtures.createBareOrderWithItem({
      ...context,
      reservationExpiresAt: futureExpiration
    })
    const unit = await fixtures.ProductUnitModel.findById(context.units[0]._id).lean()
    const session = await harness.startSession()
    session.startTransaction(fixtures.transactionOptions)

    try {
      const result = await fixtures.ProductUnitManager.markExactAvailableUnitsSoldForRepair({
        unitIds: [unit._id],
        orderId: order._id,
        orderItemId: item._id,
        productId: context.product._id,
        repairAt,
        reservationExpiresAt: order.reservationExpiresAt
      }, { session })
      assert.equal(result.matchedCount, 1)
      assert.equal(result.modifiedCount, 1)
      await session.commitTransaction()
    } finally {
      await abortAndEnd(session)
    }

    const persisted = await fixtures.ProductUnitModel.findById(unit._id).lean()
    assert.equal(persisted.status, 'sold')
    assert.equal(asId(persisted.orderId), asId(order._id))
    assert.equal(asId(persisted.orderItemId), asId(item._id))
    assert.equal(asId(persisted.reservedByOrderId), asId(order._id))
    assert.equal(epoch(persisted.reservedAt), repairAt.getTime())
    assert.equal(epoch(persisted.reservationExpiresAt), epoch(order.reservationExpiresAt))
    assert.equal(asId(persisted.soldByOrderId), asId(order._id))
    assert.equal(epoch(persisted.soldAt), repairAt.getTime())
  })

  it('rejects null-versus-missing partial available CAS and rolls the matching unit back', async function () {
    const context = await fixtures.createSyntheticCommerceContext({ unitCount: 2 })
    const repairCase = await createApprovedCase({
      ...context,
      ledgerUnits: context.units,
      quantity: 2
    })
    const snapshots = await fixtures.ProductUnitModel.find({
      _id: { $in: context.units.map((unit) => unit._id) }
    }).sort({ _id: 1 }).lean()
    const ledgerBefore = fixtures.canonicalLedger(repairCase.item.originalReservation)
    const missingUnit = snapshots[1]
    await fixtures.ProductUnitModel.collection.updateOne(
      { _id: missingUnit._id },
      { $unset: { soldAt: '' } }
    )
    const session = await harness.startSession()
    session.startTransaction(fixtures.transactionOptions)

    try {
      const input = manualWriterInput({
        order: repairCase.order.toObject(),
        entries: [{
          item: repairCase.item.toObject(),
          product: context.product,
          availableUnits: snapshots
        }]
      })
      await assert.rejects(
        writerService.writeRepair(input, { session }),
        (error) => {
          assert.equal(error.code, 'INVENTORY_REPAIR_CAS_CONFLICT')
          assert.equal(error.details.matchedCount, 1)
          assert.equal(error.details.modifiedCount, 1)
          return true
        }
      )
      const inTransaction = await fixtures.ProductUnitModel.findById(snapshots[0]._id).session(session).lean()
      assert.equal(inTransaction.status, 'sold')
    } finally {
      await abortAndEnd(session)
    }

    const [first, second, itemAfter] = await Promise.all([
      fixtures.ProductUnitModel.findById(snapshots[0]._id).lean(),
      fixtures.ProductUnitModel.findById(snapshots[1]._id).lean(),
      fixtures.OrderItemModel.findById(repairCase.item._id).lean()
    ])
    assert.equal(first.status, 'available')
    assert.equal(first.soldAt, null)
    assert.equal(second.status, 'available')
    assert.equal(Object.hasOwn(second, 'soldAt'), false)
    assert.deepEqual(fixtures.canonicalLedger(itemAfter.originalReservation), ledgerBefore)
  })

  it('matches reserved dates by epoch across distinct Date objects and sells an expired reservation', async function () {
    const context = await fixtures.createSyntheticCommerceContext()
    const { order, item } = await fixtures.createBareOrderWithItem({
      ...context,
      reservationExpiresAt: expiredAt
    })
    await setUnit(context.units[0], {
      status: 'reserved',
      orderId: order._id,
      orderItemId: item._id,
      reservedByOrderId: order._id,
      reservedAt,
      reservationExpiresAt: expiredAt,
      soldByOrderId: null,
      soldAt: null
    })
    const session = await harness.startSession()
    session.startTransaction(fixtures.transactionOptions)

    try {
      const result = await fixtures.ProductUnitManager.markExactReservedUnitsSoldForRepair({
        units: [{
          productUnitId: context.units[0]._id,
          reservedAt: new Date(reservedAt.getTime()),
          reservationExpiresAt: new Date(expiredAt.getTime())
        }],
        orderId: order._id,
        orderItemId: item._id,
        productId: context.product._id,
        repairAt
      }, { session })
      assert.equal(result.matchedCount, 1)
      assert.equal(result.modifiedCount, 1)
      await session.commitTransaction()
    } finally {
      await abortAndEnd(session)
    }

    const persisted = await fixtures.ProductUnitModel.findById(context.units[0]._id).lean()
    assert.equal(persisted.status, 'sold')
    assert.equal(asId(persisted.orderId), asId(order._id))
    assert.equal(asId(persisted.orderItemId), asId(item._id))
    assert.equal(asId(persisted.reservedByOrderId), asId(order._id))
    assert.equal(epoch(persisted.reservedAt), reservedAt.getTime())
    assert.equal(epoch(persisted.reservationExpiresAt), expiredAt.getTime())
    assert.equal(epoch(persisted.soldAt), repairAt.getTime())
  })

  it('rejects a +1ms reserved CAS mismatch and rolls an earlier ordered bulk mutation back', async function () {
    const context = await fixtures.createSyntheticCommerceContext({ unitCount: 2 })
    const { order, item } = await fixtures.createBareOrderWithItem({ ...context, quantity: 2 })
    for (const unit of context.units) {
      await setUnit(unit, {
        status: 'reserved',
        orderId: order._id,
        orderItemId: item._id,
        reservedByOrderId: order._id,
        reservedAt,
        reservationExpiresAt: futureExpiration,
        soldByOrderId: null,
        soldAt: null
      })
    }
    const snapshots = await fixtures.ProductUnitModel.find({
      _id: { $in: context.units.map((unit) => unit._id) }
    }).sort({ _id: 1 }).lean()
    const staleSecond = {
      ...snapshots[1],
      reservedAt: new Date(snapshots[1].reservedAt.getTime() + 1)
    }
    const session = await harness.startSession()
    session.startTransaction(fixtures.transactionOptions)

    try {
      const input = manualWriterInput({
        order: order.toObject(),
        entries: [{
          item: item.toObject(),
          product: context.product,
          reservedUnits: [snapshots[0], staleSecond]
        }]
      })
      await assert.rejects(
        writerService.writeRepair(input, { session }),
        (error) => error.code === 'INVENTORY_REPAIR_CAS_CONFLICT' &&
          error.details.matchedCount === 1 && error.details.modifiedCount === 1
      )
      const firstInside = await fixtures.ProductUnitModel.findById(snapshots[0]._id).session(session).lean()
      assert.equal(firstInside.status, 'sold')
    } finally {
      await abortAndEnd(session)
    }

    const persisted = await fixtures.ProductUnitModel.find({
      _id: { $in: context.units.map((unit) => unit._id) }
    }).sort({ _id: 1 }).lean()
    assert.deepEqual(persisted.map(unitState), snapshots.map(unitState))
  })

  it('rolls valid item A back when later item B has a real CAS conflict across products', async function () {
    const buyer = await fixtures.createSyntheticBuyer()
    const inventoryA = await fixtures.createSerializedInventory({ buyerId: buyer._id, unitCount: 1 })
    const inventoryB = await fixtures.createSerializedInventory({ buyerId: buyer._id, unitCount: 1 })
    const ordered = [inventoryA, inventoryB].sort((left, right) => asId(left.product._id).localeCompare(asId(right.product._id)))
    const first = await fixtures.createBareOrderWithItem({
      buyer,
      product: ordered[0].product,
      quantity: 1,
      reservationExpiresAt: futureExpiration
    })
    const secondItem = await fixtures.createBareOrderItem({
      order: first.order,
      product: ordered[1].product,
      quantity: 1
    })
    const snapshots = await fixtures.ProductUnitModel.find({
      _id: { $in: [ordered[0].units[0]._id, ordered[1].units[0]._id] }
    }).lean()
    const byId = new Map(snapshots.map((unit) => [asId(unit._id), unit]))
    const firstSnapshot = byId.get(asId(ordered[0].units[0]._id))
    const secondSnapshot = byId.get(asId(ordered[1].units[0]._id))
    await fixtures.ProductUnitModel.collection.updateOne(
      { _id: secondSnapshot._id },
      { $unset: { soldAt: '' } }
    )
    const session = await harness.startSession()
    session.startTransaction(fixtures.transactionOptions)

    try {
      const input = manualWriterInput({
        order: first.order.toObject(),
        entries: [
          { item: first.item.toObject(), product: ordered[0].product, availableUnits: [firstSnapshot] },
          { item: secondItem.toObject(), product: ordered[1].product, availableUnits: [secondSnapshot] }
        ]
      })
      await assert.rejects(
        writerService.writeRepair(input, { session }),
        (error) => error.code === 'INVENTORY_REPAIR_CAS_CONFLICT'
      )
      const firstInside = await fixtures.ProductUnitModel.findById(firstSnapshot._id).session(session).lean()
      assert.equal(firstInside.status, 'sold')
    } finally {
      await abortAndEnd(session)
    }

    const [firstAfter, secondAfter] = await Promise.all([
      fixtures.ProductUnitModel.findById(firstSnapshot._id).lean(),
      fixtures.ProductUnitModel.findById(secondSnapshot._id).lean()
    ])
    assert.equal(firstAfter.status, 'available')
    assert.equal(firstAfter.soldAt, null)
    assert.equal(secondAfter.status, 'available')
    assert.equal(Object.hasOwn(secondAfter, 'soldAt'), false)
  })

  it('rolls the real Product guard version and timestamp back on abort', async function () {
    const context = await fixtures.createSyntheticCommerceContext({ unitCount: 0 })
    const oldUpdatedAt = new Date('2026-10-01T10:00:00.000Z')
    await fixtures.ProductModel.collection.updateOne(
      { _id: context.product._id },
      { $set: { updatedAt: oldUpdatedAt } }
    )
    const before = await fixtures.ProductModel.findById(context.product._id).lean()
    const session = await harness.startSession()
    session.startTransaction(fixtures.transactionOptions)

    try {
      await fixtures.ProductUnitService.acquireInventoryRepairGuards(
        [context.product._id],
        { session }
      )
      const inside = await fixtures.ProductModel.findById(context.product._id).session(session).lean()
      assert.equal(inside.__v, before.__v + 1)
      assert.ok(inside.updatedAt.getTime() > before.updatedAt.getTime())
    } finally {
      await abortAndEnd(session)
    }

    const after = await fixtures.ProductModel.findById(context.product._id).lean()
    assert.equal(after.__v, before.__v)
    assert.equal(after.updatedAt.getTime(), before.updatedAt.getTime())
    assert.equal(after.prodStock, before.prodStock)
  })

  it('detects an extra sold unit after writes and stock recalc, then rolls units, stock, guard and ledger back', async function () {
    const context = await fixtures.createSyntheticCommerceContext({ unitCount: 2, stock: 2 })
    const repairCase = await createApprovedCase({
      ...context,
      ledgerUnits: [context.units[0]],
      quantity: 1
    })
    const beforeProduct = await fixtures.ProductModel.findById(context.product._id).lean()
    const beforeLedger = fixtures.canonicalLedger(repairCase.item.originalReservation)
    const session = await harness.startSession()
    session.startTransaction(fixtures.transactionOptions)

    try {
      const prepared = await prepareIntegratedRepair({
        orderId: repairCase.order._id,
        paymentId: repairCase.payment._id,
        session
      })
      await setUnit(context.units[1], {
        status: 'sold',
        orderId: repairCase.order._id,
        orderItemId: repairCase.item._id,
        reservedByOrderId: repairCase.order._id,
        reservedAt: repairAt,
        reservationExpiresAt: repairCase.order.reservationExpiresAt,
        soldByOrderId: repairCase.order._id,
        soldAt: repairAt
      }, { session })
      await assert.rejects(
        writerService.writeRepair(prepared.input, { session }),
        (error) => error.code === 'INVENTORY_REPAIR_FINAL_STATE_CONFLICT'
      )
      const [expectedInside, productInside, soldInside] = await Promise.all([
        fixtures.ProductUnitModel.findById(context.units[0]._id).session(session).lean(),
        fixtures.ProductModel.findById(context.product._id).session(session).lean(),
        fixtures.ProductUnitManager.getSoldUnitsForOrderItem({
          orderId: repairCase.order._id,
          orderItemId: repairCase.item._id,
          productId: context.product._id
        }, { session })
      ])
      assert.equal(expectedInside.status, 'sold')
      assert.equal(productInside.prodStock, 0)
      assert.equal(productInside.__v, beforeProduct.__v + 1)
      assert.deepEqual(
        soldInside.map((unit) => asId(unit._id)).sort(),
        context.units.map((unit) => asId(unit._id)).sort()
      )
    } finally {
      await abortAndEnd(session)
    }

    const [unitsAfter, productAfter, itemAfter] = await Promise.all([
      fixtures.ProductUnitModel.find({ productId: context.product._id }).sort({ _id: 1 }).lean(),
      fixtures.ProductModel.findById(context.product._id).lean(),
      fixtures.OrderItemModel.findById(repairCase.item._id).lean()
    ])
    assert.deepEqual(unitsAfter.map((unit) => unit.status), ['available', 'available'])
    assert.equal(productAfter.prodStock, beforeProduct.prodStock)
    assert.equal(productAfter.__v, beforeProduct.__v)
    assert.deepEqual(fixtures.canonicalLedger(itemAfter.originalReservation), beforeLedger)
  })

  it('rejects a same-count final sold set with the wrong ProductUnit identity', async function () {
    const context = await fixtures.createSyntheticCommerceContext({ unitCount: 2, stock: 1 })
    const repairCase = await createApprovedCase({
      ...context,
      ledgerUnits: [context.units[0]],
      quantity: 1
    })
    await setUnit(context.units[0], {
      status: 'sold',
      orderId: repairCase.order._id,
      orderItemId: repairCase.item._id,
      reservedByOrderId: null,
      reservedAt: null,
      reservationExpiresAt: null,
      soldByOrderId: repairCase.order._id,
      soldAt: new Date('2026-11-10T17:00:00.000Z')
    })
    const session = await harness.startSession()
    session.startTransaction(fixtures.transactionOptions)

    try {
      const prepared = await prepareIntegratedRepair({
        orderId: repairCase.order._id,
        paymentId: repairCase.payment._id,
        session
      })
      await setUnit(context.units[0], {
        status: 'available',
        orderId: null,
        orderItemId: null,
        reservedByOrderId: null,
        reservedAt: null,
        reservationExpiresAt: null,
        soldByOrderId: null,
        soldAt: null
      }, { session })
      await setUnit(context.units[1], {
        status: 'sold',
        orderId: repairCase.order._id,
        orderItemId: repairCase.item._id,
        reservedByOrderId: null,
        reservedAt: null,
        reservationExpiresAt: null,
        soldByOrderId: repairCase.order._id,
        soldAt: new Date('2026-11-10T17:00:00.000Z')
      }, { session })
      await assert.rejects(
        writerService.writeRepair(prepared.input, { session }),
        (error) => error.code === 'INVENTORY_REPAIR_FINAL_STATE_CONFLICT'
      )
      const soldInside = await fixtures.ProductUnitManager.getSoldUnitsForOrderItem({
        orderId: repairCase.order._id,
        orderItemId: repairCase.item._id,
        productId: context.product._id
      }, { session })
      assert.deepEqual(soldInside.map((unit) => asId(unit._id)), [asId(context.units[1]._id)])
    } finally {
      await abortAndEnd(session)
    }

    const [expected, substitute] = await Promise.all([
      fixtures.ProductUnitModel.findById(context.units[0]._id).lean(),
      fixtures.ProductUnitModel.findById(context.units[1]._id).lean()
    ])
    assert.equal(expected.status, 'sold')
    assert.equal(substitute.status, 'available')
  })

  it('commits the full F2A-Planner-F2B-F2C mixed-category repair and preserves the ledger', async function () {
    const context = await fixtures.createSyntheticCommerceContext({ unitCount: 5, stock: 2 })
    const [preserve, alreadySold, reclaim, deficit, replacement] = context.units
    const repairCase = await createApprovedCase({
      ...context,
      ledgerUnits: [preserve, alreadySold, reclaim, deficit],
      quantity: 4,
      reservationExpiresAt: expiredAt
    })
    await setUnit(preserve, {
      status: 'reserved',
      orderId: repairCase.order._id,
      orderItemId: repairCase.item._id,
      reservedByOrderId: repairCase.order._id,
      reservedAt,
      reservationExpiresAt: expiredAt,
      soldByOrderId: null,
      soldAt: null
    })
    const historicalSoldAt = new Date('2026-11-10T17:00:00.000Z')
    await setUnit(alreadySold, {
      status: 'sold',
      orderId: repairCase.order._id,
      orderItemId: repairCase.item._id,
      reservedByOrderId: null,
      reservedAt: null,
      reservationExpiresAt: null,
      soldByOrderId: repairCase.order._id,
      soldAt: historicalSoldAt
    })
    await setUnit(deficit, { status: 'inactive' })
    const ledgerBefore = fixtures.canonicalLedger(repairCase.item.originalReservation)
    const session = await harness.startSession()
    let result

    try {
      await session.withTransaction(async () => {
        const prepared = await prepareIntegratedRepair({
          orderId: repairCase.order._id,
          paymentId: repairCase.payment._id,
          session
        })
        assert.deepEqual(prepared.input.plan.items[0].preserveReserved.map((entry) => entry.productUnitId), [asId(preserve._id)])
        assert.deepEqual(prepared.input.plan.items[0].alreadySold.map((entry) => entry.productUnitId), [asId(alreadySold._id)])
        assert.deepEqual(prepared.input.plan.items[0].reclaimAvailableOriginals.map((entry) => entry.productUnitId), [asId(reclaim._id)])
        assert.equal(prepared.input.plan.items[0].replaceableDeficitOriginals.length, 1)
        assert.deepEqual(prepared.input.selection.selectedNewProductUnitIds, [asId(replacement._id)])
        result = await writerService.writeRepair(prepared.input, { session })
      }, fixtures.transactionOptions)
    } finally {
      await harness.endSession(session)
    }

    const [sold, product, itemAfter] = await Promise.all([
      fixtures.ProductUnitModel.find({
        orderId: repairCase.order._id,
        orderItemId: repairCase.item._id,
        status: 'sold'
      }).sort({ _id: 1 }).lean(),
      fixtures.ProductModel.findById(context.product._id).lean(),
      fixtures.OrderItemModel.findById(repairCase.item._id).lean()
    ])
    assert.deepEqual(
      sold.map((unit) => asId(unit._id)).sort(),
      [preserve, alreadySold, reclaim, replacement].map((unit) => asId(unit._id)).sort()
    )
    const byId = new Map(sold.map((unit) => [asId(unit._id), unit]))
    assert.equal(epoch(byId.get(asId(preserve._id)).reservedAt), reservedAt.getTime())
    assert.equal(epoch(byId.get(asId(preserve._id)).reservationExpiresAt), expiredAt.getTime())
    assert.equal(epoch(byId.get(asId(preserve._id)).soldAt), repairAt.getTime())
    assert.equal(epoch(byId.get(asId(alreadySold._id)).soldAt), historicalSoldAt.getTime())
    for (const unit of [reclaim, replacement]) {
      const persisted = byId.get(asId(unit._id))
      assert.equal(epoch(persisted.reservedAt), repairAt.getTime())
      assert.equal(epoch(persisted.reservationExpiresAt), expiredAt.getTime())
      assert.equal(epoch(persisted.soldAt), repairAt.getTime())
    }
    assert.equal(product.prodStock, 0)
    assert.deepEqual(fixtures.canonicalLedger(itemAfter.originalReservation), ledgerBefore)
    assert.deepEqual(result.verifiedSoldProductUnitIds.sort(), sold.map((unit) => asId(unit._id)).sort())
  })

  it('repairs two OrderItems of the same Product with disjoint units and authoritative final stock', async function () {
    const buyer = await fixtures.createSyntheticBuyer()
    const inventory = await fixtures.createSerializedInventory({ buyerId: buyer._id, unitCount: 3, stock: 3 })
    const first = await createApprovedCase({
      buyer,
      product: inventory.product,
      ledgerUnits: [inventory.units[0]],
      quantity: 1,
      reservationExpiresAt: futureExpiration
    })
    const secondItem = await fixtures.createBareOrderItem({
      order: first.order,
      product: inventory.product,
      quantity: 1
    })
    await fixtures.captureSyntheticOriginalReservation({ item: secondItem, units: [inventory.units[1]] })
    const ledgersBefore = new Map([
      [asId(first.item._id), fixtures.canonicalLedger(first.item.originalReservation)],
      [asId(secondItem._id), fixtures.canonicalLedger(secondItem.originalReservation)]
    ])
    const session = await harness.startSession()

    try {
      await session.withTransaction(async () => {
        const prepared = await prepareIntegratedRepair({
          orderId: first.order._id,
          paymentId: first.payment._id,
          session
        })
        await writerService.writeRepair(prepared.input, { session })
      }, fixtures.transactionOptions)
    } finally {
      await harness.endSession(session)
    }

    const [sold, product, items] = await Promise.all([
      fixtures.ProductUnitModel.find({ orderId: first.order._id, status: 'sold' }).lean(),
      fixtures.ProductModel.findById(inventory.product._id).lean(),
      fixtures.OrderItemModel.find({ orderId: first.order._id }).lean()
    ])
    assert.equal(sold.length, 2)
    assert.equal(new Set(sold.map((unit) => asId(unit._id))).size, 2)
    assert.deepEqual(new Set(sold.map((unit) => asId(unit.orderItemId))), new Set([
      asId(first.item._id),
      asId(secondItem._id)
    ]))
    assert.equal(product.prodStock, 1)
    const availableCount = await fixtures.ProductUnitModel.countDocuments({
      productId: inventory.product._id,
      status: 'available',
      isDeleted: false
    })
    assert.equal(product.prodStock, availableCount)
    for (const item of items) {
      assert.deepEqual(fixtures.canonicalLedger(item.originalReservation), ledgersBefore.get(asId(item._id)))
    }
  })

  it('repairs multiple Products without cross-assignment and recalculates each stock independently', async function () {
    const buyer = await fixtures.createSyntheticBuyer()
    const inventoryX = await fixtures.createSerializedInventory({ buyerId: buyer._id, unitCount: 2, stock: 2 })
    const inventoryY = await fixtures.createSerializedInventory({ buyerId: buyer._id, unitCount: 2, stock: 2 })
    const first = await createApprovedCase({
      buyer,
      product: inventoryX.product,
      ledgerUnits: [inventoryX.units[0]],
      quantity: 1,
      reservationExpiresAt: futureExpiration
    })
    const secondItem = await fixtures.createBareOrderItem({
      order: first.order,
      product: inventoryY.product,
      quantity: 1
    })
    await fixtures.captureSyntheticOriginalReservation({ item: secondItem, units: [inventoryY.units[0]] })
    const session = await harness.startSession()

    try {
      await session.withTransaction(async () => {
        const prepared = await prepareIntegratedRepair({
          orderId: first.order._id,
          paymentId: first.payment._id,
          session
        })
        await writerService.writeRepair(prepared.input, { session })
      }, fixtures.transactionOptions)
    } finally {
      await harness.endSession(session)
    }

    const [soldX, soldY, productX, productY] = await Promise.all([
      fixtures.ProductUnitModel.find({ productId: inventoryX.product._id, status: 'sold' }).lean(),
      fixtures.ProductUnitModel.find({ productId: inventoryY.product._id, status: 'sold' }).lean(),
      fixtures.ProductModel.findById(inventoryX.product._id).lean(),
      fixtures.ProductModel.findById(inventoryY.product._id).lean()
    ])
    assert.deepEqual(soldX.map((unit) => asId(unit._id)), [asId(inventoryX.units[0]._id)])
    assert.deepEqual(soldY.map((unit) => asId(unit._id)), [asId(inventoryY.units[0]._id)])
    assert.equal(asId(soldX[0].orderItemId), asId(first.item._id))
    assert.equal(asId(soldY[0].orderItemId), asId(secondItem._id))
    assert.equal(productX.prodStock, 1)
    assert.equal(productY.prodStock, 1)
  })
})
