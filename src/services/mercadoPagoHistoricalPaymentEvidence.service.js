import MercadoPagoProvider from '../providers/mercadoPago.provider.js'
import { toMinorUnits } from '../utils/commerceMoney.js'
import { ServiceError } from './service.products.js'

const HISTORICAL_PAYMENT_EVIDENCE_SOURCE = 'PAYMENTS_API_HISTORICAL_FALLBACK'
const SEARCH_PAGE_SIZE = 50
const MAX_SEARCH_RESULTS = 1000

const asText = (value) => String(value ?? '').trim()
const decimalString = (value) => String(value?.toString?.() ?? value)
const isRecord = (value) => Boolean(value) && typeof value === 'object' && !Array.isArray(value)

const normalizePaymentsApiPaymentId = (value) => {
  if (typeof value === 'number') {
    return Number.isSafeInteger(value) && value > 0 ? String(value) : null
  }

  if (typeof value !== 'string' || value !== value.trim() || !/^[1-9]\d*$/.test(value)) {
    return null
  }

  return value
}

const moneyMatches = (actual, expected, field) => {
  if (actual === undefined || actual === null || expected === undefined || expected === null) {
    return false
  }

  try {
    return toMinorUnits(actual, field) === toMinorUnits(expected, field)
  } catch {
    return false
  }
}

const evidenceMismatch = (message) => new ServiceError(
  message,
  'ATTENTION_PROVIDER_EVIDENCE_MISMATCH',
  409
)

class MercadoPagoHistoricalPaymentEvidenceService {
  constructor({
    provider = MercadoPagoProvider,
    clock = () => new Date(),
    pageSize = SEARCH_PAGE_SIZE,
    maxSearchResults = MAX_SEARCH_RESULTS
  } = {}) {
    this.provider = provider
    this.clock = clock
    this.pageSize = pageSize
    this.maxSearchResults = maxSearchResults
  }

