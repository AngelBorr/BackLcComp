import mongoose from 'mongoose'
import { PAYMENT_PROVIDERS } from './payment.model.js'

export const PAYMENT_EVENT_PROCESSING_STATUSES = [
  'received',
  'processing',
  'processed',
  'failed',
  'ignored'
]

const sanitizedErrorSchema = new mongoose.Schema(
  {
    code: { type: String, trim: true, maxlength: 100, default: '' },
    message: { type: String, trim: true, maxlength: 500, default: '' }
  },
  { _id: false }
)

const paymentEventSchema = new mongoose.Schema(
  {
    provider: {
      type: String,
      enum: PAYMENT_PROVIDERS,
      required: true
    },
    providerEventId: { type: String, required: true, trim: true },
    providerOrderId: { type: String, trim: true, maxlength: 200, default: null },
    providerPaymentId: { type: String, trim: true, default: null },
    orderId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'orders',
      default: null
    },
    receivedAt: { type: Date, default: Date.now },
    processedAt: { type: Date, default: null },
    processingStatus: {
      type: String,
      enum: PAYMENT_EVENT_PROCESSING_STATUSES,
      default: 'received'
    },
    processingStartedAt: { type: Date, default: null },
    attempts: { type: Number, min: 0, default: 0 },
    lastError: { type: sanitizedErrorSchema, default: null }
  },
  {
    timestamps: true,
    collection: 'payment_events'
  }
)

paymentEventSchema.index({ provider: 1, providerEventId: 1 }, { unique: true })
paymentEventSchema.index({ providerPaymentId: 1 })
paymentEventSchema.index({ processingStatus: 1 })

const PaymentEventModel = mongoose.model('payment_events', paymentEventSchema)

export default PaymentEventModel
