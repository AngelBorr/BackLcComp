import mongoose, { Schema } from 'mongoose'

const emailLogCollection = 'emailLogs'

const EmailLogSchema = new Schema(
  {
    userId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'usersInscription',
      required: false
    },

    sendId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'sends',
      required: false,
      index: true
    },

    recipientId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'recipients',
      required: false,
      index: true
    },

    email: {
      type: String,
      required: true,
      lowercase: true,
      trim: true,
      match: /^\S+@\S+\.\S+$/
    },

    type: {
      type: String,
      required: true,
      enum: ['inscription_validation', 'mass_validation', 'retry_validation', 'messenger_send']
    },

    status: {
      type: String,
      enum: ['success', 'failed'],
      required: true,
      index: true
    },

    sendName: {
      type: String,
      trim: true,
      required: false
    },

    sendType: {
      type: String,
      enum: ['individual', 'massive'],
      required: false
    },

    subjectSnapshot: {
      type: String,
      trim: true,
      required: false
    },

    contentSnapshot: {
      type: String,
      required: false
    },

    errorMessage: {
      type: String,
      maxlength: 1000,
      required: false
    },

    provider: {
      type: String,
      enum: ['resend', 'nodemailer', 'unknown'],
      default: 'resend'
    },

    providerMessageId: {
      type: String,
      required: false
    },

    attachments: [
      {
        fileAssetId: {
          type: mongoose.Schema.Types.ObjectId,
          ref: 'file_assets',
          required: false
        },

        fileId: {
          type: mongoose.Schema.Types.ObjectId,
          required: false
        },

        filename: String,
        originalName: String,
        mimetype: String,
        size: Number
      }
    ],

    payload: {
      type: Schema.Types.Mixed,
      required: false
    }
  },
  { timestamps: true }
)

EmailLogSchema.index({ createdAt: -1 })
EmailLogSchema.index({ email: 1, createdAt: -1 })
EmailLogSchema.index({ sendId: 1, status: 1 })

export default mongoose.model(emailLogCollection, EmailLogSchema)
