import mongoose, { Schema } from 'mongoose'

const messageTemplateCollection = 'messageTemplates'

const MessageTemplateSchema = new Schema(
  {
    name: {
      type: String,
      required: true,
      trim: true,
      maxlength: 120
    },

    subject: {
      type: String,
      required: true,
      trim: true,
      maxlength: 200
    },

    htmlContent: {
      type: String,
      required: true
    },

    plainTextContent: {
      type: String,
      required: true,
      trim: true
    },

    status: {
      type: String,
      enum: ['draft', 'ready', 'archived'],
      default: 'draft',
      index: true
    },

    category: {
      type: String,
      trim: true,
      default: ''
    },

    tags: [
      {
        type: String,
        trim: true,
        lowercase: true
      }
    ],

    variables: [
      {
        type: String,
        trim: true
      }
    ],

    isDeleted: {
      type: Boolean,
      default: false,
      index: true
    },

    createdBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'users',
      required: false
    },

    updatedBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'users',
      required: false
    }
  },
  { timestamps: true }
)

MessageTemplateSchema.index({ createdAt: -1 })
MessageTemplateSchema.index({
  name: 'text',
  subject: 'text',
  plainTextContent: 'text'
})
MessageTemplateSchema.index({ status: 1, isDeleted: 1 })

export default mongoose.model(messageTemplateCollection, MessageTemplateSchema)
