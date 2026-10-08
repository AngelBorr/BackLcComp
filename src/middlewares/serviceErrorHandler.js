import { ServiceError as ProductsServiceError } from '../services/service.products.js'
import { ServiceError as UsersServiceError } from '../services/services.users.js'
import { mapServiceErrorToHttp } from './serviceErrorMapper.js'

const PUBLIC_CHECKOUT_ERROR_CODES = new Set([
  'CHECKOUT_BLOCKED_BY_APPROVED_PAYMENT',
  'CHECKOUT_PRIOR_PAYMENT_CONFIRMED',
  'CHECKOUT_BLOCKED_BY_ACTIVE_ORDER',
  'CHECKOUT_PRIOR_PAYMENT_UNCERTAIN',
  'CHECKOUT_IN_PROGRESS',
  'CHECKOUT_RECONCILIATION_UNAVAILABLE',
  'CHECKOUT_LOCK_UNAVAILABLE',
  'CHECKOUT_LOCK_LOST'
])

const toPublicCheckoutBlocker = (value) => {
  if (!value || typeof value !== 'object' || !PUBLIC_CHECKOUT_ERROR_CODES.has(value.code)) {
    return undefined
  }

  const blocker = {
    code: value.code,
    orderNumber: /^LC-\d{4}-\d{6,}$/.test(String(value.orderNumber || ''))
      ? String(value.orderNumber)
      : undefined,
    orderStatus: ['pending_payment', 'paid', 'cancelled', 'expired', 'requires_attention']
      .includes(value.orderStatus)
      ? value.orderStatus
      : undefined,
    paymentStatus: ['pending', 'approved', 'rejected', 'cancelled', 'refunded', 'requires_attention']
      .includes(value.paymentStatus)
      ? value.paymentStatus
      : undefined,
    attentionReason: /^[A-Z0-9_]{1,100}$/.test(String(value.attentionReason || ''))
      ? String(value.attentionReason)
      : undefined
  }

  return Object.fromEntries(
    Object.entries(blocker).filter(([, fieldValue]) => fieldValue !== undefined)
  )
}

export const serviceErrorHandler = (err, req, res, next) => {
  if (res.headersSent) return next(err)

  // Solo manejamos ServiceError acá; lo demás va al errorHandler global
  if (!(err instanceof UsersServiceError) && !(err instanceof ProductsServiceError)) {
    return next(err)
  }

  const { status, message } = mapServiceErrorToHttp(err)

  const logLine = `[serviceErrorHandler] ${req.method} ${req.originalUrl} → ${status} | ${err.code} | ${err.message}`

  // ✅ 4xx = warn, 5xx = error (más limpio para monitoreo)
  if (status >= 500) req.logger?.error?.(logLine)
  else req.logger?.warn?.(logLine)

  const payload = {
    status: 'error',
    message
  }

  if (PUBLIC_CHECKOUT_ERROR_CODES.has(err.code)) {
    payload.code = err.code
    const blocker = toPublicCheckoutBlocker(err.details?.checkoutBlocker)
    if (blocker) payload.blocker = blocker
  }

  return res.status(status).json(payload)
}

export { PUBLIC_CHECKOUT_ERROR_CODES, toPublicCheckoutBlocker }
