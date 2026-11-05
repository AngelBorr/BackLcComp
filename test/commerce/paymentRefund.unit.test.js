/* eslint-env mocha */
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import mongoose from 'mongoose'
import PaymentRefundModel from '../../src/dao/models/paymentRefund.model.js'
import OrderModel from '../../src/dao/models/order.model.js'
import {
  classifyRefundEvidence,
  classifyRefundPreflight,
  REFUND_PREFLIGHT_OUTCOMES,
  REFUND_RECONCILIATION_OUTCOMES
} from '../../src/services/mercadoPagoRefundClassification.service.js'
import { PaymentRefundReconciliationService } from '../../src/services/paymentRefundReconciliation.service.js'
import { PaymentRefundService } from '../../src/services/paymentRefund.service.js'
import { MercadoPagoProviderError } from '../../src/providers/mercadoPago.provider.js'
import { PaymentRefundController } from '../../src/controllers/paymentRefund.controller.js'

const orderId = new mongoose.Types.ObjectId()
const paymentId = new mongoose.Types.ObjectId()
const refundId = new mongoose.Types.ObjectId()
const adminId = new mongoose.Types.ObjectId()
const now = new Date('2026-11-03T12:00:00.000Z')
const providerOrderId = 'ORD01REFUNDLCOMPTEST'
const providerPaymentId = 'PAY01REFUNDLCOMPTEST'

const providerOrder = (overrides = {}) => ({
  providerOrderId,
  status: 'refunded',
  statusDetail: 'refunded',
  externalReference: 'LC-2026-000100',
  totalAmount: '150000.00',
  totalPaidAmount: '150000.00',
  totalRefundedAmount: '150000.00',
  currency: 'ARS',
  payments: [{
    providerPaymentId,
    status: 'processed',
    statusDetail: 'accredited',
    amount: '150000.00',
    paidAmount: '150000.00'
  }],
  refunds: [{
    providerRefundId: 'REF01REFUNDLCOMPTEST',
    providerPaymentId,
    amount: '150000.00',
    status: 'processed',
    statusDetail: 'refunded'
  }],
  reconciliationSource: {
    totalPaidAmountPresent: true,
    totalRefundedAmountPresent: true,
    transactionsPresent: true,
    paymentsPresent: true,
    paymentsIsArray: true,
    refundsPresent: true,
    refundsIsArray: true
  },
  ...overrides
})

const cleanPreflightOrder = (overrides = {}) => ({
  ...providerOrder({
    status: 'processed',
    statusDetail: 'accredited',
    refunds: undefined,
    reconciliationSource: {
      totalPaidAmountPresent: true,
      totalRefundedAmountPresent: false,
      transactionsPresent: true,
      paymentsPresent: true,
      paymentsIsArray: true,
      refundsPresent: false,
      refundsIsArray: false
    }
  }),
  ...overrides
})

const expected = {
  providerOrderId,
  providerPaymentId,
  externalReference: 'LC-2026-000100',
  amount: '150000.00',
  currency: 'ARS'
}

const fakeMongoose = {
  async startSession() {
    return {
      async withTransaction(callback) { await callback() },
      async endSession() {}
    }
  }
}

