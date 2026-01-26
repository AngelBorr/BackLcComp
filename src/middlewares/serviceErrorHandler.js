import { ServiceError } from '../services/services.users.js'
import { mapServiceErrorToHttp } from './serviceErrorMapper.js'

export const serviceErrorHandler = (err, req, res, next) => {
  if (res.headersSent) return next(err)

  // Solo manejamos ServiceError acá; lo demás va al errorHandler global
  if (!(err instanceof ServiceError)) return next(err)

  const { status, message } = mapServiceErrorToHttp(err)

  const logLine = `[serviceErrorHandler] ${req.method} ${req.originalUrl} → ${status} | ${err.code} | ${err.message}`

  // ✅ 4xx = warn, 5xx = error (más limpio para monitoreo)
  if (status >= 500) req.logger?.error?.(logLine)
  else req.logger?.warn?.(logLine)

  return res.status(status).json({
    status: 'error',
    message
  })
}
