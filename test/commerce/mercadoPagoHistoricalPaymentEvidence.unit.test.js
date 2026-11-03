/* eslint-env mocha */
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import {
  HISTORICAL_PAYMENT_EVIDENCE_SOURCE,
  MercadoPagoHistoricalPaymentEvidenceService,
  normalizePaymentsApiPaymentId
} from '../../src/services/mercadoPagoHistoricalPaymentEvidence.service.js'

const fixedNow = new Date('2026-11-02T20:00:00.000Z')
const expected = Object.freeze({
  orderNumber: 'LC-2026-000003',
  providerOrderId: 'ORDTST01M46H588EYB92EXVMR3QE8N6J',
  providerPaymentId: 'PAY01M46HCBB6BXF58HCKXKYDQZY0',
  totalArs: '20497.40',
  currency: 'ARS'
})

const approvedSearchPayment = (overrides = {}) => ({
  id: 181512736549,
  status: 'approved',
  status_detail: 'accredited',
  ...overrides
})

const rejectedSearchPayment = (overrides = {}) => ({
  id: 181512125829,
  status: 'rejected',
  status_detail: 'cc_rejected_other_reason',
  ...overrides
})

const individualPayment = (overrides = {}) => ({
  id: 181512736549,
  status: 'approved',
  status_detail: 'accredited',
  external_reference: expected.orderNumber,
  transaction_amount: 20497.4,
  transaction_details: { total_paid_amount: 20497.4 },
  currency_id: 'ARS',
  transaction_amount_refunded: 0,
  refunds: [],
  point_of_interaction: {
    references: [{ id: expected.providerOrderId, type: 'ORDER_MP' }]
  },
  ...overrides
})

const makeHarness = ({ pages, payment = individualPayment() } = {}) => {
  const calls = { searches: [], paymentGets: [] }
  const searchPages = pages || new Map([[
    0,
    {
      paging: { total: 2, offset: 0, limit: 2 },
      results: [rejectedSearchPayment(), approvedSearchPayment()]
    }
  ]])
  const provider = {
    async searchPayments(input) {
      calls.searches.push(input)
      return structuredClone(searchPages.get(input.offset))
    },
    async getPaymentById(paymentId) {
      calls.paymentGets.push(paymentId)
      return structuredClone(payment)
    }
  }
  const service = new MercadoPagoHistoricalPaymentEvidenceService({
    provider,
    clock: () => fixedNow,
    pageSize: 2,
    maxSearchResults: 10
  })

  return { calls, service }
}

const rejectsMismatch = async (operation) => {
  await assert.rejects(operation, (error) => (
    error?.code === 'ATTENTION_PROVIDER_EVIDENCE_MISMATCH'
  ))
}