  #now() {
    const now = new Date(this.clock())
    if (Number.isNaN(now.getTime())) {
      throw new ServiceError('Fecha interna invalida', 'INVALID_ATTENTION_RESOLUTION_DATE', 500)
    }
    return now
  }

  #assertSearchPage(payload, { expectedOffset, expectedTotal }) {
    const paging = payload?.paging
    const results = payload?.results

    if (
      !isRecord(payload) ||
      !isRecord(paging) ||
      !Number.isSafeInteger(paging.total) ||
      paging.total < 0 ||
      !Number.isSafeInteger(paging.offset) ||
      paging.offset !== expectedOffset ||
      !Number.isSafeInteger(paging.limit) ||
      paging.limit !== this.pageSize ||
      !Array.isArray(results) ||
      results.length > paging.limit ||
      (expectedTotal !== null && paging.total !== expectedTotal) ||
      paging.total > this.maxSearchResults
    ) {
      throw evidenceMismatch('Mercado Pago devolvio una busqueda de pagos ambigua')
    }

    const consumed = expectedOffset + results.length
    if (
      consumed > paging.total ||
      (consumed < paging.total && results.length !== paging.limit) ||
      (consumed < paging.total && results.length === 0)
    ) {
      throw evidenceMismatch('Mercado Pago devolvio una pagina de pagos incompleta')
    }

    return { total: paging.total, results }
  }

  async #findUniqueAccreditedPayment(orderNumber) {
    const payments = []
    const seenIds = new Set()
    let expectedTotal = null
    let offset = 0

    do {
      const payload = await this.provider.searchPayments({
        externalReference: orderNumber,
        status: 'approved',
        limit: this.pageSize,
        offset
      })
      const page = this.#assertSearchPage(payload, { expectedOffset: offset, expectedTotal })
      expectedTotal = page.total

      for (const payment of page.results) {
        const paymentId = normalizePaymentsApiPaymentId(payment?.id)
        if (!paymentId || seenIds.has(paymentId)) {
          throw evidenceMismatch('Mercado Pago devolvio IDs de pago invalidos o duplicados')
        }

        seenIds.add(paymentId)
        payments.push({
          paymentsApiPaymentId: paymentId,
          status: asText(payment?.status).toLowerCase(),
          statusDetail: asText(payment?.status_detail).toLowerCase()
        })
      }

      offset += page.results.length
    } while (offset < expectedTotal)

    const candidates = payments.filter((payment) => (
      payment.status === 'approved' && payment.statusDetail === 'accredited'
    ))

    if (candidates.length !== 1) {
      throw evidenceMismatch(
        candidates.length === 0
          ? 'No se encontro evidencia historica recuperable del pago aprobado'
          : 'Mercado Pago devolvio mas de un pago aprobado para la orden'
      )
    }

    return candidates[0]
  }

  #validateIndividualPayment(payment, expected, candidateId) {
    if (!isRecord(payment)) {
      throw evidenceMismatch('Mercado Pago devolvio un pago historico invalido')
    }

    const paymentId = normalizePaymentsApiPaymentId(payment.id)
    const transactionDetails = payment.transaction_details
    const pointOfInteraction = payment.point_of_interaction
    const references = pointOfInteraction?.references
    const orderReferences = Array.isArray(references)
      ? references.filter((reference) => asText(reference?.type) === 'ORDER_MP')
      : []
    const orderReference = orderReferences[0]
    const hasRefundedAmount = Object.hasOwn(payment, 'transaction_amount_refunded') &&
      payment.transaction_amount_refunded !== null
    const hasRefunds = Object.hasOwn(payment, 'refunds') && Array.isArray(payment.refunds)
    const hasPaidAmount = isRecord(transactionDetails) &&
      Object.hasOwn(transactionDetails, 'total_paid_amount') &&
      transactionDetails.total_paid_amount !== null

    if (
      paymentId !== candidateId ||
      asText(payment.status).toLowerCase() !== 'approved' ||
      asText(payment.status_detail).toLowerCase() !== 'accredited' ||
      asText(payment.external_reference) !== expected.orderNumber ||
      !moneyMatches(payment.transaction_amount, expected.totalArs, 'payment.transaction_amount') ||
      !hasPaidAmount ||
      !moneyMatches(
        transactionDetails.total_paid_amount,
        expected.totalArs,
        'payment.transaction_details.total_paid_amount'
      ) ||
      asText(payment.currency_id) !== expected.currency ||
      !hasRefundedAmount ||
      !moneyMatches(
        payment.transaction_amount_refunded,
        '0',
        'payment.transaction_amount_refunded'
      ) ||
      !hasRefunds ||
      payment.refunds.length !== 0 ||
      !isRecord(pointOfInteraction) ||
      !Array.isArray(references) ||
      orderReferences.length !== 1 ||
      asText(orderReference?.id) !== expected.providerOrderId
    ) {
      throw evidenceMismatch('Mercado Pago no confirma exactamente el pago historico aprobado')
    }

    return {
      paymentsApiPaymentId: paymentId,
      transactionAmount: decimalString(payment.transaction_amount),
      totalPaidAmount: decimalString(transactionDetails.total_paid_amount),
      transactionAmountRefunded: decimalString(payment.transaction_amount_refunded),
      orderMpReferenceId: asText(orderReference.id)
    }
  }

  async getEvidence({
    orderNumber,
    providerOrderId,
    providerPaymentId,
    totalArs,
    currency
  }) {
    const expected = {
      orderNumber: asText(orderNumber),
      providerOrderId: asText(providerOrderId),
      providerPaymentId: asText(providerPaymentId),
      totalArs: totalArs == null ? '' : decimalString(totalArs),
      currency: asText(currency)
    }

    if (Object.values(expected).some((value) => value === '')) {
      throw evidenceMismatch('La identidad local del pago historico es incompleta')
    }

    const candidate = await this.#findUniqueAccreditedPayment(expected.orderNumber)
    const payment = await this.provider.getPaymentById(candidate.paymentsApiPaymentId)
    const validated = this.#validateIndividualPayment(
      payment,
      expected,
      candidate.paymentsApiPaymentId
    )
    const observedAt = this.#now()

    return {
      provider: 'mercado_pago',
      evidenceSource: HISTORICAL_PAYMENT_EVIDENCE_SOURCE,
      providerOrderId: expected.providerOrderId,
      providerPaymentId: expected.providerPaymentId,
      paymentsApiPaymentId: validated.paymentsApiPaymentId,
      externalReference: expected.orderNumber,
      providerStatus: 'approved',
      providerStatusDetail: 'accredited',
      amountArs: expected.totalArs,
      totalAmount: validated.transactionAmount,
      totalPaidAmount: validated.totalPaidAmount,
      currency: expected.currency,
      transactionAmountRefunded: validated.transactionAmountRefunded,
      refundCount: 0,
      orderMpReferenceId: validated.orderMpReferenceId,
      observedAt,
      remoteClassification: 'APPROVED',
      accreditedPayment: null
    }
  }
}

export {
  HISTORICAL_PAYMENT_EVIDENCE_SOURCE,
  MAX_SEARCH_RESULTS,
  MercadoPagoHistoricalPaymentEvidenceService,
  SEARCH_PAGE_SIZE,
  normalizePaymentsApiPaymentId
}
export default new MercadoPagoHistoricalPaymentEvidenceService()
