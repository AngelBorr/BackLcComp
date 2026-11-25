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

const PUBLIC_ADMIN_ERROR_CODES = new Set([
  'IDEMPOTENCY_KEY_REUSED',
  'ATTENTION_INVENTORY_REPAIR_ALREADY_COMPLETED',
  'INSUFFICIENT_REPAIR_INVENTORY',
  'ATTENTION_RESOLUTION_CAS_CONFLICT',
  'INVENTORY_REPAIR_PAYMENT_EVIDENCE_CHANGED',
  'INVENTORY_REPAIR_ORDER_STATE_CHANGED',
  'ORDER_ACTIVE_REFUND_CONFLICT',
  'INVALID_FULFILLMENT_TRANSITION',
  'ORDER_FULFILLMENT_CONFLICT'
])

const ADMIN_ROLES = new Set(['ADMIN', 'SUPERADMIN'])

const isPublicAdminError = (req, code) => (
  ADMIN_ROLES.has(String(req.user?.role || '').toUpperCase()) &&
  PUBLIC_ADMIN_ERROR_CODES.has(code)
)

const toPublicAdminErrorHttp = (err) => {
  const rawStatus = Number.isInteger(err.statusCode) ? err.statusCode : err.status
  const status = Number.isInteger(rawStatus) && rawStatus >= 400 && rawStatus <= 599
    ? rawStatus
    : 500

  return {
    status,
    message: err.message || 'Error interno del servidor'
  }
}

const toPublicCheckoutBlocker = (value) => {
  if (!value || typeof value !== 'object' || !PUBLIC_CHECKOUT_ERROR_CODES.has(value.code)) {
    return undefined
  }

  const blocker = {
    code: value.code,
    orderNumber: /^LC-\d{4}-\d{6,}$/.test(String(value.orderNumber || ''))
      ? String(value.orderNumber)
      : undefined,
    orderStatus: ['pending_payment', 'paid', 'refunded', 'cancelled', 'expired', 'requires_attention']
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

  // Manager errors are accepted only for authenticated administrative actors
  // and explicitly allowlisted domain codes.
  const isServiceError = (
    err instanceof UsersServiceError ||
    err instanceof ProductsServiceError
  )
  const isAdminError = isPublicAdminError(req, err.code)

  if (!isServiceError && !isAdminError) {
    return next(err)
  }

  const { status, message } = isServiceError
    ? mapServiceErrorToHttp(err)
    : toPublicAdminErrorHttp(err)

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
  } else if (isAdminError) {
    payload.code = err.code
  }

  return res.status(status).json(payload)
}

export {
  PUBLIC_ADMIN_ERROR_CODES,
  PUBLIC_CHECKOUT_ERROR_CODES,
  isPublicAdminError,
  toPublicCheckoutBlocker
}
