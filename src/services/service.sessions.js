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

      const isProd = process.env.NODE_ENV === 'production'

      res.cookie(env.cookie.name, token, {
        httpOnly: true,
        secure: isProd,
        sameSite: isProd ? 'none' : 'lax',
        maxAge: env.cookie.maxAge
      })

      log(`🍪 Cookie JWT seteada correctamente: ${env.cookie.name}`)

      return {
        status: 200,
        message: 'Usuario autenticado correctamente'
      }
    } catch (err) {
      logError('❌ SessionsService.generateAuthResponse error:', err)
      // Pasamos error para que lo maneje errorHandler.js
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
