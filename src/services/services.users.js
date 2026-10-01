import mongoose from 'mongoose'
import UserAdminManager from '../dao/managers/userAdmin.mongo.js'
import logger from '../utils/logger.js'
import { createHash } from '../utils/utils.passport.js'
import {
  generateVerificationToken,
  getVerificationTokenExpiration,
  hashVerificationToken
} from '../utils/emailVerificationToken.js'
import TransactionalEmailService from './transactionalEmail.service.js'

const EMAIL_VERIFICATION_COOLDOWN_MS = 60 * 1000

class ServiceError extends Error {
  constructor(message, code = 'SERVICE_ERROR', meta = undefined) {
    super(message)
    this.name = 'ServiceError'
    this.code = code
    this.meta = meta
  }
}

class UsersService {
  constructor() {
    this.users = new UserAdminManager()
    this.transactionalEmailService = new TransactionalEmailService()
    this.allowedRoles = new Set(['ADMIN', 'USER', 'PREMIUM'])
  }

  #assertValidObjectId(id) {
    if (!id) throw new ServiceError('ID requerido', 'MISSING_ID')
    if (!mongoose.Types.ObjectId.isValid(id)) {
      throw new ServiceError('ID inválido', 'INVALID_ID')
    }
  }

  async getUsers() {
    try {
      logger.debug('[UsersService] getUsers')
      const users = await this.users.getAllUsers()

      if (!users) return []

      if (!Array.isArray(users)) {
        throw new ServiceError('Formato inválido al obtener usuarios', 'INVALID_DATA_FORMAT')
      }

      return users
    } catch (err) {
      if (err instanceof ServiceError) throw err
      logger.error(`[UsersService] getUsers error: ${err?.message || err}`)
      throw new ServiceError('Error al obtener usuarios', 'GET_USERS_FAILED', {
        cause: err?.message
      })
    }
  }

  async addUser(bodyUser) {
    try {
      logger.debug('[UsersService] addUser')

      if (!bodyUser || typeof bodyUser !== 'object') {
        throw new ServiceError('Datos inválidos para crear usuario', 'INVALID_USER_PAYLOAD')
      }

      const { firstName, lastName, email, password, role } = bodyUser

      if (!firstName || !lastName || !email || !password) {
        throw new ServiceError('Todos los campos son obligatorios', 'MISSING_REQUIRED_FIELDS')
      }

      // ✅ Validación básica de password antes de hashear (ajustá a tu regla real)
      const passStr = String(password)
      if (passStr.length < 6 || passStr.length > 30) {
        throw new ServiceError('Contraseña inválida', 'INVALID_PASSWORD')
      }

      const normalizedEmail = String(email).trim().toLowerCase()

      const existing = await this.users.getUserForEmail(normalizedEmail)
      if (existing) {
        throw new ServiceError('El usuario ya existe', 'USER_ALREADY_EXISTS')
      }

      const safeRole = role ? String(role).trim().toUpperCase() : 'USER'
      if (!this.allowedRoles.has(safeRole)) {
        throw new ServiceError('Rol inválido', 'INVALID_ROLE')
      }

      // ✅ HASH DEL PASSWORD (clave para passport + bcrypt.compare)
      const hashedPassword = createHash(passStr)

      const created = await this.users.createUser({
        ...bodyUser,
        email: normalizedEmail,
        role: safeRole,
        password: hashedPassword
      })

      if (!created) {
        throw new ServiceError('No se pudo crear el usuario', 'CREATE_USER_FAILED')
      }

      logger.info(`[UsersService] Usuario creado email=${normalizedEmail}`)
      return this.#sanitizeUser(created)
    } catch (err) {
      const msg = String(err?.message || '')
      const isDuplicate =
        msg.toLowerCase().includes('e11000') || msg.toLowerCase().includes('duplicate')

      if (isDuplicate) {
        throw new ServiceError('El usuario ya existe', 'USER_ALREADY_EXISTS')
      }

      if (err instanceof ServiceError) throw err

      logger.error(`[UsersService] addUser error: ${err?.message || err}`)
      throw new ServiceError('Error interno al crear usuario', 'ADD_USER_FAILED', {
        cause: err?.message
      })
    }
  }

  async registerPublicUser(bodyUser) {
    try {
      logger.debug('[UsersService] registerPublicUser')

      if (!bodyUser || typeof bodyUser !== 'object') {
        throw new ServiceError('Datos inválidos para crear usuario', 'INVALID_USER_PAYLOAD')
      }

      const { firstName, lastName, email, password } = bodyUser

      const user = await this.addUser({
        firstName,
        lastName,
        email,
        password,
        role: 'USER'
      })

      let verificationEmailSent = false

      try {
        const issuedAt = new Date()
        const token = generateVerificationToken()
        const tokenHash = hashVerificationToken(token)
        const expiresAt = getVerificationTokenExpiration(issuedAt)

        const pendingUser = await this.users.setEmailVerificationToken(user._id, {
          tokenHash,
          expiresAt,
          lastSentAt: issuedAt
        })

        if (!pendingUser) {
          throw new Error('No se pudo preparar la verificación de email')
        }

        await this.transactionalEmailService.sendEmailVerification({
          email: pendingUser.email,
          firstName: pendingUser.firstName,
          token
        })

        verificationEmailSent = true
      } catch (verificationError) {
        logger.error(
          `[UsersService] No se pudo enviar la verificación inicial: ${verificationError?.message || verificationError}`
        )
      }

      return {
        user,
        verificationEmailSent
      }
    } catch (err) {
      if (err instanceof ServiceError) throw err

      logger.error(`[UsersService] registerPublicUser error: ${err?.message || err}`)
      throw new ServiceError('Error interno al registrar usuario', 'PUBLIC_REGISTER_FAILED', {
        cause: err?.message
      })
    }
  }

  async verifyEmail(token) {
    try {
      const normalizedToken = typeof token === 'string' ? token.trim() : ''

      if (!normalizedToken || normalizedToken.length > 512) {
        throw new ServiceError(
          'El token de verificación es inválido.',
          'EMAIL_VERIFICATION_TOKEN_INVALID'
        )
      }

      const tokenHash = hashVerificationToken(normalizedToken)
      const pendingUser = await this.users.getPendingUserByVerificationTokenHash(tokenHash)

      if (!pendingUser) {
        throw new ServiceError(
          'El token de verificación es inválido o ya fue utilizado.',
          'EMAIL_VERIFICATION_TOKEN_INVALID'
        )
      }

      const now = new Date()
      const expiresAt = pendingUser.emailVerificationExpiresAt

      if (!expiresAt || new Date(expiresAt).getTime() <= now.getTime()) {
        throw new ServiceError(
          'El token de verificación venció. Solicitá un nuevo correo.',
          'EMAIL_VERIFICATION_TOKEN_EXPIRED'
        )
      }

      const verifiedUser = await this.users.markEmailVerified({
        userId: pendingUser._id,
        tokenHash,
        verifiedAt: now
      })

      if (!verifiedUser) {
        throw new ServiceError(
          'El token de verificación es inválido o ya fue utilizado.',
          'EMAIL_VERIFICATION_TOKEN_INVALID'
        )
      }

      return {
        emailVerified: true,
        emailVerifiedAt: verifiedUser.emailVerifiedAt
      }
    } catch (err) {
      if (err instanceof ServiceError) throw err

      logger.error(`[UsersService] verifyEmail error: ${err?.message || err}`)
      throw new ServiceError(
        'No se pudo verificar el correo electrónico.',
        'EMAIL_VERIFICATION_FAILED'
      )
    }
  }

  async resendEmailVerification(email) {
    const normalizedEmail = String(email || '')
      .trim()
      .toLowerCase()

    if (!normalizedEmail || !/^\S+@\S+\.\S+$/.test(normalizedEmail)) {
      return { accepted: true }
    }

    try {
      const attemptedAt = new Date()
      const cooldownBefore = new Date(attemptedAt.getTime() - EMAIL_VERIFICATION_COOLDOWN_MS)
      const token = generateVerificationToken()
      const tokenHash = hashVerificationToken(token)
      const expiresAt = getVerificationTokenExpiration(attemptedAt)

      const pendingUser = await this.users.claimEmailVerificationResend({
        email: normalizedEmail,
        tokenHash,
        expiresAt,
        attemptedAt,
        cooldownBefore
      })

      if (!pendingUser) {
        return { accepted: true }
      }

      try {
        await this.transactionalEmailService.sendEmailVerification({
          email: pendingUser.email,
          firstName: pendingUser.firstName,
          token
        })
      } catch (sendError) {
        logger.error(
          `[UsersService] No se pudo reenviar la verificación: ${sendError?.message || sendError}`
        )
      }

      return { accepted: true }
    } catch (err) {
      logger.error(`[UsersService] resendEmailVerification error: ${err?.message || err}`)
      return { accepted: true }
    }
  }

  async deleteUserById(id) {
    try {
      logger.debug(`[UsersService] deleteUserById id=${id}`)

      this.#assertValidObjectId(id)

      const result = await this.users.deleteUser(id)
      return result?.deletedCount === 1
    } catch (err) {
      if (err instanceof ServiceError) throw err

      logger.error(`[UsersService] deleteUserById error: ${err?.message || err}`)
      throw new ServiceError('Error interno al eliminar usuario', 'DELETE_USER_FAILED', {
        cause: err?.message
      })
    }
  }

  async updateRole(id, payload) {
    try {
      logger.debug(`[UsersService] updateRole id=${id}`)

      this.#assertValidObjectId(id)

      if (!payload || typeof payload !== 'object') {
        throw new ServiceError('Datos inválidos para actualizar rol', 'INVALID_ROLE_PAYLOAD')
      }

      const role = payload.role ?? payload.newRole ?? payload?.data?.role
      if (!role) throw new ServiceError('Rol requerido', 'MISSING_ROLE')

      const normalizedRole = String(role).trim().toUpperCase()
      if (!this.allowedRoles.has(normalizedRole)) {
        throw new ServiceError('Rol inválido', 'INVALID_ROLE')
      }

      const updated = await this.users.updateUser(id, { role: normalizedRole })
      return Boolean(updated)
    } catch (err) {
      if (err instanceof ServiceError) throw err

      logger.error(`[UsersService] updateRole error: ${err?.message || err}`)
      throw new ServiceError('Error interno al actualizar rol', 'UPDATE_ROLE_FAILED', {
        cause: err?.message
      })
    }
  }

  async getUserForAuth(email) {
    try {
      logger.debug('[UsersService] getUserForAuth')

      if (!email) throw new ServiceError('Email requerido', 'MISSING_EMAIL')

      const normalizedEmail = String(email).trim().toLowerCase()
      const user = await this.users.getUserForAuth(normalizedEmail)
      return user || null
    } catch (err) {
      if (err instanceof ServiceError) throw err

      logger.error(`[UsersService] getUserForAuth error: ${err?.message || err}`)
      throw new ServiceError('Error al obtener usuario para auth', 'GET_USER_AUTH_FAILED', {
        cause: err?.message
      })
    }
  }

  #sanitizeUser(user) {
    const obj = typeof user?.toObject === 'function' ? user.toObject() : user
    if (!obj || typeof obj !== 'object') return obj
    const sanitized = { ...obj }

    delete sanitized.password
    delete sanitized.__v
    delete sanitized.emailVerificationTokenHash
    delete sanitized.emailVerificationExpiresAt
    delete sanitized.emailVerificationLastSentAt

    return sanitized
  }
}

export { ServiceError }
export default UsersService
