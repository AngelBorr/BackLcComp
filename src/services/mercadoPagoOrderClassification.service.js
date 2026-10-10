import { toMinorUnits } from '../utils/commerceMoney.js'

const REMOTE_ORDER_CLASSIFICATIONS = Object.freeze({
  APPROVED: 'APPROVED',
  PAYABLE: 'PAYABLE',
  PROCESSING: 'PROCESSING',
  TERMINAL_UNPAID: 'TERMINAL_UNPAID',
  REFUNDED: 'REFUNDED',
  FAILED_UNCERTAIN: 'FAILED_UNCERTAIN',
  INCONSISTENT: 'INCONSISTENT'
})

const asText = (value) => String(value ?? '').trim()
const asStatus = (value) => asText(value).toLowerCase()

const moneyMatches = (actual, expected, field) => {
  try {
    return toMinorUnits(actual, field) === toMinorUnits(expected, field)
  } catch {
    return false
  }
}

const hasExpectedValueMismatch = (
  providerOrder,
  {
    expectedProviderOrderId,
    expectedExternalReference,
    expectedTotalAmount,
    expectedCurrency
  }
) => {
  if (
    expectedProviderOrderId !== undefined &&
    asText(providerOrder.providerOrderId) !== asText(expectedProviderOrderId)
  ) return true

  if (
    expectedExternalReference !== undefined &&
    asText(providerOrder.externalReference).toUpperCase() !==
      asText(expectedExternalReference).toUpperCase()
  ) return true

  if (
    expectedTotalAmount !== undefined &&
    !moneyMatches(providerOrder.totalAmount, expectedTotalAmount, 'MercadoPago.totalAmount')
  ) return true

  if (
    expectedCurrency !== undefined &&
    asText(providerOrder.currency).toUpperCase() !== asText(expectedCurrency).toUpperCase()
  ) return true

  return false
}

const hasAccreditedPayment = (payments) => payments.some((payment) => (
  asStatus(payment?.status) === 'processed' && asStatus(payment?.statusDetail) === 'accredited'
))

const hasPositivePaidAmount = (payments) => payments.some((payment) => {
  if (payment?.paidAmount === undefined || payment?.paidAmount === null) return false
  try {
    return toMinorUnits(payment.paidAmount, 'MercadoPago.payment.paidAmount') > 0
  } catch {
    return true
  }
})

const classifyRemoteOrder = (providerOrder, expected = {}) => {
  if (!providerOrder || typeof providerOrder !== 'object' || Array.isArray(providerOrder)) {
    return REMOTE_ORDER_CLASSIFICATIONS.INCONSISTENT
  }

  const status = asStatus(providerOrder.status)
  const statusDetail = asStatus(providerOrder.statusDetail)
  const payments = providerOrder.payments ?? []

  if (!status || !Array.isArray(payments) || hasExpectedValueMismatch(providerOrder, expected)) {
    return REMOTE_ORDER_CLASSIFICATIONS.INCONSISTENT
  }

  if (
    status === 'refunded' ||
    ['refunded', 'partially_refunded'].includes(statusDetail)
  ) return REMOTE_ORDER_CLASSIFICATIONS.REFUNDED

  if (status === 'processed' && statusDetail === 'accredited') {
    return REMOTE_ORDER_CLASSIFICATIONS.APPROVED
  }

  if (['created', 'action_required'].includes(status)) {
    return REMOTE_ORDER_CLASSIFICATIONS.PAYABLE
  }

  if (status === 'processing') return REMOTE_ORDER_CLASSIFICATIONS.PROCESSING
  if (status === 'failed') return REMOTE_ORDER_CLASSIFICATIONS.FAILED_UNCERTAIN

  if (status === 'canceled') {
    const externalReference = asText(providerOrder.externalReference)
    const currency = asText(providerOrder.currency)
    const totalAmount = providerOrder.totalAmount
    const totalPaidAmount = providerOrder.totalPaidAmount

    if (
      !externalReference ||
      !currency ||
      totalAmount === undefined ||
      totalAmount === null ||
      totalPaidAmount === undefined ||
      totalPaidAmount === null ||
      !moneyMatches(totalPaidAmount, '0', 'MercadoPago.totalPaidAmount') ||
      hasAccreditedPayment(payments) ||
      hasPositivePaidAmount(payments)
    ) return REMOTE_ORDER_CLASSIFICATIONS.INCONSISTENT

    return REMOTE_ORDER_CLASSIFICATIONS.TERMINAL_UNPAID
  }

  return REMOTE_ORDER_CLASSIFICATIONS.INCONSISTENT
}

export { REMOTE_ORDER_CLASSIFICATIONS, classifyRemoteOrder }
