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

const validateFinancialIdentity = (providerOrder, expected, mismatch) => {
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
    cents(payment.amount, 'provider.payment.amount') !== expectedCents ||
    cents(payment.paidAmount, 'provider.payment.paidAmount') !== expectedCents
  ) {
    return mismatch('PROVIDER_PAYMENT_AMOUNT_MISMATCH')
  }

  return { expectedCents, payment }
}

const validatePreRefundPaymentState = (validated, mismatch) => {
  if (
    text(validated.payment.status).toLowerCase() !== 'processed' ||
    text(validated.payment.statusDetail).toLowerCase() !== 'accredited'
  ) {
    return mismatch('PROVIDER_PAYMENT_NOT_ACCREDITED')
  }
  if (validated.payment.refundedAmountPresent === true) {
    const refundedCents = cents(
      validated.payment.refundedAmount,
      'provider.payment.refundedAmount'
    )
    if (refundedCents === null || refundedCents !== 0) {
      return mismatch('PROVIDER_PAYMENT_ALREADY_REFUNDED')
    }
  }

  return validated
}

const classifyRefundPreflight = (providerOrder, expected) => {
  const mismatch = (reason) => ({
    outcome: REFUND_PREFLIGHT_OUTCOMES.REQUIRES_ATTENTION,
    reason
  })
  const validated = validateFinancialIdentity(providerOrder, expected, mismatch)
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

  const paymentState = validatePreRefundPaymentState(validated, mismatch)
  if (paymentState.outcome) return paymentState

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

  const validated = validateFinancialIdentity(providerOrder, expected, mismatch)
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
  const normalizedRefunds = []
  for (const refund of refunds) {
    if (!/^REF/i.test(text(refund.providerRefundId))) {
      return mismatch('PROVIDER_REFUND_ID_MISSING')
    }
    if (text(refund.providerPaymentId) !== text(expected.providerPaymentId)) {
      return mismatch('PROVIDER_REFUND_PAYMENT_ID_MISMATCH')
    }
    const amountCents = cents(refund.amount, 'provider.refund.amount')
    if (amountCents === null) return mismatch('PROVIDER_REFUND_AMOUNT_MISMATCH')
    normalizedRefunds.push({ refund, amountCents })
  }

  const refundStatuses = normalizedRefunds.map(({ refund }) =>
    text(refund.status).toLowerCase()
  )
  if (refundStatuses.some((status) => ['pending', 'processing', 'in_process'].includes(status))) {
    return {
      outcome: REFUND_RECONCILIATION_OUTCOMES.PROCESSING,
      reason: 'PROVIDER_REFUND_PROCESSING',
      refund: normalizedRefunds.find(({ refund }) =>
        ['pending', 'processing', 'in_process'].includes(text(refund.status).toLowerCase())
      )?.refund
    }
  }
  if (refundStatuses.every((status) => ['rejected', 'cancelled', 'failed'].includes(status))) {
    return {
      outcome: REFUND_RECONCILIATION_OUTCOMES.REJECTED_DEFINITIVE,
      reason: 'PROVIDER_REFUND_REJECTED',
      refund: normalizedRefunds[0].refund
    }
  }
  if (refundStatuses.some((status) => status !== 'processed')) {
    return mismatch('PROVIDER_REFUND_STATE_INCONSISTENT')
  }
  if (normalizedRefunds.some(({ refund }) =>
    text(refund.statusDetail) && text(refund.statusDetail).toLowerCase() !== 'accredited'
  )) {
    return mismatch('PROVIDER_REFUND_STATUS_DETAIL_INCONSISTENT')
  }

  let totalRefundCents = 0
  for (const { amountCents } of normalizedRefunds) {
    totalRefundCents += amountCents
    if (!Number.isSafeInteger(totalRefundCents)) {
      return mismatch('PROVIDER_REFUND_AMOUNT_SUM_MISMATCH')
    }
  }
  if (totalRefundCents !== expectedCents) {
    return mismatch('PROVIDER_REFUND_AMOUNT_SUM_MISMATCH')
  }

  const exactRefund = normalizedRefunds.find(({ amountCents }) => amountCents === expectedCents)
  if (!exactRefund) return mismatch('PROVIDER_REFUND_AMOUNT_MISMATCH')
  if (
    source.totalRefundedAmountPresent === true &&
    cents(providerOrder.totalRefundedAmount, 'provider.totalRefundedAmount') !== expectedCents
  ) {
    return mismatch('TOTAL_REFUNDED_AMOUNT_INCONSISTENT')
  }
  if (
    validated.payment.refundedAmountPresent === true &&
    cents(validated.payment.refundedAmount, 'provider.payment.refundedAmount') !== expectedCents
  ) {
    return mismatch('PROVIDER_PAYMENT_REFUNDED_AMOUNT_MISMATCH')
  }
  if (
    text(validated.payment.status).toLowerCase() !== 'refunded' ||
    text(validated.payment.statusDetail).toLowerCase() !== 'refunded'
  ) {
    return mismatch('PROVIDER_PAYMENT_NOT_REFUNDED')
  }
  if (
    text(providerOrder.status).toLowerCase() !== 'refunded' ||
    text(providerOrder.statusDetail).toLowerCase() !== 'refunded'
  ) {
    return mismatch('PROVIDER_ORDER_NOT_REFUNDED')
  }

  return {
    outcome: REFUND_RECONCILIATION_OUTCOMES.SUCCEEDED,
    reason: 'PROVIDER_TOTAL_REFUND_CONFIRMED',
    refund: exactRefund.refund,
    payment: validated.payment
  }
}

export { classifyRefundEvidence, classifyRefundPreflight }
