import mongoose from 'mongoose'

const userCollection = 'users'

const userAdminSchema = new mongoose.Schema(
  {
    firstName: {
      type: String,
      required: true,
      trim: true
    },
    lastName: {
      type: String,
      required: true,
      trim: true
    },
    email: {
      type: String,
      required: true,
      unique: true,
      trim: true,
      lowercase: true,
      match: /^\S+@\S+\.\S+$/
    },
    password: {
      type: String,
      required: true,
      select: false // ✅ nunca sale “por accidente”
    },
    role: {
      type: String,
      enum: ['ADMIN', 'USER', 'PREMIUM'],
      default: 'USER'
    }
  },
  {
    timestamps: true // ✅ createdAt / updatedAt
  }
)

// ✅ índice único explícito
userAdminSchema.index({ email: 1 }, { unique: true })

const userAdminModel = mongoose.model(userCollection, userAdminSchema)
export default userAdminModel
