import CheckoutService, { IDEMPOTENCY_KEY_PATTERN } from './checkout.service.js'
import MercadoPagoCheckoutService from './mercadoPagoCheckout.service.js'
import { ServiceError } from './service.products.js'
import { error as logError, secureLog } from '../utils/logger.js'

const CHECKOUT_BODY_FIELDS = new Set(['items'])

class CheckoutHttpService {
  constructor({
    checkoutService = CheckoutService,
    mercadoPagoCheckoutService = MercadoPagoCheckoutService
  } = {}) {
    this.checkout = checkoutService
    this.mercadoPagoCheckout = mercadoPagoCheckoutService
  }

  #normalizeBody(body) {
    if (!body || typeof body !== 'object' || Array.isArray(body)) {
      throw new ServiceError('El body del checkout es inválido', 'CHECKOUT_INVALID_INPUT', 400)
    }

    const unexpectedFields = Object.keys(body).filter(
      (field) => !CHECKOUT_BODY_FIELDS.has(field)
    )

    if (unexpectedFields.length) {
      throw new ServiceError(
        'El body del checkout contiene campos no permitidos',
        'CHECKOUT_INVALID_INPUT',
        400
      )
    }

    if (!Array.isArray(body.items) || body.items.length === 0) {
      throw new ServiceError(
        'El checkout debe contener al menos un producto',
        'CHECKOUT_EMPTY',
        400
      )
    }

    return body.items
  }

  #normalizeIdempotencyKey(value) {
    if (typeof value !== 'string') {
      throw new ServiceError(
        'El header Idempotency-Key es obligatorio',
        'CHECKOUT_INVALID_IDEMPOTENCY_KEY',
        400
      )
    }

    const idempotencyKey = value.trim()

    if (!IDEMPOTENCY_KEY_PATTERN.test(idempotencyKey)) {
      throw new ServiceError(
        'El header Idempotency-Key es inválido',
        'CHECKOUT_INVALID_IDEMPOTENCY_KEY',
        400
      )
    }

    return idempotencyKey
  }

  #toPublicDto(localCheckout, providerCheckout) {
    return {
      order: {
        orderNumber: localCheckout.order.orderNumber,
        status: localCheckout.order.status,
        reservationExpiresAt: localCheckout.order.reservationExpiresAt
      },
      totals: {
        totalUsd: localCheckout.totals.totalUsd,
        totalArs: localCheckout.totals.totalArs
      },
      exchangeRate: {
        source: localCheckout.exchangeRate.source,
        rate: localCheckout.exchangeRate.rate,
        sourceDate: localCheckout.exchangeRate.sourceDate
      },
      payment: {
        status: localCheckout.payment.status,
        provider: localCheckout.payment.provider
      },
      checkoutUrl: providerCheckout.checkoutUrl
    }
  }

  async createCheckout(
    { userId, idempotencyKey: rawIdempotencyKey, body },
    { now = new Date() } = {}
  ) {
    const startedAt = Date.now()
    const idempotencyKey = this.#normalizeIdempotencyKey(rawIdempotencyKey)
    const items = this.#normalizeBody(body)
    let localCheckout

    try {
      localCheckout = await this.checkout.createCheckout(
        { userId, items, idempotencyKey },
        { now }
      )
    } catch (error) {
      logError('Checkout HTTP local error', {
        userId: String(userId || ''),
        code: error?.code || 'CHECKOUT_FAILED',
        durationMs: Date.now() - startedAt
      })
      throw error
    }

    try {
      const providerCheckout = await this.mercadoPagoCheckout.ensureCheckoutOrderForPayment(
        localCheckout.payment.id,
        { now }
      )
      const isIdempotent = localCheckout.isIdempotent === true

      secureLog('Checkout HTTP completado', {
        userId: String(userId),
        orderId: localCheckout.order.id,
        orderNumber: localCheckout.order.orderNumber,
        paymentId: localCheckout.payment.id,
        providerOrderId: providerCheckout.providerOrderId,
        result: 'checkout_url_ready',
        isIdempotent,
        durationMs: Date.now() - startedAt
      })

      return {
        isIdempotent,
        checkout: this.#toPublicDto(localCheckout, providerCheckout)
      }
    } catch (error) {
      logError('Checkout HTTP provider error', {
        userId: String(userId),
        orderId: localCheckout.order.id,
        orderNumber: localCheckout.order.orderNumber,
        paymentId: localCheckout.payment.id,
        result: 'provider_error',
        isIdempotent: localCheckout.isIdempotent === true,
        code: error?.code || 'MERCADOPAGO_UNAVAILABLE',
        durationMs: Date.now() - startedAt
      })
      throw error
    }
  }
}

export { CheckoutHttpService, CHECKOUT_BODY_FIELDS }
export default new CheckoutHttpService()
