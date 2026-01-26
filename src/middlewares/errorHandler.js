// src/middlewares/errorHandler.js
import { error as logError } from '../utils/logger.js'

const isProd = process.env.NODE_ENV === 'production'

/**
 * Middleware para rutas no encontradas (404)
 */
export const notFoundHandler = (req, res, next) => {
  return res.status(404).json({
    status: 'error',
    message: `Ruta no encontrada: ${req.method} ${req.originalUrl}`
  })
}

/**
 * Middleware global de manejo de errores.
 * Cualquier `next(err)` o error no capturado en rutas/controladores
 * debería terminar acá.
 */
export const errorHandler = (err, req, res, next) => {
  // Si ya se enviaron headers, delegamos a Express
  if (res.headersSent) {
    return next(err)
  }

  const statusCode = err.statusCode || 500

  // Loguear SIEMPRE el error en backend
  logError(`Error en petición ${req.method} ${req.originalUrl}:`, err.message, err.stack || '')

  const baseResponse = {
    status: 'error',
    message: isProd ? 'Error interno del servidor' : err.message || 'Error interno del servidor'
  }

  // En desarrollo podemos enviar el stack para debugguear
  if (!isProd && err.stack) {
    baseResponse.stack = err.stack
  }

  return res.status(statusCode).json(baseResponse)
}
