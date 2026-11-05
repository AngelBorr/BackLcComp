import { createHash } from 'node:crypto'
import mongoose from 'mongoose'
import OrderManager from '../dao/managers/order.manager.js'
import PaymentManager from '../dao/managers/payment.manager.js'
import PaymentRefundManager from '../dao/managers/paymentRefund.manager.js'
import MercadoPagoProvider, {
  MercadoPagoProviderError
} from '../providers/mercadoPago.provider.js'
import PaymentRefundReconciliationService from './paymentRefundReconciliation.service.js'
import { ServiceError } from './service.products.js'
import { toMinorUnits } from '../utils/commerceMoney.js'
import {
  classifyRefundPreflight,
  REFUND_PREFLIGHT_OUTCOMES
} from './mercadoPagoRefundClassification.service.js'

const TRANSACTION_OPTIONS = Object.freeze({
  readConcern: { level: 'snapshot' },
  writeConcern: { w: 'majority' }
})

const REASON_CODES = new Set([
  'customer_request',
  'out_of_stock',
  'order_cannot_be_fulfilled',
  'duplicate_payment',
  'admin_correction',
  'other'
])
const BODY_FIELDS = new Set(['type', 'reasonCode', 'note'])
const IDEMPOTENCY_PATTERN = /^[A-Za-z0-9._:-]{8,128}$/

const plain = (document) => typeof document?.toObject === 'function'
  ? document.toObject()
  : document
const text = (value) => String(value ?? '').trim()
const sameMoney = (left, right) => {
  try {
    return toMinorUnits(left) === toMinorUnits(right)
  } catch {
    return false
  }
}
const refundDto = (refund, { idempotent = false } = {}) => ({
  refundId: String(refund._id),
  orderId: String(refund.orderId),
  paymentId: String(refund.paymentId),
  type: refund.type,
  status: refund.status,
  requestedAmountArs: refund.requestedAmountArs?.toString?.() || String(refund.requestedAmountArs),
  confirmedAmountArs: refund.confirmedAmountArs?.toString?.() || null,
  currency: refund.currency,
  providerRefundId: refund.providerRefundId || null,
  origin: refund.origin,
  requestedAt: refund.requestedAt,
  completedAt: refund.completedAt || null,
  reasonCode: refund.reasonCode,
  note: refund.note,
  idempotent
})

class PaymentRefundService {
  constructor({
    mongooseInstance = mongoose,
    orderManager = OrderManager,
    paymentManager = PaymentManager,
    paymentRefundManager = PaymentRefundManager,
    provider = MercadoPagoProvider,
    reconciliationService = PaymentRefundReconciliationService
  } = {}) {
    this.mongoose = mongooseInstance
    this.orders = orderManager
    this.payments = paymentManager
    this.refunds = paymentRefundManager
    this.provider = provider
    this.reconciliation = reconciliationService
  }

