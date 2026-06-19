import mongoose from 'mongoose'

const fileAssetSchema = new mongoose.Schema(
  {
    fileId: {
      type: mongoose.Schema.Types.ObjectId,
      required: true,
      index: true
    },

    filename: {
      type: String,
      required: true,
      trim: true
    },

    originalName: {
      type: String,
      required: true,
      trim: true
    },

    mimetype: {
      type: String,
      required: true,
      trim: true
    },

    size: {
      type: Number,
      required: true,
      min: 1
    },

    module: {
      type: String,
      enum: ['catalog', 'messenger', 'quote', 'billing', 'general'],
      required: true,
      index: true
    },

    entityType: {
      type: String,
      default: null,
      trim: true,
      index: true
    },

    entityId: {
      type: mongoose.Schema.Types.ObjectId,
      default: null,
      index: true
    },

    visibility: {
      type: String,
      enum: ['premium', 'private', 'token'],
      required: true,
      default: 'private',
      index: true
    },

    isActive: {
      type: Boolean,
      default: true,
      index: true
    },

    isDeleted: {
      type: Boolean,
      default: false,
      index: true
    },

    uploadedBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'users',
      default: null
    },

    data: {
      type: mongoose.Schema.Types.Mixed,
      default: {}
    },

    token: {
      type: String,
      default: null,
      index: true
    },

    expiresAt: {
      type: Date,
      default: null,
      index: true
    }
  },
  {
    timestamps: true
  }
)

fileAssetSchema.index({
  module: 1,
  visibility: 1,
  isActive: 1,
  isDeleted: 1,
  createdAt: -1
})

fileAssetSchema.index({
  module: 1,
  entityType: 1,
  entityId: 1,
  isDeleted: 1
})

fileAssetSchema.index({
  token: 1,
  expiresAt: 1,
  isDeleted: 1
})

export default mongoose.model('file_assets', fileAssetSchema)
