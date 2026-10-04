import config from '../config.js'
import { error as logError } from '../utils/logger.js'

const MERCADOPAGO_API_URL = 'https://api.mercadopago.com'
const MERCADOPAGO_CHECKOUT_HOST = 'www.mercadopago.com.ar'
const DEFAULT_TIMEOUT_MS = 10000
const MAX_LOG_TEXT_LENGTH = 500
const MAX_LOG_DETAIL_ITEMS = 10

const sanitizeLogText = (value, secrets = []) => {
  if (value === undefined || value === null || value === '') return null
  if (!['string', 'number', 'boolean'].includes(typeof value)) return null

  let sanitized = String(value)

  for (const secret of secrets) {
    const normalizedSecret = String(secret || '')
    if (normalizedSecret) sanitized = sanitized.split(normalizedSecret).join('[REDACTED]')
  }

  sanitized = sanitized
    .replace(/\bBearer\s+[^\s,;"']+/gi, '[REDACTED]')
    .replace(
      /\b(?:authorization|access[_ -]?token|cookie|set-cookie|x-idempotency-key)\b\s*[:=]\s*[^\s,;]+/gi,
      '[REDACTED]'
    )
    .replace(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi, '[REDACTED_EMAIL]')

  return sanitized.slice(0, MAX_LOG_TEXT_LENGTH)
}

const sanitizeLogDetail = (value, secrets) => {
  if (value === undefined || value === null) return null

  const entries = Array.isArray(value)
    ? value.slice(0, MAX_LOG_DETAIL_ITEMS)
    : [value]

  const sanitizedEntries = entries
    .map((entry) => {
      if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
        return sanitizeLogText(entry, secrets)
      }

      const sanitizedEntry = {
        code: sanitizeLogText(entry.code, secrets),
        message: sanitizeLogText(entry.message, secrets),
        description: sanitizeLogText(entry.description, secrets),
        type: sanitizeLogText(entry.type, secrets)
      }

      return Object.fromEntries(
        Object.entries(sanitizedEntry).filter(([, fieldValue]) => fieldValue !== null)
      )
    })
    .filter((entry) => entry !== null && (
      typeof entry !== 'object' || Object.keys(entry).length > 0
    ))

  if (!sanitizedEntries.length) return null
  return Array.isArray(value) ? sanitizedEntries : sanitizedEntries[0]
}

const sanitizeMercadoPagoHttpError = ({ status, payload, path, method, secrets = [] }) => {
  const providerCode = payload?.code || payload?.error || payload?.cause?.[0]?.code
  const sanitized = {
    httpStatus: Number(status),
    providerCode: sanitizeLogText(providerCode, secrets),
    message: sanitizeLogText(payload?.message, secrets),
    cause: sanitizeLogDetail(payload?.cause, secrets),
    details: sanitizeLogDetail(payload?.details ?? payload?.detail, secrets),
    path: sanitizeLogText(path, secrets),
    method: sanitizeLogText(method, secrets)?.toUpperCase() || 'GET'
  }

  return Object.fromEntries(
    Object.entries(sanitized).filter(([, value]) => value !== null)
  )
}

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
    timeoutMs = config.mercadoPago?.timeoutMs ?? DEFAULT_TIMEOUT_MS,
    errorLogger = logError
  } = {}) {
    this.fetch = fetchImplementation
    this.accessToken = accessToken
    this.errorLogger = errorLogger
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

      if (!response.ok) {
        const sanitizedError = sanitizeMercadoPagoHttpError({
          status: response.status,
          payload,
          path,
          method,
          secrets: [this.accessToken, idempotencyKey]
        })

        if (typeof this.errorLogger === 'function') {
          try {
            this.errorLogger('Mercado Pago HTTP request rejected', sanitizedError)
          } catch {
            // La observabilidad nunca debe alterar el mapeo del error del provider.
          }
        }

        throw this.#mapHttpError(response.status, payload)
      }
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
