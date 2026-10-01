import userAdminModel from '../models/userAdmin.model.js'

class UserAdminManager {
  constructor() {
    this.userAdmin = userAdminModel
  }

  // trae a todos los usuarios (sin password)
  async getAllUsers() {
    return this.userAdmin.find().select('-password').lean()
  }

  // crea al usuario
  async createUser(bodyUser) {
    return this.userAdmin.create(bodyUser)
  }

  // trae al usuario por su id (sin password)
  async getUserById(id, { session } = {}) {
    const query = this.userAdmin.findById(id).select('-password').lean()

    if (session) query.session(session)

    return query
  }

  // eliminar un usuario
  async deleteUser(id) {
    return this.userAdmin.deleteOne({ _id: id })
  }

  // trae al usuario por su email (sin password)
  async getUserForEmail(email) {
    return this.userAdmin.findOne({ email }).select('-password').lean()
  }

  // ✅ para login/auth (incluye password aunque esté select:false)
  async getUserForAuth(email) {
    return this.userAdmin.findOne({ email }).select('+password').lean()
  }

  // ✅ actualizar usuario (sin password)
  async updateUser(id, data) {
    return this.userAdmin.findByIdAndUpdate(id, data, { new: true }).select('-password').lean()
  }

  async setEmailVerificationToken(
    userId,
    { tokenHash, expiresAt, lastSentAt }
  ) {
    return this.userAdmin
      .findOneAndUpdate(
        {
          _id: userId,
          role: 'USER',
          emailVerified: { $ne: true }
        },
        {
          $set: {
            emailVerified: false,
            emailVerifiedAt: null,
            emailVerificationTokenHash: tokenHash,
            emailVerificationExpiresAt: expiresAt,
            emailVerificationLastSentAt: lastSentAt
          }
        },
        { new: true }
      )
      .select('firstName lastName email role emailVerified emailVerifiedAt')
      .lean()
  }

  async getPendingUserByVerificationTokenHash(tokenHash) {
    return this.userAdmin
      .findOne({
        emailVerificationTokenHash: tokenHash,
        role: 'USER',
        emailVerified: { $ne: true }
      })
      .select(
        'role emailVerified +emailVerificationTokenHash +emailVerificationExpiresAt'
      )
      .lean()
  }

  async markEmailVerified({ userId, tokenHash, verifiedAt }) {
    return this.userAdmin
      .findOneAndUpdate(
        {
          _id: userId,
          role: 'USER',
          emailVerified: { $ne: true },
          emailVerificationTokenHash: tokenHash,
          emailVerificationExpiresAt: { $gt: verifiedAt }
        },
        {
          $set: {
            emailVerified: true,
            emailVerifiedAt: verifiedAt,
            emailVerificationTokenHash: null,
            emailVerificationExpiresAt: null,
            emailVerificationLastSentAt: null
          }
        },
        { new: true }
      )
      .select('emailVerified emailVerifiedAt role')
      .lean()
  }

  async claimEmailVerificationResend({
    email,
    tokenHash,
    expiresAt,
    attemptedAt,
    cooldownBefore
  }) {
    return this.userAdmin
      .findOneAndUpdate(
        {
          email,
          role: 'USER',
          emailVerified: { $ne: true },
          $or: [
            { emailVerificationLastSentAt: null },
            { emailVerificationLastSentAt: { $exists: false } },
            { emailVerificationLastSentAt: { $lte: cooldownBefore } }
          ]
        },
        {
          $set: {
            emailVerificationTokenHash: tokenHash,
            emailVerificationExpiresAt: expiresAt,
            emailVerificationLastSentAt: attemptedAt
          }
        },
        { new: true }
      )
      .select('firstName email role emailVerified')
      .lean()
  }
}

export default UserAdminManager
