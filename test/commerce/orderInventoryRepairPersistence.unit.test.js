/* eslint-env mocha */
import assert from 'node:assert/strict'
import mongoose from 'mongoose'
import OrderModel from '../../src/dao/models/order.model.js'
import PaymentModel from '../../src/dao/models/payment.model.js'
import OrderAttentionResolutionModel from '../../src/dao/models/orderAttentionResolution.model.js'
import { OrderManager } from '../../src/dao/managers/order.manager.js'
import { PaymentManager } from '../../src/dao/managers/payment.manager.js'
import {
  OrderAttentionResolutionManager
} from '../../src/dao/managers/orderAttentionResolution.manager.js'
import {
  OrderAttentionResolutionService
} from '../../src/services/orderAttentionResolution.service.js'

const ids = Object.freeze({
  order: new mongoose.Types.ObjectId('507f1f77bcf86cd799439001'),
  payment: new mongoose.Types.ObjectId('507f1f77bcf86cd799439002'),
  actor: new mongoose.Types.ObjectId('507f1f77bcf86cd799439003'),
  resolution: new mongoose.Types.ObjectId('507f1f77bcf86cd799439004'),
  item: new mongoose.Types.ObjectId('507f1f77bcf86cd799439005'),
  product: new mongoose.Types.ObjectId('507f1f77bcf86cd799439006'),
  unitA: new mongoose.Types.ObjectId('507f1f77bcf86cd799439007'),
  unitB: new mongoose.Types.ObjectId('507f1f77bcf86cd799439008'),
  unitC: new mongoose.Types.ObjectId('507f1f77bcf86cd799439009'),
  unitD: new mongoose.Types.ObjectId('507f1f77bcf86cd799439010')
})

const requestedAt = new Date('2026-11-18T10:00:00.000Z')
const paymentUpdatedAt = new Date('2026-11-18T10:00:01.000Z')
const repairAt = new Date('2026-11-18T10:00:02.000Z')
const reservationExpiresAt = new Date('2026-11-18T16:00:00.000Z')
const requestHash = 'a'.repeat(64)
const activeSession = () => ({
  hasEnded: false,
  inTransaction: () => true
})

const makeSummary = (overrides = {}) => ({
  items: [{
    orderItemId: ids.item,
    productId: ids.product,
    alreadySoldProductUnitIds: [ids.unitA],
    preservedReservedProductUnitIds: [ids.unitB],
    reclaimedOriginalProductUnitIds: [ids.unitC],
    replacementProductUnitIds: [ids.unitD]
  }],
  alreadySoldCount: 1,
  preservedReservedCount: 1,
  reclaimedOriginalCount: 1,
  replacementCount: 1,
  soldCount: 4,
  ...overrides
})

const makeHistoricalResolution = (overrides = {}) => ({
  orderId: ids.order,
  paymentId: ids.payment,
  idempotencyKey: 'historical-attention-key',
  action: 'complete_existing_reservation_sale',
  originalAttentionReason: 'RESERVATION_EXPIRED',
  actorUserId: ids.actor,
  actorRole: 'ADMIN',
  requestedAt,
  ...overrides
})

const makeF3Resolution = (overrides = {}) => ({
  orderId: ids.order,
  orderNumber: 'LC-2026-000100',
  paymentId: ids.payment,
  idempotencyKey: 'inventory-repair-key-0001',
  requestHash,
  action: 'reassign_inventory',
  originalAttentionReason: 'RESERVATION_CHANGED_DURING_APPROVAL',
  actorUserId: ids.actor,
  actorRole: 'ADMIN',
  note: 'Reparacion administrativa',
  requestedAt,
  repairAt,
  previousState: {
    orderStatus: 'requires_attention',
    paymentStatus: 'approved',
    fulfillmentStatus: 'pending',
    attentionReason: 'RESERVATION_CHANGED_DURING_APPROVAL',
    attentionResolutionVersion: 0
  },
  ...overrides
})

const makePaymentFenceInput = (overrides = {}) => ({
  paymentId: ids.payment,
  orderId: ids.order,
  provider: 'mercado_pago',
  normalizedStatus: 'approved',
  providerOrderId: 'ORD-REPAIR-001',
  providerPaymentId: 'PAY-REPAIR-001',
  approvedAt: requestedAt,
  externalReference: 'LC-2026-000100',
  amountArs: mongoose.Types.Decimal128.fromString('20497.40'),
  currency: 'ARS',
  expectedUpdatedAt: paymentUpdatedAt,
  repairAt,
  ...overrides
})

