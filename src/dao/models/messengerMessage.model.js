import mongoose, { Schema } from 'mongoose'

const messengerMessageCollection = 'messengerMessages'

const MessengerMessageSchema = new Schema(
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

    content: {
      type: String,
      required: true
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

MessengerMessageSchema.index({ createdAt: -1 })
MessengerMessageSchema.index({ name: 'text', subject: 'text', content: 'text' })
MessengerMessageSchema.index({ status: 1, isDeleted: 1 })

export default mongoose.model(messengerMessageCollection, MessengerMessageSchema)
