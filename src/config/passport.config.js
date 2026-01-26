import passport from 'passport'
import local from 'passport-local'
import jwt from 'passport-jwt'
import env from '../config.js'
import UsersService from '../services/services.users.js'
import { isValidPassword } from '../utils/utils.passport.js'
import { warn, error as logError, secureLog } from '../utils/logger.js'

const usersService = new UsersService()
const LocalStrategy = local.Strategy
const JWTStrategy = jwt.Strategy
const ExtractJWT = jwt.ExtractJwt

const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/

const initializePassport = () => {
  /**
   * 🔐 Estrategia Local → Login
   */
  passport.use(
    'login',
    new LocalStrategy(
      { usernameField: 'email', passwordField: 'password', session: false },

      async (email, password, done) => {
        try {
          const normalized = String(email || '')
            .trim()
            .toLowerCase()

          // 1️⃣ Validación del email
          if (!normalized || !emailRegex.test(normalized)) {
            warn(`⚠️ Intento de login con email inválido: ${email}`)
            return done(null, false, { message: 'Email inválido' })
          }

          // 2️⃣ Validación de contraseña
          if (!password || password.length < 4) {
            warn(`⚠️ Intento de login con contraseña inválida para: ${normalized}`)
            return done(null, false, { message: 'Contraseña inválida' })
          }

          // 3️⃣ Buscar usuario
          const user = await usersService.getUserForAuth(normalized)

          if (!user) {
            warn(`⚠️ Usuario inexistente: ${normalized}`)
            return done(null, false, { message: 'Usuario inexistente' })
          }

          // 4️⃣ Verificación de contraseña
          const validPass = isValidPassword(user, password)

          if (!validPass) {
            warn(`⚠️ Contraseña incorrecta para usuario: ${normalized}`)
            return done(null, false, { message: 'Credenciales incorrectas' })
          }

          // 5️⃣ Login exitoso
          secureLog('🔐 Login correcto para:', {
            id: user._id,
            email: user.email,
            role: user.role
          })

          return done(null, user)
        } catch (err) {
          logError('❌ Error interno en Passport LocalStrategy:', err)
          return done(err)
        }
      }
    )
  )

  /**
   * 🔮 Estrategia JWT
   * Maneja autenticación persistente vía cookie httpOnly
   */
  passport.use(
    'jwt',
    new JWTStrategy(
      {
        jwtFromRequest: ExtractJWT.fromExtractors([
          (req) => req?.cookies?.[env.cookie.name] || null
        ]),
        secretOrKey: env.jwt.privateKey
      },
      async (payload, done) => {
        try {
          if (!payload?.user) {
            warn('⚠️ Token recibido sin payload.user')
            return done(null, false)
          }

          secureLog('🔐 JWT verificado para usuario:', payload.user)

          return done(null, payload.user)
        } catch (err) {
          logError('❌ Error interno en JWTStrategy:', err)
          return done(err)
        }
      }
    )
  )
}

export default initializePassport
