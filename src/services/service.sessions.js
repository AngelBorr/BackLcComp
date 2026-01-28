import jwt from 'jsonwebtoken'
import env from '../config.js'
import UsersService from '../services/services.users.js'
import { log, warn, error as logError, secureLog } from '../utils/logger.js'

const usersService = new UsersService()

class SessionsService {
  /**
   * 🔐 Genera token JWT y setea cookie httpOnly segura.
   * Se usa en /api/sessions/login luego de validar credenciales por Passport.
   */
  async generateAuthResponse(user, res) {
    try {
      const payload = {
        id: user._id,
        firstName: user.firstName,
        lastName: user.lastName,
        email: user.email,
        role: user.role
      }

      secureLog('🔐 Generando token para usuario:', payload)

      const token = jwt.sign({ user: payload }, env.jwt.privateKey, {
        expiresIn: env.jwt.expiresIn
      })

      // ✅ NO dependas de NODE_ENV si no existe
      // ✅ Usá SIEMPRE la config centralizada de env.cookie
      res.cookie(env.cookie.name, token, {
        httpOnly: true,
        secure: env.cookie.secure, // ✅ true en prod si usás HTTPS (recomendado)
        sameSite: env.cookie.sameSite, // ✅ 'none' si front/back son dominios distintos
        maxAge: env.cookie.maxAge,
        path: '/', // ✅ CLAVE
        ...(env.cookie.domain ? { domain: env.cookie.domain } : {}) // ✅ opcional
      })

      log(`🍪 Cookie JWT seteada correctamente: ${env.cookie.name}`)

      return {
        status: 200,
        message: 'Usuario autenticado correctamente',
        user: payload
      }
    } catch (err) {
      logError('❌ SessionsService.generateAuthResponse error:', err)
      err.statusCode = 500
      throw err
    }
  }

  /**
   * 👤 Retorna los datos del usuario autenticado según el token JWT.
   * El middleware handlePolicies ya inyectó req.user.
   */
  async getCurrentUser(user) {
    try {
      if (!user?.email) {
        warn('⚠️ Token recibido sin email válido')
        return { status: 400, message: 'Datos de usuario inválidos en el token' }
      }

      const dbUser = await usersService.getUserForAuth(user.email)

      if (!dbUser) {
        warn(`⚠️ Usuario no encontrado: ${user.email}`)
        return { status: 404, message: 'Usuario no encontrado' }
      }

      const safeUser = {
        id: dbUser._id,
        firstName: dbUser.firstName,
        lastName: dbUser.lastName,
        email: dbUser.email,
        role: dbUser.role
      }

      secureLog('🔍 Usuario encontrado en DB:', safeUser)

      return {
        status: 200,
        message: 'Usuario autenticado correctamente',
        user: safeUser
      }
    } catch (err) {
      logError('❌ SessionsService.getCurrentUser error:', err)
      return { status: 500, message: 'Error al obtener datos del usuario' }
    }
  }

  /**
   * 🚪 Cierre de sesión → limpia cookie y responde al cliente.
   */
  async logoutUser(user) {
    try {
      const email = user?.email || 'usuario desconocido'

      log(`👋 Logout exitoso para ${email}`)

      return {
        success: true,
        message: `Logout exitoso para ${email}`
      }
    } catch (err) {
      logError('❌ SessionsService.logoutUser error:', err)
      err.statusCode = 500
      throw err
    }
  }
}

export default SessionsService