describe('P1C-A historical Payments API evidence (isolated)', () => {
  it('accepts rejected siblings plus exactly one approved/accredited candidate', async () => {
    const { service, calls } = makeHarness()
    const evidence = await service.getEvidence(expected)

    assert.equal(evidence.evidenceSource, HISTORICAL_PAYMENT_EVIDENCE_SOURCE)
    assert.equal(evidence.providerOrderId, expected.providerOrderId)
    assert.equal(evidence.providerPaymentId, expected.providerPaymentId)
    assert.equal(evidence.paymentsApiPaymentId, '181512736549')
    assert.notEqual(evidence.providerPaymentId, evidence.paymentsApiPaymentId)
    assert.equal(evidence.transactionAmountRefunded, '0')
    assert.equal(evidence.refundCount, 0)
    assert.equal(evidence.orderMpReferenceId, expected.providerOrderId)
    assert.equal(evidence.observedAt.toISOString(), fixedNow.toISOString())
    assert.deepEqual(calls.searches, [{
      externalReference: expected.orderNumber,
      status: 'approved',
      limit: 2,
      offset: 0
    }])
    assert.deepEqual(calls.paymentGets, ['181512736549'])
  })

  for (const [name, results] of [
    ['zero approved candidates', [rejectedSearchPayment()]],
    ['two approved candidates', [
      approvedSearchPayment(),
      approvedSearchPayment({ id: 181512736550 })
    ]]
  ]) {
    it(`fails closed with ${name}`, async () => {
      const { service, calls } = makeHarness({
        pages: new Map([[0, {
          paging: { total: results.length, offset: 0, limit: 2 },
          results
        }]])
      })

      await rejectsMismatch(service.getEvidence(expected))
      assert.equal(calls.paymentGets.length, 0)
    })
  }

  for (const [name, mutate] of [
    ['external reference mismatch', (payment) => { payment.external_reference = 'LC-OTHER' }],
    ['ORDER_MP mismatch', (payment) => {
      payment.point_of_interaction.references[0].id = 'ORD-OTHER'
    }],
    ['ORDER_MP missing', (payment) => { payment.point_of_interaction.references = [] }],
    ['multiple ORDER_MP references', (payment) => {
      payment.point_of_interaction.references.push({
        id: expected.providerOrderId,
        type: 'ORDER_MP'
      })
    }],
    ['transaction amount mismatch', (payment) => { payment.transaction_amount = '20497.41' }],
    ['paid amount mismatch', (payment) => {
      payment.transaction_details.total_paid_amount = '20497.39'
    }],
    ['currency mismatch', (payment) => { payment.currency_id = 'USD' }],
    ['refunded amount positive', (payment) => { payment.transaction_amount_refunded = '0.01' }],
    ['refunds non-empty', (payment) => { payment.refunds = [{ id: 1 }] }],
    ['status changed after search', (payment) => { payment.status = 'rejected' }],
    ['status detail changed after search', (payment) => { payment.status_detail = 'pending' }],
    ['individual ID mismatch', (payment) => { payment.id = 181512736550 }],
    ['refund amount missing', (payment) => { delete payment.transaction_amount_refunded }],
    ['refund amount null', (payment) => { payment.transaction_amount_refunded = null }],
    ['refunds missing', (payment) => { delete payment.refunds }],
    ['refunds null', (payment) => { payment.refunds = null }],
    ['paid amount missing', (payment) => { delete payment.transaction_details.total_paid_amount }]
  ]) {
    it(`rejects individual Payment when ${name}`, async () => {
      const payment = individualPayment()
      mutate(payment)
      const { service } = makeHarness({ payment })
      await rejectsMismatch(service.getEvidence(expected))
    })
  }

  it('retrieves every coherent page before selecting the unique candidate', async () => {
    const pages = new Map([
      [0, {
        paging: { total: 3, offset: 0, limit: 2 },
        results: [rejectedSearchPayment(), rejectedSearchPayment({ id: 181512125830 })]
      }],
      [2, {
        paging: { total: 3, offset: 2, limit: 2 },
        results: [approvedSearchPayment()]
      }]
    ])
    const { service, calls } = makeHarness({ pages })
    const evidence = await service.getEvidence(expected)

    assert.equal(evidence.paymentsApiPaymentId, '181512736549')
    assert.deepEqual(calls.searches.map(({ offset }) => offset), [0, 2])
  })

  for (const [name, pages] of [
    ['paging is missing', new Map([[0, { results: [approvedSearchPayment()] }]])],
    ['paging offset is incoherent', new Map([[0, {
      paging: { total: 1, offset: 1, limit: 2 },
      results: [approvedSearchPayment()]
    }]])],
    ['paging limit is incoherent', new Map([[0, {
      paging: { total: 1, offset: 0, limit: 1 },
      results: [approvedSearchPayment()]
    }]])],
    ['paging total changes', new Map([
      [0, {
        paging: { total: 3, offset: 0, limit: 2 },
        results: [rejectedSearchPayment(), rejectedSearchPayment({ id: 181512125830 })]
      }],
      [2, {
        paging: { total: 4, offset: 2, limit: 2 },
        results: [approvedSearchPayment(), rejectedSearchPayment({ id: 181512125831 })]
      }]
    ])],
    ['page is partial before total', new Map([[0, {
      paging: { total: 3, offset: 0, limit: 2 },
      results: [approvedSearchPayment()]
    }]])],
    ['ID is duplicated between pages', new Map([
      [0, {
        paging: { total: 3, offset: 0, limit: 2 },
        results: [rejectedSearchPayment(), approvedSearchPayment()]
      }],
      [2, {
        paging: { total: 3, offset: 2, limit: 2 },
        results: [approvedSearchPayment()]
      }]
    ])],
    ['numeric ID is unsafe', new Map([[0, {
      paging: { total: 1, offset: 0, limit: 2 },
      results: [approvedSearchPayment({ id: Number.MAX_SAFE_INTEGER + 1 })]
    }]])],
    ['payment ID is missing', new Map([[0, {
      paging: { total: 1, offset: 0, limit: 2 },
      results: [approvedSearchPayment({ id: undefined })]
    }]])],
    ['payment ID string is non-canonical', new Map([[0, {
      paging: { total: 1, offset: 0, limit: 2 },
      results: [approvedSearchPayment({ id: '0181512736549' })]
    }]])]
  ]) {
    it(`fails closed when ${name}`, async () => {
      const { service, calls } = makeHarness({ pages })
      await rejectsMismatch(service.getEvidence(expected))
      assert.equal(calls.paymentGets.length, 0)
    })
  }

  it('normalizes only positive canonical safe integer payment IDs', () => {
    assert.equal(normalizePaymentsApiPaymentId(181512736549), '181512736549')
    assert.equal(normalizePaymentsApiPaymentId('181512736549'), '181512736549')

    for (const invalid of [
      0,
      -1,
      1.5,
      Number.NaN,
      Number.POSITIVE_INFINITY,
      Number.MAX_SAFE_INTEGER + 1,
      '0181512736549',
      '181512736549.0',
      ' 181512736549',
      '1e5',
      null,
      undefined
    ]) {
      assert.equal(normalizePaymentsApiPaymentId(invalid), null)
    }
  })

  it('remains structurally isolated from webhook, P1A, worker and Financial Guard', () => {
    for (const path of [
      'src/services/mercadoPagoWebhook.service.js',
      'src/services/buyerPaymentReconciliation.service.js',
      'src/services/paymentReconciliationWorker.service.js',
      'src/services/checkoutFinancialGuard.service.js'
    ]) {
      const source = readFileSync(path, 'utf8')
      assert.equal(source.includes('mercadoPagoHistoricalPaymentEvidence'), false, path)
    }
  })
})
