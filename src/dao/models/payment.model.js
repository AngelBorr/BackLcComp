import mongoose from 'mongoose'

export const PAYMENT_PROVIDERS = ['mercado_pago']
export const PAYMENT_STATUSES = [
  'pending',
  'approved',
  'rejected',
  'cancelled',
  'refunded',
  'requires_attention'
]

export const PROVIDER_ATTEMPT_STATUSES = [
  null,
  'prepared',
  'uncertain',
  'rejected',
  'conflict',
  'succeeded'
]

export const PROVIDER_CANCELLATION_STATUSES = [
  null,
  'prepared',
  'uncertain',
  'succeeded',
  'rejected'
]

const paymentSchema = new mongoose.Schema(
  {
    orderId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'orders',
      required: true
    },
    provider: {
      type: String,
      enum: PAYMENT_PROVIDERS,
      default: 'mercado_pago'
    },
    preferenceId: { type: String, trim: true, default: null },
    providerOrderId: { type: String, trim: true, maxlength: 200, default: null },
    providerCheckoutUrl: { type: String, trim: true, maxlength: 2048, default: null },
    providerIdempotencyKey: { type: String, trim: true, maxlength: 128, default: null },
    providerRequestSnapshot: { type: mongoose.Schema.Types.Mixed, default: null },
    providerAttemptStatus: {
      type: String,
      enum: PROVIDER_ATTEMPT_STATUSES,
      default: null
    },
    providerCancellationIdempotencyKey: {
      type: String,
      trim: true,
      maxlength: 128,
      validate: {
        validator: (value) => value === null || value === undefined || value.length > 0,
        message: 'La clave de idempotencia de cancelacion no puede estar vacia'
      },
      default: null
    },
    providerCancellationStatus: {
      type: String,
      enum: PROVIDER_CANCELLATION_STATUSES,
      default: null
    },
    providerCancellationAttemptedAt: { type: Date, default: null },
    providerCancellationCompletedAt: { type: Date, default: null },
    providerPaymentId: { type: String, trim: true, default: null },
    externalReference: { type: String, required: true, trim: true },
    providerStatus: { type: String, trim: true, default: null },
    providerStatusDetail: { type: String, trim: true, default: null },
    normalizedStatus: {
      type: String,
      enum: PAYMENT_STATUSES,
      default: 'pending'
    },
    amountArs: {
      type: mongoose.Schema.Types.Decimal128,
      required: true,
      validate: {
        validator: (value) => Number(value.toString()) > 0,
        message: 'El importe ARS debe ser mayor que cero'
      }
    },
    currency: {
      type: String,
      enum: ['ARS'],
      default: 'ARS'
    },
    approvedAt: { type: Date, default: null },
    lastProviderCheckAt: { type: Date, default: null }
  },
  {
    timestamps: true,
    collection: 'payments'
  }
)

paymentSchema.index({ orderId: 1 })
paymentSchema.index({ orderId: 1, createdAt: -1, _id: -1 })
paymentSchema.index(
  { provider: 1, providerOrderId: 1 },
  {
    unique: true,
    partialFilterExpression: { providerOrderId: { $type: 'string' } }
  }
)
paymentSchema.index(
  { provider: 1, providerIdempotencyKey: 1 },
  {
    unique: true,
    partialFilterExpression: { providerIdempotencyKey: { $type: 'string' } }
  }
)
paymentSchema.index(
  { provider: 1, providerCancellationIdempotencyKey: 1 },
  {
    unique: true,
    partialFilterExpression: {
      providerCancellationIdempotencyKey: { $type: 'string', $gt: '' }
    }
  }
)
paymentSchema.index(
  { provider: 1, providerPaymentId: 1 },
  {
    unique: true,
    partialFilterExpression: { providerPaymentId: { $type: 'string' } }
  }
)
paymentSchema.index({ normalizedStatus: 1 })

const PaymentModel = mongoose.model('payments', paymentSchema)

export default PaymentModel
