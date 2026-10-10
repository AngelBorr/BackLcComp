/* eslint-env mocha */
import assert from 'node:assert/strict'
import {
  REMOTE_ORDER_CLASSIFICATIONS as CLASSIFICATION,
  classifyRemoteOrder
} from '../../src/services/mercadoPagoOrderClassification.service.js'

const baseOrder = (overrides = {}) => ({
  providerOrderId: 'ORD01TESTCLASSIFICATION',
  status: 'created',
  statusDetail: null,
  externalReference: 'LC-2026-000010',
  totalAmount: '154500.00',
  totalPaidAmount: '0.00',
  currency: 'ARS',
  payments: [],
  ...overrides
})

const expected = {
  expectedProviderOrderId: 'ORD01TESTCLASSIFICATION',
  expectedExternalReference: 'LC-2026-000010',
  expectedTotalAmount: '154500.00',
  expectedCurrency: 'ARS'
}

describe('Mercado Pago remote Order financial classification (pure)', () => {
  for (const status of ['created', 'action_required']) {
    it(`classifies ${status} as PAYABLE`, () => {
      assert.equal(classifyRemoteOrder(baseOrder({ status }), expected), CLASSIFICATION.PAYABLE)
    })
  }

  it('classifies processing as PROCESSING', () => {
    assert.equal(
      classifyRemoteOrder(baseOrder({ status: 'processing' }), expected),
      CLASSIFICATION.PROCESSING
    )
  })

  it('classifies processed/accredited as APPROVED', () => {
    const order = baseOrder({
      status: 'processed',
      statusDetail: 'accredited',
      totalPaidAmount: '154500.00',
      payments: [{
        providerPaymentId: 'PAY-APPROVED',
        status: 'processed',
        statusDetail: 'accredited',
        amount: '154500.00',
        paidAmount: '154500.00'
      }]
    })
    assert.equal(classifyRemoteOrder(order, expected), CLASSIFICATION.APPROVED)
  })

  it('classifies canceled with zero paid and no accredited payment as TERMINAL_UNPAID', () => {
    assert.equal(
      classifyRemoteOrder(baseOrder({ status: 'canceled' }), expected),
      CLASSIFICATION.TERMINAL_UNPAID
    )
  })

  it('rejects canceled with a positive paid amount as INCONSISTENT', () => {
    const order = baseOrder({
      status: 'canceled',
      totalPaidAmount: '1.00',
      payments: [{ status: 'failed', statusDetail: 'rejected', paidAmount: '1.00' }]
    })
    assert.equal(classifyRemoteOrder(order, expected), CLASSIFICATION.INCONSISTENT)
  })

  it('rejects canceled with an accredited payment as INCONSISTENT', () => {
    const order = baseOrder({
      status: 'canceled',
      payments: [{
        status: 'processed',
        statusDetail: 'accredited',
        paidAmount: '0.00'
      }]
    })
    assert.equal(classifyRemoteOrder(order, expected), CLASSIFICATION.INCONSISTENT)
  })

  it('keeps failed fail-closed as FAILED_UNCERTAIN', () => {
    assert.equal(
      classifyRemoteOrder(baseOrder({ status: 'failed' }), expected),
      CLASSIFICATION.FAILED_UNCERTAIN
    )
  })

  for (const order of [
    baseOrder({ status: 'refunded' }),
    baseOrder({ status: 'processed', statusDetail: 'partially_refunded' })
  ]) {
    it('classifies refunded shapes as REFUNDED', () => {
      assert.equal(classifyRemoteOrder(order, expected), CLASSIFICATION.REFUNDED)
    })
  }

  it('uses the complete Order state when one attempt failed and another is accredited', () => {
    const order = baseOrder({
      status: 'processed',
      statusDetail: 'accredited',
      totalPaidAmount: '154500.00',
      payments: [
        { status: 'failed', statusDetail: 'processing_error', paidAmount: '0.00' },
        {
          status: 'processed',
          statusDetail: 'accredited',
          amount: '154500.00',
          paidAmount: '154500.00'
        }
      ]
    })
    assert.equal(classifyRemoteOrder(order, expected), CLASSIFICATION.APPROVED)
  })

  it('classifies unknown states as INCONSISTENT', () => {
    assert.equal(
      classifyRemoteOrder(baseOrder({ status: 'future_status' }), expected),
      CLASSIFICATION.INCONSISTENT
    )
  })

  it('classifies an amount mismatch as INCONSISTENT', () => {
    assert.equal(
      classifyRemoteOrder(baseOrder({ totalAmount: '1.00' }), expected),
      CLASSIFICATION.INCONSISTENT
    )
  })

  it('classifies an external reference mismatch as INCONSISTENT', () => {
    assert.equal(
      classifyRemoteOrder(baseOrder({ externalReference: 'OTHER' }), expected),
      CLASSIFICATION.INCONSISTENT
    )
  })

  it('classifies a provider Order ID mismatch as INCONSISTENT', () => {
    assert.equal(
      classifyRemoteOrder(baseOrder({ providerOrderId: 'ORD01OTHER' }), expected),
      CLASSIFICATION.INCONSISTENT
    )
  })
})
