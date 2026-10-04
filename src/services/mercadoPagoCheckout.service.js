import { randomUUID } from 'node:crypto'
import { isIP } from 'node:net'
import mongoose from 'mongoose'
import config from '../config.js'
import OrderManager from '../dao/managers/order.manager.js'
import PaymentManager from '../dao/managers/payment.manager.js'
import MercadoPagoProvider, {
  MERCADOPAGO_CHECKOUT_HOST,
  MercadoPagoProviderError
} from '../providers/mercadoPago.provider.js'
import { minorUnitsToDecimalString, toMinorUnits } from '../utils/commerceMoney.js'
import { log, error as logError, secureLog } from '../utils/logger.js'
import { ServiceError } from './service.products.js'

const RETURN_PATHS = Object.freeze({
  successUrl: '/checkout/success',
  failureUrl: '/checkout/failure',
  pendingUrl: '/checkout/pending'
})

const normalizeReturnBaseUrl = (value) => {
  let url

  try {
    url = new URL(String(value || '').trim())
  } catch {
    url = null
  }

  const hostname = url?.hostname.toLowerCase()
  const isLocalHostname =
    hostname === 'localhost' ||
    hostname?.endsWith('.localhost') ||
    hostname === '127.0.0.1' ||
    hostname === '::1'

  if (
    !url ||
    url.protocol !== 'https:' ||
    !hostname ||
    isLocalHostname ||
    isIP(hostname) !== 0 ||
    url.username ||
    url.password
  ) {
    throw new ServiceError(
      'La URL de retorno de Mercado Pago debe ser una URL HTTPS pública',
      'MERCADOPAGO_RETURN_URL_INVALID',
      500
    )
  }

  return url.origin
}

const toIsoDuration = (milliseconds) => {
  const totalSeconds = Math.floor(milliseconds / 1000)

  if (!Number.isSafeInteger(totalSeconds) || totalSeconds <= 0) {
    throw new ServiceError(
      'La reserva del checkout ya expiró',
      'MERCADOPAGO_CHECKOUT_EXPIRED',
      409
    )
  }

  const days = Math.floor(totalSeconds / 86400)
  const hours = Math.floor((totalSeconds % 86400) / 3600)
  const minutes = Math.floor((totalSeconds % 3600) / 60)
  const seconds = totalSeconds % 60
  const datePart = days ? `${days}D` : ''
  const timeParts = [
    hours ? `${hours}H` : '',
    minutes ? `${minutes}M` : '',
    seconds ? `${seconds}S` : ''
  ].join('')

  return `P${datePart}${timeParts ? `T${timeParts}` : ''}`
}

const normalizeMoney = (value, fieldName) => {
  try {
    const decimal = String(value ?? '').trim()

    if (!/^\d+(?:\.\d{1,2})?$/.test(decimal)) throw new Error('invalid scale')

    const minorUnits = toMinorUnits(decimal, fieldName)
    if (minorUnits <= 0) throw new Error('non-positive')
    return minorUnitsToDecimalString(minorUnits)
  } catch {
    throw new ServiceError(
      'La Order no tiene un importe ARS válido',
      'ORDER_ARS_TOTAL_REQUIRED',
      409
    )
  }
}

const cloneProviderRequest = (request) => {
  try {
    return JSON.parse(JSON.stringify(request))
  } catch {
    throw new ServiceError(
      'El request almacenado de Mercado Pago es invÃ¡lido',
      'MERCADOPAGO_ORDER_CONFLICT',
      409
    )
  }
}

class MercadoPagoCheckoutService {
  constructor({
    paymentManager = PaymentManager,
    orderManager = OrderManager,
    provider = MercadoPagoProvider,
    returnBaseUrl = config.mercadoPago?.returnBaseUrl,
    uuidFactory = randomUUID
  } = {}) {
    this.payments = paymentManager
    this.orders = orderManager
    this.provider = provider
    this.returnBaseUrl = returnBaseUrl
    this.uuidFactory = uuidFactory
  }

