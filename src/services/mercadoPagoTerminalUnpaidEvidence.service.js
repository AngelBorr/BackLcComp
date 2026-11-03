import MercadoPagoProvider from '../providers/mercadoPago.provider.js'
import { toMinorUnits } from '../utils/commerceMoney.js'
import {
  REMOTE_ORDER_CLASSIFICATIONS,
  classifyRemoteOrder
} from './mercadoPagoOrderClassification.service.js'
import { ServiceError } from './service.products.js'

const ORDERS_API_TERMINAL_UNPAID = 'ORDERS_API_TERMINAL_UNPAID'
const OWN_CANCELLATION_TERMINAL_UNPAID = 'OWN_CANCELLATION_TERMINAL_UNPAID'
const SEARCH_PAGE_SIZE = 50
const MAX_SEARCH_RESULTS = 1000
const TERMINAL_UNPAID_PAYMENT_STATUSES = new Set(['rejected', 'cancelled', 'canceled'])
const PROHIBITED_PAYMENT_STATUSES = new Set([
  'approved',
  'authorized',
  'pending',
  'in_process',
  'in_mediation',
  'refunded',
  'charged_back'
])

const asText = (value) => String(value ?? '').trim()
const lowerText = (value) => asText(value).toLowerCase()
const decimalString = (value) => value == null ? null : String(value?.toString?.() ?? value)
const isRecord = (value) => Boolean(value) && typeof value === 'object' && !Array.isArray(value)

const validDate = (value) => {
  if (value == null) return null
  const date = new Date(value)
  return Number.isNaN(date.getTime()) ? null : date
}

const moneyMatches = (actual, expected, field) => {
  if (actual == null || expected == null) return false
  try {
    return toMinorUnits(actual, field) === toMinorUnits(expected, field)
  } catch {
    return false
  }
}

const canonicalPaymentId = (value) => {
  if (typeof value === 'number') {
    return Number.isSafeInteger(value) && value > 0 ? String(value) : null
  }
  if (typeof value !== 'string' || value !== value.trim() || !/^[1-9]\d*$/.test(value)) {
    return null
  }
  return value
}

const evidenceMismatch = (message) => new ServiceError(
  message,
  'ATTENTION_TERMINAL_UNPAID_EVIDENCE_MISMATCH',
  409
)

class MercadoPagoTerminalUnpaidEvidenceService {
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

