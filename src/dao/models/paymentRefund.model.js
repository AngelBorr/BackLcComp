import mongoose from 'mongoose'

export const PAYMENT_REFUND_STATUSES = [
  'prepared',
  'submitted',
  'processing',
  'succeeded',
  'rejected',
  'requires_attention'
]

export const PAYMENT_REFUND_ORIGINS = ['admin', 'provider_observed']

const nonNegativeDecimal = {
  validator: (value) => value === null || Number(value.toString()) >= 0,
  message: 'El importe del reembolso no puede ser negativo'
}

const sanitizedErrorSchema = new mongoose.Schema(
  {
    code: { type: String, trim: true, maxlength: 100, default: '' },
    message: { type: String, trim: true, maxlength: 500, default: '' },
    providerHttpStatus: { type: Number, min: 100, max: 599, default: null },
    providerCode: { type: String, trim: true, maxlength: 100, default: null }
  },
  { _id: false }
)

const paymentRefundSchema = new mongoose.Schema(
  {
    orderId: { type: mongoose.Schema.Types.ObjectId, ref: 'orders', required: true },
    paymentId: { type: mongoose.Schema.Types.ObjectId, ref: 'payments', required: true },
    provider: { type: String, enum: ['mercado_pago'], default: 'mercado_pago' },
    providerOrderId: { type: String, trim: true, maxlength: 200, required: true },
    providerPaymentId: { type: String, trim: true, maxlength: 200, required: true },
    type: { type: String, enum: ['total'], default: 'total' },
    requestedAmountArs: {
      type: mongoose.Schema.Types.Decimal128,
      required: true,
      validate: nonNegativeDecimal
    },
    confirmedAmountArs: {
      type: mongoose.Schema.Types.Decimal128,
      default: null,
      validate: nonNegativeDecimal
    },
    currency: { type: String, enum: ['ARS'], required: true },
    status: { type: String, enum: PAYMENT_REFUND_STATUSES, required: true },
    idempotencyKey: { type: String, trim: true, maxlength: 128, default: null },
    providerIdempotencyKey: { type: String, trim: true, maxlength: 128, default: null },
    requestHash: { type: String, match: /^[a-f0-9]{64}$/, required: true },
    providerRefundId: { type: String, trim: true, maxlength: 200, default: null },
    operationScope: { type: String, enum: ['total_refund', null], default: 'total_refund' },
    providerStatus: { type: String, trim: true, maxlength: 100, default: null },
    providerStatusDetail: { type: String, trim: true, maxlength: 200, default: null },
    requestedAt: { type: Date, required: true },
    submittedAt: { type: Date, default: null },
    lastProviderCheckAt: { type: Date, default: null },
    completedAt: { type: Date, default: null },
    providerRequestSnapshot: { type: mongoose.Schema.Types.Mixed, default: null },
    providerEvidenceSnapshot: { type: mongoose.Schema.Types.Mixed, default: null },
    origin: { type: String, enum: PAYMENT_REFUND_ORIGINS, required: true },
    requestedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'users', default: null },
    requestedByRole: { type: String, enum: ['ADMIN', 'SUPERADMIN', null], default: null },
    reasonCode: { type: String, trim: true, maxlength: 100, default: '' },
    note: { type: String, trim: true, maxlength: 500, default: '' },
    attemptOwnerToken: { type: String, trim: true, maxlength: 128, default: null },
    attemptLeaseUntil: { type: Date, default: null },
    version: { type: Number, min: 0, default: 0 },
    sanitizedError: { type: sanitizedErrorSchema, default: null }
  },
  { timestamps: true, collection: 'payment_refunds' }
)

paymentRefundSchema.index(
  { orderId: 1, idempotencyKey: 1 },
  {
    unique: true,
    partialFilterExpression: { idempotencyKey: { $type: 'string' } }
  }
)
paymentRefundSchema.index(
  { provider: 1, providerIdempotencyKey: 1 },
  {
    unique: true,
    partialFilterExpression: { providerIdempotencyKey: { $type: 'string' } }
  }
)
paymentRefundSchema.index(
  { provider: 1, providerRefundId: 1 },
  {
    unique: true,
    partialFilterExpression: { providerRefundId: { $type: 'string' } }
  }
)
paymentRefundSchema.index(
  { paymentId: 1, operationScope: 1 },
  {
    unique: true,
    partialFilterExpression: { operationScope: { $type: 'string' } }
  }
)
paymentRefundSchema.index({ orderId: 1, requestedAt: 1, _id: 1 })
paymentRefundSchema.index({ provider: 1, providerOrderId: 1, requestedAt: -1 })

export default mongoose.model('payment_refunds', paymentRefundSchema)
