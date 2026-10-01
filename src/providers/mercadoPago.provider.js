import config from '../config.js'

const MERCADOPAGO_API_URL = 'https://api.mercadopago.com'
const MERCADOPAGO_CHECKOUT_HOST = 'www.mercadopago.com.ar'
const DEFAULT_TIMEOUT_MS = 10000

class MercadoPagoProviderError extends Error {
  constructor(message, code, status = 502) {
    super(message)
    this.name = 'MercadoPagoProviderError'
    this.code = code
    this.status = status
  }
}

const normalizeCheckoutUrl = (value, { required }) => {
  if ((value === undefined || value === null || value === '') && !required) return null

  let url

  try {
    url = new URL(String(value))
  } catch {
    url = null
  }

  if (
    !url ||
    url.protocol !== 'https:' ||
    url.hostname.toLowerCase() !== MERCADOPAGO_CHECKOUT_HOST
  ) {
    throw new MercadoPagoProviderError(
      'Mercado Pago devolvió una URL de checkout inválida',
      'MERCADOPAGO_INVALID_RESPONSE',
      502
    )
  }

  return url.toString()
}

const optionalString = (value) =>
  value === undefined || value === null || value === '' ? null : String(value)

const normalizeProviderPayments = (payments) => {
  if (!Array.isArray(payments)) return []

  return payments.map((payment) => ({
    providerPaymentId: optionalString(payment?.id),
    status: optionalString(payment?.status),
    statusDetail: optionalString(payment?.status_detail),
    amount: optionalString(payment?.amount),
    paidAmount: optionalString(payment?.paid_amount)
  }))
}

const normalizeProviderOrder = (
  payload,
  { requireCheckoutUrl = false, includeReconciliation = false } = {}
) => {
  const providerOrderId = String(payload?.id || '').trim()
  const status = String(payload?.status || '').trim()

  if (!providerOrderId || !status) {
    throw new MercadoPagoProviderError(
      'Mercado Pago devolvió una order incompleta',
      'MERCADOPAGO_INVALID_RESPONSE',
      502
    )
  }

  let createdAt = null

  if (payload.created_date) {
    const parsedCreatedAt = new Date(payload.created_date)
    if (!Number.isNaN(parsedCreatedAt.getTime())) createdAt = parsedCreatedAt.toISOString()
  }

  const normalized = {
    providerOrderId,
    status,
    checkoutUrl: normalizeCheckoutUrl(payload.checkout_url, { required: requireCheckoutUrl }),
    externalReference:
      payload.external_reference === undefined || payload.external_reference === null
        ? null
        : String(payload.external_reference),
    totalAmount:
      payload.total_amount === undefined || payload.total_amount === null
        ? null
        : String(payload.total_amount),
    createdAt
  }

  if (includeReconciliation) {
    normalized.statusDetail = optionalString(payload.status_detail)
    normalized.totalPaidAmount = optionalString(payload.total_paid_amount)
    normalized.currency = optionalString(payload.currency)
    normalized.lastUpdatedDate = optionalString(payload.last_updated_date)
    normalized.payments = normalizeProviderPayments(payload.transactions?.payments)
  }

  return normalized
}

class MercadoPagoProvider {
  constructor({
    fetchImplementation = globalThis.fetch,
    accessToken = config.mercadoPago?.accessToken,
    timeoutMs = config.mercadoPago?.timeoutMs ?? DEFAULT_TIMEOUT_MS
  } = {}) {
    this.fetch = fetchImplementation
    this.accessToken = accessToken
    this.timeoutMs = Number.isFinite(Number(timeoutMs)) && Number(timeoutMs) > 0
      ? Number(timeoutMs)
      : DEFAULT_TIMEOUT_MS
  }

  #assertConfigured() {
    if (!this.accessToken || typeof this.accessToken !== 'string') {
      throw new MercadoPagoProviderError(
        'Mercado Pago no está configurado',
        'MERCADOPAGO_NOT_CONFIGURED',
        500
      )
    }

