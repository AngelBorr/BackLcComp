/* eslint-env mocha */
import assert from 'node:assert/strict'
import mongoose from 'mongoose'
import { MongoReplicaSetHarness } from '../helpers/mongoReplicaSet.js'
import OrderManager from '../../../src/dao/managers/order.manager.js'
import PaymentManager from '../../../src/dao/managers/payment.manager.js'
import OrderAttentionResolutionManager from '../../../src/dao/managers/orderAttentionResolution.manager.js'
import OrderAttentionResolutionModel from '../../../src/dao/models/orderAttentionResolution.model.js'
import OrderAttentionResolutionService from '../../../src/services/orderAttentionResolution.service.js'
import OrderInventoryRepairReadService from '../../../src/services/orderInventoryRepairRead.service.js'
import OrderInventoryRepairPlannerService from '../../../src/services/orderInventoryRepairPlanner.service.js'
import OrderInventoryRepairSelectorService from '../../../src/services/orderInventoryRepairSelector.service.js'
import OrderInventoryRepairWriterService from '../../../src/services/orderInventoryRepairWriter.service.js'
import {
  OrderInventoryRepairCommandService,
  inventoryRepairRequestHash
} from '../../../src/services/orderInventoryRepairCommand.service.js'

const futureExpiration = new Date('2030-11-20T18:00:00.000Z')
const approvedAt = new Date('2026-11-18T15:00:00.000Z')
const commandClock = new Date('2030-11-20T12:00:00.000Z')

const asId = (value) => String(value?._id ?? value).toLowerCase()
const epoch = (value) => value == null ? null : new Date(value).getTime()

const deferred = () => {
  let resolvePromise
  let rejectPromise
  const promise = new Promise((resolve, reject) => {
    resolvePromise = resolve
    rejectPromise = reject
  })
  promise.catch(() => {})
  return { promise, resolve: resolvePromise, reject: rejectPromise }
}

const rendezvous = (participantCount) => {
  const release = deferred()
  let arrivals = 0
  return {
    async arrive () {
      arrivals += 1
      if (arrivals === participantCount) release.resolve()
      await release.promise
    }
  }
}

const expectedError = async (promise, code) => {
  let observed
  try {
    await promise
    assert.fail(`Expected ${code}`)
  } catch (error) {
    observed = error
  }
  assert.equal(observed?.code, code)
  return observed
}