  async #transaction(operation) {
    const session = await this.mongoose.startSession()
    let result
    try {
      await session.withTransaction(async () => {
        result = await operation(session)
      }, TRANSACTION_OPTIONS)
      return result
    } finally {
      await session.endSession()
    }
  }

  #normalizeInput({ orderNumber, idempotencyKey, body, adminUserId, adminRole }) {
    const normalizedOrderNumber = text(orderNumber).toUpperCase()
    const normalizedKey = text(idempotencyKey)
    const role = text(adminRole).toUpperCase()
    const source = body && typeof body === 'object' && !Array.isArray(body) ? body : {}
    const extraFields = Object.keys(source).filter((key) => !BODY_FIELDS.has(key))

    if (!/^LC-\d{4}-\d{6,}$/.test(normalizedOrderNumber)) {
      throw new ServiceError('Numero de orden invalido', 'INVALID_ORDER_NUMBER', 400)
    }
    if (!['ADMIN', 'SUPERADMIN'].includes(role) || !mongoose.Types.ObjectId.isValid(adminUserId)) {
      throw new ServiceError('Acceso administrativo requerido', 'ORDERS_ADMIN_FORBIDDEN', 403)
    }
    if (!IDEMPOTENCY_PATTERN.test(normalizedKey)) {
      throw new ServiceError('Idempotency-Key invalida', 'REFUND_IDEMPOTENCY_KEY_INVALID', 400)
    }
    if (extraFields.length) {
      throw new ServiceError('El request contiene campos no permitidos', 'REFUND_REQUEST_FIELDS_INVALID', 400)
    }

    const type = text(source.type).toLowerCase()
    const reasonCode = text(source.reasonCode).toLowerCase()
    const note = text(source.note)
    if (type !== 'total') {
      throw new ServiceError('Solo se admite reembolso total', 'REFUND_TYPE_NOT_SUPPORTED', 400)
    }
    if (!REASON_CODES.has(reasonCode)) {
      throw new ServiceError('Motivo de reembolso invalido', 'REFUND_REASON_INVALID', 400)
    }
    if (note.length > 500) {
      throw new ServiceError('Nota de reembolso demasiado extensa', 'REFUND_NOTE_INVALID', 400)
    }

    return {
      orderNumber: normalizedOrderNumber,
      idempotencyKey: normalizedKey,
      type,
      reasonCode,
      note,
      adminUserId,
      adminRole: role
    }
  }

  #requestHash(input, orderId) {
    return createHash('sha256').update(JSON.stringify({
      orderNumber: input.orderNumber,
      orderId: String(orderId),
      type: input.type,
      reasonCode: input.reasonCode,
      note: input.note
    })).digest('hex')
  }

  #assertLocalEligibility(order, payment) {
    if (order.status !== 'paid') {
      throw new ServiceError('La orden no esta pagada', 'REFUND_ORDER_NOT_PAID', 409)
    }
    if (payment?.normalizedStatus !== 'approved' || !payment.approvedAt) {
      throw new ServiceError('El pago no esta aprobado', 'REFUND_PAYMENT_NOT_APPROVED', 409)
    }
    if (
      payment.provider !== 'mercado_pago' ||
      !text(payment.providerOrderId) ||
      !text(payment.providerPaymentId)
    ) {
      throw new ServiceError('Identidad de pago incompleta', 'REFUND_PAYMENT_IDENTITY_INVALID', 409)
    }
    if (
      payment.currency !== 'ARS' ||
      order.paymentCurrency !== 'ARS' ||
      !sameMoney(order.totals?.totalArs, payment.amountArs)
    ) {
      throw new ServiceError('Importe o moneda local inconsistente', 'REFUND_LOCAL_AMOUNT_MISMATCH', 409)
    }
  }

  #assertProviderPreflight(providerOrder, order, payment) {
    const classification = classifyRefundPreflight(providerOrder, {
      providerOrderId: payment.providerOrderId,
      providerPaymentId: payment.providerPaymentId,
      externalReference: order.orderNumber,
      amount: payment.amountArs,
      currency: payment.currency
    })

    if (classification.outcome !== REFUND_PREFLIGHT_OUTCOMES.VALID) {
      const error = new ServiceError(
        'La evidencia financiera remota no habilita un reembolso',
        classification.outcome === REFUND_PREFLIGHT_OUTCOMES.REMOTE_REFUND_OBSERVED
          ? 'REFUND_ALREADY_OBSERVED'
          : 'REFUND_PREFLIGHT_MISMATCH',
        409
      )
      error.refundPreflightReason = classification.reason
      throw error
    }
  }

  #isPreSubmissionRecoveryCandidate(refund) {
    return refund?.origin === 'admin' &&
      refund.status === 'requires_attention' &&
      refund.operationScope === 'total_refund' &&
      refund.submittedAt === null &&
      refund.providerRefundId === null &&
      refund.providerStatus === null &&
      refund.providerStatusDetail === null &&
      refund.providerEvidenceSnapshot === null &&
      refund.attemptOwnerToken === null &&
      refund.attemptLeaseUntil === null &&
      refund.sanitizedError?.code === 'REFUND_PREFLIGHT_MISMATCH' &&
      (
        refund.sanitizedError?.providerCode == null ||
        refund.sanitizedError.providerCode === 'PROVIDER_REFUNDS_PROVENANCE_MISSING'
      ) &&
      Boolean(text(refund.providerIdempotencyKey))
  }

  async #recoverPreSubmissionFailure(refundId) {
    return this.#transaction(async (session) => {
      const refund = await this.refunds.getById(refundId, { session })
      const order = refund && await this.orders.getById(refund.orderId, { session })
      const payment = refund && await this.payments.getById(refund.paymentId, { session })

      if (!refund || !order || !payment || !this.#isPreSubmissionRecoveryCandidate(refund)) {
        throw new ServiceError(
          'El reembolso no admite recuperacion pre-envio',
          'REFUND_RECOVERY_NOT_ALLOWED',
          409
        )
      }
      this.#assertLocalEligibility(order, payment)
      const snapshot = refund.providerRequestSnapshot
      if (
        String(order.activeRefundId || '') !== String(refund._id) ||
        String(refund.orderId) !== String(order._id) ||
        String(refund.paymentId) !== String(payment._id) ||
        refund.providerOrderId !== payment.providerOrderId ||
        refund.providerPaymentId !== payment.providerPaymentId ||
        refund.currency !== payment.currency ||
        !sameMoney(refund.requestedAmountArs, payment.amountArs) ||
        snapshot?.method !== 'POST' ||
        snapshot?.path !== `/v1/orders/${payment.providerOrderId}/refund` ||
        snapshot?.providerOrderId !== payment.providerOrderId ||
        snapshot?.externalReference !== order.orderNumber ||
        snapshot?.currency !== payment.currency ||
        !sameMoney(snapshot?.totalAmount, payment.amountArs)
      ) {
        throw new ServiceError(
          'El contexto local no admite recuperacion pre-envio',
          'REFUND_RECOVERY_NOT_ALLOWED',
          409
        )
      }

      const recovered = await this.refunds.recoverPreSubmissionFailure(
        refund._id,
        {
          expectedVersion: refund.version,
          orderId: refund.orderId,
          paymentId: refund.paymentId,
          idempotencyKey: refund.idempotencyKey,
          requestHash: refund.requestHash,
          providerIdempotencyKey: refund.providerIdempotencyKey,
          providerOrderId: refund.providerOrderId,
          providerPaymentId: refund.providerPaymentId,
          requestedAmountArs: refund.requestedAmountArs,
          currency: refund.currency
        },
        { session }
      )
      if (!recovered) {
        throw new ServiceError(
          'Conflicto al recuperar el reembolso',
          'REFUND_RECOVERY_CONFLICT',
          409
        )
      }
      return { order, payment, refund: recovered, existing: true }
    })
  }

  async #createPrepared(input, now) {
    return this.#transaction(async (session) => {
      const order = await this.orders.getByOrderNumber(input.orderNumber, { session })
      if (!order) throw new ServiceError('Orden no encontrada', 'ORDER_NOT_FOUND', 404)
      const hash = this.#requestHash(input, order._id)
      const existing = await this.refunds.getByOrderAndIdempotencyKey(
        order._id,
        input.idempotencyKey,
        { session }
      )
      if (existing) {
        if (existing.requestHash !== hash) {
          throw new ServiceError(
            'La clave de idempotencia corresponde a otra solicitud',
            'REFUND_IDEMPOTENCY_CONFLICT',
            409
          )
        }
        const existingPayment = await this.payments.getLatestByOrderId(order._id, { session })
        return { order, payment: existingPayment, refund: existing, existing: true }
      }

      const payment = await this.payments.getLatestByOrderId(order._id, { session })
      this.#assertLocalEligibility(order, payment)

      const active = await this.refunds.getActiveByPaymentId(payment._id, { session })
      if (active || order.activeRefundId) {
        throw new ServiceError('Ya existe un reembolso total', 'REFUND_ALREADY_EXISTS', 409)
      }

      const refundId = new mongoose.Types.ObjectId()
      const providerIdempotencyKey = `refund-${refundId}`
      const created = plain(await this.refunds.create({
        _id: refundId,
        orderId: order._id,
        paymentId: payment._id,
        provider: 'mercado_pago',
        providerOrderId: payment.providerOrderId,
        providerPaymentId: payment.providerPaymentId,
        type: 'total',
        requestedAmountArs: payment.amountArs,
        confirmedAmountArs: null,
        currency: payment.currency,
        status: 'prepared',
        idempotencyKey: input.idempotencyKey,
        providerIdempotencyKey,
        requestHash: hash,
        operationScope: 'total_refund',
        providerRequestSnapshot: {
          method: 'POST',
          path: `/v1/orders/${payment.providerOrderId}/refund`,
          body: null,
          providerOrderId: payment.providerOrderId,
          externalReference: order.orderNumber,
          totalAmount: payment.amountArs.toString(),
          currency: payment.currency
        },
        origin: 'admin',
        requestedBy: input.adminUserId,
        requestedByRole: input.adminRole,
        reasonCode: input.reasonCode,
        note: input.note,
        requestedAt: now
      }, { session }))
      const fenced = await this.orders.attachActiveRefund(order._id, refundId, { session })
      if (!fenced) {
        throw new ServiceError('La orden cambio durante el reembolso', 'REFUND_ORDER_CONFLICT', 409)
      }
      return { order: fenced, payment, refund: created, existing: false }
    })
  }

  async #markProviderFailure(refund, error, now) {
    const sanitizedError = {
      code: text(error.code).slice(0, 100),
      message: 'No se pudo confirmar el reembolso con Mercado Pago',
      providerHttpStatus: Number.isInteger(error.providerHttpStatus)
        ? error.providerHttpStatus
        : null,
      providerCode: text(error.providerCode).slice(0, 100) || null
    }

    if (error.failureKind === 'definitive_rejection') {
      return this.#transaction(async (session) => {
        const rejected = await this.refunds.markRejected(
          refund._id,
          ['submitted'],
          { completedAt: now, lastProviderCheckAt: now, sanitizedError },
          { session }
        )
        const cleared = rejected && await this.orders.clearActiveRefund(
          refund.orderId,
          refund._id,
          { session }
        )
        if (!rejected || !cleared) {
          throw new ServiceError('Conflicto al rechazar el reembolso', 'REFUND_REJECTION_CONFLICT', 409)
        }
        return rejected
      })
    }

    return this.refunds.transition(
      refund._id,
      ['submitted', 'processing'],
      { status: 'processing', sanitizedError },
      {}
    )
  }

  async #markSubmitted(refundId, submittedAt) {
    return this.#transaction(async (session) => {
      const refund = await this.refunds.getById(refundId, { session })
      const order = refund && await this.orders.getById(refund.orderId, { session })
      const payment = refund && await this.payments.getById(refund.paymentId, { session })

      if (!refund || !order || !payment) {
        throw new ServiceError('Contexto local de reembolso incompleto', 'REFUND_LOCAL_CONTEXT_MISSING', 409)
      }
      this.#assertLocalEligibility(order, payment)
      if (
        refund.status !== 'prepared' ||
        String(order.activeRefundId || '') !== String(refund._id) ||
        refund.providerOrderId !== payment.providerOrderId ||
        refund.providerPaymentId !== payment.providerPaymentId ||
        refund.currency !== payment.currency ||
        !sameMoney(refund.requestedAmountArs, payment.amountArs)
      ) {
        throw new ServiceError(
          'El contexto local cambio antes del envio',
          'REFUND_SUBMISSION_CONFLICT',
          409
        )
      }

      const submitted = await this.refunds.transition(
        refund._id,
        ['prepared'],
        { status: 'submitted', submittedAt, lastProviderCheckAt: submittedAt },
        { session }
      )
      if (!submitted) {
        throw new ServiceError('Conflicto al enviar el reembolso', 'REFUND_SUBMISSION_CONFLICT', 409)
      }
      return submitted
    })
  }

  async requestTotalRefund(args, { now = new Date() } = {}) {
    const input = this.#normalizeInput(args)
    const requestedAt = new Date(now)
    if (Number.isNaN(requestedAt.getTime())) {
      throw new ServiceError('Fecha de reembolso invalida', 'INVALID_REFUND_DATE', 400)
    }

    let context
    try {
      context = await this.#createPrepared(input, requestedAt)
    } catch (error) {
      const duplicate = error?.code === 11000 || error?.errorResponse?.code === 11000
      if (!duplicate) throw error

      const order = await this.orders.getByOrderNumber(input.orderNumber)
      const existing = order && await this.refunds.getByOrderAndIdempotencyKey(
        order._id,
        input.idempotencyKey
      )
      if (!existing) {
        throw new ServiceError('Ya existe un reembolso total', 'REFUND_ALREADY_EXISTS', 409)
      }
      if (existing.requestHash !== this.#requestHash(input, order._id)) {
        throw new ServiceError(
          'La clave de idempotencia corresponde a otra solicitud',
          'REFUND_IDEMPOTENCY_CONFLICT',
          409
        )
      }
      context = {
        order,
        payment: await this.payments.getLatestByOrderId(order._id),
        refund: existing,
        existing: true
      }
    }
    let refund = context.refund
    if (refund.status === 'succeeded' || refund.status === 'rejected') {
      return { ...refundDto(refund, { idempotent: true }), httpStatus: 200 }
    }
    const recoverablePreSubmission = context.existing &&
      this.#isPreSubmissionRecoveryCandidate(refund)
    if (context.existing && refund.status !== 'prepared' && !recoverablePreSubmission) {
      const result = await this.reconciliation.reconcileRefund(refund._id, { now: requestedAt })
      return { ...refundDto(result.refund, { idempotent: true }), httpStatus: result.outcome === 'processing' ? 202 : 200 }
    }

    this.#assertLocalEligibility(context.order, context.payment)
    if (String(context.order.activeRefundId || '') !== String(refund._id)) {
      throw new ServiceError('La orden perdio el fencing del reembolso', 'REFUND_ORDER_CONFLICT', 409)
    }

    let preflight
    try {
      preflight = await this.provider.getOrder(refund.providerOrderId)
      this.#assertProviderPreflight(preflight, context.order, context.payment)
    } catch (error) {
      if (error?.code === 'REFUND_ALREADY_OBSERVED') {
        const result = await this.reconciliation.reconcileRefund(refund._id, {
          now: requestedAt,
          providerOrder: preflight
        })
        return { ...refundDto(result.refund, { idempotent: context.existing }), httpStatus: result.outcome === 'succeeded' ? 200 : 202 }
      }
      if (error instanceof MercadoPagoProviderError) {
        throw new ServiceError(error.message, error.code, error.status)
      }
      if (error instanceof ServiceError) {
        if (refund.status === 'prepared') {
          await this.refunds.transition(
            refund._id,
            ['prepared'],
            {
              status: 'requires_attention',
              lastProviderCheckAt: requestedAt,
              sanitizedError: {
                code: error.code,
                message: error.message,
                providerCode: error.refundPreflightReason || null
              }
            }
          )
        }
      }
      throw error
    }

    if (recoverablePreSubmission) {
      context = await this.#recoverPreSubmissionFailure(refund._id)
      refund = context.refund
    }

    refund = await this.#markSubmitted(refund._id, requestedAt)

    try {
      await this.provider.refundOrder(refund.providerOrderId, {
        idempotencyKey: refund.providerIdempotencyKey
      })
    } catch (error) {
      if (!(error instanceof MercadoPagoProviderError)) throw error
      await this.#markProviderFailure(refund, error, requestedAt)
      if (error.failureKind !== 'definitive_rejection') {
        try {
          const recovered = await this.reconciliation.reconcileRefund(refund._id, { now: requestedAt })
          if (recovered.outcome === 'succeeded') {
            return { ...refundDto(recovered.refund), httpStatus: 200 }
          }
        } catch {
          // El error original conserva la taxonomia HTTP; el Refund queda no terminal.
        }
      }
      throw new ServiceError(error.message, error.code, error.status)
    }

    try {
      const result = await this.reconciliation.reconcileRefund(refund._id, { now: requestedAt })
      return {
        ...refundDto(result.refund, { idempotent: context.existing }),
        httpStatus: result.outcome === 'succeeded' ? 200 : 202
      }
    } catch (error) {
      await this.refunds.transition(
        refund._id,
        ['submitted', 'processing'],
        {
          status: 'processing',
          sanitizedError: {
            code: text(error?.code || 'REFUND_RECONCILIATION_UNAVAILABLE').slice(0, 100),
            message: 'El reembolso fue enviado y requiere reconciliacion'
          }
        }
      )
      throw error
    }
  }

  async reconcile({ orderNumber, refundId, adminUserId, adminRole }, { now = new Date() } = {}) {
    if (!['ADMIN', 'SUPERADMIN'].includes(text(adminRole).toUpperCase()) ||
      !mongoose.Types.ObjectId.isValid(adminUserId)) {
      throw new ServiceError('Acceso administrativo requerido', 'ORDERS_ADMIN_FORBIDDEN', 403)
    }
    const order = await this.orders.getByOrderNumber(text(orderNumber).toUpperCase())
    if (!order) throw new ServiceError('Orden no encontrada', 'ORDER_NOT_FOUND', 404)
    if (!mongoose.Types.ObjectId.isValid(refundId)) {
      throw new ServiceError('Reembolso no encontrado', 'REFUND_NOT_FOUND', 404)
    }
    const refund = await this.refunds.getById(refundId)
    if (!refund || String(refund.orderId) !== String(order._id)) {
      throw new ServiceError('Reembolso no encontrado', 'REFUND_NOT_FOUND', 404)
    }
    const result = await this.reconciliation.reconcileRefund(refund._id, { now })
    return {
      ...refundDto(result.refund, { idempotent: result.idempotent }),
      httpStatus: result.outcome === 'processing' ? 202 : 200
    }
  }
}

export { PaymentRefundService, REASON_CODES, refundDto }
export default new PaymentRefundService()
