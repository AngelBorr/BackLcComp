// src/routes/sessions.router.js
import MyOwnRouter from './router.js'
import passport from 'passport'
import {
  loginUser,
  failLogin,
  currentUser,
  logoutUser
} from '../controllers/controller.sessions.js'
import { error as logError } from '../utils/logger.js'

export default class SessionsRouter extends MyOwnRouter {
  init() {
    this.post('/login', ['PUBLIC'], async (req, res, next) => {
      passport.authenticate('login', { session: false }, (err, user, info) => {
        // ❌ Error técnico interno → pasa al errorHandler (500)
        if (err) {
          logError('🔥 Error interno en Passport:', err)
          return next(err)
        }

        // ❌ Error de credenciales (email/contraseña incorrecta)
        if (!user) {
          const message = info?.message || 'Credenciales inválidas'
          logError('⚠️ Error de autenticación:', message)

          return res.status(401).json({
            status: 'error',
            message
          })
        }

        // 🟢 Guardar el user validado para el controller
        req.user = user
        return loginUser(req, res, next)
      })(req, res, next)
    })

    this.get('/failLogin', ['PUBLIC'], failLogin)
    this.get('/current', ['USER', 'ADMIN', 'PREMIUM'], currentUser)
    this.post('/logout', ['USER', 'ADMIN', 'PREMIUM'], logoutUser)
  }
}
