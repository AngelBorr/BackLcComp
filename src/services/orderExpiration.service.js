import mongoose from 'mongoose'
import OrderManager from '../dao/managers/order.manager.js'
import PaymentManager from '../dao/managers/payment.manager.js'
import ProductUnitManager from '../dao/managers/productUnit.manager.js'
import ProductUnitService from './productUnit.service.js'
import { REMOTE_ORDER_CLASSIFICATIONS } from './mercadoPagoOrderClassification.service.js'
import { ServiceError } from './service.products.js'
import { toMinorUnits } from '../utils/commerceMoney.js'
import { error as logError, secureLog } from '../utils/logger.js'

const TRANSACTION_OPTIONS = Object.freeze({
  readConcern: { level: 'snapshot' },
  writeConcern: { w: 'majority' }
})

const EXPIRATION_REASON = 'PAYMENT_WINDOW_EXPIRED_UNPAID'
const INTEGRITY_REASON = 'RESERVATION_INTEGRITY_CONFLICT'
const CONTEXTUAL_CANCELLATION_SOURCE = 'worker_cancellation_chain'

const asText = (value) => String(value ?? '').trim()
const sameId = (left, right) => String(left ?? '') === String(right ?? '')
const sameMoney = (left, right) => {
  try {
    return toMinorUnits(left) === toMinorUnits(right)
  } catch {
    return false
  }
}

class OrderExpirationService {
  constructor({
    mongooseInstance = mongoose,
    orderManager = OrderManager,
    paymentManager = PaymentManager,
    productUnitManager = ProductUnitManager,
    productUnitService = ProductUnitService
  } = {}) {
    this.mongoose = mongooseInstance
    this.orders = orderManager
    this.payments = paymentManager
    this.productUnitManager = productUnitManager
    this.productUnits = productUnitService
  }

