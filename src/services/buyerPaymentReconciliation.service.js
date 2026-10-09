import mongoose from 'mongoose'
import OrderManager from '../dao/managers/order.manager.js'
import PaymentManager from '../dao/managers/payment.manager.js'
import MercadoPagoReconciliationService from './mercadoPagoReconciliation.service.js'
import { ServiceError } from './service.products.js'
import { getEffectiveFulfillmentStatus } from '../utils/orderFulfillment.js'

const ORDER_NUMBER_PATTERN = /^LC-\d{4}-\d{6,}$/
const BUYER_RECONCILIATION_COOLDOWN_MS = 15 * 1000
const TERMINAL_UNPAID_PAYMENT_STATUSES = new Set([
  'rejected',
  'cancelled',
  'refunded'
])
const CONCURRENT_RECONCILIATION_CODES = new Set([
  'PAYMENT_STATUS_CONFLICT',
  'ORDER_STATUS_CONFLICT',
  'ORDER_FULFILLMENT_CONFLICT'
])

const toIsoString = (value) => {
  if (!value) return null
  const date = new Date(value)
  return Number.isNaN(date.getTime()) ? null : date.toISOString()
}

const safeAttentionReason = (value) => {
  const normalized = String(value || '').trim().toUpperCase()
  return /^[A-Z0-9_]{1,100}$/.test(normalized) ? normalized : null
}

class BuyerPaymentReconciliationService {
  constructor({
    orderManager = OrderManager,
    paymentManager = PaymentManager,
    reconciliationService = MercadoPagoReconciliationService
  } = {}) {
    this.orders = orderManager
    this.payments = paymentManager
    this.reconciliation = reconciliationService
  }

  #normalizeInput({ orderNumber, userId, now }) {
    const normalizedOrderNumber = String(orderNumber || '').trim().toUpperCase()
    if (!ORDER_NUMBER_PATTERN.test(normalizedOrderNumber)) {
      throw new ServiceError(
        'Número de orden inválido',
        'INVALID_ORDER_NUMBER',
        400
      )
    }

    if (!mongoose.Types.ObjectId.isValid(userId)) {
      throw new ServiceError(
        'Usuario no autenticado',
        'BUYER_RECONCILIATION_UNAUTHENTICATED',
        401
      )
    }

    const checkedAt = new Date(now)
    if (Number.isNaN(checkedAt.getTime())) {
      throw new ServiceError(
        'Fecha de reconciliación inválida',
        'INVALID_PAYMENT_CHECK_DATE',
        400
      )
    }

    return { normalizedOrderNumber, checkedAt }
  }

  async #loadOwnedContext(orderNumber, userId) {
    const order = await this.orders.getByOrderNumberAndUserId(orderNumber, userId)
    if (!order) {
      throw new ServiceError('Orden no encontrada', 'ORDER_NOT_FOUND', 404)
    }

    const payment = await this.payments.getLatestByOrderId(order._id)
    if (!payment) {
      throw new ServiceError(
        'No se pudo consultar el estado del pago',
        'ORDER_PAYMENT_NOT_FOUND',
        404
      )
    }

    return { order, payment }
  }

  #localOutcome(order, payment) {
    if (order.status === 'paid' && payment.normalizedStatus === 'approved') {
      return 'paid'
    }
    if (order.status === 'requires_attention') return 'requires_attention'
    if (
      ['cancelled', 'expired'].includes(order.status) &&
      TERMINAL_UNPAID_PAYMENT_STATUSES.has(payment.normalizedStatus)
    ) return 'terminal_unpaid'
    if (order.status === 'pending_payment' && payment.normalizedStatus === 'pending') {
      return 'pending'
    }
    return 'uncertain'
  }

  #toDto(order, payment, outcome) {
    return {
      outcome,
      orderNumber: String(order.orderNumber),
      orderStatus: String(order.status),
      paymentStatus: String(payment.normalizedStatus),
      fulfillmentStatus: getEffectiveFulfillmentStatus(order),
      attentionReason: order.status === 'requires_attention'
        ? safeAttentionReason(order.attentionReason)
        : null,
      paidAt: toIsoString(order.paidAt),
      paymentApprovedAt: toIsoString(payment.approvedAt)
    }
  }

  #isLocallyResolved(order, payment) {
    return (
      order.status === 'paid' ||
      order.status === 'requires_attention' ||
      (
        ['cancelled', 'expired'].includes(order.status) &&
        TERMINAL_UNPAID_PAYMENT_STATUSES.has(payment.normalizedStatus)
      ) ||
      payment.normalizedStatus !== 'pending'
    )
  }

  #isProviderUnavailable(error) {
    return !error?.status || Number(error.status) >= 500
  }

  async reconcileForBuyer({ orderNumber, userId, now = new Date() }) {
    const { normalizedOrderNumber, checkedAt } = this.#normalizeInput({
      orderNumber,
      userId,
      now
    })
    let context = await this.#loadOwnedContext(normalizedOrderNumber, userId)

    if (this.#isLocallyResolved(context.order, context.payment)) {
      return this.#toDto(
        context.order,
        context.payment,
        this.#localOutcome(context.order, context.payment)
      )
    }

    const providerOrderId = String(context.payment.providerOrderId || '').trim()
    if (!providerOrderId) {
      return this.#toDto(context.order, context.payment, 'uncertain')
    }

    const claimed = await this.payments.claimBuyerProviderCheck(
      context.payment._id,
      {
        checkedAt,
        cooldownThreshold: new Date(
          checkedAt.getTime() - BUYER_RECONCILIATION_COOLDOWN_MS
        )
      }
    )

    if (!claimed) {
      context = await this.#loadOwnedContext(normalizedOrderNumber, userId)
      return this.#toDto(context.order, context.payment, this.#localOutcome(
        context.order,
        context.payment
      ))
    }

    try {
      await this.reconciliation.reconcileProviderOrder(providerOrderId, {
        now: checkedAt
      })
    } catch (error) {
      if (CONCURRENT_RECONCILIATION_CODES.has(error?.code)) {
        context = await this.#loadOwnedContext(normalizedOrderNumber, userId)
        if (this.#isLocallyResolved(context.order, context.payment)) {
          return this.#toDto(
            context.order,
            context.payment,
            this.#localOutcome(context.order, context.payment)
          )
        }
      }

      if (this.#isProviderUnavailable(error)) {
        throw new ServiceError(
          'No pudimos actualizar el estado del pago en este momento. Tu pedido sigue registrado. Volvé a intentarlo en unos instantes.',
          'BUYER_PAYMENT_RECONCILIATION_UNAVAILABLE',
          503
        )
      }

      throw error
    }

    context = await this.#loadOwnedContext(normalizedOrderNumber, userId)
    return this.#toDto(
      context.order,
      context.payment,
      this.#localOutcome(context.order, context.payment)
    )
  }
}

export {
  BuyerPaymentReconciliationService,
  BUYER_RECONCILIATION_COOLDOWN_MS
}
export default new BuyerPaymentReconciliationService()