const makeOrderTransition = (overrides = {}) => ({
  expectedAttentionReason: 'RESERVATION_CHANGED_DURING_APPROVAL',
  expectedAttentionResolutionVersion: 0,
  expectedReservationExpiresAt: reservationExpiresAt,
  expectedActiveRefundId: null,
  expectedReconciliationNextAt: null,
  expectedReconciliationLeaseOwner: null,
  expectedReconciliationLeaseUntil: null,
  paymentApprovedAt: requestedAt,
  actorUserId: ids.actor,
  repairAt,
  ...overrides
})

describe('P1C-B0B F3-A persistence contracts (isolated)', () => {
  describe('OrderAttentionResolution F3 persistence', () => {
    it('keeps historical resolutions valid without F3 fields', async () => {
      const resolution = new OrderAttentionResolutionModel(makeHistoricalResolution())
      await resolution.validate()
      assert.equal(resolution.orderNumber, undefined)
      assert.equal(resolution.requestHash, undefined)
      assert.equal(resolution.repairAt, undefined)
      assert.equal(resolution.inventoryRepairSummary, undefined)
    })

    it('accepts the compact F3 identity and inventory summary', async () => {
      const resolution = new OrderAttentionResolutionModel({
        ...makeF3Resolution(),
        inventoryRepairSummary: makeSummary()
      })
      await resolution.validate()
      assert.equal(resolution.orderNumber, 'LC-2026-000100')
      assert.equal(resolution.inventoryRepairSummary.soldCount, 4)
    })

    it('declares F3 request identity immutable', () => {
      for (const field of ['orderNumber', 'requestHash', 'repairAt']) {
        assert.equal(OrderAttentionResolutionModel.schema.path(field).options.immutable, true)
      }
    })

    it('rejects a non-lowercase SHA-256 request hash', async () => {
      const resolution = new OrderAttentionResolutionModel(makeF3Resolution({
        requestHash: 'A'.repeat(64)
      }))
      await assert.rejects(resolution.validate(), /requestHash/)
    })

    it('rejects an invalid repairAt date', async () => {
      const resolution = new OrderAttentionResolutionModel(makeF3Resolution({
        repairAt: 'invalid-date'
      }))
      await assert.rejects(resolution.validate(), /repairAt/)
    })

    it('rejects invalid ProductUnit IDs in the summary', async () => {
      const summary = makeSummary()
      summary.items[0].replacementProductUnitIds = ['invalid-id']
      const resolution = new OrderAttentionResolutionModel({
        ...makeF3Resolution(),
        inventoryRepairSummary: summary
      })
      await assert.rejects(resolution.validate(), /replacementProductUnitIds/)
    })

    it('rejects duplicate or overlapping ProductUnit summary categories', async () => {
      const summary = makeSummary()
      summary.items[0].replacementProductUnitIds = [ids.unitA]
      const resolution = new OrderAttentionResolutionModel({
        ...makeF3Resolution(),
        inventoryRepairSummary: summary
      })
      await assert.rejects(resolution.validate(), /IDs superpuestos/)
    })

    it('rejects summary counts that do not match their ID sets', async () => {
      const resolution = new OrderAttentionResolutionModel({
        ...makeF3Resolution(),
        inventoryRepairSummary: makeSummary({ replacementCount: 2 })
      })
      await assert.rejects(resolution.validate(), /conteos invalidos/)
    })

    it('keeps the historical compound and completed repair indexes exact', () => {
      const indexes = OrderAttentionResolutionModel.schema.indexes()
      const historical = indexes.find(([fields, options]) => (
        fields.orderId === 1 &&
        fields.idempotencyKey === 1 &&
        Object.keys(fields).length === 2 &&
        options.unique === true
      ))
      const completed = indexes.find(([, options]) => (
        options.name === 'uniq_completed_reassign_inventory_per_order'
      ))
      assert.ok(historical)
      assert.deepEqual(historical[0], { orderId: 1, idempotencyKey: 1 })
      assert.ok(completed)
      assert.deepEqual(completed[0], { orderId: 1, action: 1 })
      assert.equal(completed[1].unique, true)
      assert.deepEqual(completed[1].partialFilterExpression, {
        status: 'completed',
        action: 'reassign_inventory'
      })
    })

    it('declares the exact global idempotency partial unique index', () => {
      const globalIdempotency = OrderAttentionResolutionModel.schema.indexes()
        .find(([, options]) => (
          options.name === 'uniq_attention_resolution_idempotency_key'
        ))

      assert.ok(globalIdempotency)
      assert.deepEqual(globalIdempotency[0], { idempotencyKey: 1 })
      assert.equal(globalIdempotency[1].unique, true)
      assert.deepEqual(globalIdempotency[1].partialFilterExpression, {
        idempotencyKey: {
          $type: 'string',
          $gt: ''
        }
      })
    })

    it('requires an active transaction for F3 create and complete writes', async () => {
      const manager = new OrderAttentionResolutionManager({ model: {} })
      const invalidSessions = [
        undefined,
        { hasEnded: true, inTransaction: () => true },
        { hasEnded: false, inTransaction: () => false },
        { hasEnded: false, inTransaction: () => { throw new Error('invalid') } }
      ]

      for (const session of invalidSessions) {
        await assert.rejects(
          manager.createPreparedInventoryRepairResolution(makeF3Resolution(), { session }),
          (error) => error.code === 'INVENTORY_REPAIR_TRANSACTION_REQUIRED'
        )
        await assert.rejects(
          manager.completeInventoryRepairResolution({}, { session }),
          (error) => error.code === 'INVENTORY_REPAIR_TRANSACTION_REQUIRED'
        )
      }
    })

    it('creates only whitelisted prepared F3 metadata in the caller transaction', async () => {
      let constructed
      let saveOptions
      class FakeModel {
        constructor(data) {
          constructed = data
          Object.assign(this, data)
        }

        async save(options) {
          saveOptions = options
          return this
        }
      }
      const session = activeSession()
      const manager = new OrderAttentionResolutionManager({ model: FakeModel })
      await manager.createPreparedInventoryRepairResolution({
        ...makeF3Resolution(),
        providerPaymentId: 'CLIENT-MUST-NOT-PERSIST'
      }, { session })

      assert.equal(constructed.action, 'reassign_inventory')
      assert.equal(constructed.status, 'prepared')
      assert.equal(constructed.providerPaymentId, undefined)
      assert.equal(constructed.finalResult, null)
      assert.equal(saveOptions.session, session)
    })

    it('completes F3 with the exact immutable identity CAS', async () => {
      let captured
      const session = activeSession()
      const model = {
        async updateOne(filter, update, options) {
          captured = { filter, update, options }
          return { matchedCount: 1, modifiedCount: 1 }
        }
      }
      const manager = new OrderAttentionResolutionManager({ model })
      await manager.completeInventoryRepairResolution({
        resolutionId: ids.resolution,
        orderId: ids.order,
        idempotencyKey: 'inventory-repair-key-0001',
        requestHash,
        completedAt: repairAt,
        finalProductUnits: [],
        inventoryRepairSummary: makeSummary(),
        finalResult: { outcome: 'completed' }
      }, { session })

      assert.deepEqual(captured.filter, {
        _id: ids.resolution,
        orderId: ids.order,
        action: 'reassign_inventory',
        status: 'prepared',
        idempotencyKey: 'inventory-repair-key-0001',
        requestHash
      })
      assert.equal(captured.update.$set.status, 'completed')
      assert.equal(captured.update.$set.actorUserId, undefined)
      assert.equal(captured.update.$set.idempotencyKey, undefined)
      assert.equal(captured.options.session, session)
      assert.equal(captured.options.runValidators, true)
    })

    it('rejects a Resolution CAS count mismatch', async () => {
      const manager = new OrderAttentionResolutionManager({
        model: { async updateOne() { return { matchedCount: 1, modifiedCount: 0 } } }
      })
      await assert.rejects(
        manager.completeInventoryRepairResolution({
          resolutionId: ids.resolution,
          orderId: ids.order,
          idempotencyKey: 'inventory-repair-key-0001',
          requestHash,
          completedAt: repairAt,
          inventoryRepairSummary: makeSummary(),
          finalResult: { outcome: 'completed' }
        }, { session: activeSession() }),
        (error) => error.code === 'ATTENTION_RESOLUTION_CAS_CONFLICT'
      )
    })

    it('preserves a Mongo error from Resolution completion by identity', async () => {
      const transient = new Error('write conflict')
      transient.hasErrorLabel = (label) => label === 'TransientTransactionError'
      const manager = new OrderAttentionResolutionManager({
        model: { async updateOne() { throw transient } }
      })
      await assert.rejects(
        manager.completeInventoryRepairResolution({
          resolutionId: ids.resolution,
          orderId: ids.order,
          idempotencyKey: 'inventory-repair-key-0001',
          requestHash,
          completedAt: repairAt,
          inventoryRepairSummary: makeSummary(),
          finalResult: { outcome: 'completed' }
        }, { session: activeSession() }),
        (error) => error === transient
      )
    })

    it('keeps F3 service writes delegated to the transaction-aware manager primitives', async () => {
      const calls = []
      const expected = { _id: ids.resolution, status: 'completed' }
      const manager = {
        async createPreparedInventoryRepairResolution(input, options) {
          calls.push({ operation: 'create', input, options })
          return { toObject: () => ({ _id: ids.resolution, status: 'prepared' }) }
        },
        async completeInventoryRepairResolution(input, options) {
          calls.push({ operation: 'complete', input, options })
          return { matchedCount: 1, modifiedCount: 1 }
        },
        async getById(resolutionId, options) {
          calls.push({ operation: 'read', resolutionId, options })
          return expected
        }
      }
      const session = activeSession()
      const service = new OrderAttentionResolutionService({ resolutionManager: manager })
      const created = await service.createPreparedInventoryRepairResolution(
        makeF3Resolution(),
        { session }
      )
      const completed = await service.completeInventoryRepairResolution(
        { resolutionId: ids.resolution },
        { session }
      )

      assert.equal(created.status, 'prepared')
      assert.equal(completed, expected)
      assert.deepEqual(calls.map((call) => call.operation), ['create', 'complete', 'read'])
      assert.ok(calls.every((call) => call.options.session === session))
    })
  })

  describe('Payment approved-evidence fence', () => {
    const originalUpdateOne = PaymentModel.updateOne

    afterEach(() => {
      PaymentModel.updateOne = originalUpdateOne
    })

    it('requires an active transaction', async () => {
      await assert.rejects(
        new PaymentManager().fenceApprovedInventoryRepairEvidence(
          makePaymentFenceInput()
        ),
        (error) => error.code === 'INVENTORY_REPAIR_TRANSACTION_REQUIRED'
      )
    })

    it('uses the exact financial evidence filter and only writes updatedAt', async () => {
      let captured
      const session = activeSession()
      PaymentModel.updateOne = async (filter, update, options) => {
        captured = { filter, update, options }
        return { matchedCount: 1, modifiedCount: 1 }
      }

      await new PaymentManager().fenceApprovedInventoryRepairEvidence(
        makePaymentFenceInput(),
        { session }
      )

      assert.deepEqual(captured.filter, {
        _id: ids.payment,
        orderId: ids.order,
        provider: 'mercado_pago',
        normalizedStatus: 'approved',
        providerOrderId: 'ORD-REPAIR-001',
        providerPaymentId: 'PAY-REPAIR-001',
        approvedAt: requestedAt,
        externalReference: 'LC-2026-000100',
        amountArs: makePaymentFenceInput().amountArs,
        currency: 'ARS',
        updatedAt: paymentUpdatedAt
      })
      assert.deepEqual(captured.update, { $set: { updatedAt: repairAt } })
      assert.deepEqual(Object.keys(captured.update.$set), ['updatedAt'])
      assert.equal(captured.options.timestamps, false)
      assert.equal(captured.options.runValidators, true)
      assert.equal(captured.options.session, session)
    })

    it('rejects repairAt equal to or older than expectedUpdatedAt before writing', async () => {
      let calls = 0
      PaymentModel.updateOne = async () => {
        calls += 1
        return { matchedCount: 1, modifiedCount: 1 }
      }
      const manager = new PaymentManager()

      for (const invalidRepairAt of [
        new Date(paymentUpdatedAt),
        new Date(paymentUpdatedAt.getTime() - 1)
      ]) {
        await assert.rejects(
          manager.fenceApprovedInventoryRepairEvidence(
            makePaymentFenceInput({ repairAt: invalidRepairAt }),
            { session: activeSession() }
          ),
          (error) => error.code === 'INVENTORY_REPAIR_PAYMENT_FENCE_TIMESTAMP_CONFLICT'
        )
      }
      assert.equal(calls, 0)
    })

    it('reports stale financial evidence for either count mismatch', async () => {
      const manager = new PaymentManager()
      for (const result of [
        { matchedCount: 0, modifiedCount: 0 },
        { matchedCount: 1, modifiedCount: 0 }
      ]) {
        PaymentModel.updateOne = async () => result
        await assert.rejects(
          manager.fenceApprovedInventoryRepairEvidence(
            makePaymentFenceInput(),
            { session: activeSession() }
          ),
          (error) => error.code === 'INVENTORY_REPAIR_PAYMENT_EVIDENCE_CHANGED'
        )
      }
    })

    it('preserves transient Mongo errors by identity', async () => {
      const transient = new Error('payment write conflict')
      transient.code = 112
      transient.hasErrorLabel = (label) => label === 'TransientTransactionError'
      PaymentModel.updateOne = async () => { throw transient }

      await assert.rejects(
        new PaymentManager().fenceApprovedInventoryRepairEvidence(
          makePaymentFenceInput(),
          { session: activeSession() }
        ),
        (error) => error === transient
      )
    })
  })

  describe('Order inventory-repair completion CAS', () => {
    const originalUpdateOne = OrderModel.updateOne

    afterEach(() => {
      OrderModel.updateOne = originalUpdateOne
    })

    it('requires an active transaction', async () => {
      await assert.rejects(
        new OrderManager().completeInventoryRepairAttention(
          ids.order,
          makeOrderTransition()
        ),
        (error) => error.code === 'INVENTORY_REPAIR_TRANSACTION_REQUIRED'
      )
    })

    it('uses exact attention, refund, reservation, reconciliation and version guards', async () => {
      let captured
      const session = activeSession()
      OrderModel.updateOne = async (filter, update, options) => {
        captured = { filter, update, options }
        return { matchedCount: 1, modifiedCount: 1 }
      }

      await new OrderManager().completeInventoryRepairAttention(
        ids.order,
        makeOrderTransition(),
        { session }
      )

      const base = captured.filter.$and[0]
      assert.equal(base._id, ids.order)
      assert.equal(base.status, 'requires_attention')
      assert.equal(base.attentionReason, 'RESERVATION_CHANGED_DURING_APPROVAL')
      assert.equal(base.fulfillmentStatus, 'pending')
      assert.equal(base.reservationExpiresAt, reservationExpiresAt)
      assert.ok(captured.filter.$and.some((entry) => entry.$or?.some(
        (alternative) => Object.hasOwn(alternative, 'activeRefundId')
      )))
      assert.ok(captured.filter.$and.some((entry) => entry.$or?.some(
        (alternative) => Object.hasOwn(alternative, 'attentionResolutionVersion')
      )))
      assert.equal(captured.options.session, session)
      assert.equal(captured.options.runValidators, true)
    })

    it('writes paid/preparing histories without clearing attentionReason', async () => {
      let update
      OrderModel.updateOne = async (_filter, value) => {
        update = value
        return { matchedCount: 1, modifiedCount: 1 }
      }

      await new OrderManager().completeInventoryRepairAttention(
        ids.order,
        makeOrderTransition(),
        { session: activeSession() }
      )

      assert.deepEqual(update.$set, {
        status: 'paid',
        paidAt: requestedAt,
        fulfillmentStatus: 'preparing'
      })
      assert.equal(update.$set.attentionReason, undefined)
      assert.deepEqual(update.$inc, { attentionResolutionVersion: 1 })
      assert.deepEqual(update.$push.statusHistory, {
        status: 'paid',
        changedAt: repairAt,
        reason: 'ATTENTION_RESOLUTION_INVENTORY_REPAIR'
      })
      assert.deepEqual(update.$push.fulfillmentHistory, {
        status: 'preparing',
        changedAt: repairAt,
        changedBy: ids.actor,
        reason: 'ATTENTION_RESOLUTION_INVENTORY_REPAIR'
      })
    })

    it('requires exact matched and modified counts', async () => {
      const manager = new OrderManager()
      for (const result of [
        { matchedCount: 0, modifiedCount: 0 },
        { matchedCount: 1, modifiedCount: 0 }
      ]) {
        OrderModel.updateOne = async () => result
        await assert.rejects(
          manager.completeInventoryRepairAttention(
            ids.order,
            makeOrderTransition(),
            { session: activeSession() }
          ),
          (error) => error.code === 'INVENTORY_REPAIR_ORDER_STATE_CHANGED'
        )
      }
    })

    it('preserves Mongo errors by identity', async () => {
      const transient = new Error('order write conflict')
      transient.hasErrorLabel = (label) => label === 'TransientTransactionError'
      OrderModel.updateOne = async () => { throw transient }

      await assert.rejects(
        new OrderManager().completeInventoryRepairAttention(
          ids.order,
          makeOrderTransition(),
          { session: activeSession() }
        ),
        (error) => error === transient
      )
    })
  })
})