const makePreflightRecoveryHarness = ({ refundOverrides = {}, remoteOrder } = {}) => {
  const orderNumber = 'LC-2026-000100'
  const idempotencyKey = 'refund-admin-key-0001'
  const note = 'same request'
  const requestHash = createHash('sha256').update(JSON.stringify({
    orderNumber,
    orderId: String(orderId),
    type: 'total',
    reasonCode: 'customer_request',
    note
  })).digest('hex')
  const order = {
    _id: orderId,
    orderNumber,
    status: 'paid',
    activeRefundId: refundId,
    paymentCurrency: 'ARS',
    totals: { totalArs: '150000.00' }
  }
  const payment = {
    _id: paymentId,
    orderId,
    normalizedStatus: 'approved',
    approvedAt: now,
    provider: 'mercado_pago',
    providerOrderId,
    providerPaymentId,
    amountArs: '150000.00',
    currency: 'ARS'
  }
  const refund = {
    _id: refundId,
    orderId,
    paymentId,
    type: 'total',
    status: 'requires_attention',
    version: 2,
    operationScope: 'total_refund',
    providerOrderId,
    providerPaymentId,
    providerIdempotencyKey: `refund-${refundId}`,
    idempotencyKey,
    requestHash,
    requestedAmountArs: '150000.00',
    confirmedAmountArs: null,
    currency: 'ARS',
    origin: 'admin',
    submittedAt: null,
    providerRefundId: null,
    providerStatus: null,
    providerStatusDetail: null,
    providerEvidenceSnapshot: null,
    attemptOwnerToken: null,
    attemptLeaseUntil: null,
    providerRequestSnapshot: {
      method: 'POST',
      path: `/v1/orders/${providerOrderId}/refund`,
      body: null,
      providerOrderId,
      externalReference: orderNumber,
      totalAmount: '150000.00',
      currency: 'ARS'
    },
    sanitizedError: {
      code: 'REFUND_PREFLIGHT_MISMATCH',
      message: 'La evidencia financiera remota no habilita un reembolso',
      providerCode: null
    },
    requestedAt: now,
    reasonCode: 'customer_request',
    note,
    ...refundOverrides
  }
  const calls = {
    create: 0,
    recover: 0,
    providerGet: 0,
    providerPost: 0,
    reconcile: 0,
    providerKeys: []
  }
  const refunds = {
    async getByOrderAndIdempotencyKey() { return refund },
    async getById() { return refund },
    async create() { calls.create += 1 },
    async recoverPreSubmissionFailure(id, expected) {
      calls.recover += 1
      assert.equal(String(id), String(refundId))
      assert.equal(expected.expectedVersion, refund.version)
      assert.equal(expected.providerIdempotencyKey, refund.providerIdempotencyKey)
      Object.assign(refund, { status: 'prepared', sanitizedError: null, version: refund.version + 1 })
      return refund
    },
    async transition(id, statuses, update) {
      assert.equal(statuses.includes(refund.status), true)
      Object.assign(refund, update, { version: refund.version + 1 })
      return refund
    }
  }
  const service = new PaymentRefundService({
    mongooseInstance: fakeMongoose,
    orderManager: {
      async getByOrderNumber() { return order },
      async getById() { return order }
    },
    paymentManager: {
      async getLatestByOrderId() { return payment },
      async getById() { return payment }
    },
    paymentRefundManager: refunds,
    provider: {
      async getOrder() {
        calls.providerGet += 1
        return remoteOrder || cleanPreflightOrder()
      },
      async refundOrder(id, { idempotencyKey: key }) {
        calls.providerPost += 1
        calls.providerKeys.push(key)
      }
    },
    reconciliationService: {
      async reconcileRefund() {
        calls.reconcile += 1
        return {
          refund: { ...refund, status: 'processing' },
          outcome: 'processing'
        }
      }
    }
  })
  const request = {
    orderNumber,
    idempotencyKey,
    body: { type: 'total', reasonCode: 'customer_request', note },
    adminUserId: adminId,
    adminRole: 'ADMIN'
  }
  return { service, request, order, payment, refund, calls }
}

