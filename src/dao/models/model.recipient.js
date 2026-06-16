// src/models/model.recipient.js
import mongoose from 'mongoose'

const recipientCollection = 'recipients'

const recipientSchema = new mongoose.Schema(
  {
    email: {
      type: String,
      required: true,
      trim: true,
      lowercase: true,
      index: true
    },
    name: {
      type: String,
      trim: true,
      default: ''
    },
    source: {
      type: String,
      enum: ['manual', 'database', 'imported'],
      default: 'manual'
    },
    status: {
      type: String,
      enum: ['active', 'inactive'],
      default: 'active'
    },
    tags: {
      type: [String],
      default: []
    },
    notes: {
      type: String,
      trim: true,
      default: ''
    },
    isDeleted: {
      type: Boolean,
      default: false,
      index: true
    }
  },
  {
    timestamps: true
  }
)

recipientSchema.index(
  { email: 1, isDeleted: 1 },
  {
    unique: true,
    partialFilterExpression: { isDeleted: false }
  }
)

const RecipientModel = mongoose.model(recipientCollection, recipientSchema)

export default RecipientModel