describe('P1C-B0B F3-C real Mongo inventory repair command', function () {
  const harness = new MongoReplicaSetHarness()
  let fixtures
  let sequence = 0

  before(async function () {
    await harness.start()
    fixtures = await import('../helpers/commerceFixtures.js')
    await fixtures.initializeCommerceModels()
    await OrderAttentionResolutionModel.init()
  })

  afterEach(async function () {
    await harness.cleanupCollections()
  })

  after(async function () {
    await harness.stop()
  })

  const nextOrderNumber = () => {
    sequence += 1
    return `LC-2099-${String(sequence).padStart(6, '0')}`
  }

  const createActor = async () => {
    const actor = await fixtures.createSyntheticBuyer()
    actor.role = 'ADMIN'
    return actor.save()
  }

  const setUnit = (unit, values, { session } = {}) => {
    const query = fixtures.ProductUnitModel.findByIdAndUpdate(
      unit._id,
      { $set: values },
      { new: true, runValidators: true }
    ).lean()
    if (session) query.session(session)
    return query
  }

  const syncStock = async (productId, { session } = {}) => {
    const countQuery = fixtures.ProductUnitModel.countDocuments({
      productId,
      status: 'available',
      isDeleted: false
    })
    if (session) countQuery.session(session)
    const count = await countQuery
    const updateQuery = fixtures.ProductModel.updateOne(
      { _id: productId },
      { $set: { prodStock: count } }
    )
    if (session) updateQuery.session(session)
    await updateQuery
    return count
  }

  const createOrderCase = async ({
    buyer,
    actor,
    product,
    ledgerUnits,
    quantity = ledgerUnits.length,
    captureLedger = true,
    orderNumber = nextOrderNumber()
  }) => {
    const created = await fixtures.createBareOrderWithItem({
      buyer,
      product,
      quantity,
      orderNumber,
      reservationExpiresAt: futureExpiration
    })
    if (captureLedger) {
      await fixtures.captureSyntheticOriginalReservation({
        item: created.item,
        units: ledgerUnits
      })
    }
    await fixtures.markSyntheticOrderRequiresInventoryAttention({ order: created.order })
    const payment = await fixtures.createSyntheticApprovedPayment({
      order: created.order,
      approvedAt
    })
    return { ...created, payment, buyer, actor, product, ledgerUnits }
  }

  const createCase = async ({
    unitCount = 1,
    ledgerIndexes = [0],
    captureLedger = true
  } = {}) => {
    const buyer = await fixtures.createSyntheticBuyer()
    const actor = await createActor()
    const inventory = await fixtures.createSerializedInventory({
      buyerId: buyer._id,
      unitCount
    })
    const repairCase = await createOrderCase({
      buyer,
      actor,
      product: inventory.product,
      ledgerUnits: ledgerIndexes.map((index) => inventory.units[index]),
      captureLedger
    })
    return { ...repairCase, units: inventory.units }
  }

  const commandInput = (repairCase, overrides = {}) => ({
    orderNumber: repairCase.order.orderNumber,
    idempotencyKey: `repair-command-${repairCase.order.orderNumber}-${sequence}`,
    actorUserId: asId(repairCase.actor),
    actorRole: 'ADMIN',
    note: 'Synthetic isolated inventory repair',
    ...overrides
  })

  const trackedMongoose = (tracker) => ({
    async startSession () {
      const session = await mongoose.startSession()
      const originalEnd = session.endSession.bind(session)
      let ended = false
      tracker.started += 1
      session.endSession = async (...args) => {
        if (!ended) {
          ended = true
          tracker.ended += 1
        }
        return originalEnd(...args)
      }
      return session
    }
  })

  const createCommand = (overrides = {}) => {
    const tracker = overrides.tracker || { started: 0, ended: 0 }
    const command = new OrderInventoryRepairCommandService({
      mongooseInstance: trackedMongoose(tracker),
      clock: () => new Date(commandClock),
      ...overrides,
      tracker: undefined
    })
    return { command, tracker }
  }

  const assertStockInvariant = async (productId) => {
    const [product, availableCount] = await Promise.all([
      fixtures.ProductModel.findById(productId).lean(),
      fixtures.ProductUnitModel.countDocuments({
        productId,
        status: 'available',
        isDeleted: false
      })
    ])
    assert.equal(product.prodStock, availableCount)
    return availableCount
  }

  const resolutionDocuments = (query = {}) => (
    OrderAttentionResolutionModel.find(query).sort({ createdAt: 1, _id: 1 }).lean()
  )

  const createPreparedResolutionRecord = async () => {
    const token = String(sequence + 1).padStart(6, '0')
    return OrderAttentionResolutionModel.create({
      orderId: new mongoose.Types.ObjectId(),
      orderNumber: nextOrderNumber(),
      paymentId: new mongoose.Types.ObjectId(),
      idempotencyKey: `mongo-completion-key-${token}`,
      requestHash: 'a'.repeat(64),
      action: 'reassign_inventory',
      originalAttentionReason: 'RESERVATION_QUANTITY_MISMATCH',
      actorUserId: new mongoose.Types.ObjectId(),
      actorRole: 'ADMIN',
      note: 'Mongo completion regression',
      requestedAt: commandClock,
      repairAt: commandClock,
      status: 'prepared'
    })
  }

  const completionSummary = (overrides = {}) => ({
    items: [{
      orderItemId: new mongoose.Types.ObjectId(),
      productId: new mongoose.Types.ObjectId(),
      alreadySoldProductUnitIds: [],
      preservedReservedProductUnitIds: [],
      reclaimedOriginalProductUnitIds: [],
      replacementProductUnitIds: [new mongoose.Types.ObjectId()]
    }],
    alreadySoldCount: 0,
    preservedReservedCount: 0,
    reclaimedOriginalCount: 0,
    replacementCount: 1,
    soldCount: 1,
    ...overrides
  })

  const completePreparedResolution = async (prepared, summary, session) => (
    OrderAttentionResolutionManager.completeInventoryRepairResolution(
      {
        resolutionId: prepared._id,
        orderId: prepared.orderId,
        idempotencyKey: prepared.idempotencyKey,
        requestHash: prepared.requestHash,
        completedAt: commandClock,
        finalProductUnits: [],
        inventoryRepairSummary: summary,
        finalResult: { outcome: 'completed' }
      },
      { session }
    )
  )

  const assertResolutionUniqueness = async () => {
    const completed = await OrderAttentionResolutionModel.aggregate([
      { $match: { action: 'reassign_inventory', status: 'completed' } },
      { $group: { _id: '$orderId', count: { $sum: 1 } } },
      { $match: { count: { $gt: 1 } } }
    ])
    const duplicateKeys = await OrderAttentionResolutionModel.aggregate([
      { $match: { idempotencyKey: { $type: 'string', $gt: '' } } },
      { $group: { _id: '$idempotencyKey', count: { $sum: 1 } } },
      { $match: { count: { $gt: 1 } } }
    ])
    assert.deepEqual(completed, [])
    assert.deepEqual(duplicateKeys, [])
  }

  const snapshotCase = async (repairCase) => {
    const [order, payment, units, product, item] = await Promise.all([
      fixtures.OrderModel.findById(repairCase.order._id).lean(),
      fixtures.PaymentModel.findById(repairCase.payment._id).lean(),
      fixtures.ProductUnitModel.find({ productId: repairCase.product._id }).sort({ _id: 1 }).lean(),
      fixtures.ProductModel.findById(repairCase.product._id).lean(),
      fixtures.OrderItemModel.findById(repairCase.item._id).lean()
    ])
    return {
      order,
      payment,
      units: units.map((unit) => ({
        id: asId(unit),
        status: unit.status,
        orderId: unit.orderId == null ? null : asId(unit.orderId),
        orderItemId: unit.orderItemId == null ? null : asId(unit.orderItemId),
        reservedByOrderId: unit.reservedByOrderId == null ? null : asId(unit.reservedByOrderId),
        reservedAt: epoch(unit.reservedAt),
        reservationExpiresAt: epoch(unit.reservationExpiresAt),
        soldByOrderId: unit.soldByOrderId == null ? null : asId(unit.soldByOrderId),
        soldAt: epoch(unit.soldAt),
        isDeleted: unit.isDeleted
      })),
      stock: product.prodStock,
      ledger: fixtures.canonicalLedger(item.originalReservation)
    }
  }

  const assertRolledBack = async (repairCase, before) => {
    const after = await snapshotCase(repairCase)
    assert.equal(after.order.status, 'requires_attention')
    assert.equal(after.order.fulfillmentStatus, 'pending')
    assert.equal(epoch(after.payment.updatedAt), epoch(before.payment.updatedAt))
    assert.deepEqual(after.units, before.units)
    assert.equal(after.stock, before.stock)
    assert.deepEqual(after.ledger, before.ledger)
    assert.equal(await OrderAttentionResolutionModel.countDocuments({ orderId: repairCase.order._id }), 0)
    await assertStockInvariant(repairCase.product._id)
  }

  const prepareManualRepair = async (repairCase, session, repairAt) => {
    const [order, payment, orderItems] = await Promise.all([
      fixtures.OrderModel.findById(repairCase.order._id).session(session).lean(),
      fixtures.PaymentModel.findById(repairCase.payment._id).session(session).lean(),
      fixtures.OrderItemModel.find({ orderId: repairCase.order._id })
        .sort({ createdAt: 1, _id: 1 })
        .session(session)
        .lean()
    ])
    const originalProductUnitIds = orderItems.flatMap((item) => (
      item.originalReservation.units.map((entry) => entry.productUnitId)
    ))
    const authoritativeInputs = await OrderInventoryRepairReadService.loadAuthoritativeInputs(
      { orderId: order._id, originalProductUnitIds },
      { session }
    )
    const plan = OrderInventoryRepairPlannerService.buildInventoryRepairPlan({
      order,
      payment,
      orderItems: authoritativeInputs.orderItems,
      originalProductUnits: authoritativeInputs.originalProductUnits,
      currentProductUnits: authoritativeInputs.relatedProductUnits,
      externalOrderItemsById: authoritativeInputs.externalOrderItemsById
    })
    const selection = await OrderInventoryRepairSelectorService.selectCandidates(plan, { session })
    return { order, authoritativeInputs, plan, selection, repairAt }
  }

  const commitManualRepair = async (repairCase, repairAt) => {
    const session = await harness.startSession()
    try {
      await session.withTransaction(async () => {
        const input = await prepareManualRepair(repairCase, session, repairAt)
        await OrderInventoryRepairWriterService.writeRepair(input, { session })
      }, fixtures.transactionOptions)
    } finally {
      await harness.endSession(session)
    }
  }

  it('persists a valid complete summary through the real runValidators update path', async function () {
    const prepared = await createPreparedResolutionRecord()
    const summary = completionSummary()
    const session = await harness.startSession()
    try {
      await session.withTransaction(async () => {
        await completePreparedResolution(prepared, summary, session)
      }, fixtures.transactionOptions)
    } finally {
      await harness.endSession(session)
    }

    const persisted = await OrderAttentionResolutionModel.findById(prepared._id).lean()
    assert.equal(persisted.status, 'completed')
    assert.equal(persisted.inventoryRepairSummary.replacementCount, 1)
    assert.equal(persisted.inventoryRepairSummary.soldCount, 1)
    assert.deepEqual(
      persisted.inventoryRepairSummary.items[0].replacementProductUnitIds.map(asId),
      summary.items[0].replacementProductUnitIds.map(asId)
    )
  })

  it('keeps the real completion update fail-closed for an overlapping summary', async function () {
    const prepared = await createPreparedResolutionRecord()
    const duplicateId = new mongoose.Types.ObjectId()
    const summary = completionSummary({
      items: [{
        orderItemId: new mongoose.Types.ObjectId(),
        productId: new mongoose.Types.ObjectId(),
        alreadySoldProductUnitIds: [duplicateId],
        preservedReservedProductUnitIds: [],
        reclaimedOriginalProductUnitIds: [],
        replacementProductUnitIds: [duplicateId]
      }],
      alreadySoldCount: 1,
      replacementCount: 1,
      soldCount: 2
    })
    const session = await harness.startSession()
    try {
      await assert.rejects(
        session.withTransaction(
          () => completePreparedResolution(prepared, summary, session),
          fixtures.transactionOptions
        ),
        (error) => (
          error?.name === 'ValidationError' &&
          Boolean(error?.errors?.['inventoryRepairSummary.items'])
        )
      )
    } finally {
      await harness.endSession(session)
    }

    const persisted = await OrderAttentionResolutionModel.findById(prepared._id).lean()
    assert.equal(persisted.status, 'prepared')
    assert.equal(persisted.inventoryRepairSummary, undefined)
  })

  it('commits the complete command with immutable financial evidence, ledger, summary and stock', async function () {
    const repairCase = await createCase({ unitCount: 2, ledgerIndexes: [0] })
    await setUnit(repairCase.units[0], { status: 'inactive' })
    await syncStock(repairCase.product._id)
    const before = await snapshotCase(repairCase)
    const input = commandInput(repairCase)
    const { command, tracker } = createCommand()

    const result = await command.repairApprovedOrderInventory(input)

    const [order, payment, units, resolutions, item] = await Promise.all([
      fixtures.OrderModel.findById(repairCase.order._id).lean(),
      fixtures.PaymentModel.findById(repairCase.payment._id).lean(),
      fixtures.ProductUnitModel.find({ productId: repairCase.product._id }).sort({ _id: 1 }).lean(),
      resolutionDocuments({ orderId: repairCase.order._id }),
      fixtures.OrderItemModel.findById(repairCase.item._id).lean()
    ])
    const sold = units.filter((unit) => unit.status === 'sold')
    assert.equal(result.idempotent, false)
    assert.equal(order.status, 'paid')
    assert.equal(order.fulfillmentStatus, 'preparing')
    assert.equal(epoch(order.paidAt), epoch(before.payment.approvedAt))
    assert.equal(order.attentionResolutionVersion, 1)
    assert.equal(payment.normalizedStatus, before.payment.normalizedStatus)
    assert.equal(payment.amountArs.toString(), before.payment.amountArs.toString())
    assert.equal(payment.currency, before.payment.currency)
    assert.equal(payment.providerOrderId, before.payment.providerOrderId)
    assert.equal(payment.providerPaymentId, before.payment.providerPaymentId)
    assert.equal(epoch(payment.approvedAt), epoch(before.payment.approvedAt))
    assert.equal(payment.externalReference, before.payment.externalReference)
    assert.equal(epoch(payment.updatedAt), epoch(result.repairAt))
    assert.equal(sold.length, 1)
    assert.equal(asId(sold[0]), asId(repairCase.units[1]))
    assert.equal(asId(sold[0].orderId), asId(order))
    assert.equal(asId(sold[0].orderItemId), asId(repairCase.item))
    assert.equal(resolutions.length, 1)
    assert.equal(resolutions[0].status, 'completed')
    assert.deepEqual(
      resolutions[0].inventoryRepairSummary.items[0].replacementProductUnitIds.map(asId),
      [asId(repairCase.units[1])]
    )
    assert.equal(resolutions[0].inventoryRepairSummary.replacementCount, 1)
    assert.equal(resolutions[0].inventoryRepairSummary.soldCount, 1)
    assert.deepEqual(fixtures.canonicalLedger(item.originalReservation), before.ledger)
    assert.equal(await assertStockInvariant(repairCase.product._id), 0)
    await assertResolutionUniqueness()
    assert.deepEqual(tracker, { started: 1, ended: 1 })
  })

  it('rolls back ProductUnits, stock, Payment fence and prepared Resolution after F2C failure', async function () {
    const repairCase = await createCase()
    const before = await snapshotCase(repairCase)
    const writerService = {
      async writeRepair (input, options) {
        await OrderInventoryRepairWriterService.writeRepair(input, options)
        throw new Error('synthetic failure after F2C')
      }
    }
    const { command, tracker } = createCommand({ writerService })

    const error = await expectedError(
      command.repairApprovedOrderInventory(commandInput(repairCase)),
      'INVENTORY_REPAIR_FAILED'
    )

    assert.equal(error.status, 500)
    await assertRolledBack(repairCase, before)
    assert.deepEqual(tracker, { started: 1, ended: 1 })
  })

  it('rolls the complete transaction back when the real Order CAS no longer matches', async function () {
    const repairCase = await createCase()
    const before = await snapshotCase(repairCase)
    const orderManager = {
      ...OrderManager,
      getByOrderNumber: OrderManager.getByOrderNumber.bind(OrderManager),
      async completeInventoryRepairAttention (orderId, input, { session }) {
        await fixtures.OrderModel.updateOne(
          { _id: orderId },
          { $inc: { attentionResolutionVersion: 1 } },
          { session }
        )
        return OrderManager.completeInventoryRepairAttention(orderId, input, { session })
      }
    }
    const { command } = createCommand({ orderManager })

    await expectedError(
      command.repairApprovedOrderInventory(commandInput(repairCase)),
      'INVENTORY_REPAIR_ORDER_STATE_CHANGED'
    )
    await assertRolledBack(repairCase, before)
  })

  it('rolls Order, inventory, stock, Payment and Resolution back when completion fails', async function () {
    const repairCase = await createCase()
    const before = await snapshotCase(repairCase)
    const resolutionService = {
      createPreparedInventoryRepairResolution:
        OrderAttentionResolutionService.createPreparedInventoryRepairResolution.bind(
          OrderAttentionResolutionService
        ),
      async completeInventoryRepairResolution () {
        throw new Error('synthetic resolution completion failure')
      }
    }
    const { command } = createCommand({ resolutionService })

    await expectedError(
      command.repairApprovedOrderInventory(commandInput(repairCase)),
      'INVENTORY_REPAIR_FAILED'
    )
    await assertRolledBack(repairCase, before)
  })

  it('converges same-key concurrent commands to one commit and one idempotent replay', async function () {
    const repairCase = await createCase()
    const input = commandInput(repairCase)
    const gate = rendezvous(2)
    const resolutionService = {
      async createPreparedInventoryRepairResolution (data, options) {
        await gate.arrive()
        return OrderAttentionResolutionService.createPreparedInventoryRepairResolution(data, options)
      },
      completeInventoryRepairResolution:
        OrderAttentionResolutionService.completeInventoryRepairResolution.bind(
          OrderAttentionResolutionService
        )
    }
    const first = createCommand({ resolutionService })
    const second = createCommand({ resolutionService })

    const results = await Promise.all([
      first.command.repairApprovedOrderInventory(input),
      second.command.repairApprovedOrderInventory(input)
    ])

    assert.deepEqual(results.map((result) => result.idempotent).sort(), [false, true])
    assert.equal(await OrderAttentionResolutionModel.countDocuments({ orderId: repairCase.order._id }), 1)
    assert.equal(await fixtures.ProductUnitModel.countDocuments({
      orderId: repairCase.order._id,
      status: 'sold'
    }), 1)
    const order = await fixtures.OrderModel.findById(repairCase.order._id).lean()
    assert.equal(order.attentionResolutionVersion, 1)
    await assertResolutionUniqueness()
    await assertStockInvariant(repairCase.product._id)
    assert.deepEqual(first.tracker, { started: 1, ended: 1 })
    assert.deepEqual(second.tracker, { started: 1, ended: 1 })
  })

  it('rejects reuse of the same key with a different request hash without a second repair', async function () {
    const repairCase = await createCase()
    const key = 'repair-command-same-key-different-request'
    const { command } = createCommand()
    await command.repairApprovedOrderInventory(commandInput(repairCase, {
      idempotencyKey: key,
      note: 'first note'
    }))

    const error = await expectedError(
      command.repairApprovedOrderInventory(commandInput(repairCase, {
        idempotencyKey: key,
        note: 'different note'
      })),
      'IDEMPOTENCY_KEY_REUSED'
    )

    assert.equal(error.status, 409)
    assert.equal(await OrderAttentionResolutionModel.countDocuments({ orderId: repairCase.order._id }), 1)
    assert.equal(await fixtures.ProductUnitModel.countDocuments({
      orderId: repairCase.order._id,
      status: 'sold'
    }), 1)
  })

  it('allows exactly one different-key command for the same Order and returns a domain loser', async function () {
    const repairCase = await createCase()
    const gate = rendezvous(2)
    const resolutionService = {
      async createPreparedInventoryRepairResolution (data, options) {
        await gate.arrive()
        return OrderAttentionResolutionService.createPreparedInventoryRepairResolution(data, options)
      },
      completeInventoryRepairResolution:
        OrderAttentionResolutionService.completeInventoryRepairResolution.bind(
          OrderAttentionResolutionService
        )
    }
    const first = createCommand({ resolutionService })
    const second = createCommand({ resolutionService })
    const settled = await Promise.allSettled([
      first.command.repairApprovedOrderInventory(commandInput(repairCase, {
        idempotencyKey: 'repair-different-key-same-order-a'
      })),
      second.command.repairApprovedOrderInventory(commandInput(repairCase, {
        idempotencyKey: 'repair-different-key-same-order-b'
      }))
    ])

    assert.equal(settled.filter((entry) => entry.status === 'fulfilled').length, 1)
    const rejected = settled.find((entry) => entry.status === 'rejected')
    assert.equal(rejected.reason.code, 'ATTENTION_INVENTORY_REPAIR_ALREADY_COMPLETED')
    assert.equal(rejected.reason.status, 409)
    assert.equal(await OrderAttentionResolutionModel.countDocuments({
      orderId: repairCase.order._id,
      status: 'completed'
    }), 1)
    assert.equal(await fixtures.ProductUnitModel.countDocuments({
      orderId: repairCase.order._id,
      status: 'sold'
    }), 1)
    await assertResolutionUniqueness()
    assert.deepEqual(first.tracker, { started: 1, ended: 1 })
    assert.deepEqual(second.tracker, { started: 1, ended: 1 })
  })

  it('maps a cross-Order same-key race to IDEMPOTENCY_KEY_REUSED instead of 500', async function () {
    const firstCase = await createCase()
    const secondCase = await createCase()
    const gate = rendezvous(2)
    const resolutionService = {
      async createPreparedInventoryRepairResolution (data, options) {
        await gate.arrive()
        return OrderAttentionResolutionService.createPreparedInventoryRepairResolution(data, options)
      },
      completeInventoryRepairResolution:
        OrderAttentionResolutionService.completeInventoryRepairResolution.bind(
          OrderAttentionResolutionService
        )
    }
    const first = createCommand({ resolutionService })
    const second = createCommand({ resolutionService })
    const key = 'repair-cross-order-global-key'
    const settled = await Promise.allSettled([
      first.command.repairApprovedOrderInventory(commandInput(firstCase, { idempotencyKey: key })),
      second.command.repairApprovedOrderInventory(commandInput(secondCase, { idempotencyKey: key }))
    ])

    assert.equal(settled.filter((entry) => entry.status === 'fulfilled').length, 1)
    const rejected = settled.find((entry) => entry.status === 'rejected')
    assert.equal(rejected.reason.code, 'IDEMPOTENCY_KEY_REUSED')
    assert.equal(rejected.reason.status, 409)
    assert.equal(await OrderAttentionResolutionModel.countDocuments({ idempotencyKey: key }), 1)
    await assertResolutionUniqueness()
    await assertStockInvariant(firstCase.product._id)
    await assertStockInvariant(secondCase.product._id)
  })

  const runRetryRace = async ({ replacementAvailable }) => {
    const buyer = await fixtures.createSyntheticBuyer()
    const actor = await createActor()
    const inventory = await fixtures.createSerializedInventory({
      buyerId: buyer._id,
      unitCount: replacementAvailable ? 2 : 1
    })
    const commandCase = await createOrderCase({
      buyer,
      actor,
      product: inventory.product,
      ledgerUnits: [inventory.units[0]]
    })
    const competitorCase = await createOrderCase({
      buyer,
      actor,
      product: inventory.product,
      ledgerUnits: [inventory.units[0]]
    })
    const firstSelectionReady = deferred()
    const releaseFirstSelection = deferred()
    const observations = []
    let selectionCalls = 0
    const readService = {
      async loadAuthoritativeInputs (input, options) {
        const value = await OrderInventoryRepairReadService.loadAuthoritativeInputs(input, options)
        observations.push({ kind: 'read', value })
        return value
      }
    }
    const plannerService = {
      buildInventoryRepairPlan (input) {
        const value = OrderInventoryRepairPlannerService.buildInventoryRepairPlan(input)
        observations.push({ kind: 'plan', value })
        return value
      }
    }
    const selectorService = {
      async selectCandidates (plan, options) {
        selectionCalls += 1
        const value = await OrderInventoryRepairSelectorService.selectCandidates(plan, options)
        observations.push({ kind: 'selection', value })
        if (selectionCalls === 1) {
          firstSelectionReady.resolve()
          await releaseFirstSelection.promise
        }
        return value
      }
    }
    const preparedInputs = []
    const resolutionService = {
      async createPreparedInventoryRepairResolution (input, options) {
        preparedInputs.push(input)
        return OrderAttentionResolutionService.createPreparedInventoryRepairResolution(input, options)
      },
      completeInventoryRepairResolution:
        OrderAttentionResolutionService.completeInventoryRepairResolution.bind(
          OrderAttentionResolutionService
        )
    }
    const transientErrors = []
    const writerService = {
      async writeRepair (input, options) {
        try {
          return await OrderInventoryRepairWriterService.writeRepair(input, options)
        } catch (error) {
          if (error?.hasErrorLabel?.('TransientTransactionError')) transientErrors.push(error)
          throw error
        }
      }
    }
    const { command, tracker } = createCommand({
      readService,
      plannerService,
      selectorService,
      resolutionService,
      writerService
    })
    const input = commandInput(commandCase, {
      idempotencyKey: `retry-race-${replacementAvailable ? 'replacement' : 'none'}-key`
    })
    const commandPromise = command.repairApprovedOrderInventory(input)

    await firstSelectionReady.promise
    await commitManualRepair(competitorCase, new Date('2030-11-20T11:00:00.000Z'))
    releaseFirstSelection.resolve()

    return {
      buyer,
      actor,
      inventory,
      commandCase,
      competitorCase,
      observations,
      preparedInputs,
      transientErrors,
      tracker,
      input,
      commandPromise
    }
  }

  it('rebuilds a real transient retry, preserves repairAt/hash and reselects U2', async function () {
    const race = await runRetryRace({ replacementAvailable: true })
    const result = await race.commandPromise

    assert.equal(race.transientErrors.length, 1)
    assert.equal(
      race.transientErrors[0].hasErrorLabel('TransientTransactionError'),
      true
    )
    assert.equal(race.preparedInputs.length, 2)
    assert.equal(
      epoch(race.preparedInputs[0].repairAt),
      epoch(race.preparedInputs[1].repairAt)
    )
    assert.equal(
      race.preparedInputs[0].requestHash,
      race.preparedInputs[1].requestHash
    )
    assert.equal(
      race.preparedInputs[0].requestHash,
      inventoryRepairRequestHash(race.input)
    )
    const reads = race.observations.filter((entry) => entry.kind === 'read')
    const plans = race.observations.filter((entry) => entry.kind === 'plan')
    const selections = race.observations.filter((entry) => entry.kind === 'selection')
    assert.equal(reads.length, 2)
    assert.equal(plans.length, 2)
    assert.equal(selections.length, 2)
    assert.notEqual(reads[0].value, reads[1].value)
    assert.notEqual(plans[0].value, plans[1].value)
    assert.notEqual(selections[0].value, selections[1].value)
    assert.deepEqual(selections[0].value.selectedNewProductUnitIds, [])
    assert.deepEqual(selections[1].value.selectedNewProductUnitIds, [asId(race.inventory.units[1])])
    assert.equal(result.summary.replacementCount, 1)

    const [unit1, unit2] = await Promise.all([
      fixtures.ProductUnitModel.findById(race.inventory.units[0]._id).lean(),
      fixtures.ProductUnitModel.findById(race.inventory.units[1]._id).lean()
    ])
    assert.equal(asId(unit1.orderId), asId(race.competitorCase.order))
    assert.equal(asId(unit2.orderId), asId(race.commandCase.order))
    assert.equal(unit1.status, 'sold')
    assert.equal(unit2.status, 'sold')
    await assertStockInvariant(race.inventory.product._id)
    await assertResolutionUniqueness()
    assert.deepEqual(race.tracker, { started: 1, ended: 1 })
  })

  it('returns the domain insufficient-inventory error after a real retry has no replacement', async function () {
    const race = await runRetryRace({ replacementAvailable: false })
    const error = await expectedError(race.commandPromise, 'INSUFFICIENT_REPAIR_INVENTORY')

    assert.equal(error.status, 409)
    assert.equal(race.transientErrors.length, 1)
    assert.equal(race.preparedInputs.length, 2)
    const order = await fixtures.OrderModel.findById(race.commandCase.order._id).lean()
    assert.equal(order.status, 'requires_attention')
    assert.equal(await OrderAttentionResolutionModel.countDocuments({
      orderId: race.commandCase.order._id
    }), 0)
    const unit = await fixtures.ProductUnitModel.findById(race.inventory.units[0]._id).lean()
    assert.equal(asId(unit.orderId), asId(race.competitorCase.order))
    await assertStockInvariant(race.inventory.product._id)
    assert.deepEqual(race.tracker, { started: 1, ended: 1 })
  })

  it('serializes the Payment fence against a stale concurrent financial CAS', async function () {
    const repairCase = await createCase()
    const before = await snapshotCase(repairCase)
    const fenceApplied = deferred()
    const releaseWriter = deferred()
    const writerService = {
      async writeRepair (input, options) {
        fenceApplied.resolve()
        await releaseWriter.promise
        return OrderInventoryRepairWriterService.writeRepair(input, options)
      }
    }
    const { command } = createCommand({ writerService })
    const commandPromise = command.repairApprovedOrderInventory(commandInput(repairCase))
    await fenceApplied.promise

    const concurrentEntered = deferred()
    const concurrentSession = await harness.startSession()
    let concurrentResult
    const concurrent = concurrentSession.withTransaction(async () => {
      concurrentEntered.resolve()
      concurrentResult = await fixtures.PaymentModel.updateOne(
        { _id: repairCase.payment._id, updatedAt: before.payment.updatedAt },
        { $set: { providerPaymentId: 'PAY-CONCURRENT-STALE' } },
        { session: concurrentSession, timestamps: false }
      )
    }, fixtures.transactionOptions)
    await concurrentEntered.promise
    releaseWriter.resolve()
    await commandPromise
    await concurrent
    await harness.endSession(concurrentSession)

    assert.equal(concurrentResult.matchedCount, 0)
    const payment = await fixtures.PaymentModel.findById(repairCase.payment._id).lean()
    assert.equal(payment.providerPaymentId, before.payment.providerPaymentId)
    const order = await fixtures.OrderModel.findById(repairCase.order._id).lean()
    assert.equal(order.status, 'paid')
    await assertStockInvariant(repairCase.product._id)
  })

  it('aborts F3 when a concurrent financial writer commits newer Payment evidence first', async function () {
    const repairCase = await createCase()
    const beforeFence = deferred()
    const releaseFence = deferred()
    let fenceCalls = 0
    let attemptedRepairAt = null
    const paymentManager = {
      getLatestByOrderId: PaymentManager.getLatestByOrderId.bind(PaymentManager),
      async fenceApprovedInventoryRepairEvidence (input, options) {
        fenceCalls += 1
        if (fenceCalls === 1) {
          attemptedRepairAt = new Date(input.repairAt)
          beforeFence.resolve()
          await releaseFence.promise
        }
        return PaymentManager.fenceApprovedInventoryRepairEvidence(input, options)
      }
    }
    const { command } = createCommand({ paymentManager })
    const commandPromise = command.repairApprovedOrderInventory(commandInput(repairCase))
    await beforeFence.promise

    const concurrentSession = await harness.startSession()
    const newerUpdatedAt = new Date(attemptedRepairAt.getTime() + 1)
    try {
      await concurrentSession.withTransaction(async () => {
        await fixtures.PaymentModel.collection.updateOne(
          { _id: repairCase.payment._id },
          {
            $set: {
              providerPaymentId: 'PAY-CONCURRENT-NEWER',
              updatedAt: newerUpdatedAt
            }
          },
          { session: concurrentSession }
        )
      }, fixtures.transactionOptions)
    } finally {
      await harness.endSession(concurrentSession)
    }
    releaseFence.resolve()

    const error = await expectedError(
      commandPromise,
      'INVENTORY_REPAIR_PAYMENT_FENCE_TIMESTAMP_CONFLICT'
    )
    assert.equal(error.status, 409)
    const [order, payment] = await Promise.all([
      fixtures.OrderModel.findById(repairCase.order._id).lean(),
      fixtures.PaymentModel.findById(repairCase.payment._id).lean()
    ])
    assert.equal(order.status, 'requires_attention')
    assert.equal(payment.providerPaymentId, 'PAY-CONCURRENT-NEWER')
    assert.equal(epoch(payment.updatedAt), newerUpdatedAt.getTime())
    assert.equal(await OrderAttentionResolutionModel.countDocuments({
      orderId: repairCase.order._id
    }), 0)
    await assertStockInvariant(repairCase.product._id)
  })

  it('blocks a pre-existing active refund and permits the real refund fence only after repair', async function () {
    const blockedCase = await createCase()
    const refundId = new mongoose.Types.ObjectId()
    await fixtures.OrderModel.updateOne(
      { _id: blockedCase.order._id },
      { $set: { activeRefundId: refundId } }
    )
    const { command: blockedCommand } = createCommand()
    await expectedError(
      blockedCommand.repairApprovedOrderInventory(commandInput(blockedCase)),
      'INVENTORY_REPAIR_PLAN_BLOCKED'
    )
    assert.equal(await OrderAttentionResolutionModel.countDocuments({
      orderId: blockedCase.order._id
    }), 0)

    const successCase = await createCase()
    const { command } = createCommand()
    await command.repairApprovedOrderInventory(commandInput(successCase))
    const attached = await OrderManager.attachActiveRefund(
      successCase.order._id,
      new mongoose.Types.ObjectId()
    )
    assert.ok(attached)
    assert.equal(attached.status, 'paid')
    assert.ok(attached.activeRefundId)
  })

  it('returns PLAN_BLOCKED with no writes when the immutable ledger is missing', async function () {
    const repairCase = await createCase({ captureLedger: false })
    const before = await snapshotCase(repairCase)
    const { command } = createCommand()

    await expectedError(
      command.repairApprovedOrderInventory(commandInput(repairCase)),
      'INVENTORY_REPAIR_PLAN_BLOCKED'
    )
    await assertRolledBack(repairCase, before)
  })

  it('completes an already-satisfied exact sold set without unnecessary ProductUnit mutation', async function () {
    const repairCase = await createCase()
    const historicalSoldAt = new Date('2026-11-18T16:00:00.000Z')
    await setUnit(repairCase.units[0], {
      status: 'sold',
      orderId: repairCase.order._id,
      orderItemId: repairCase.item._id,
      reservedByOrderId: null,
      reservedAt: null,
      reservationExpiresAt: null,
      soldByOrderId: repairCase.order._id,
      soldAt: historicalSoldAt
    })
    await syncStock(repairCase.product._id)
    const ledgerBefore = fixtures.canonicalLedger(repairCase.item.originalReservation)
    const { command } = createCommand()

    const result = await command.repairApprovedOrderInventory(commandInput(repairCase))

    const [unit, item, order, resolution] = await Promise.all([
      fixtures.ProductUnitModel.findById(repairCase.units[0]._id).lean(),
      fixtures.OrderItemModel.findById(repairCase.item._id).lean(),
      fixtures.OrderModel.findById(repairCase.order._id).lean(),
      OrderAttentionResolutionModel.findOne({ orderId: repairCase.order._id }).lean()
    ])
    assert.equal(result.summary.alreadySoldCount, 1)
    assert.equal(result.summary.replacementCount, 0)
    assert.equal(epoch(unit.soldAt), historicalSoldAt.getTime())
    assert.equal(order.status, 'paid')
    assert.equal(resolution.status, 'completed')
    assert.deepEqual(fixtures.canonicalLedger(item.originalReservation), ledgerBefore)
    await assertStockInvariant(repairCase.product._id)
  })

  it('rolls prepared state back when repairable inventory has no replacement candidate', async function () {
    const repairCase = await createCase()
    await setUnit(repairCase.units[0], { status: 'inactive' })
    await syncStock(repairCase.product._id)
    const before = await snapshotCase(repairCase)
    const { command, tracker } = createCommand()

    await expectedError(
      command.repairApprovedOrderInventory(commandInput(repairCase)),
      'INSUFFICIENT_REPAIR_INVENTORY'
    )
    await assertRolledBack(repairCase, before)
    assert.deepEqual(tracker, { started: 1, ended: 1 })
  })

  it('closes sessions for replay and unexpected failures without persisting partial state', async function () {
    const successCase = await createCase()
    const successInput = commandInput(successCase)
    const success = createCommand()
    await success.command.repairApprovedOrderInventory(successInput)
    const replay = await success.command.repairApprovedOrderInventory(successInput)
    assert.equal(replay.idempotent, true)
    assert.deepEqual(success.tracker, { started: 1, ended: 1 })

    const failureCase = await createCase()
    const before = await snapshotCase(failureCase)
    const failure = createCommand({
      writerService: {
        async writeRepair () {
          throw new Error('unexpected isolated failure')
        }
      }
    })
    await expectedError(
      failure.command.repairApprovedOrderInventory(commandInput(failureCase)),
      'INVENTORY_REPAIR_FAILED'
    )
    assert.deepEqual(failure.tracker, { started: 1, ended: 1 })
    await assertRolledBack(failureCase, before)
  })
})