describe('P1C-C1 total refund domain (isolated)', () => {
  it('declares auditable Refund states, exact unique fences and refunded Order state', () => {
    assert.equal(OrderModel.schema.path('status').enumValues.includes('refunded'), true)
    assert.equal(OrderModel.schema.path('refundedAt').instance, 'Date')
    assert.equal(OrderModel.schema.path('activeRefundId').options.ref, 'payment_refunds')
    assert.deepEqual(PaymentRefundModel.schema.path('status').enumValues, [
      'prepared', 'submitted', 'processing', 'succeeded', 'rejected', 'requires_attention'
    ])
    const indexes = PaymentRefundModel.schema.indexes()
    assert.equal(indexes.some(([keys, options]) =>
      keys.orderId === 1 && keys.idempotencyKey === 1 && options.unique === true
    ), true)
    assert.equal(indexes.some(([keys, options]) =>
      keys.paymentId === 1 && keys.operationScope === 1 && options.unique === true
    ), true)
  })

  it('accepts only exact full-refund evidence as succeeded', () => {
    const result = classifyRefundEvidence(providerOrder(), expected)
    assert.equal(result.outcome, REFUND_RECONCILIATION_OUTCOMES.SUCCEEDED)
    assert.equal(result.refund.providerRefundId, 'REF01REFUNDLCOMPTEST')
  })

  for (const [name, mutate, reason] of [
    ['amount mismatch', { refunds: [{ ...providerOrder().refunds[0], amount: '149999.99' }] }, 'PROVIDER_REFUND_AMOUNT_MISMATCH'],
    ['currency mismatch', { currency: 'USD' }, 'CURRENCY_MISMATCH'],
    ['external reference mismatch', { externalReference: 'LC-2026-999999' }, 'EXTERNAL_REFERENCE_MISMATCH'],
    ['payment transaction mismatch', { payments: [{ ...providerOrder().payments[0], providerPaymentId: 'PAY-OTHER' }] }, 'PROVIDER_PAYMENT_ID_MISMATCH'],
    ['partial/multiple refunds', { refunds: [providerOrder().refunds[0], { ...providerOrder().refunds[0], providerRefundId: 'REF-2' }] }, 'PROVIDER_REFUND_CARDINALITY_MISMATCH']
  ]) {
    it(`fails closed for ${name}`, () => {
      const result = classifyRefundEvidence(providerOrder(mutate), expected)
      assert.equal(result.outcome, REFUND_RECONCILIATION_OUTCOMES.REQUIRES_ATTENTION)
      assert.equal(result.reason, reason)
    })
  }

  it('distinguishes absent refund provenance from an explicit empty array', () => {
    const absent = classifyRefundEvidence(providerOrder({
      refunds: undefined,
      reconciliationSource: {
        totalPaidAmountPresent: true,
        transactionsPresent: true,
        paymentsPresent: true,
        paymentsIsArray: true,
        refundsPresent: false,
        refundsIsArray: false,
        totalRefundedAmountPresent: false
      }
    }), expected)
    const empty = classifyRefundEvidence(providerOrder({
      status: 'processed',
      statusDetail: 'accredited',
      totalRefundedAmount: '0.00',
      refunds: []
    }), expected)
    assert.equal(absent.outcome, REFUND_RECONCILIATION_OUTCOMES.REQUIRES_ATTENTION)
    assert.equal(empty.outcome, REFUND_RECONCILIATION_OUTCOMES.NOT_OBSERVED)
  })

  it('accepts the real clean preflight with omitted refunds and total refunded amount', () => {
    const result = classifyRefundPreflight(cleanPreflightOrder(), expected)
    assert.equal(result.outcome, REFUND_PREFLIGHT_OUTCOMES.VALID)
  })

  it('accepts an explicit empty refunds array in the clean preflight', () => {
    const result = classifyRefundPreflight(cleanPreflightOrder({
      refunds: [],
      reconciliationSource: {
        ...cleanPreflightOrder().reconciliationSource,
        refundsPresent: true,
        refundsIsArray: true
      }
    }), expected)
    assert.equal(result.outcome, REFUND_PREFLIGHT_OUTCOMES.VALID)
  })

  for (const [name, overrides, reason] of [
    ['refunded order status', { status: 'refunded' }, 'PROVIDER_ORDER_NOT_ACCREDITED'],
    ['partially refunded detail', { statusDetail: 'partially_refunded' }, 'PROVIDER_ORDER_NOT_ACCREDITED'],
    ['payment identity mismatch', {
      payments: [{ ...cleanPreflightOrder().payments[0], providerPaymentId: 'PAY-OTHER' }]
    }, 'PROVIDER_PAYMENT_ID_MISMATCH'],
    ['payment amount mismatch', {
      payments: [{ ...cleanPreflightOrder().payments[0], amount: '149999.99' }]
    }, 'PROVIDER_PAYMENT_AMOUNT_MISMATCH'],
    ['currency mismatch', { currency: 'USD' }, 'CURRENCY_MISMATCH'],
    ['omitted total paid amount', {
      totalPaidAmount: undefined,
      reconciliationSource: {
        ...cleanPreflightOrder().reconciliationSource,
        totalPaidAmountPresent: false
      }
    }, 'PROVIDER_PAYMENT_PROVENANCE_MISSING'],
    ['different total paid amount', { totalPaidAmount: '149999.99' }, 'TOTAL_PAID_AMOUNT_MISMATCH']
  ]) {
    it(`rejects omitted-refunds preflight with ${name}`, () => {
      const result = classifyRefundPreflight(cleanPreflightOrder(overrides), expected)
      assert.equal(result.outcome, REFUND_PREFLIGHT_OUTCOMES.REQUIRES_ATTENTION)
      assert.equal(result.reason, reason)
    })
  }

  it('detects a prior remote refund and does not authorize another POST', () => {
    const result = classifyRefundPreflight(cleanPreflightOrder({
      refunds: [providerOrder().refunds[0]],
      reconciliationSource: {
        ...cleanPreflightOrder().reconciliationSource,
        refundsPresent: true,
        refundsIsArray: true
      }
    }), expected)
    assert.equal(result.outcome, REFUND_PREFLIGHT_OUTCOMES.REMOTE_REFUND_OBSERVED)
  })

  it('recovers the same preflight-only Refund with the same provider key and no duplicate', async () => {
    const harness = makePreflightRecoveryHarness()
    const originalRefundId = String(harness.refund._id)
    const originalProviderKey = harness.refund.providerIdempotencyKey

    const result = await harness.service.requestTotalRefund(harness.request, { now })

    assert.equal(result.refundId, originalRefundId)
    assert.equal(harness.calls.create, 0)
    assert.equal(harness.calls.recover, 1)
    assert.equal(harness.calls.providerPost, 1)
    assert.deepEqual(harness.calls.providerKeys, [originalProviderKey])
    assert.equal(harness.order.activeRefundId, refundId)
  })

  it('does not recover or POST when the same Refund now observes a prior remote refund', async () => {
    const harness = makePreflightRecoveryHarness({
      remoteOrder: providerOrder()
    })

    const result = await harness.service.requestTotalRefund(harness.request, { now })

    assert.equal(result.status, 'processing')
    assert.equal(harness.calls.recover, 0)
    assert.equal(harness.calls.providerPost, 0)
    assert.equal(harness.calls.reconcile, 1)
  })

  for (const [name, refundOverrides] of [
    ['submittedAt present', { submittedAt: now }],
    ['providerRefundId present', { providerRefundId: 'REF-ALREADY-SUBMITTED' }],
    ['financial mismatch attention', {
      sanitizedError: {
        code: 'REFUND_PREFLIGHT_MISMATCH',
        message: 'La evidencia financiera remota no habilita un reembolso',
        providerCode: 'PROVIDER_PAYMENT_AMOUNT_MISMATCH'
      }
    }]
  ]) {
    it(`does not reopen requires_attention with ${name}`, async () => {
      const harness = makePreflightRecoveryHarness({ refundOverrides })

      await harness.service.requestTotalRefund(harness.request, { now })

      assert.equal(harness.calls.recover, 0)
      assert.equal(harness.calls.providerGet, 0)
      assert.equal(harness.calls.providerPost, 0)
      assert.equal(harness.calls.reconcile, 1)
    })
  }

  it('keeps processing and definitive rejection distinct', () => {
    const processing = classifyRefundEvidence(providerOrder({
      status: 'processed',
      statusDetail: 'accredited',
      refunds: [{ ...providerOrder().refunds[0], status: 'processing' }]
    }), expected)
    const rejected = classifyRefundEvidence(providerOrder({
      status: 'processed',
      statusDetail: 'accredited',
      refunds: [{ ...providerOrder().refunds[0], status: 'rejected' }]
    }), expected)
    assert.equal(processing.outcome, REFUND_RECONCILIATION_OUTCOMES.PROCESSING)
    assert.equal(rejected.outcome, REFUND_RECONCILIATION_OUTCOMES.REJECTED_DEFINITIVE)
  })

  it('finalizes Payment, Order, fulfillment and Refund in one transaction without inventory calls', async () => {
    const calls = []
    const refund = {
      _id: refundId,
      orderId,
      paymentId,
      status: 'processing',
      version: 3,
      operationScope: 'total_refund',
      requestedAmountArs: '150000.00',
      providerOrderId,
      providerPaymentId
    }
    const payment = {
      _id: paymentId,
      orderId,
      provider: 'mercado_pago',
      normalizedStatus: 'approved',
      approvedAt: now,
      providerOrderId,
      providerPaymentId,
      amountArs: '150000.00',
      currency: 'ARS'
    }
    const order = {
      _id: orderId,
      orderNumber: 'LC-2026-000100',
      status: 'paid',
      activeRefundId: refundId,
      fulfillmentStatus: 'ready_for_pickup'
    }
    const service = new PaymentRefundReconciliationService({
      mongooseInstance: fakeMongoose,
      paymentRefundManager: {
        async getById() { return refund },
        async finalizeSucceeded(id, input) {
          calls.push(['refund', id, input])
          return { ...refund, status: 'succeeded', providerRefundId: input.providerRefundId }
        }
      },
      paymentManager: {
        async getById() { return payment },
        async finalizeTotalRefund(id, input) {
          calls.push(['payment', id, input])
          return { ...payment, normalizedStatus: 'refunded' }
        }
      },
      orderManager: {
        async getById() { return order },
        async finalizeTotalRefund(id, idRefund, input) {
          calls.push(['order', id, idRefund, input])
          return { ...order, status: 'refunded', fulfillmentStatus: 'cancelled' }
        }
      }
    })

    const result = await service.reconcileRefund(refundId, { now, providerOrder: providerOrder() })
    assert.equal(result.outcome, 'succeeded')
    assert.deepEqual(calls.map(([kind]) => kind), ['payment', 'order', 'refund'])
    assert.equal(calls[1][3].expectedFulfillmentStatus, 'ready_for_pickup')
    assert.equal(calls[2][2].expectedVersion, 3)
  })

  it('records and finalizes an exact provider-observed refund without fake admin keys', async () => {
    let observedRefund = null
    const payment = {
      _id: paymentId,
      orderId,
      provider: 'mercado_pago',
      normalizedStatus: 'approved',
      approvedAt: now,
      providerOrderId,
      providerPaymentId,
      amountArs: '150000.00',
      currency: 'ARS'
    }
    const order = {
      _id: orderId,
      orderNumber: 'LC-2026-000100',
      status: 'paid',
      activeRefundId: null,
      paidAt: now,
      fulfillmentStatus: 'preparing'
    }
    const refunds = {
      async getActiveByProviderOrderId() { return observedRefund },
      async create(data) {
        observedRefund = { ...data, version: 0 }
        return observedRefund
      },
      async getById() { return observedRefund },
      async finalizeSucceeded(id, input) {
        observedRefund = {
          ...observedRefund,
          status: 'succeeded',
          providerRefundId: input.providerRefundId,
          confirmedAmountArs: input.confirmedAmountArs
        }
        return observedRefund
      }
    }
    const service = new PaymentRefundReconciliationService({
      mongooseInstance: fakeMongoose,
      paymentRefundManager: refunds,
      paymentManager: {
        async getByProviderOrderId() { return payment },
        async getById() { return payment },
        async finalizeTotalRefund() { return { ...payment, normalizedStatus: 'refunded' } }
      },
      orderManager: {
        async getById() { return order },
        async attachActiveRefund(id, idRefund) {
          order.activeRefundId = idRefund
          return order
        },
        async finalizeTotalRefund() { return { ...order, status: 'refunded' } }
      }
    })

    const result = await service.reconcileProviderOrder(providerOrder(), { now })
    assert.equal(result.handled, true)
    assert.equal(result.outcome, 'succeeded')
    assert.equal(observedRefund.origin, 'provider_observed')
    assert.equal(observedRefund.idempotencyKey, null)
    assert.equal(observedRefund.providerIdempotencyKey, null)
    assert.equal(observedRefund.status, 'succeeded')
  })

  it('rejects partial/amount input before any local or provider call', async () => {
    let orderCalls = 0
    const service = new PaymentRefundService({
      mongooseInstance: fakeMongoose,
      orderManager: { async getByOrderNumber() { orderCalls += 1 } }
    })
    await assert.rejects(
      service.requestTotalRefund({
        orderNumber: 'LC-2026-000100',
        idempotencyKey: 'refund-admin-key-0001',
        body: { type: 'total', reasonCode: 'customer_request', amount: '1.00' },
        adminUserId: adminId,
        adminRole: 'ADMIN'
      }),
      (error) => error.code === 'REFUND_REQUEST_FIELDS_INVALID'
    )
    assert.equal(orderCalls, 0)
  })

  for (const role of ['USER', 'PREMIUM']) {
    it(`rejects ${role} before invoking the refund service`, async () => {
      let calls = 0
      const controller = new PaymentRefundController({
        paymentRefundService: {
          async requestTotalRefund() { calls += 1 }
        }
      })
      const error = await new Promise((resolve) => {
        controller.create(
          {
            user: { id: adminId.toString(), role },
            params: { orderNumber: 'LC-2026-000100' },
            body: { type: 'total', reasonCode: 'customer_request' },
            get() { return 'refund-admin-key-0001' }
          },
          { status() { throw new Error('response must not be written') } },
          resolve
        )
      })
      assert.equal(error.code, 'ORDERS_ADMIN_FORBIDDEN')
      assert.equal(error.status, 403)
      assert.equal(calls, 0)
    })
  }

  it('returns the same terminal Refund for the same key/hash and rejects hash reuse', async () => {
    const orderNumber = 'LC-2026-000100'
    const idempotencyKey = 'refund-admin-key-0001'
    const requestHash = createHash('sha256').update(JSON.stringify({
      orderNumber,
      orderId: String(orderId),
      type: 'total',
      reasonCode: 'customer_request',
      note: 'same request'
    })).digest('hex')
    const terminalRefund = {
      _id: refundId,
      orderId,
      paymentId,
      type: 'total',
      status: 'succeeded',
      requestHash,
      requestedAmountArs: '150000.00',
      confirmedAmountArs: '150000.00',
      currency: 'ARS',
      origin: 'admin',
      reasonCode: 'customer_request',
      note: 'same request',
      requestedAt: now,
      completedAt: now
    }
    let providerCalls = 0
    const service = new PaymentRefundService({
      mongooseInstance: fakeMongoose,
      orderManager: {
        async getByOrderNumber() {
          return { _id: orderId, orderNumber, status: 'refunded' }
        }
      },
      paymentManager: { async getLatestByOrderId() { return null } },
      paymentRefundManager: {
        async getByOrderAndIdempotencyKey() { return terminalRefund }
      },
      provider: { async getOrder() { providerCalls += 1 } }
    })
    const base = {
      orderNumber,
      idempotencyKey,
      body: { type: 'total', reasonCode: 'customer_request', note: 'same request' },
      adminUserId: adminId,
      adminRole: 'ADMIN'
    }
    const result = await service.requestTotalRefund(base, { now })
    assert.equal(result.refundId, String(refundId))
    assert.equal(result.idempotent, true)
    assert.equal(providerCalls, 0)

    await assert.rejects(
      service.requestTotalRefund({
        ...base,
        body: { ...base.body, note: 'different request' }
      }, { now }),
      (error) => error.code === 'REFUND_IDEMPOTENCY_CONFLICT'
    )
    assert.equal(providerCalls, 0)
  })

  it('keeps timeout non-terminal and never rotates the persisted provider key', async () => {
    const refund = {
      _id: refundId,
      orderId,
      paymentId,
      status: 'prepared',
      version: 0,
      operationScope: 'total_refund',
      providerOrderId,
      providerPaymentId,
      providerIdempotencyKey: `refund-${refundId}`,
      requestedAmountArs: '150000.00',
      currency: 'ARS'
    }
    const order = {
      _id: orderId,
      orderNumber: 'LC-2026-000100',
      status: 'paid',
      activeRefundId: null,
      paymentCurrency: 'ARS',
      totals: { totalArs: '150000.00' }
    }
    const payment = {
      _id: paymentId,
      orderId,
      normalizedStatus: 'approved',
      approvedAt: now,
      provider: 'mercado_pago',
      providerOrderId,
      providerPaymentId,
      amountArs: '150000.00',
      currency: 'ARS'
    }
    const transitions = []
    const keys = []
    const service = new PaymentRefundService({
      mongooseInstance: fakeMongoose,
      orderManager: {
        async getByOrderNumber() { return order },
        async getById() { return order },
        async attachActiveRefund(id, idRefund) {
          order.activeRefundId = idRefund
          return order
        },
        async clearActiveRefund() { return order }
      },
      paymentManager: {
        async getLatestByOrderId() { return payment },
        async getById() { return payment }
      },
      paymentRefundManager: {
        async getByOrderAndIdempotencyKey() { return null },
        async getActiveByPaymentId() { return null },
        async create(data) {
          Object.assign(refund, data)
          return refund
        },
        async getById() { return refund },
        async transition(id, statuses, update) {
          transitions.push(update.status)
          Object.assign(refund, update)
          return refund
        }
      },
      provider: {
        async getOrder() {
          return cleanPreflightOrder({
            refunds: [],
            reconciliationSource: {
              ...cleanPreflightOrder().reconciliationSource,
              refundsPresent: true,
              refundsIsArray: true
            }
          })
        },
        async refundOrder(id, { idempotencyKey }) {
          keys.push(idempotencyKey)
          throw new MercadoPagoProviderError(
            'timeout', 'MERCADOPAGO_TIMEOUT', 504, { failureKind: 'timeout' }
          )
        }
      },
      reconciliationService: { async reconcileRefund() { throw new Error('still uncertain') } }
    })

    await assert.rejects(
      service.requestTotalRefund({
        orderNumber: order.orderNumber,
        idempotencyKey: 'refund-admin-key-0001',
        body: { type: 'total', reasonCode: 'customer_request', note: '' },
        adminUserId: adminId,
        adminRole: 'ADMIN'
      }, { now }),
      (error) => error.code === 'MERCADOPAGO_TIMEOUT'
    )
    assert.deepEqual(keys, [refund.providerIdempotencyKey])
    assert.deepEqual(transitions, ['submitted', 'processing'])
    assert.equal(refund.status, 'processing')
  })
})
