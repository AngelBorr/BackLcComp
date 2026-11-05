import { toMinorUnits } from '../utils/commerceMoney.js'

export const REFUND_RECONCILIATION_OUTCOMES = Object.freeze({
  SUCCEEDED: 'succeeded',
  PROCESSING: 'processing',
  REJECTED_DEFINITIVE: 'rejected_definitive',
  REQUIRES_ATTENTION: 'requires_attention',
  NOT_OBSERVED: 'not_observed'
})

export const REFUND_PREFLIGHT_OUTCOMES = Object.freeze({
  VALID: 'valid',
  REMOTE_REFUND_OBSERVED: 'remote_refund_observed',
  REQUIRES_ATTENTION: 'requires_attention'
})

const text = (value) => String(value ?? '').trim()
const cents = (value, field) => {
  try {
    return toMinorUnits(value, field)
  } catch {
    return null
  }
}

const validatePaymentIdentity = (providerOrder, expected, mismatch) => {
  const source = providerOrder?.reconciliationSource
  if (
    source?.totalPaidAmountPresent !== true ||
    source?.transactionsPresent !== true ||
    source?.paymentsPresent !== true ||
    source?.paymentsIsArray !== true
  ) {
    return mismatch('PROVIDER_PAYMENT_PROVENANCE_MISSING')
  }
  if (text(providerOrder.providerOrderId) !== text(expected.providerOrderId)) {
    return mismatch('PROVIDER_ORDER_ID_MISMATCH')
  }
  if (text(providerOrder.externalReference).toUpperCase() !== text(expected.externalReference)) {
    return mismatch('EXTERNAL_REFERENCE_MISMATCH')
  }
  if (text(providerOrder.currency).toUpperCase() !== text(expected.currency).toUpperCase()) {
    return mismatch('CURRENCY_MISMATCH')
  }

  const expectedCents = cents(expected.amount, 'expected.amount')
  if (expectedCents === null || cents(providerOrder.totalAmount, 'provider.totalAmount') !== expectedCents) {
    return mismatch('TOTAL_AMOUNT_MISMATCH')
  }
  if (cents(providerOrder.totalPaidAmount, 'provider.totalPaidAmount') !== expectedCents) {
    return mismatch('TOTAL_PAID_AMOUNT_MISMATCH')
  }

  const payments = providerOrder.payments || []
  if (payments.length !== 1) return mismatch('PROVIDER_PAYMENT_CARDINALITY_MISMATCH')
  const payment = payments[0]
  if (text(payment.providerPaymentId) !== text(expected.providerPaymentId)) {
    return mismatch('PROVIDER_PAYMENT_ID_MISMATCH')
  }
  if (
    text(payment.status).toLowerCase() !== 'processed' ||
    text(payment.statusDetail).toLowerCase() !== 'accredited'
  ) {
    return mismatch('PROVIDER_PAYMENT_NOT_ACCREDITED')
  }
  if (
    cents(payment.amount, 'provider.payment.amount') !== expectedCents ||
    cents(payment.paidAmount, 'provider.payment.paidAmount') !== expectedCents
  ) {
    return mismatch('PROVIDER_PAYMENT_AMOUNT_MISMATCH')
  }

  return { expectedCents }
}

const classifyRefundPreflight = (providerOrder, expected) => {
  const mismatch = (reason) => ({
    outcome: REFUND_PREFLIGHT_OUTCOMES.REQUIRES_ATTENTION,
    reason
  })
  const validated = validatePaymentIdentity(providerOrder, expected, mismatch)
  if (validated.outcome) return validated

  const source = providerOrder.reconciliationSource
  if (
    source.refundsPresent === true &&
    source.refundsIsArray === true &&
    Array.isArray(providerOrder.refunds) &&
    providerOrder.refunds.length > 0
  ) {
    return {
      outcome: REFUND_PREFLIGHT_OUTCOMES.REMOTE_REFUND_OBSERVED,
      reason: 'PROVIDER_REFUND_ALREADY_OBSERVED'
    }
  }

  if (
    text(providerOrder.status).toLowerCase() !== 'processed' ||
    text(providerOrder.statusDetail).toLowerCase() !== 'accredited'
  ) {
    return mismatch('PROVIDER_ORDER_NOT_ACCREDITED')
  }

  if (source.refundsPresent === true) {
    if (source.refundsIsArray !== true || !Array.isArray(providerOrder.refunds)) {
      return mismatch('PROVIDER_REFUNDS_PROVENANCE_INVALID')
    }
    if (source.totalRefundedAmountPresent === true) {
      const refundedCents = cents(
        providerOrder.totalRefundedAmount,
        'provider.totalRefundedAmount'
      )
      if (refundedCents === null || refundedCents !== 0) {
        return mismatch('TOTAL_REFUNDED_AMOUNT_INCONSISTENT')
      }
    }
  } else if (
    source.refundsPresent !== false ||
    source.refundsIsArray !== false ||
    source.totalRefundedAmountPresent !== false
  ) {
    return mismatch('PROVIDER_REFUNDS_PROVENANCE_MISSING')
  }

  return {
    outcome: REFUND_PREFLIGHT_OUTCOMES.VALID,
    reason: 'PROVIDER_FIRST_TOTAL_REFUND_ALLOWED'
  }
}

