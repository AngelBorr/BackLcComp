import { randomUUID } from 'node:crypto'
import mongoose from 'mongoose'
import PaymentManager from '../dao/managers/payment.manager.js'
import MercadoPagoProvider, {
  MercadoPagoProviderError
} from '../providers/mercadoPago.provider.js'
import {
  REMOTE_ORDER_CLASSIFICATIONS,
  classifyRemoteOrder
} from './mercadoPagoOrderClassification.service.js'
import { ServiceError } from './service.products.js'

const asText = (value) => String(value ?? '').trim()
const CANCELABLE_REMOTE_STATUSES = new Set(['created', 'action_required'])

const isRemoteOrderCancelable = (providerOrder, classification) => (
  classification === REMOTE_ORDER_CLASSIFICATIONS.PAYABLE &&
  CANCELABLE_REMOTE_STATUSES.has(asText(providerOrder?.status).toLowerCase())
)

class MercadoPagoOrderCancellationService {
  constructor({
    paymentManager = PaymentManager,
    provider = MercadoPagoProvider,
    uuidFactory = randomUUID
  } = {}) {
    this.payments = paymentManager
    this.provider = provider
    this.uuidFactory = uuidFactory
  }

  #assertPaymentId(paymentId) {
    if (!mongoose.Types.ObjectId.isValid(paymentId)) {
      throw new ServiceError('ID de pago invalido', 'INVALID_PAYMENT_ID', 400)
    }
  }

  #assertCancelablePayment(payment) {
    if (!payment) throw new ServiceError('Pago no encontrado', 'PAYMENT_NOT_FOUND', 404)

    if (payment.provider !== 'mercado_pago') {
      throw new ServiceError(
        'El pago no pertenece a Mercado Pago',
        'PAYMENT_PROVIDER_NOT_SUPPORTED',
        409
      )
    }

    if (payment.normalizedStatus !== 'pending') {
      throw new ServiceError('El pago ya no esta pendiente', 'PAYMENT_NOT_PENDING', 409)
    }

    const providerOrderId = asText(payment.providerOrderId)
    if (!providerOrderId) {
      throw new ServiceError(
        'El pago no tiene una order de Mercado Pago asociada',
        'MERCADOPAGO_ORDER_REQUIRED',
        409
      )
    }

    return providerOrderId
  }

  #completedResult(payment, alreadyCompleted = false) {
    return {
      paymentId: String(payment._id),
      providerOrderId: asText(payment.providerOrderId),
      providerCancellationStatus: payment.providerCancellationStatus,
      alreadyCompleted
    }
  }

  #remoteResult(payment, providerOrder, classification) {
    return {
      paymentId: String(payment._id),
      providerOrderId: asText(payment.providerOrderId),
      providerCancellationStatus: payment.providerCancellationStatus,
      alreadyCompleted: false,
      alreadyCanceled: classification === REMOTE_ORDER_CLASSIFICATIONS.TERMINAL_UNPAID,
      outcome: classification === REMOTE_ORDER_CLASSIFICATIONS.TERMINAL_UNPAID
        ? 'terminal_unpaid'
        : 'not_cancelable',
      remoteClassification: classification,
      remoteStatus: asText(providerOrder?.status).toLowerCase()
    }
  }

  async #getCancelableRemoteOrder(payment, providerOrderId) {
    let providerOrder

    try {
      providerOrder = await this.provider.getOrder(providerOrderId)
    } catch (error) {
      if (error instanceof MercadoPagoProviderError) {
        throw new ServiceError(error.message, error.code, error.status)
      }

      throw new ServiceError(
        'No se pudo verificar la order de Mercado Pago antes de cancelarla',
        'MERCADOPAGO_UNAVAILABLE',
        503
      )
    }

    const classification = classifyRemoteOrder(providerOrder, {
      expectedProviderOrderId: providerOrderId,
      expectedExternalReference: payment.externalReference,
      expectedTotalAmount: payment.amountArs,
      expectedCurrency: payment.currency
    })

    if (isRemoteOrderCancelable(providerOrder, classification)) {
      return providerOrder
    }

    const result = this.#remoteResult(payment, providerOrder, classification)
    if (classification === REMOTE_ORDER_CLASSIFICATIONS.TERMINAL_UNPAID) {
      return { terminalResult: result }
    }

    throw new ServiceError(
      'La order de Mercado Pago no esta en un estado cancelable',
      'MERCADOPAGO_ORDER_NOT_CANCELABLE',
      409,
      {
        remoteClassification: result.remoteClassification,
        remoteStatus: result.remoteStatus
      }
    )
  }

  async #ensureAttempt(payment, providerOrderId) {
    const existingKey = asText(payment.providerCancellationIdempotencyKey)

    if (payment.providerCancellationStatus === 'succeeded') {
      return { completed: this.#completedResult(payment, true) }
    }

    if (payment.providerCancellationStatus === 'rejected') {
      throw new ServiceError(
        'Mercado Pago rechazo definitivamente la cancelacion de la order',
        'MERCADOPAGO_CANCELLATION_REJECTED',
        409
      )
    }

    if (existingKey) {
      if (existingKey.length > 128 || !['prepared', 'uncertain'].includes(
        payment.providerCancellationStatus
      )) {
        throw new ServiceError(
          'El intento de cancelacion almacenado es inconsistente',
          'MERCADOPAGO_CANCELLATION_CONFLICT',
          409
        )
      }

      return { payment, idempotencyKey: existingKey }
    }

    const idempotencyKey = asText(this.uuidFactory())
    if (!idempotencyKey || idempotencyKey.length > 128) {
      throw new ServiceError(
        'No se pudo generar la idempotencia de cancelacion',
        'MERCADOPAGO_CANCELLATION_CONFLICT',
        409
      )
    }

    const prepared = await this.payments.prepareProviderCancellationIfMissing(
      payment._id,
      providerOrderId,
      idempotencyKey
    )
    const current = prepared || await this.payments.getById(payment._id)

    if (current?.providerCancellationStatus === 'succeeded') {
      return { completed: this.#completedResult(current, true) }
    }

    const stableKey = asText(current?.providerCancellationIdempotencyKey)
    if (
      !current ||
      !stableKey ||
      stableKey.length > 128 ||
      !['prepared', 'uncertain'].includes(current.providerCancellationStatus)
    ) {
      throw new ServiceError(
        'No se pudo preparar la cancelacion idempotente',
        'MERCADOPAGO_CANCELLATION_CONFLICT',
        409
      )
    }

    return { payment: current, idempotencyKey: stableKey }
  }

  async #recordFailure(payment, idempotencyKey, error) {
    const definitive = error instanceof MercadoPagoProviderError &&
      error.failureKind === 'definitive_rejection'
    const status = definitive ? 'rejected' : 'uncertain'

    await this.payments.updateProviderCancellationStatus(
      payment._id,
      idempotencyKey,
      status
    )
  }

  async cancelPaymentOrder(paymentId, { now = new Date() } = {}) {
    this.#assertPaymentId(paymentId)
    const attemptedAt = new Date(now)

    if (Number.isNaN(attemptedAt.getTime())) {
      throw new ServiceError('Fecha de cancelacion invalida', 'INVALID_CANCELLATION_DATE', 400)
    }

    let payment = await this.payments.getById(paymentId)
    const providerOrderId = this.#assertCancelablePayment(payment)
    if (payment.providerCancellationStatus === 'succeeded') {
      return this.#completedResult(payment, true)
    }

    const remoteCheck = await this.#getCancelableRemoteOrder(payment, providerOrderId)
    if (remoteCheck?.terminalResult) return remoteCheck.terminalResult

    const attempt = await this.#ensureAttempt(payment, providerOrderId)

    if (attempt.completed) return attempt.completed

    payment = await this.payments.markProviderCancellationAttempt(
      payment._id,
      attempt.idempotencyKey,
      attemptedAt
    )

    if (!payment) {
      const current = await this.payments.getById(paymentId)
      if (current?.providerCancellationStatus === 'succeeded') {
        return this.#completedResult(current, true)
      }

      throw new ServiceError(
        'Se perdio el intento idempotente de cancelacion',
        'MERCADOPAGO_CANCELLATION_CONFLICT',
        409
      )
    }

    try {
      const providerOrder = await this.provider.cancelOrder(providerOrderId, {
        idempotencyKey: attempt.idempotencyKey
      })
      const classification = classifyRemoteOrder(providerOrder, {
        expectedProviderOrderId: providerOrderId,
        expectedExternalReference: payment.externalReference,
        expectedTotalAmount: payment.amountArs,
        expectedCurrency: payment.currency
      })

      if (
        classification !== REMOTE_ORDER_CLASSIFICATIONS.TERMINAL_UNPAID ||
        asText(providerOrder.status).toLowerCase() !== 'canceled'
      ) {
        throw new ServiceError(
          'Mercado Pago no confirmo una cancelacion terminal sin pago',
          'MERCADOPAGO_CANCELLATION_UNCONFIRMED',
          409
        )
      }

      const completed = await this.payments.updateProviderCancellationStatus(
        payment._id,
        attempt.idempotencyKey,
        'succeeded',
        { completedAt: attemptedAt }
      )

      if (!completed) {
        throw new ServiceError(
          'No se pudo confirmar localmente la cancelacion',
          'MERCADOPAGO_CANCELLATION_CONFLICT',
          409
        )
      }

      return this.#completedResult(completed)
    } catch (error) {
      try {
        await this.#recordFailure(payment, attempt.idempotencyKey, error)
      } catch {
        // El error original conserva la semantica fail-closed.
      }

      if (error instanceof ServiceError) throw error
      if (error instanceof MercadoPagoProviderError) {
        throw new ServiceError(error.message, error.code, error.status)
      }

      throw new ServiceError(
        'No se pudo cancelar la order de Mercado Pago',
        'MERCADOPAGO_UNAVAILABLE',
        503
      )
    }
  }
}

export { MercadoPagoOrderCancellationService }
export default new MercadoPagoOrderCancellationService()
