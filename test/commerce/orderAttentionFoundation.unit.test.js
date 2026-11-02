import assert from 'node:assert/strict'
import mongoose from 'mongoose'
import OrderModel from '../../src/dao/models/order.model.js'
import OrderAttentionResolutionModel from '../../src/dao/models/orderAttentionResolution.model.js'
import {
  OrderAttentionResolutionManager
} from '../../src/dao/managers/orderAttentionResolution.manager.js'
import {
  ATTENTION_CATEGORIES,
  OrderAttentionService
} from '../../src/services/orderAttention.service.js'
import {
  OrderAttentionResolutionService
} from '../../src/services/orderAttentionResolution.service.js'

const orderId = '507f1f77bcf86cd799439012'
const otherOrderId = '507f1f77bcf86cd799439099'
const paymentId = '507f1f77bcf86cd799439015'
const actorUserId = '507f1f77bcf86cd799439088'
const itemId = '507f1f77bcf86cd799439013'
const productId = '507f1f77bcf86cd799439014'
const now = new Date('2026-11-02T12:00:00.000Z')

const makeOrder = (overrides = {}) => ({
  _id: orderId,
  orderNumber: 'LC-2026-000010',
  status: 'requires_attention',
  fulfillmentStatus: 'pending',
  attentionReason: 'RESERVATION_EXPIRED',
  ...overrides
})

const makePayment = (overrides = {}) => ({
  _id: paymentId,
  orderId,
  normalizedStatus: 'approved',
  providerPaymentId: 'PAY-ATTENTION-001',
  approvedAt: now,
  ...overrides
})

const orderItem = {
  _id: itemId,
  orderId,
  productId,
  quantity: 1
}

const makeReservedUnit = (overrides = {}) => ({
  _id: '507f1f77bcf86cd799439016',
  productId,
  orderId,
  orderItemId: itemId,
  reservedByOrderId: orderId,
  soldByOrderId: null,
  serialNumber: 'ATTENTION-001',
  status: 'reserved',
  reservedAt: now,
  reservationExpiresAt: now,
  soldAt: null,
  isDeleted: false,
  ...overrides
})

class InMemoryResolutionManager {
  constructor() {
    this.rows = new Map()
  }

  #key(orderIdValue, idempotencyKey) {
    return `${orderIdValue}:${idempotencyKey}`
  }

  async createPreparedResolution(data) {
    await Promise.resolve()
    const key = this.#key(data.orderId, data.idempotencyKey)
    if (this.rows.has(key)) {
      const error = new Error('duplicate key')
      error.code = 11000
      throw error
    }
    const row = {
      _id: new mongoose.Types.ObjectId(),
      ...data,
      status: 'prepared',
      completedAt: null,
      finalProductUnits: [],
      finalResult: null,
      sanitizedError: null
    }
    this.rows.set(key, row)
    return { ...row }
  }

  async getByOrderAndIdempotencyKey(orderIdValue, idempotencyKey) {
    const row = this.rows.get(this.#key(orderIdValue, idempotencyKey))
    return row ? { ...row } : null
  }

  async getOrderResolutionHistory(orderIdValue) {
    return [...this.rows.values()]
      .filter((row) => String(row.orderId) === String(orderIdValue))
      .map((row) => ({ ...row }))
  }

  async completePreparedResolution(resolutionId, update) {
    await Promise.resolve()
    const entry = [...this.rows.entries()].find(
      ([, row]) => String(row._id) === String(resolutionId)
    )
    if (!entry || entry[1].status !== 'prepared') return null
    const [key, row] = entry
    const completed = { ...row, ...update, status: 'completed', sanitizedError: null }
    this.rows.set(key, completed)
    return { ...completed }
  }

  async failPreparedResolution(resolutionId, update) {
    await Promise.resolve()
    const entry = [...this.rows.entries()].find(
      ([, row]) => String(row._id) === String(resolutionId)
    )
    if (!entry || entry[1].status !== 'prepared') return null
    const [key, row] = entry
    const failed = { ...row, ...update, status: 'failed' }
    this.rows.set(key, failed)
    return { ...failed }
  }
}

const makePreparedInput = (overrides = {}) => ({
  orderId,
  paymentId,
  idempotencyKey: 'attention-resolution-key-1',
  action: 'complete_existing_reservation_sale',
  originalAttentionReason: 'RESERVATION_EXPIRED',
  actorUserId,
  actorRole: 'ADMIN',
  note: 'Revision administrativa',
  requestedAt: now,
  previousState: {
    orderStatus: 'requires_attention',
    paymentStatus: 'approved',
    fulfillmentStatus: 'pending',
    attentionReason: 'RESERVATION_EXPIRED',
    attentionResolutionVersion: 0
  },
  previousProductUnits: [],
  ...overrides
})

