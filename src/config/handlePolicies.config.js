import jwt from 'jsonwebtoken'
import env from '../config.js'
import { log, warn, error as logError, secureLog } from '../utils/logger.js'

const isDev = process.env.NODE_ENV !== 'production'

const isTest = process.env.NODE_ENV === 'test'

const handlePolicies =
  (policies = []) =>
  (req, res, next) => {
    try {
      log('🔵 [handlePolicies] Ejecutando política:', policies)

      // 🟢 En test mode → TODAS LAS RUTAS SON PUBLIC
      if (isTest) {
        console.log('[TEST MODE] 🔓 Acceso libre (ignorado policies)')
        return next()
      }

      // 🟢 1. Ruta pública
      const firstPolicy = String(policies[0] || '').toUpperCase()

      if (firstPolicy === 'PUBLIC' || policies.length === 0) {
        log('🟢 Ruta pública → acceso automático')
        return next()
      }

      // 🟠 2. Leer cookie JWT
      const token = req.cookies?.[env.cookie.name]

      if (isDev) {
        secureLog('🔵 Cookie de autenticación recibida:', {
          cookiePresent: Boolean(token)
        })
      }

      if (!token) {
        warn('❌ Cookie no encontrada. Acceso denegado.')
        return res.status(401).json({
          status: 'error',
          message: 'No autenticado. Cookie faltante.'
        })
      }

      // 🔵 3. Verificar token
      let decoded
      try {
        decoded = jwt.verify(token, env.jwt.privateKey)
      } catch (err) {
        warn('❌ Error verificando JWT:', err.message)

        return res.status(401).json({
          status: 'error',
          message: 'Token inválido o expirado.'
        })
      }

      const user = decoded?.user

      if (!user) {
        warn('❌ Token sin estructura válida (falta user)')
        return res.status(401).json({
          status: 'error',
          message: 'Token corrupto o incompleto.'
        })
      }

      secureLog('🔍 Usuario encontrado en token:', {
        email: user.email,
        role: user.role
      })

      // 🔐 4. Validar rol
      const requiredPolicies = policies.map((p) => p.toUpperCase())
      const userRole = String(user.role || '').toUpperCase()

      if (!userRole) {
        warn('⚠️ Token sin rol asignado')
        return res.status(401).json({
          status: 'error',
          message: 'Token sin rol asignado.'
        })
      }

      // SUPERADMIN siempre pasa
      if (userRole === 'SUPERADMIN') {
        log('🟢 SUPERADMIN autorizado')
        req.user = user
        return next()
      }

      // Verificación normal
      if (!requiredPolicies.includes(userRole)) {
        warn(`🚫 Rol '${userRole}' no autorizado. Requiere: ${requiredPolicies}`)
        return res.status(403).json({
          status: 'error',
          message: 'Acceso denegado. Rol no autorizado.'
        })
      }

      // 🟢 5. Autorizado
      req.user = user
      log(`✅ Usuario autenticado: ${user.email}`)

      next()
    } catch (err) {
      logError('❌ Error crítico en handlePolicies:', err)
      err.statusCode = 500
      return next(err) // Delegamos al errorHandler global
    }
  }

export default handlePolicies
