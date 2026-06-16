import mongoose, { Schema } from 'mongoose'

const sendCollection = 'sends'

const SendSchema = new Schema(
  {
    sendName: {
      type: String,
      required: true,
      trim: true,
      maxlength: 120
    },

    sendType: {
      type: String,
      enum: ['individual', 'massive'],
      required: true,
      index: true
    },

    messageId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'messageTemplates',
      required: false,
      index: true
    },

    subjectSnapshot: {
      type: String,
      required: true,
      trim: true,
      maxlength: 200
    },

    contentSnapshot: {
      type: String,
      required: true
    },

    internalNote: {
      type: String,
      trim: true,
      maxlength: 1000,
      default: ''
    },

    recipients: [
      {
        recipientId: {
          type: mongoose.Schema.Types.ObjectId,
          ref: 'recipients',
          required: false
        },
        email: {
          type: String,
          required: true,
          lowercase: true,
          trim: true,
          match: /^\S+@\S+\.\S+$/
        },
        name: {
          type: String,
          trim: true,
          default: ''
        },
        status: {
          type: String,
          enum: ['pending', 'success', 'failed'],
          default: 'pending'
        },
        errorMessage: {
          type: String,
          maxlength: 1000,
          required: false
        },
        emailLogId: {
          type: mongoose.Schema.Types.ObjectId,
          ref: 'emailLogs',
          required: false
        }
      }
    ],

    attachments: [
      {
        filename: {
          type: String,
          required: true
        },
        mimetype: {
          type: String,
          required: false
        },
        size: {
          type: Number,
          required: false
        }
      }
    ],

    totalRecipients: {
      type: Number,
      default: 0,
      min: 0
    },

    successCount: {
      type: Number,
      default: 0,
      min: 0
    },

    failedCount: {
      type: Number,
      default: 0,
      min: 0
    },

    status: {
      type: String,
      enum: ['pending', 'processing', 'completed', 'partial_failed', 'failed'],
      default: 'pending',
      index: true
    },

    provider: {
      type: String,
      enum: ['resend', 'nodemailer', 'unknown'],
      default: 'resend'
    },

    createdBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'users',
      required: false
    }
  },
  { timestamps: true }
)

SendSchema.index({ createdAt: -1 })
SendSchema.index({ sendName: 'text', subjectSnapshot: 'text' })
SendSchema.index({ status: 1, createdAt: -1 })

export default mongoose.model(sendCollection, SendSchema)
