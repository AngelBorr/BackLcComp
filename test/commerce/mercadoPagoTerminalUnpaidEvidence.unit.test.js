/* eslint-env mocha */
import assert from 'node:assert/strict'
import { MercadoPagoProviderError } from '../../src/providers/mercadoPago.provider.js'
import {
  MercadoPagoTerminalUnpaidEvidenceService,
  ORDERS_API_TERMINAL_UNPAID,
  OWN_CANCELLATION_TERMINAL_UNPAID
} from '../../src/services/mercadoPagoTerminalUnpaidEvidence.service.js'

const observedAt = new Date('2026-11-02T18:00:00.000Z')
const payableObservedAt = new Date('2026-11-02T15:00:00.000Z')
const attemptedAt = new Date('2026-11-02T15:05:00.000Z')
const completedAt = new Date('2026-11-02T15:06:00.000Z')

const typeAOrder = (overrides = {}) => ({
  providerOrderId: 'ORD-P1CD-001',
  status: 'canceled',
  statusDetail: 'canceled',
  externalReference: 'LC-2026-000010',
  totalAmount: '20497.40',
  totalPaidAmount: '0',
  currency: 'ARS',
  lastUpdatedDate: '2026-11-02T17:59:00.000Z',
  payments: [],
  reconciliationSource: {
    totalPaidAmountPresent: true,
    transactionsPresent: true,
    paymentsPresent: true,
    paymentsIsArray: true
  },
  ...overrides
})

const typeBOrder = (overrides = {}) => typeAOrder({
  totalPaidAmount: null,
  payments: [],
  reconciliationSource: {
    totalPaidAmountPresent: false,
    transactionsPresent: false,
    paymentsPresent: false,
    paymentsIsArray: false
  },
  ...overrides
})

const localPayment = (overrides = {}) => ({
  provider: 'mercado_pago',
  normalizedStatus: 'requires_attention',
  providerOrderId: 'ORD-P1CD-001',
  providerPaymentId: null,
  externalReference: 'LC-2026-000010',
  amountArs: '20497.40',
  currency: 'ARS',
  approvedAt: null,
  providerCancellationPayableStatus: 'created',
  providerCancellationPayableObservedAt: payableObservedAt,
  providerCancellationIdempotencyKey: 'cancel-P1CD-001',
  providerCancellationAttemptedAt: attemptedAt,
  providerCancellationStatus: 'succeeded',
  providerCancellationCompletedAt: completedAt,
  ...overrides
})

const searchPage = (results = [], overrides = {}) => ({
  paging: { total: results.length, offset: 0, limit: 50 },
  results,
  ...overrides
})

const terminalPayment = (overrides = {}) => ({
  id: 123456,
  status: 'rejected',
  status_detail: 'cc_rejected_other_reason',
  external_reference: 'LC-2026-000010',
  transaction_amount: 20497.4,
  transaction_details: { total_paid_amount: 0 },
  currency_id: 'ARS',
  transaction_amount_refunded: 0,
  refunds: [],
  point_of_interaction: {
    references: [{ id: 'ORD-P1CD-001', type: 'ORDER_MP' }]
  },
  ...overrides
})

const makeService = ({ orders, search = searchPage(), payments = {}, error } = {}) => {
  const orderQueue = [...(orders || [typeAOrder(), typeAOrder()])]
  const calls = { orders: 0, searches: [], payments: [] }
  const provider = {
    async getOrder() {
      calls.orders += 1
      if (error) throw error
      return structuredClone(orderQueue.shift())
    },
    async searchPayments(input) {
      calls.searches.push(input)
      if (error) throw error
      return structuredClone(search)
    },
    async getPaymentById(id) {
      calls.payments.push(id)
      if (error) throw error
      return structuredClone(payments[id])
    }
  }
  return {
    calls,
    service: new MercadoPagoTerminalUnpaidEvidenceService({
      provider,
      clock: () => observedAt
    })
  }
}

const input = (payment = localPayment()) => ({
  orderNumber: 'LC-2026-000010',
  providerOrderId: 'ORD-P1CD-001',
  totalArs: '20497.40',
  currency: 'ARS',
  payment
})

const rejectsEvidence = async (operation) => {
  await assert.rejects(
    operation,
    (error) => error?.code === 'ATTENTION_TERMINAL_UNPAID_EVIDENCE_MISMATCH'
  )
}