  #objectId(value, code, message) {
    if (!mongoose.Types.ObjectId.isValid(value)) {
      throw new ServiceError(message, code, 400)
    }
    return value
  }

  #owner(value) {
    const ownerToken = asText(value)
    if (!ownerToken || ownerToken.length > 128) {
      throw new ServiceError(
        'Owner de reconciliación inválido',
        'INVALID_RECONCILIATION_OWNER',
        400
      )
    }
    return ownerToken
  }

  #evidence(value, { orderId, paymentId }) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
      throw new ServiceError(
        'Evidencia terminal inválida',
        'INVALID_TERMINAL_UNPAID_EVIDENCE',
        400
      )
    }

    const providerOrderId = asText(value.providerOrderId)
    const remoteStatus = asText(value.remoteStatus).toLowerCase()
    const observedAt = new Date(value.observedAt)

    if (
      value.classification !== REMOTE_ORDER_CLASSIFICATIONS.TERMINAL_UNPAID ||
      remoteStatus !== 'canceled' ||
      !providerOrderId ||
      Number.isNaN(observedAt.getTime()) ||
      !sameId(value.orderId, orderId) ||
      !sameId(value.paymentId, paymentId)
    ) {
      throw new ServiceError(
        'La evidencia no confirma un impago terminal para esta operación',
        'INVALID_TERMINAL_UNPAID_EVIDENCE',
        409
      )
    }

    let cancellationContext = null

    if (value.source === CONTEXTUAL_CANCELLATION_SOURCE) {
      const context = value.cancellationContext
      const attemptedAt = context?.providerCancellationAttemptedAt == null
        ? null
        : new Date(context.providerCancellationAttemptedAt)
      const payableObservedAt = context?.providerCancellationPayableObservedAt == null
        ? null
        : new Date(context.providerCancellationPayableObservedAt)
      const idempotencyKey = asText(context?.providerCancellationIdempotencyKey)
      const cancellationStatus = asText(context?.providerCancellationStatus)
      const payableStatus = asText(context?.providerCancellationPayableStatus).toLowerCase()
      const verifiedExternalReference = asText(context?.verifiedExternalReference)
      const verifiedAmountArs = asText(context?.verifiedAmountArs)
      const verifiedCurrency = asText(context?.verifiedCurrency).toUpperCase()

      if (
        !idempotencyKey ||
        idempotencyKey.length > 128 ||
        !['uncertain', 'succeeded'].includes(cancellationStatus) ||
        !['created', 'action_required'].includes(payableStatus) ||
        !verifiedExternalReference ||
        !verifiedAmountArs ||
        verifiedCurrency !== 'ARS' ||
        !attemptedAt ||
        !payableObservedAt ||
        Number.isNaN(attemptedAt.getTime()) ||
        Number.isNaN(payableObservedAt.getTime()) ||
        payableObservedAt.getTime() > attemptedAt.getTime() ||
        observedAt.getTime() < attemptedAt.getTime()
      ) {
        throw new ServiceError(
          'La evidencia contextual de cancelacion es invalida',
          'INVALID_TERMINAL_UNPAID_EVIDENCE',
          409
        )
      }

      cancellationContext = {
        providerCancellationIdempotencyKey: idempotencyKey,
        providerCancellationStatus: cancellationStatus,
        providerCancellationAttemptedAt: attemptedAt,
        providerCancellationPayableStatus: payableStatus,
        providerCancellationPayableObservedAt: payableObservedAt,
        verifiedExternalReference,
        verifiedAmountArs,
        verifiedCurrency
      }
    } else if (value.source != null) {
      throw new ServiceError(
        'La fuente de evidencia terminal es invalida',
        'INVALID_TERMINAL_UNPAID_EVIDENCE',
        409
      )
    }

    return {
      providerOrderId,
      classification: value.classification,
      remoteStatus,
      observedAt,
      orderId: String(orderId),
      paymentId: String(paymentId),
      cancellationContext
    }
  }

  async #runTransaction(operation) {
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

  async #alreadyExpired(order, paymentId, session) {
    const payment = await this.payments.getLatestByOrderId(order._id, { session })
    const units = await this.productUnitManager.findUnitsByOrderReferences(order._id, { session })
    const reservedUnits = units.filter((unit) => unit.status === 'reserved')

    if (
      !payment ||
      !sameId(payment._id, paymentId) ||
      payment.normalizedStatus !== 'cancelled' ||
      order.fulfillmentStatus !== 'cancelled' ||
      reservedUnits.length > 0
    ) {
      throw new ServiceError(
        'La expiración previa quedó en un estado inconsistente',
        'ORDER_EXPIRATION_TERMINAL_STATE_CONFLICT',
        409
      )
    }

    return {
      outcome: 'already_expired',
      orderId: String(order._id),
      paymentId: String(payment._id),
      releasedCount: 0,
      productIds: []
    }
  }

  #assertPaymentEvidence(payment, { orderId, paymentId, evidence }) {
    const observedAt = new Date(payment?.lastProviderCheckAt)
    const context = evidence.cancellationContext
    const attemptedAt = payment?.providerCancellationAttemptedAt == null
      ? null
      : new Date(payment.providerCancellationAttemptedAt)
    const payableObservedAt = payment?.providerCancellationPayableObservedAt == null
      ? null
      : new Date(payment.providerCancellationPayableObservedAt)
    const contextualEvidenceMismatch = Boolean(context && (
      payment.providerCancellationIdempotencyKey !==
        context.providerCancellationIdempotencyKey ||
      payment.providerCancellationStatus !== context.providerCancellationStatus ||
      !attemptedAt ||
      attemptedAt.getTime() !== context.providerCancellationAttemptedAt.getTime() ||
      payment.providerCancellationPayableStatus !==
        context.providerCancellationPayableStatus ||
      !payableObservedAt ||
      payableObservedAt.getTime() !==
        context.providerCancellationPayableObservedAt.getTime() ||
      asText(payment.externalReference) !== context.verifiedExternalReference ||
      !sameMoney(payment.amountArs, context.verifiedAmountArs) ||
      asText(payment.currency).toUpperCase() !== context.verifiedCurrency
    ))

    if (
      !payment ||
      !sameId(payment._id, paymentId) ||
      !sameId(payment.orderId, orderId) ||
      payment.provider !== 'mercado_pago' ||
      payment.normalizedStatus !== 'pending' ||
      !sameId(payment.providerOrderId, evidence.providerOrderId) ||
      payment.providerPaymentId != null ||
      payment.approvedAt != null ||
      asText(payment.providerStatus).toLowerCase() !== evidence.remoteStatus ||
      Number.isNaN(observedAt.getTime()) ||
      observedAt.getTime() !== evidence.observedAt.getTime() ||
      contextualEvidenceMismatch
    ) {
      throw new ServiceError(
        'El pago cambió o ya no coincide con la evidencia terminal',
        'PAYMENT_EXPIRATION_CONFLICT',
        409
      )
    }
  }

  async #transitionPayment(paymentId, orderId, evidence, nextStatus, session) {
    const payment = await this.payments.transitionPendingWithTerminalUnpaidObservation(
      paymentId,
      {
        orderId,
        providerOrderId: evidence.providerOrderId,
        observedAt: evidence.observedAt,
        nextStatus,
        cancellationContext: evidence.cancellationContext
      },
      { session }
    )

    if (!payment) {
      throw new ServiceError(
        'El pago cambió durante la expiración',
        'PAYMENT_EXPIRATION_CONFLICT',
        409
      )
    }

    return payment
  }

  async expirePendingOrderWithTerminalUnpaidEvidence({
    orderId,
    paymentId,
    ownerToken,
    terminalEvidence,
    now = new Date()
  } = {}) {
    const normalizedOrderId = this.#objectId(
      orderId,
      'INVALID_ORDER_ID',
      'ID de orden inválido'
    )
    const normalizedPaymentId = this.#objectId(
      paymentId,
      'INVALID_PAYMENT_ID',
      'ID de pago inválido'
    )
    const normalizedOwner = this.#owner(ownerToken)
    const changedAt = new Date(now)

    if (Number.isNaN(changedAt.getTime())) {
      throw new ServiceError('Fecha de expiración inválida', 'INVALID_EXPIRATION_DATE', 400)
    }

    const evidence = this.#evidence(terminalEvidence, {
      orderId: normalizedOrderId,
      paymentId: normalizedPaymentId
    })

    try {
      const result = await this.#runTransaction(async (session) => {
        const initialOrder = await this.orders.getById(normalizedOrderId, { session })

        if (!initialOrder) {
          throw new ServiceError('Orden no encontrada', 'ORDER_NOT_FOUND', 404)
        }

        if (initialOrder.status === 'expired') {
          return this.#alreadyExpired(initialOrder, normalizedPaymentId, session)
        }

        const order = await this.orders.assertReconciliationOwnership(
          {
            orderId: normalizedOrderId,
            ownerToken: normalizedOwner,
            now: changedAt
          },
          { session }
        )

        if (!order) {
          throw new ServiceError(
            'El claim de reconciliación ya no pertenece al worker',
            'RECONCILIATION_CLAIM_LOST',
            409
          )
        }

        if (order.reservationExpiresAt == null) {
          throw new ServiceError(
            'La reserva de la orden todav\u00eda no venci\u00f3',
            'ORDER_RESERVATION_NOT_EXPIRED',
            409
          )
        }

        const reservationExpiration = new Date(order.reservationExpiresAt)
        if (
          Number.isNaN(reservationExpiration.getTime()) ||
          reservationExpiration.getTime() > changedAt.getTime()
        ) {
          throw new ServiceError(
            'La reserva de la orden todavía no venció',
            'ORDER_RESERVATION_NOT_EXPIRED',
            409
          )
        }

        if (evidence.cancellationContext && (
          asText(order.orderNumber) !==
            evidence.cancellationContext.verifiedExternalReference ||
          !sameMoney(
            order.totals?.totalArs,
            evidence.cancellationContext.verifiedAmountArs
          )
        )) {
          throw new ServiceError(
            'La identidad monetaria de la orden cambio antes de expirar',
            'PAYMENT_EXPIRATION_CONFLICT',
            409
          )
        }

        const payment = await this.payments.getLatestByOrderId(normalizedOrderId, { session })
        this.#assertPaymentEvidence(payment, {
          orderId: normalizedOrderId,
          paymentId: normalizedPaymentId,
          evidence
        })

        const inventory = await this.productUnits.releaseOrderReservationsForExpiration(
          {
            orderId: normalizedOrderId,
            expirationLimit: changedAt
          },
          { session }
        )

        if (!inventory.valid) {
          const attentionPayment = await this.#transitionPayment(
            normalizedPaymentId,
            normalizedOrderId,
            evidence,
            'requires_attention',
            session
          )
          const attentionOrder = await this.orders.markExpirationIntegrityAttention(
            normalizedOrderId,
            normalizedOwner,
            { changedAt, reason: INTEGRITY_REASON },
            { session }
          )

          if (!attentionOrder) {
            throw new ServiceError(
              'La orden cambió durante la derivación a atención',
              'ORDER_EXPIRATION_CONFLICT',
              409
            )
          }

          return {
            outcome: 'requires_attention',
            reason: INTEGRITY_REASON,
            orderId: String(attentionOrder._id),
            paymentId: String(attentionPayment._id),
            releasedCount: 0,
            productIds: []
          }
        }

        const cancelledPayment = await this.#transitionPayment(
          normalizedPaymentId,
          normalizedOrderId,
          evidence,
          'cancelled',
          session
        )
        const expiredOrder = await this.orders.expirePendingPaymentOrder(
          normalizedOrderId,
          normalizedOwner,
          { changedAt, reason: EXPIRATION_REASON },
          { session }
        )

        if (!expiredOrder) {
          throw new ServiceError(
            'La orden cambió durante la expiración',
            'ORDER_EXPIRATION_CONFLICT',
            409
          )
        }

        return {
          outcome: 'expired',
          orderId: String(expiredOrder._id),
          paymentId: String(cancelledPayment._id),
          releasedCount: inventory.releasedCount,
          productIds: inventory.productIds
        }
      })

      secureLog('Order expiration domain command completed', {
        orderId: normalizedOrderId,
        paymentId: normalizedPaymentId,
        outcome: result.outcome,
        releasedCount: result.releasedCount
      })

      return result
    } catch (error) {
      logError('Order expiration domain command failed', {
        orderId: normalizedOrderId,
        paymentId: normalizedPaymentId,
        code: error?.code || 'ORDER_EXPIRATION_FAILED'
      })

      if (error instanceof ServiceError) throw error

      throw new ServiceError(
        'No se pudo completar la expiración segura de la orden',
        'ORDER_EXPIRATION_FAILED',
        500,
        { cause: error?.message }
      )
    }
  }
}

export {
  OrderExpirationService,
  TRANSACTION_OPTIONS,
  EXPIRATION_REASON,
  INTEGRITY_REASON
}
export default new OrderExpirationService()
