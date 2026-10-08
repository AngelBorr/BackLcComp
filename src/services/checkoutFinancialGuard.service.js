import mongoose from 'mongoose'
import OrderManager from '../dao/managers/order.manager.js'
import PaymentManager from '../dao/managers/payment.manager.js'
import MercadoPagoReconciliationService from './mercadoPagoReconciliation.service.js'
import { ServiceError } from './service.products.js'

const FINANCIALLY_TERMINAL_UNPAID_STATUSES = new Set([
  'rejected',
  'cancelled',
  'refunded'
])
const UNCERTAIN_PROVIDER_ATTEMPT_STATUSES = new Set([
  'prepared',
  'uncertain',
  'conflict',
  'succeeded'
])

const toSafeAttentionReason = (value) => {
  const normalized = String(value || '').trim().toUpperCase()
  return /^[A-Z0-9_]{1,100}$/.test(normalized) ? normalized : undefined
}

class CheckoutFinancialGuardService {
  constructor({
    orderManager = OrderManager,
    paymentManager = PaymentManager,
    mercadoPagoReconciliationService = MercadoPagoReconciliationService
  } = {}) {
    this.orders = orderManager
    this.payments = paymentManager
    this.reconciliation = mercadoPagoReconciliationService
  }

  #assertUserId(userId) {
    if (!mongoose.Types.ObjectId.isValid(userId)) {
      throw new ServiceError('ID de usuario inválido', 'INVALID_USER_ID', 400)
    }
  }

  #buildBlocker(code, order, payment) {
    return {
      code,
      orderNumber: String(order?.orderNumber || ''),
      orderStatus: String(order?.status || ''),
      paymentStatus: String(payment?.normalizedStatus || 'unknown'),
      ...(toSafeAttentionReason(order?.attentionReason) && {
        attentionReason: toSafeAttentionReason(order.attentionReason)
      })
    }
  }

  #isActiveOrder(order, now) {
    if (order?.status !== 'pending_payment') return false
    const expiration = new Date(order.reservationExpiresAt)
    return !Number.isNaN(expiration.getTime()) && expiration.getTime() > now.getTime()
  }

  #classify(order, payment, now) {
    if (order.status === 'paid') return { kind: 'safe' }

    if (payment?.normalizedStatus === 'approved') {
      return {
        kind: 'blocked',
        blocker: this.#buildBlocker('CHECKOUT_BLOCKED_BY_APPROVED_PAYMENT', order, payment)
      }
    }

    if (payment?.normalizedStatus === 'requires_attention') {
      return {
        kind: 'blocked',
        blocker: this.#buildBlocker('CHECKOUT_PRIOR_PAYMENT_UNCERTAIN', order, payment)
      }
    }

    if (FINANCIALLY_TERMINAL_UNPAID_STATUSES.has(payment?.normalizedStatus)) {
      return { kind: 'safe' }
    }

    if (!payment) {
      if (['cancelled', 'expired'].includes(order.status)) return { kind: 'safe' }

      return {
        kind: 'blocked',
        blocker: this.#buildBlocker(
          this.#isActiveOrder(order, now)
            ? 'CHECKOUT_BLOCKED_BY_ACTIVE_ORDER'
            : 'CHECKOUT_PRIOR_PAYMENT_UNCERTAIN',
          order,
          null
        )
      }
    }

    if (payment.normalizedStatus !== 'pending') {
      return {
        kind: 'blocked',
        blocker: this.#buildBlocker('CHECKOUT_PRIOR_PAYMENT_UNCERTAIN', order, payment)
      }
    }

    const providerOrderId = String(payment.providerOrderId || '').trim()
    if (providerOrderId) return { kind: 'reconcile', providerOrderId, order, payment }

    const hasAttemptStatus = Object.hasOwn(payment, 'providerAttemptStatus')
    const attemptStatus = payment.providerAttemptStatus
    const hasRequestSnapshot = Boolean(payment.providerRequestSnapshot)
    const hasCheckoutUrl = Boolean(String(payment.providerCheckoutUrl || '').trim())

    if (!hasAttemptStatus) {
      return {
        kind: 'blocked',
        blocker: this.#buildBlocker('CHECKOUT_PRIOR_PAYMENT_UNCERTAIN', order, payment)
      }
    }

    if (
      UNCERTAIN_PROVIDER_ATTEMPT_STATUSES.has(attemptStatus) ||
      hasCheckoutUrl ||
      (attemptStatus === null && hasRequestSnapshot)
    ) {
      return {
        kind: 'blocked',
        blocker: this.#buildBlocker('CHECKOUT_PRIOR_PAYMENT_UNCERTAIN', order, payment)
      }
    }

    if (attemptStatus === 'rejected') {
      if (!this.#isActiveOrder(order, now)) return { kind: 'safe' }

      return {
        kind: 'blocked',
        blocker: this.#buildBlocker('CHECKOUT_BLOCKED_BY_ACTIVE_ORDER', order, payment)
      }
    }

    if (attemptStatus !== null) {
      return {
        kind: 'blocked',
        blocker: this.#buildBlocker('CHECKOUT_PRIOR_PAYMENT_UNCERTAIN', order, payment)
      }
    }

    if (this.#isActiveOrder(order, now)) {
      return {
        kind: 'blocked',
        blocker: this.#buildBlocker('CHECKOUT_BLOCKED_BY_ACTIVE_ORDER', order, payment)
      }
    }

    if (order.status === 'requires_attention') {
      return {
        kind: 'blocked',
        blocker: this.#buildBlocker('CHECKOUT_PRIOR_PAYMENT_UNCERTAIN', order, payment)
      }
    }

    return { kind: 'safe' }
  }

  #classifyContinuingCheckout(order, payment, now) {
    if (
      order?.status !== 'pending_payment' ||
      payment?.normalizedStatus !== 'pending'
    ) {
      return this.#classify(order, payment, now)
    }

    const providerOrderId = String(payment.providerOrderId || '').trim()
    if (providerOrderId) return { kind: 'safe' }

    const hasAttemptStatus = Object.hasOwn(payment, 'providerAttemptStatus')
    const attemptStatus = payment.providerAttemptStatus
    const hasRequestSnapshot = Boolean(payment.providerRequestSnapshot)
    const hasCheckoutUrl = Boolean(String(payment.providerCheckoutUrl || '').trim())

    if (
      !hasAttemptStatus ||
      attemptStatus === 'conflict' ||
      attemptStatus === 'succeeded' ||
      hasCheckoutUrl ||
      (attemptStatus === null && hasRequestSnapshot)
    ) {
      return {
        kind: 'blocked',
        blocker: this.#buildBlocker('CHECKOUT_PRIOR_PAYMENT_UNCERTAIN', order, payment)
      }
    }

    if (['prepared', 'uncertain', 'rejected', null].includes(attemptStatus)) {
      return { kind: 'safe' }
    }

    return {
      kind: 'blocked',
      blocker: this.#buildBlocker('CHECKOUT_PRIOR_PAYMENT_UNCERTAIN', order, payment)
    }
  }

  async #buildReconciledPaidBlocker(reconciliationResult, fallbackOrder, fallbackPayment) {
    const [order, payment] = await Promise.all([
      reconciliationResult?.orderId && typeof this.orders.getById === 'function'
        ? this.orders.getById(reconciliationResult.orderId)
        : null,
      reconciliationResult?.paymentId && typeof this.payments.getById === 'function'
        ? this.payments.getById(reconciliationResult.paymentId)
        : null
    ])

    return this.#buildBlocker(
      'CHECKOUT_PRIOR_PAYMENT_CONFIRMED',
      order || { ...fallbackOrder, status: 'paid' },
      payment || { ...fallbackPayment, normalizedStatus: 'approved' }
    )
  }

  async #loadOperations(userId, { session } = {}) {
    const orders = await this.orders.getFinanciallyUnresolvedByUserId(userId, { session })

    return Promise.all(orders.map(async (order) => ({
      order,
      payment: await this.payments.getLatestByOrderId(order._id, { session })
    })))
  }

  #toError(blocker) {
    const messages = {
      CHECKOUT_BLOCKED_BY_APPROVED_PAYMENT:
        'Tu pago ya fue acreditado. El pedido está siendo revisado y no es necesario volver a pagar.',
      CHECKOUT_PRIOR_PAYMENT_CONFIRMED:
        'Tu pago anterior fue confirmado. No es necesario volver a pagar.',
      CHECKOUT_BLOCKED_BY_ACTIVE_ORDER:
        'Ya existe un checkout activo para esta cuenta.',
      CHECKOUT_PRIOR_PAYMENT_UNCERTAIN:
        'Existe un pago anterior pendiente de confirmación. No inicies otro pago.',
      CHECKOUT_RECONCILIATION_UNAVAILABLE:
        'No pudimos confirmar de forma segura el estado de un pago anterior.'
    }

    return new ServiceError(
      messages[blocker.code] || 'El checkout está bloqueado temporalmente.',
      blocker.code,
      blocker.code === 'CHECKOUT_RECONCILIATION_UNAVAILABLE' ? 503 : 409,
      { checkoutBlocker: blocker }
    )
  }

  async evaluate(userId, {
    now = new Date(),
    session,
    reconcile = false,
    continuingCheckoutId = null
  } = {}) {
    this.#assertUserId(userId)
    const checkedAt = new Date(now)

    if (Number.isNaN(checkedAt.getTime())) {
      throw new ServiceError('Fecha de checkout inválida', 'CHECKOUT_INVALID_DATE', 400)
    }

    const operations = await this.#loadOperations(userId, { session })
    const classifications = operations.map(({ order, payment }) => {
      const isOwnPendingCheckout =
        continuingCheckoutId &&
        String(order._id) === String(continuingCheckoutId) &&
        order.status === 'pending_payment' &&
        payment?.normalizedStatus === 'pending'

      return isOwnPendingCheckout
        ? this.#classifyContinuingCheckout(order, payment, checkedAt)
        : this.#classify(order, payment, checkedAt)
    })
    const approvedBlocker = classifications.find(
      ({ blocker }) => blocker?.code === 'CHECKOUT_BLOCKED_BY_APPROVED_PAYMENT'
    )

    if (approvedBlocker) return { allowed: false, blocker: approvedBlocker.blocker }

    const localBlocker = classifications.find(({ kind }) => kind === 'blocked')
    if (localBlocker) return { allowed: false, blocker: localBlocker.blocker }

    const reconcilable = classifications.find(({ kind }) => kind === 'reconcile')
    if (!reconcilable) return { allowed: true, blocker: null }

    if (!reconcile || session) {
      return {
        allowed: false,
        blocker: this.#buildBlocker(
          'CHECKOUT_PRIOR_PAYMENT_UNCERTAIN',
          reconcilable.order,
          reconcilable.payment
        )
      }
    }

    let reconciliationResult

    try {
      reconciliationResult = await this.reconciliation.reconcileProviderOrder(
        reconcilable.providerOrderId,
        { now: checkedAt }
      )
    } catch {
      return {
        allowed: false,
        blocker: this.#buildBlocker(
          'CHECKOUT_RECONCILIATION_UNAVAILABLE',
          reconcilable.order,
          reconcilable.payment
        )
      }
    }

    if (reconciliationResult?.outcome === 'paid') {
      return {
        allowed: false,
        blocker: await this.#buildReconciledPaidBlocker(
          reconciliationResult,
          reconcilable.order,
          reconcilable.payment
        )
      }
    }

    return this.evaluate(userId, {
      now: checkedAt,
      reconcile: false,
      continuingCheckoutId
    })
  }

  async assertCanCreateCheckout(userId, options = {}) {
    const eligibility = await this.evaluate(userId, options)
    if (!eligibility.allowed) throw this.#toError(eligibility.blocker)
    return eligibility
  }

  async assertCanContinueCheckout(userId, checkoutId, options = {}) {
    const eligibility = await this.evaluate(userId, {
      ...options,
      continuingCheckoutId: checkoutId
    })
    if (!eligibility.allowed) throw this.#toError(eligibility.blocker)
    return eligibility
  }

  assertCheckoutCanContinue(checkout) {
    const paymentStatus = checkout?.payment?.status
    const orderStatus = checkout?.order?.status

    if (paymentStatus === 'approved') {
      throw this.#toError(this.#buildBlocker(
        'CHECKOUT_BLOCKED_BY_APPROVED_PAYMENT',
        {
          orderNumber: checkout.order.orderNumber,
          status: orderStatus,
          attentionReason: checkout.order.attentionReason
        },
        { normalizedStatus: paymentStatus }
      ))
    }

    if (paymentStatus === 'requires_attention') {
      throw this.#toError(this.#buildBlocker(
        'CHECKOUT_PRIOR_PAYMENT_UNCERTAIN',
        {
          orderNumber: checkout.order.orderNumber,
          status: orderStatus,
          attentionReason: checkout.order.attentionReason
        },
        { normalizedStatus: paymentStatus }
      ))
    }
  }

  async getEligibility(userId, { now = new Date(), idempotencyKey = null } = {}) {
    let continuingCheckoutId = null

    if (idempotencyKey) {
      const order = await this.orders.getByUserAndCheckoutIdempotencyKey(
        userId,
        idempotencyKey
      )
      continuingCheckoutId = order?._id || null
    }

    return this.evaluate(userId, {
      now,
      reconcile: false,
      continuingCheckoutId
    })
  }
}

export {
  CheckoutFinancialGuardService,
  FINANCIALLY_TERMINAL_UNPAID_STATUSES,
  UNCERTAIN_PROVIDER_ATTEMPT_STATUSES
}
export default new CheckoutFinancialGuardService()