  #expected(input) {
    const expected = {
      orderNumber: asText(input.orderNumber).toUpperCase(),
      providerOrderId: asText(input.providerOrderId),
      totalArs: decimalString(input.totalArs),
      currency: asText(input.currency).toUpperCase(),
      payment: input.payment
    }
    if (
      !expected.orderNumber ||
      !expected.providerOrderId ||
      !expected.totalArs ||
      !expected.currency ||
      !isRecord(expected.payment)
    ) {
      throw evidenceMismatch('La identidad financiera local es incompleta')
    }
    if (
      expected.payment.provider !== 'mercado_pago' ||
      !['pending', 'requires_attention'].includes(expected.payment.normalizedStatus) ||
      asText(expected.payment.providerOrderId) !== expected.providerOrderId ||
      asText(expected.payment.externalReference).toUpperCase() !== expected.orderNumber ||
      !moneyMatches(expected.payment.amountArs, expected.totalArs, 'local.payment.amount') ||
      asText(expected.payment.currency).toUpperCase() !== expected.currency ||
      asText(expected.payment.providerPaymentId) ||
      validDate(expected.payment.approvedAt)
    ) {
      throw evidenceMismatch('La identidad financiera local es inconsistente')
    }
    return expected
  }

  #assertOrderIdentity(order, expected) {
    if (
      !isRecord(order) ||
      asText(order.providerOrderId) !== expected.providerOrderId ||
      asText(order.externalReference).toUpperCase() !== expected.orderNumber ||
      !moneyMatches(order.totalAmount, expected.totalArs, 'order.total_amount') ||
      asText(order.currency).toUpperCase() !== expected.currency ||
      lowerText(order.status) !== 'canceled' ||
      lowerText(order.statusDetail) !== 'canceled'
    ) {
      throw evidenceMismatch('Mercado Pago no confirma exactamente una order cancelada')
    }
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

  async #searchAllPayments(externalReference) {
    const ids = []
    const seen = new Set()
    let expectedTotal = null
    let offset = 0

    do {
      const payload = await this.provider.searchPayments({
        externalReference,
        status: null,
        limit: this.pageSize,
        offset
      })
      const page = this.#assertSearchPage(payload, { expectedOffset: offset, expectedTotal })
      expectedTotal = page.total

      for (const result of page.results) {
        const id = canonicalPaymentId(result?.id)
        if (!id || seen.has(id)) {
          throw evidenceMismatch('Mercado Pago devolvio IDs de pago invalidos o duplicados')
        }
        seen.add(id)
        ids.push(id)
      }
      offset += page.results.length
    } while (offset < expectedTotal)

    return ids
  }

  #validateIndividualPayment(payment, paymentId, expected) {
    if (!isRecord(payment) || canonicalPaymentId(payment.id) !== paymentId) {
      throw evidenceMismatch('Mercado Pago devolvio un pago invalido')
    }

    const status = lowerText(payment.status)
    const statusDetail = lowerText(payment.status_detail)
    const details = payment.transaction_details
    const references = payment.point_of_interaction?.references
    const orderReferences = Array.isArray(references)
      ? references.filter((reference) => asText(reference?.type) === 'ORDER_MP')
      : []
    const hasPaidAmount = isRecord(details) &&
      Object.hasOwn(details, 'total_paid_amount') &&
      details.total_paid_amount !== null
    const hasRefundedAmount = Object.hasOwn(payment, 'transaction_amount_refunded') &&
      payment.transaction_amount_refunded !== null
    const hasRefunds = Object.hasOwn(payment, 'refunds') && Array.isArray(payment.refunds)

    if (
      PROHIBITED_PAYMENT_STATUSES.has(status) ||
      !TERMINAL_UNPAID_PAYMENT_STATUSES.has(status) ||
      !statusDetail ||
      statusDetail.includes('accredit') ||
      statusDetail.includes('refund') ||
      asText(payment.external_reference).toUpperCase() !== expected.orderNumber ||
      !moneyMatches(payment.transaction_amount, expected.totalArs, 'payment.transaction_amount') ||
      asText(payment.currency_id).toUpperCase() !== expected.currency ||
      !hasPaidAmount ||
      !moneyMatches(details.total_paid_amount, '0', 'payment.total_paid_amount') ||
      !hasRefundedAmount ||
      !moneyMatches(payment.transaction_amount_refunded, '0', 'payment.refunded_amount') ||
      !hasRefunds ||
      payment.refunds.length !== 0 ||
      !Array.isArray(references) ||
      orderReferences.length !== 1 ||
      asText(orderReferences[0]?.id) !== expected.providerOrderId
    ) {
      throw evidenceMismatch('Un pago de Mercado Pago impide demostrar ausencia de cobro')
    }

    return {
      paymentsApiPaymentId: paymentId,
      providerPaymentId: paymentId,
      status,
      statusDetail,
      amount: decimalString(payment.transaction_amount),
      paidAmount: decimalString(details.total_paid_amount),
      refundedAmount: decimalString(payment.transaction_amount_refunded),
      refundCount: payment.refunds.length,
      orderMpReferenceId: asText(orderReferences[0].id)
    }
  }

  async #paymentsVeto(expected) {
    const ids = await this.#searchAllPayments(expected.orderNumber)
    const payments = []

    for (const id of ids) {
      const payment = await this.provider.getPaymentById(id)
      payments.push(this.#validateIndividualPayment(payment, id, expected))
    }

    return {
      completed: true,
      total: ids.length,
      inspectedCount: payments.length,
      vetoCount: 0,
      paymentIds: ids,
      payments
    }
  }

  #typeA(order, expected) {
    const source = order.reconciliationSource
    if (
      !isRecord(source) ||
      source.totalPaidAmountPresent !== true ||
      source.transactionsPresent !== true ||
      source.paymentsPresent !== true ||
      source.paymentsIsArray !== true ||
      !Array.isArray(order.payments)
    ) return null

    const explicitZero = order.totalPaidAmount !== null &&
      moneyMatches(order.totalPaidAmount, '0', 'order.total_paid_amount')
    const explicitNullAndEmpty = order.totalPaidAmount === null && order.payments.length === 0
    if (!explicitZero && !explicitNullAndEmpty) return null

    const payments = order.payments.map((payment) => {
      const status = lowerText(payment?.status)
      const statusDetail = lowerText(payment?.statusDetail)
      if (
        !TERMINAL_UNPAID_PAYMENT_STATUSES.has(status) ||
        !statusDetail ||
        statusDetail.includes('accredit') ||
        statusDetail.includes('refund') ||
        payment?.paidAmount == null ||
        !moneyMatches(payment.paidAmount, '0', 'order.payment.paid_amount') ||
        payment?.amount == null ||
        !moneyMatches(payment.amount, expected.totalArs, 'order.payment.amount')
      ) {
        throw evidenceMismatch('La order contiene un payment ambiguo o financieramente activo')
      }
      return {
        providerPaymentId: asText(payment.providerPaymentId) || null,
        status,
        statusDetail,
        amount: decimalString(payment.amount),
        paidAmount: decimalString(payment.paidAmount),
        refundedAmount: null,
        refundCount: null,
        orderMpReferenceId: null
      }
    })

    return {
      evidenceSource: ORDERS_API_TERMINAL_UNPAID,
      remoteClassification: REMOTE_ORDER_CLASSIFICATIONS.TERMINAL_UNPAID,
      payments
    }
  }

  #typeB(order, expected, observedAt) {
    const source = order.reconciliationSource
    const payment = expected.payment
    const payableObservedAt = validDate(payment.providerCancellationPayableObservedAt)
    const attemptedAt = validDate(payment.providerCancellationAttemptedAt)
    const completedAt = validDate(payment.providerCancellationCompletedAt)
    const cancellationStatus = lowerText(payment.providerCancellationStatus)
    const payableStatus = lowerText(payment.providerCancellationPayableStatus)
    const statusIsCoherent = cancellationStatus === 'uncertain'
      ? payment.providerCancellationCompletedAt == null
      : cancellationStatus === 'succeeded' && completedAt &&
        completedAt.getTime() >= attemptedAt?.getTime() &&
        completedAt.getTime() <= observedAt.getTime()

    if (
      !isRecord(source) ||
      source.totalPaidAmountPresent !== false ||
      source.transactionsPresent !== false ||
      source.paymentsPresent !== false ||
      source.paymentsIsArray !== false ||
      order.totalPaidAmount !== null ||
      !Array.isArray(order.payments) ||
      order.payments.length !== 0 ||
      !['created', 'action_required'].includes(payableStatus) ||
      !payableObservedAt ||
      !asText(payment.providerCancellationIdempotencyKey) ||
      !attemptedAt ||
      payableObservedAt.getTime() > attemptedAt.getTime() ||
      observedAt.getTime() <= attemptedAt.getTime() ||
      !statusIsCoherent
    ) return null

    return {
      evidenceSource: OWN_CANCELLATION_TERMINAL_UNPAID,
      remoteClassification:
        REMOTE_ORDER_CLASSIFICATIONS.CANCELED_PAYMENT_AGGREGATES_OMITTED,
      payments: undefined
    }
  }

  #buildEvidence(order, expected, observedAt, veto, type) {
    const source = order.reconciliationSource
    const payment = expected.payment
    return {
      provider: 'mercado_pago',
      evidenceSource: type.evidenceSource,
      providerOrderId: expected.providerOrderId,
      providerPaymentId: null,
      externalReference: expected.orderNumber,
      providerStatus: 'canceled',
      providerStatusDetail: 'canceled',
      amountArs: expected.totalArs,
      totalAmount: decimalString(order.totalAmount),
      totalPaidAmount: order.totalPaidAmount === null
        ? null
        : decimalString(order.totalPaidAmount),
      currency: expected.currency,
      observedAt,
      remoteClassification: type.remoteClassification,
      totalPaidAmountPresent: source.totalPaidAmountPresent,
      transactionsPresent: source.transactionsPresent,
      paymentsPresent: source.paymentsPresent,
      paymentsIsArray: source.paymentsIsArray,
      paymentCount: type.payments?.length ?? null,
      ...(type.payments !== undefined && { payments: type.payments }),
      paymentsSearch: veto,
      providerLastUpdatedDate: order.lastUpdatedDate || null,
      providerCancellationPayableStatus:
        type.evidenceSource === OWN_CANCELLATION_TERMINAL_UNPAID
          ? payment.providerCancellationPayableStatus
          : null,
      providerCancellationPayableObservedAt:
        type.evidenceSource === OWN_CANCELLATION_TERMINAL_UNPAID
          ? validDate(payment.providerCancellationPayableObservedAt)
          : null,
      providerCancellationIdempotencyKey:
        type.evidenceSource === OWN_CANCELLATION_TERMINAL_UNPAID
          ? payment.providerCancellationIdempotencyKey
          : null,
      providerCancellationAttemptedAt:
        type.evidenceSource === OWN_CANCELLATION_TERMINAL_UNPAID
          ? validDate(payment.providerCancellationAttemptedAt)
          : null,
      providerCancellationStatus:
        type.evidenceSource === OWN_CANCELLATION_TERMINAL_UNPAID
          ? payment.providerCancellationStatus
          : null,
      providerCancellationCompletedAt:
        type.evidenceSource === OWN_CANCELLATION_TERMINAL_UNPAID
          ? validDate(payment.providerCancellationCompletedAt)
          : null
    }
  }

  async getEvidence(input) {
    const expected = this.#expected(input)
    const firstOrder = await this.provider.getOrder(expected.providerOrderId)
    this.#assertOrderIdentity(firstOrder, expected)

    const veto = await this.#paymentsVeto(expected)
    const finalOrder = await this.provider.getOrder(expected.providerOrderId)
    this.#assertOrderIdentity(finalOrder, expected)

    const observedAt = this.#now()
    const classification = classifyRemoteOrder(finalOrder, {
      expectedProviderOrderId: expected.providerOrderId,
      expectedExternalReference: expected.orderNumber,
      expectedTotalAmount: expected.totalArs,
      expectedCurrency: expected.currency
    })

    let type = null
    if (classification === REMOTE_ORDER_CLASSIFICATIONS.TERMINAL_UNPAID) {
      type = this.#typeA(finalOrder, expected)
    } else if (
      classification === REMOTE_ORDER_CLASSIFICATIONS.CANCELED_PAYMENT_AGGREGATES_OMITTED
    ) {
      type = this.#typeB(finalOrder, expected, observedAt)
    }

    if (!type) {
      throw evidenceMismatch('Mercado Pago no demuestra de forma autoritativa ausencia de cobro')
    }

    return this.#buildEvidence(finalOrder, expected, observedAt, veto, type)
  }
}

export {
  MAX_SEARCH_RESULTS,
  MercadoPagoTerminalUnpaidEvidenceService,
  ORDERS_API_TERMINAL_UNPAID,
  OWN_CANCELLATION_TERMINAL_UNPAID,
  SEARCH_PAGE_SIZE,
  canonicalPaymentId
}
export default new MercadoPagoTerminalUnpaidEvidenceService()