  #assertPaymentId(paymentId) {
    if (!mongoose.Types.ObjectId.isValid(paymentId)) {
      throw new ServiceError('ID de pago inválido', 'INVALID_PAYMENT_ID', 400)
    }
  }

  #isDuplicateKeyError(error) {
    return error?.code === 11000 || error?.errorResponse?.code === 11000
  }

  #assertPendingEntities(payment, order, now) {
    if (payment.provider !== 'mercado_pago') {
      throw new ServiceError(
        'El pago no pertenece a Mercado Pago',
        'PAYMENT_PROVIDER_NOT_SUPPORTED',
        409
      )
    }

    if (payment.normalizedStatus !== 'pending') {
      throw new ServiceError(
        'El pago ya no está pendiente',
        'PAYMENT_NOT_PENDING',
        409
      )
    }

    if (order.status !== 'pending_payment') {
      throw new ServiceError(
        'La Order ya no está pendiente de pago',
        'ORDER_NOT_PENDING_PAYMENT',
        409
      )
    }

    const reservationExpiresAt = new Date(order.reservationExpiresAt)

    if (
      Number.isNaN(reservationExpiresAt.getTime()) ||
      reservationExpiresAt.getTime() <= now.getTime()
    ) {
      throw new ServiceError(
        'La reserva del checkout ya expiró',
        'MERCADOPAGO_CHECKOUT_EXPIRED',
        409
      )
    }

    if (!order.exchangeRateSnapshot) {
      throw new ServiceError(
        'La Order no tiene una conversión ARS autoritativa',
        'ORDER_ARS_TOTAL_REQUIRED',
        409
      )
    }

    return reservationExpiresAt
  }

  #validateStoredCheckout(payment) {
    const providerOrderId = String(payment.providerOrderId || '').trim()
    const providerCheckoutUrl = String(payment.providerCheckoutUrl || '').trim()

    if (!providerOrderId && !providerCheckoutUrl) return null

    if (!providerOrderId || !providerCheckoutUrl) {
      throw new ServiceError(
        'La asociación local con Mercado Pago está incompleta',
        'MERCADOPAGO_ORDER_CONFLICT',
        409
      )
    }

    let checkoutUrl

    try {
      checkoutUrl = new URL(providerCheckoutUrl)
    } catch {
      checkoutUrl = null
    }

    if (
      !checkoutUrl ||
      checkoutUrl.protocol !== 'https:' ||
      checkoutUrl.hostname.toLowerCase() !== MERCADOPAGO_CHECKOUT_HOST
    ) {
      throw new ServiceError(
        'La URL almacenada de Mercado Pago es inválida',
        'MERCADOPAGO_INVALID_RESPONSE',
        502
      )
    }

    return {
      paymentId: String(payment._id),
      paymentStatus: payment.normalizedStatus,
      provider: payment.provider,
      providerOrderId,
      providerStatus: payment.providerStatus,
      checkoutUrl: checkoutUrl.toString()
    }
  }

  async #ensureProviderIdempotencyKey(payment) {
    const existingKey = String(payment.providerIdempotencyKey || '').trim()

    if (existingKey) {
      if (existingKey.length > 128) {
        throw new ServiceError(
          'La clave de idempotencia almacenada es inválida',
          'MERCADOPAGO_IDEMPOTENCY_CONFLICT',
          409
        )
      }

      return { payment, providerIdempotencyKey: existingKey }
    }

    const generatedKey = this.uuidFactory()
    const claimed = await this.payments.assignProviderIdempotencyKeyIfMissing(
      payment._id,
      'mercado_pago',
      generatedKey
    )

    if (claimed) {
      return { payment: claimed, providerIdempotencyKey: claimed.providerIdempotencyKey }
    }

    const current = await this.payments.getById(payment._id)
    const concurrentKey = String(current?.providerIdempotencyKey || '').trim()

    if (!current || !concurrentKey || concurrentKey.length > 128) {
      throw new ServiceError(
        'No se pudo establecer la idempotencia de Mercado Pago',
        'MERCADOPAGO_IDEMPOTENCY_CONFLICT',
        409
      )
    }

    return { payment: current, providerIdempotencyKey: concurrentKey }
  }

  #buildRequest(order, { now, reservationExpiresAt }) {
    const returnBaseUrl = normalizeReturnBaseUrl(this.returnBaseUrl)
    const totalArs = normalizeMoney(order.totals?.totalArs, 'Order.totalArs')
    const orderNumber = String(order.orderNumber || '').trim()

    if (!orderNumber || orderNumber.length > 64) {
      throw new ServiceError(
        'La referencia externa de la Order es inválida',
        'MERCADOPAGO_ORDER_CONFLICT',
        409
      )
    }

    return {
      type: 'online',
      processing_mode: 'manual',
      total_amount: totalArs,
      external_reference: orderNumber,
      expiration_time: toIsoDuration(reservationExpiresAt.getTime() - now.getTime()),
      payer: {
        email: order.buyerSnapshot.email,
        first_name: order.buyerSnapshot.firstName,
        last_name: order.buyerSnapshot.lastName
      },
      items: [
        {
          title: `Pedido LC COMP ${orderNumber}`,
          external_code: orderNumber,
          quantity: 1,
          unit_price: totalArs,
          total_amount: totalArs,
          unit_measure: 'unit'
        }
      ],
      config: {
        online: {
          available_from: now.toISOString(),
          success_url: new URL(RETURN_PATHS.successUrl, returnBaseUrl).toString(),
          failure_url: new URL(RETURN_PATHS.failureUrl, returnBaseUrl).toString(),
          pending_url: new URL(RETURN_PATHS.pendingUrl, returnBaseUrl).toString(),
          auto_return: 'approved'
        }
      }
    }
  }

  #resolveRequestAnchor(order, requestedAt) {
    const pendingHistory = Array.isArray(order.statusHistory)
      ? order.statusHistory.find((entry) => entry?.status === 'pending_payment')
      : null
    const candidates = [pendingHistory?.changedAt, order.createdAt, requestedAt]

    for (const candidate of candidates) {
      const date = new Date(candidate)
      if (!Number.isNaN(date.getTime())) return date
    }

    throw new ServiceError(
      'No se pudo determinar la fecha estable del request de Mercado Pago',
      'MERCADOPAGO_ORDER_CONFLICT',
      409
    )
  }

  async #ensureProviderAttempt(payment, order, requestedAt, reservationExpiresAt) {
    const ensured = await this.#ensureProviderIdempotencyKey(payment)
    let current = ensured.payment
    let providerIdempotencyKey = ensured.providerIdempotencyKey
    let request = current.providerRequestSnapshot

    if (!request) {
      const requestAnchor = this.#resolveRequestAnchor(order, requestedAt)
      const builtRequest = this.#buildRequest(order, {
        now: requestAnchor,
        reservationExpiresAt
      })
      const prepared = await this.payments.prepareProviderRequestSnapshot(
        payment._id,
        providerIdempotencyKey,
        builtRequest
      )

      current = prepared || await this.payments.getById(payment._id)
      providerIdempotencyKey = String(current?.providerIdempotencyKey || '').trim()
      request = current?.providerRequestSnapshot
    }

    if (!current || !providerIdempotencyKey || !request) {
      throw new ServiceError(
        'No se pudo preparar un request idempotente de Mercado Pago',
        'MERCADOPAGO_ORDER_CONFLICT',
        409
      )
    }

    if (['rejected', 'conflict'].includes(current.providerAttemptStatus)) {
      const nextProviderIdempotencyKey = this.uuidFactory()
      const nextProviderRequest = this.#buildRequest(order, {
        now: requestedAt,
        reservationExpiresAt
      })
      const rotated = await this.payments.rotateProviderIdempotencyKey(
        payment._id,
        providerIdempotencyKey,
        nextProviderIdempotencyKey,
        nextProviderRequest
      )

      current = rotated || await this.payments.getById(payment._id)
      providerIdempotencyKey = String(current?.providerIdempotencyKey || '').trim()
      request = current?.providerRequestSnapshot
    }

    if (
      !current ||
      !providerIdempotencyKey ||
      !request ||
      ['rejected', 'conflict'].includes(current.providerAttemptStatus)
    ) {
      throw new ServiceError(
        'No se pudo iniciar una nueva tentativa idempotente de Mercado Pago',
        'MERCADOPAGO_ORDER_CONFLICT',
        409
      )
    }

    return {
      payment: current,
      providerIdempotencyKey,
      request: cloneProviderRequest(request)
    }
  }

  async #recordProviderAttemptFailure(attempt, error) {
    if (!attempt?.providerIdempotencyKey) return

    let providerAttemptStatus = 'uncertain'

    if (error instanceof MercadoPagoProviderError) {
      if (error.failureKind === 'idempotency_conflict') {
        providerAttemptStatus = 'conflict'
      } else if (error.retryStrategy === 'new_attempt') {
        providerAttemptStatus = 'rejected'
      }
    }

    try {
      await this.payments.updateProviderAttemptStatus(
        attempt.payment._id,
        attempt.providerIdempotencyKey,
        providerAttemptStatus
      )
    } catch (stateError) {
      logError('MercadoPagoCheckoutService attempt state update failed', {
        paymentId: attempt.payment._id,
        code: stateError?.code || 'PROVIDER_ATTEMPT_STATE_UPDATE_FAILED'
      })
    }
  }

  #validateProviderResult(result, order, totalArs) {
    if (result.externalReference !== order.orderNumber) {
      throw new ServiceError(
        'Mercado Pago devolvió una referencia externa inconsistente',
        'MERCADOPAGO_INVALID_RESPONSE',
        502
      )
    }

    if (result.totalAmount !== null) {
      let providerTotal

      try {
        providerTotal = normalizeMoney(result.totalAmount, 'MercadoPago.totalAmount')
      } catch {
        throw new ServiceError(
          'Mercado Pago devolvió un importe inconsistente',
          'MERCADOPAGO_INVALID_RESPONSE',
          502
        )
      }

      if (providerTotal !== totalArs) {
        throw new ServiceError(
          'Mercado Pago devolvió un importe inconsistente',
          'MERCADOPAGO_INVALID_RESPONSE',
          502
        )
      }
    }
  }

  async ensureCheckoutOrderForPayment(paymentId, { now = new Date() } = {}) {
    this.#assertPaymentId(paymentId)
    const requestedAt = new Date(now)

    if (Number.isNaN(requestedAt.getTime())) {
      throw new ServiceError('Fecha de operación inválida', 'INVALID_PAYMENT_CHECK_DATE', 400)
    }

    log('💳 MercadoPagoCheckoutService → asegurando provider order')
    let payment = await this.payments.getById(paymentId)

    if (!payment) throw new ServiceError('Pago no encontrado', 'PAYMENT_NOT_FOUND', 404)

    const order = await this.orders.getById(payment.orderId)
    if (!order) throw new ServiceError('Order no encontrada', 'ORDER_NOT_FOUND', 404)

    const reservationExpiresAt = this.#assertPendingEntities(payment, order, requestedAt)
    const orderTotalArs = normalizeMoney(order.totals?.totalArs, 'Order.totalArs')
    const paymentTotalArs = normalizeMoney(payment.amountArs, 'Payment.amountArs')

    if (orderTotalArs !== paymentTotalArs || payment.externalReference !== order.orderNumber) {
      throw new ServiceError(
        'El pago no coincide con la Order autoritativa',
        'MERCADOPAGO_ORDER_CONFLICT',
        409
      )
    }

    const storedCheckout = this.#validateStoredCheckout(payment)
    if (storedCheckout) return storedCheckout

    const startedAt = Date.now()
    let attempt
    let providerRequestSent = false

    try {
      attempt = await this.#ensureProviderAttempt(
        payment,
        order,
        requestedAt,
        reservationExpiresAt
      )
      payment = attempt.payment

      const concurrentCheckout = this.#validateStoredCheckout(payment)
      if (concurrentCheckout) return concurrentCheckout

      providerRequestSent = true
      const providerOrder = await this.provider.createCheckoutOrder({
        providerIdempotencyKey: attempt.providerIdempotencyKey,
        request: attempt.request
      })

      this.#validateProviderResult(providerOrder, order, orderTotalArs)

      const attached = await this.payments.attachProviderOrder(
        payment._id,
        attempt.providerIdempotencyKey,
        {
          providerOrderId: providerOrder.providerOrderId,
          providerCheckoutUrl: providerOrder.checkoutUrl,
          providerStatus: providerOrder.status
        }
      )

      if (attached) {
        const result = this.#validateStoredCheckout(attached)

        secureLog('✅ MercadoPagoCheckoutService provider order asociada', {
          orderId: order._id,
          orderNumber: order.orderNumber,
          paymentId: payment._id,
          providerOrderId: providerOrder.providerOrderId,
          providerStatus: providerOrder.status,
          durationMs: Date.now() - startedAt
        })

        return result
      }

      const current = await this.payments.getById(payment._id)
      const currentCheckout = current && this.#validateStoredCheckout(current)

      if (
        currentCheckout &&
        currentCheckout.providerOrderId === providerOrder.providerOrderId
      ) {
        return currentCheckout
      }

      throw new ServiceError(
        'Otra operación asoció un recurso diferente al pago',
        'MERCADOPAGO_ORDER_CONFLICT',
        409
      )
    } catch (error) {
      if (providerRequestSent) {
        await this.#recordProviderAttemptFailure(attempt, error)
      }

      const mappedError = error instanceof MercadoPagoProviderError
        ? new ServiceError(error.message, error.code, error.status)
        : error

      logError('❌ MercadoPagoCheckoutService provider order error', {
        paymentId: payment._id,
        orderId: order._id,
        code: mappedError?.code || 'MERCADOPAGO_UNAVAILABLE',
        durationMs: Date.now() - startedAt
      })

      if (mappedError instanceof ServiceError) throw mappedError
      if (this.#isDuplicateKeyError(mappedError)) {
        throw new ServiceError(
          'La order de Mercado Pago ya está asociada a otro pago',
          'MERCADOPAGO_ORDER_CONFLICT',
          409
        )
      }

      throw new ServiceError(
        'No se pudo crear la order de Mercado Pago',
        'MERCADOPAGO_UNAVAILABLE',
        503
      )
    }
  }
}

export {
  MercadoPagoCheckoutService,
  RETURN_PATHS,
  normalizeReturnBaseUrl,
  toIsoDuration
}
export default new MercadoPagoCheckoutService()
