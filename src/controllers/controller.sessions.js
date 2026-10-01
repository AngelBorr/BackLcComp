import SessionsService from '../services/service.sessions.js'
import env from '../config.js'
import { log, warn, error as logError, secureLog } from '../utils/logger.js'

const sessionsService = new SessionsService()

/**
 * 🔐 LOGIN (Passport ya autenticó)
 * - Nunca debe llegar acá sin req.user
 * - Todas las credenciales incorrectas ya fueron manejadas en sessions.router.js
 */
export const loginUser = async (req, res, next) => {
  try {
    if (!req.user) {
      // Caso improbable → Passport maneja la mayoría de errores antes
      warn('⚠️ loginUser llamado sin req.user')
      return res.status(401).json({
        status: 'error',
        message: 'Credenciales inválidas'
      })
    }

    // Log seguro (solo en dev)
    secureLog('🔐 Usuario autenticado → payload:', {
      id: req.user._id ?? req.user.id,
      email: req.user.email,
      role: req.user.role
    })

    const result = await sessionsService.generateAuthResponse(req.user, res)

    return res.status(result.status).json({
      status: result.status === 200 ? 'success' : 'error',
      message: result.message,
      user: result.user
    })
  } catch (err) {
    logError('❌ controller.sessions.loginUser error:', err)
    err.statusCode = 500
    next(err)
  }
}

/**
 * 🔐 Error de login (para debug)
 */
export const failLogin = (_, res) => {
  return res.status(401).json({
    status: 'error',
    message: 'Fallo en autenticación'
  })
}

/**
 * 👤 CURRENT USER (requiere handlePolicies)
 * handlePolicies ya garantiza que req.user exista y sea válido
 */
export const currentUser = async (req, res, next) => {
  try {
    if (!req.user) {
      warn('⚠️ currentUser llamado sin req.user')
      return res.status(401).json({
        status: 'error',
        message: 'Usuario no autenticado'
      })
    }

    secureLog('🔍 currentUser req.user:', {
      id: req.user.id ?? req.user._id,
      email: req.user.email,
      role: req.user.role
    })

    const result = await sessionsService.getCurrentUser(req.user)
    return res.status(result.status).json(result)
  } catch (err) {
    logError('❌ controller.sessions.currentUser error:', err)
    err.statusCode = 500
    next(err)
  }
}

/**
 * 🚪 LOGOUT
 * - Borra cookie httpOnly
 * - No depende de localStorage
 */
export const logoutUser = async (req, res, next) => {
  try {
    const result = await sessionsService.logoutUser(req.user)

    const isProd = process.env.NODE_ENV === 'production'

    res.clearCookie(env.cookie.name, {
      httpOnly: true,
      secure: isProd,
      sameSite: isProd ? 'none' : 'lax',
      path: '/', // ✅ CLAVE
      ...(env.cookie.domain ? { domain: env.cookie.domain } : {}) // ✅ opcional
    })

    log('🔵 Cookie JWT eliminada correctamente')

    return res.status(200).json({
      status: 'success',
      message: result.message
    })
  } catch (err) {
    logError('❌ controller.sessions.logoutUser error:', err)
    err.statusCode = 500
    next(err)
  }
}