describe('P1C-0 Order attention foundation (isolated)', () => {
  it('defines immutable audit identity and unique Order/idempotency index', () => {
    for (const field of [
      'orderId',
      'paymentId',
      'idempotencyKey',
      'action',
      'originalAttentionReason',
      'actorUserId',
      'actorRole',
      'requestedAt'
    ]) assert.equal(OrderAttentionResolutionModel.schema.path(field).options.immutable, true)

    const uniqueIndex = OrderAttentionResolutionModel.schema.indexes().find(
      ([fields, options]) => fields.orderId === 1 && fields.idempotencyKey === 1 && options.unique
    )
    assert.ok(uniqueIndex)
  })

  it('keeps historical Orders compatible with a safe resolution version default', async () => {
    const order = new OrderModel({
      orderNumber: 'LC-2026-000010',
      userId: actorUserId,
      buyerSnapshot: {
        firstName: 'Ada',
        lastName: 'Lovelace',
        email: 'ada@example.com',
        role: 'USER'
      },
      totals: { totalUsd: '10.00' }
    })

    await order.validate()
    assert.equal(order.attentionResolutionVersion, 0)
    assert.equal(OrderModel.schema.path('attentionResolutionVersion').options.min, 0)
  })

  it('rejects a non-integer attention resolution version', async () => {
    const order = new OrderModel({
      orderNumber: 'LC-2026-000011',
      userId: actorUserId,
      buyerSnapshot: {
        firstName: 'Ada',
        lastName: 'Lovelace',
        email: 'ada@example.com',
        role: 'USER'
      },
      totals: { totalUsd: '10.00' },
      attentionResolutionVersion: 1.5
    })

    await assert.rejects(order.validate(), /version de resolucion debe ser un entero/)
  })

  it('classifies approved payment plus recoverable inventory attention', () => {
    const service = new OrderAttentionService()
    const result = service.buildReadModel({
      order: makeOrder(),
      payment: makePayment(),
      orderItems: [orderItem],
      productUnits: [makeReservedUnit()]
    })

    assert.equal(result.attentionCategory, ATTENTION_CATEGORIES.APPROVED_INVENTORY)
    assert.equal(result.financialRisk, 'approved_money_inventory_unresolved')
    assert.equal(result.reservationIntegrity.valid, true)
    assert.equal(result.allowedActions.canCompleteExistingReservationSale, false)
  })

  it('classifies provider mismatch as a financial inconsistency', () => {
    const result = new OrderAttentionService().buildReadModel({
      order: makeOrder({ attentionReason: 'PAYMENT_PROVIDER_MISMATCH' }),
      payment: makePayment({ normalizedStatus: 'requires_attention' }),
      orderItems: [orderItem],
      productUnits: [makeReservedUnit()]
    })
    assert.equal(result.attentionCategory, ATTENTION_CATEGORIES.FINANCIAL_INCONSISTENCY)
  })

  it('classifies only supported local no-approved-money evidence as terminal unpaid attention', () => {
    const result = new OrderAttentionService().buildReadModel({
      order: makeOrder({ attentionReason: 'RESERVATION_INTEGRITY_CONFLICT' }),
      payment: makePayment({
        normalizedStatus: 'requires_attention',
        providerPaymentId: null,
        approvedAt: null
      }),
      orderItems: [orderItem],
      productUnits: [makeReservedUnit()]
    })
    assert.equal(result.attentionCategory, ATTENTION_CATEGORIES.TERMINAL_UNPAID)
    assert.equal(result.financialRisk, 'unpaid_not_provider_verified')
  })

  it('classifies provider refund attention separately', () => {
    const result = new OrderAttentionService().buildReadModel({
      order: makeOrder({ attentionReason: 'PROVIDER_REFUND_REQUIRES_ATTENTION' }),
      payment: makePayment({ normalizedStatus: 'requires_attention' }),
      orderItems: [orderItem],
      productUnits: [makeReservedUnit()]
    })
    assert.equal(result.attentionCategory, ATTENTION_CATEGORIES.REFUND)
  })

  it('falls closed for an unknown attention reason', () => {
    const result = new OrderAttentionService().buildReadModel({
      order: makeOrder({ attentionReason: 'UNRECOGNIZED_REASON' }),
      payment: makePayment(),
      orderItems: [orderItem],
      productUnits: [makeReservedUnit()]
    })
    assert.equal(result.attentionCategory, ATTENTION_CATEGORIES.UNKNOWN)
    assert.equal(result.financialRisk, 'unknown_fail_closed')
  })

  it('reports reference mismatch and keeps every action disabled', () => {
    const result = new OrderAttentionService().buildReadModel({
      order: makeOrder(),
      payment: makePayment(),
      orderItems: [orderItem],
      productUnits: [makeReservedUnit({ productId: otherOrderId })]
    })
    assert.equal(result.reservationIntegrity.valid, false)
    assert.equal(result.reservationIntegrity.reason, 'RESERVATION_REFERENCE_MISMATCH')
    assert.ok(result.allowedActions.blockers.completeExistingReservationSale.includes(
      'RESERVATION_INTEGRITY_INVALID'
    ))
    assert.equal(Object.values(result.allowedActions).includes(true), false)
  })

  it('reports a unit sold by another Order as invalid integrity', () => {
    const result = new OrderAttentionService().buildReadModel({
      order: makeOrder(),
      payment: makePayment(),
      orderItems: [orderItem],
      productUnits: [makeReservedUnit({ status: 'sold', soldByOrderId: otherOrderId, soldAt: now })]
    })
    assert.equal(result.reservationIntegrity.valid, false)
    assert.equal(result.reservationIntegrity.reason, 'UNIT_SOLD_BY_ANOTHER_ORDER')
  })

  it('deduplicates concurrent preparation by Order and idempotency key', async () => {
    const manager = new InMemoryResolutionManager()
    const service = new OrderAttentionResolutionService({ resolutionManager: manager })
    const results = await Promise.all([
      service.createPreparedResolution(makePreparedInput()),
      service.createPreparedResolution(makePreparedInput())
    ])

    assert.equal(manager.rows.size, 1)
    assert.equal(new Set(results.map((result) => String(result.resolution._id))).size, 1)
    assert.equal(results.filter((result) => result.idempotent).length, 1)
  })

  it('allows different keys for the same Order at persistence foundation level', async () => {
    const manager = new InMemoryResolutionManager()
    const service = new OrderAttentionResolutionService({ resolutionManager: manager })
    await service.createPreparedResolution(makePreparedInput())
    await service.createPreparedResolution(makePreparedInput({ idempotencyKey: 'key-2' }))
    assert.equal(manager.rows.size, 2)
  })

  it('rejects reusing a key for a different logical action', async () => {
    const manager = new InMemoryResolutionManager()
    const service = new OrderAttentionResolutionService({ resolutionManager: manager })
    await service.createPreparedResolution(makePreparedInput())
    await assert.rejects(
      service.createPreparedResolution(makePreparedInput({ action: 'refund' })),
      (error) => error.code === 'ATTENTION_RESOLUTION_IDEMPOTENCY_CONFLICT'
    )
  })

  it('uses CAS so only one concurrent prepared-to-completed transition wins', async () => {
    const manager = new InMemoryResolutionManager()
    const service = new OrderAttentionResolutionService({ resolutionManager: manager })
    const prepared = await service.createPreparedResolution(makePreparedInput())
    const results = await Promise.allSettled([
      service.completePreparedResolution({
        resolutionId: prepared.resolution._id,
        completedAt: now,
        finalResult: { outcome: 'future-test-only' }
      }),
      service.completePreparedResolution({
        resolutionId: prepared.resolution._id,
        completedAt: now,
        finalResult: { outcome: 'future-test-only' }
      })
    ])

    assert.equal(results.filter((result) => result.status === 'fulfilled').length, 1)
    assert.equal(results.filter((result) => result.status === 'rejected').length, 1)
    assert.equal(results.find((result) => result.status === 'rejected').reason.code,
      'ATTENTION_RESOLUTION_STATE_CONFLICT')
  })

  it('persists completion with an exact prepared-state CAS filter', async () => {
    let captured
    const expected = { _id: new mongoose.Types.ObjectId(), status: 'completed' }
    const manager = new OrderAttentionResolutionManager({
      model: {
        findOneAndUpdate(filter, update, options) {
          captured = { filter, update, options }
          return { lean: async () => expected }
        }
      }
    })
    const resolutionId = new mongoose.Types.ObjectId()
    const result = await manager.completePreparedResolution(
      resolutionId,
      {
        completedAt: now,
        providerEvidence: null,
        finalProductUnits: [],
        finalResult: { outcome: 'test' }
      }
    )

    assert.deepEqual(captured.filter, { _id: resolutionId, status: 'prepared' })
    assert.equal(captured.update.$set.status, 'completed')
    assert.equal(captured.options.runValidators, true)
    assert.equal(result, expected)
  })

  it('does not return completed resolutions to prepared on idempotent retry', async () => {
    const manager = new InMemoryResolutionManager()
    const service = new OrderAttentionResolutionService({ resolutionManager: manager })
    const prepared = await service.createPreparedResolution(makePreparedInput())
    await service.completePreparedResolution({ resolutionId: prepared.resolution._id })
    const retry = await service.createPreparedResolution(makePreparedInput())
    assert.equal(retry.idempotent, true)
    assert.equal(retry.resolution.status, 'completed')
  })

  it('retains failed resolutions and their sanitized audit error', async () => {
    const manager = new InMemoryResolutionManager()
    const service = new OrderAttentionResolutionService({ resolutionManager: manager })
    const prepared = await service.createPreparedResolution(makePreparedInput())
    await service.failPreparedResolution({
      resolutionId: prepared.resolution._id,
      sanitizedError: { code: 'SAFE_CODE', message: 'Safe diagnostic' }
    })

    const history = await manager.getOrderResolutionHistory(orderId)
    assert.equal(history.length, 1)
    assert.equal(history[0].status, 'failed')
    assert.deepEqual(history[0].sanitizedError, {
      code: 'SAFE_CODE',
      message: 'Safe diagnostic'
    })
  })
})