describe('P1C-D Mercado Pago terminal-unpaid evidence (isolated)', () => {
  it('accepts Type A only with explicit zero provenance and a final Order GET', async () => {
    const { service, calls } = makeService()
    const evidence = await service.getEvidence(input())

    assert.equal(evidence.evidenceSource, ORDERS_API_TERMINAL_UNPAID)
    assert.equal(evidence.totalPaidAmount, '0')
    assert.equal(evidence.totalPaidAmountPresent, true)
    assert.equal(evidence.transactionsPresent, true)
    assert.equal(evidence.paymentsPresent, true)
    assert.equal(evidence.paymentsIsArray, true)
    assert.deepEqual(evidence.payments, [])
    assert.equal(evidence.paymentsSearch.total, 0)
    assert.equal(calls.orders, 2)
    assert.equal(calls.searches[0].status, null)
  })

  it('preserves explicit null plus explicit empty payments as valid Type A', async () => {
    const order = typeAOrder({ totalPaidAmount: null })
    const { service } = makeService({ orders: [order, order] })
    const evidence = await service.getEvidence(input())
    assert.equal(evidence.evidenceSource, ORDERS_API_TERMINAL_UNPAID)
    assert.equal(evidence.totalPaidAmount, null)
    assert.deepEqual(evidence.payments, [])
  })

  it('accepts Type B only with the complete own-cancellation chain', async () => {
    const order = typeBOrder()
    const { service } = makeService({ orders: [order, order] })
    const evidence = await service.getEvidence(input())

    assert.equal(evidence.evidenceSource, OWN_CANCELLATION_TERMINAL_UNPAID)
    assert.equal(evidence.totalPaidAmountPresent, false)
    assert.equal(evidence.transactionsPresent, false)
    assert.equal(evidence.paymentsPresent, false)
    assert.equal(evidence.paymentsIsArray, false)
    assert.equal(evidence.payments, undefined)
    assert.equal(evidence.providerCancellationIdempotencyKey, 'cancel-P1CD-001')
  })

  it('accepts an uncertain own cancellation only while completedAt remains absent', async () => {
    const order = typeBOrder()
    const { service } = makeService({ orders: [order, order] })
    const evidence = await service.getEvidence(input(localPayment({
      providerCancellationStatus: 'uncertain',
      providerCancellationCompletedAt: null
    })))
    assert.equal(evidence.evidenceSource, OWN_CANCELLATION_TERMINAL_UNPAID)
    assert.equal(evidence.providerCancellationStatus, 'uncertain')
    assert.equal(evidence.providerCancellationCompletedAt, null)
  })

  it('accepts explicit zero Type A with a fully terminal child payment', async () => {
    const order = typeAOrder({
      payments: [{
        providerPaymentId: '123456',
        status: 'rejected',
        statusDetail: 'cc_rejected_other_reason',
        amount: '20497.40',
        paidAmount: '0'
      }]
    })
    const { service } = makeService({
      orders: [order, order],
      search: searchPage([{ id: 123456 }]),
      payments: { 123456: terminalPayment() }
    })
    const evidence = await service.getEvidence(input())
    assert.equal(evidence.paymentCount, 1)
    assert.equal(evidence.payments[0].status, 'rejected')
    assert.equal(evidence.paymentsSearch.inspectedCount, 1)
  })

  for (const [name, change] of [
    ['LC000007 missing PAYABLE status', { providerCancellationPayableStatus: null }],
    ['LC000007 missing PAYABLE observation', { providerCancellationPayableObservedAt: null }],
    ['missing cancellation key', { providerCancellationIdempotencyKey: null }],
    ['PAYABLE observed after attempt', {
      providerCancellationPayableObservedAt: new Date('2026-11-02T15:06:00.000Z')
    }],
    ['prepared cancellation', { providerCancellationStatus: 'prepared' }],
    ['rejected cancellation', { providerCancellationStatus: 'rejected' }],
    ['succeeded without completion', {
      providerCancellationStatus: 'succeeded',
      providerCancellationCompletedAt: null
    }]
  ]) {
    it(`fails closed for omitted aggregates with ${name}`, async () => {
      const order = typeBOrder()
      const { service } = makeService({ orders: [order, order] })
      await rejectsEvidence(service.getEvidence(input(localPayment(change))))
    })
  }

  it('treats an empty Payments search only as no veto, never as positive evidence', async () => {
    const order = typeBOrder()
    const { service } = makeService({ orders: [order, order] })
    await rejectsEvidence(service.getEvidence(input(localPayment({
      providerCancellationPayableStatus: null,
      providerCancellationPayableObservedAt: null
    }))))
  })

  it('reproduces LC-2026-000007 and rejects omitted aggregates without PAYABLE metadata', async () => {
    const order = typeBOrder({ externalReference: 'LC-2026-000007' })
    const payment = localPayment({
      externalReference: 'LC-2026-000007',
      providerCancellationPayableStatus: null,
      providerCancellationPayableObservedAt: null
    })
    const { service } = makeService({ orders: [order, order] })
    await rejectsEvidence(service.getEvidence({
      orderNumber: 'LC-2026-000007',
      providerOrderId: 'ORD-P1CD-001',
      totalArs: '20497.40',
      currency: 'ARS',
      payment
    }))
  })

  it('inspects every Payments result and accepts only explicit terminal-unpaid payments', async () => {
    const search = searchPage([{ id: 123456 }])
    const { service, calls } = makeService({
      search,
      payments: { 123456: terminalPayment() }
    })
    const evidence = await service.getEvidence(input())
    assert.equal(evidence.paymentsSearch.inspectedCount, 1)
    assert.deepEqual(calls.payments, ['123456'])
  })

  it('paginates exhaustively and GETs every unique Payment before the final Order', async () => {
    const calls = []
    const provider = {
      async getOrder() {
        calls.push('order')
        return typeAOrder()
      },
      async searchPayments({ offset }) {
        calls.push(`search:${offset}`)
        return offset === 0
          ? {
              paging: { total: 3, offset: 0, limit: 2 },
              results: [{ id: 1 }, { id: 2 }]
            }
          : {
              paging: { total: 3, offset: 2, limit: 2 },
              results: [{ id: 3 }]
            }
      },
      async getPaymentById(id) {
        calls.push(`payment:${id}`)
        return terminalPayment({ id: Number(id) })
      }
    }
    const service = new MercadoPagoTerminalUnpaidEvidenceService({
      provider,
      clock: () => observedAt,
      pageSize: 2
    })
    const evidence = await service.getEvidence(input())
    assert.equal(evidence.paymentsSearch.total, 3)
    assert.deepEqual(calls, [
      'order',
      'search:0',
      'search:2',
      'payment:1',
      'payment:2',
      'payment:3',
      'order'
    ])
  })

  for (const [name, override] of [
    ['approved/accredited', { status: 'approved', status_detail: 'accredited' }],
    ['authorized', { status: 'authorized', status_detail: 'pending_capture' }],
    ['pending', { status: 'pending', status_detail: 'pending_waiting_payment' }],
    ['in_process', { status: 'in_process', status_detail: 'pending_contingency' }],
    ['full refund', {
      status: 'refunded',
      status_detail: 'refunded',
      transaction_amount_refunded: 20497.4,
      refunds: [{ id: 1 }]
    }],
    ['partial refund', {
      status: 'approved',
      status_detail: 'partially_refunded',
      transaction_amount_refunded: 100,
      refunds: [{ id: 1 }]
    }],
    ['external reference mismatch', { external_reference: 'LC-OTHER' }],
    ['ORDER_MP mismatch', {
      point_of_interaction: { references: [{ id: 'ORD-OTHER', type: 'ORDER_MP' }] }
    }],
    ['amount mismatch', { transaction_amount: 1 }],
    ['currency mismatch', { currency_id: 'USD' }],
    ['malformed payload', { transaction_details: null }]
  ]) {
    it(`vetoes ${name}`, async () => {
      const { service } = makeService({
        search: searchPage([{ id: 123456 }]),
        payments: { 123456: terminalPayment(override) }
      })
      await rejectsEvidence(service.getEvidence(input()))
    })
  }

  for (const [name, override] of [
    ['providerOrderId mismatch', { providerOrderId: 'ORD-OTHER' }],
    ['external reference mismatch', { externalReference: 'LC-OTHER' }],
    ['amount mismatch', { totalAmount: '1.00' }],
    ['currency mismatch', { currency: 'USD' }],
    ['remote approved', { status: 'processed', statusDetail: 'accredited' }],
    ['remote pending', { status: 'created', statusDetail: 'created' }]
  ]) {
    it(`rejects final Order ${name}`, async () => {
      const { service } = makeService({ orders: [typeAOrder(), typeAOrder(override)] })
      await rejectsEvidence(service.getEvidence(input()))
    })
  }

  it('rejects unstable pagination totals and duplicate IDs', async () => {
    const { service } = makeService({
      search: searchPage([{ id: 123456 }, { id: 123456 }]),
      payments: { 123456: terminalPayment() }
    })
    await rejectsEvidence(service.getEvidence(input()))
  })

  for (const [name, error] of [
    ['timeout', new MercadoPagoProviderError('timeout', 'MERCADOPAGO_TIMEOUT', 504)],
    ['429', new MercadoPagoProviderError('rate', 'MERCADOPAGO_RATE_LIMIT', 503)],
    ['5xx', new MercadoPagoProviderError('down', 'MERCADOPAGO_UNAVAILABLE', 503)]
  ]) {
    it(`propagates provider ${name} without creating evidence`, async () => {
      const { service } = makeService({ error })
      await assert.rejects(service.getEvidence(input()), (caught) => caught === error)
    })
  }
})