    if (typeof this.fetch !== 'function') {
      throw new MercadoPagoProviderError(
        'No hay un cliente HTTP disponible para Mercado Pago',
        'MERCADOPAGO_NOT_CONFIGURED',
        500
      )
    }
  }

  #mapHttpError(status, payload) {
    const providerCode = String(
      payload?.code || payload?.error || payload?.cause?.[0]?.code || ''
    ).toLowerCase()

    if (status === 401 || status === 403) {
      return new MercadoPagoProviderError(
        'Mercado Pago rechazó las credenciales configuradas',
        'MERCADOPAGO_AUTH_ERROR',
        502
      )
    }

    if (status === 429) {
      return new MercadoPagoProviderError(
        'Mercado Pago limitó temporalmente las solicitudes',
        'MERCADOPAGO_RATE_LIMIT',
        503
      )
    }

    if (status === 409 || providerCode.includes('idempotency')) {
      return new MercadoPagoProviderError(
        'Mercado Pago rechazó la clave de idempotencia',
        'MERCADOPAGO_IDEMPOTENCY_CONFLICT',
        409
      )
    }

    if (status === 423 || providerCode === 'resource_locked') {
      return new MercadoPagoProviderError(
        'La order de Mercado Pago está temporalmente bloqueada',
        'MERCADOPAGO_ORDER_CONFLICT',
        409
      )
    }

    if (status >= 500) {
      return new MercadoPagoProviderError(
        'Mercado Pago no está disponible temporalmente',
        'MERCADOPAGO_UNAVAILABLE',
        503
      )
    }

    return new MercadoPagoProviderError(
      'Mercado Pago rechazó la creación de la order',
      'MERCADOPAGO_ORDER_REJECTED',
      502
    )
  }

  async #request(path, { method = 'GET', idempotencyKey, body } = {}) {
    this.#assertConfigured()

    if (method === 'POST') {
      const normalizedKey = String(idempotencyKey || '').trim()

      if (!normalizedKey || normalizedKey.length > 128) {
        throw new MercadoPagoProviderError(
          'La clave de idempotencia de Mercado Pago es inválida',
          'MERCADOPAGO_IDEMPOTENCY_CONFLICT',
          409
        )
      }
    }

    const controller = new AbortController()
    const timeout = setTimeout(() => controller.abort(), this.timeoutMs)
    const headers = {
      Accept: 'application/json',
      Authorization: `Bearer ${this.accessToken}`
    }

    if (method === 'POST') {
      headers['Content-Type'] = 'application/json'
      headers['X-Idempotency-Key'] = String(idempotencyKey).trim()
    }

    try {
      const response = await this.fetch(`${MERCADOPAGO_API_URL}${path}`, {
        method,
        headers,
        signal: controller.signal,
        ...(body && { body: JSON.stringify(body) })
      })
      let payload

      try {
        payload = await response.json()
      } catch {
        if (response.ok) {
          throw new MercadoPagoProviderError(
            'Mercado Pago devolvió una respuesta inválida',
            'MERCADOPAGO_INVALID_RESPONSE',
            502
          )
        }

        payload = null
      }

      if (!response.ok) throw this.#mapHttpError(response.status, payload)
      return payload
    } catch (error) {
      if (error instanceof MercadoPagoProviderError) throw error

      if (error?.name === 'AbortError') {
        throw new MercadoPagoProviderError(
          'Mercado Pago no respondió dentro del tiempo permitido',
          'MERCADOPAGO_TIMEOUT',
          504
        )
      }

      throw new MercadoPagoProviderError(
        'No se pudo conectar con Mercado Pago',
        'MERCADOPAGO_UNAVAILABLE',
        503
      )
    } finally {
      clearTimeout(timeout)
    }
  }

  async createCheckoutOrder({ providerIdempotencyKey, request }) {
    const payload = await this.#request('/v1/orders', {
      method: 'POST',
      idempotencyKey: providerIdempotencyKey,
      body: request
    })

    return normalizeProviderOrder(payload, { requireCheckoutUrl: true })
  }

  async getOrder(providerOrderId) {
    const normalizedId = String(providerOrderId || '').trim()

    if (!normalizedId) {
      throw new MercadoPagoProviderError(
        'ID de order de Mercado Pago requerido',
        'MERCADOPAGO_INVALID_RESPONSE',
        400
      )
    }

    const payload = await this.#request(`/v1/orders/${encodeURIComponent(normalizedId)}`)
    return normalizeProviderOrder(payload, { includeReconciliation: true })
  }
}

export {
  DEFAULT_TIMEOUT_MS,
  MERCADOPAGO_API_URL,
  MERCADOPAGO_CHECKOUT_HOST,
  MercadoPagoProvider,
  MercadoPagoProviderError,
  normalizeProviderPayments,
  normalizeProviderOrder
}
export default new MercadoPagoProvider()