const classifyRefundEvidence = (providerOrder, expected) => {
  const mismatch = (reason) => ({
    outcome: REFUND_RECONCILIATION_OUTCOMES.REQUIRES_ATTENTION,
    reason
  })
  const source = providerOrder?.reconciliationSource

  const validated = validatePaymentIdentity(providerOrder, expected, mismatch)
  if (validated.outcome) return validated
  if (!source?.refundsPresent || !source?.refundsIsArray) {
    return mismatch('PROVIDER_REFUNDS_PROVENANCE_MISSING')
  }
  const expectedCents = validated.expectedCents

  const refunds = providerOrder.refunds || []
  if (!refunds.length) {
    if (source.totalRefundedAmountPresent === true) {
      const refundedCents = cents(
        providerOrder.totalRefundedAmount,
        'provider.totalRefundedAmount'
      )
      if (refundedCents === null || refundedCents !== 0) {
        return mismatch('TOTAL_REFUNDED_AMOUNT_INCONSISTENT')
      }
    }
    return {
      outcome: REFUND_RECONCILIATION_OUTCOMES.NOT_OBSERVED,
      reason: 'PROVIDER_REFUND_NOT_OBSERVED'
    }
  }
  if (refunds.length !== 1) return mismatch('PROVIDER_REFUND_CARDINALITY_MISMATCH')

  const refund = refunds[0]
  if (!text(refund.providerRefundId)) return mismatch('PROVIDER_REFUND_ID_MISSING')
  if (text(refund.providerPaymentId) !== text(expected.providerPaymentId)) {
    return mismatch('PROVIDER_REFUND_PAYMENT_ID_MISMATCH')
  }
  if (cents(refund.amount, 'provider.refund.amount') !== expectedCents) {
    return mismatch('PROVIDER_REFUND_AMOUNT_MISMATCH')
  }
  if (
    source.totalRefundedAmountPresent === true &&
    cents(providerOrder.totalRefundedAmount, 'provider.totalRefundedAmount') !== expectedCents
  ) {
    return mismatch('TOTAL_REFUNDED_AMOUNT_INCONSISTENT')
  }

  const refundStatus = text(refund.status).toLowerCase()
  const orderStatus = text(providerOrder.status).toLowerCase()
  const orderStatusDetail = text(providerOrder.statusDetail).toLowerCase()

  if (
    ['processed', 'succeeded'].includes(refundStatus) &&
    orderStatus === 'refunded' &&
    orderStatusDetail === 'refunded'
  ) {
    return {
      outcome: REFUND_RECONCILIATION_OUTCOMES.SUCCEEDED,
      reason: 'PROVIDER_TOTAL_REFUND_CONFIRMED',
      refund
    }
  }

  if (['rejected', 'cancelled', 'failed'].includes(refundStatus)) {
    return {
      outcome: REFUND_RECONCILIATION_OUTCOMES.REJECTED_DEFINITIVE,
      reason: 'PROVIDER_REFUND_REJECTED',
      refund
    }
  }

  if (['pending', 'processing', 'in_process'].includes(refundStatus)) {
    return {
      outcome: REFUND_RECONCILIATION_OUTCOMES.PROCESSING,
      reason: 'PROVIDER_REFUND_PROCESSING',
      refund
    }
  }

  return mismatch('PROVIDER_REFUND_STATE_INCONSISTENT')
}

export { classifyRefundEvidence, classifyRefundPreflight }
