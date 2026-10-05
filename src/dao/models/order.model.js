import mongoose from 'mongoose'

export const ORDER_STATUSES = [
  'pending_payment',
  'paid',
  'cancelled',
  'expired',
  'requires_attention'
]

export const ORDER_FULFILLMENT_MODES = ['pickup']
export const ORDER_FULFILLMENT_STATUSES = [
  'pending',
  'preparing',
  'ready_for_pickup',
  'picked_up',
  'cancelled'
]

const nonNegativeDecimal = {
  validator: (value) => value === null || Number(value.toString()) >= 0,
  message: 'El importe no puede ser negativo'
}

const buyerSnapshotSchema = new mongoose.Schema(
  {
    firstName: { type: String, required: true, trim: true },
    lastName: { type: String, required: true, trim: true },
    email: { type: String, required: true, trim: true, lowercase: true },
    role: { type: String, required: true, enum: ['USER', 'PREMIUM'] }
  },
  { _id: false }
)

const totalsSchema = new mongoose.Schema(
  {
    totalUsd: {
      type: mongoose.Schema.Types.Decimal128,
      required: true,
      validate: nonNegativeDecimal
    },
    totalArs: {
      type: mongoose.Schema.Types.Decimal128,
      default: null,
      validate: nonNegativeDecimal
    }
  },
  { _id: false }
)

const exchangeRateSnapshotSchema = new mongoose.Schema(
  {
    source: { type: String, required: true, trim: true },
    quoteType: { type: String, required: true, enum: ['billete_venta'] },
    baseCurrency: { type: String, required: true, enum: ['USD'] },
    quoteCurrency: { type: String, required: true, enum: ['ARS'] },
    rate: {
      type: mongoose.Schema.Types.Decimal128,
      required: true,
      validate: {
        validator: (value) => {
          const decimal = value.toString()
          return /^\d+(?:\.\d+)?$/.test(decimal) && BigInt(decimal.replace('.', '')) > 0n
        },
        message: 'La cotización debe ser mayor que cero'
      }
    },
    sourceDate: {
      type: String,
      required: true,
      validate: /^\d{4}-\d{2}-\d{2}$/
    },
    sourceUpdatedTime: {
      type: String,
      required: true,
      validate: /^(?:[01]\d|2[0-3]):[0-5]\d$/
    },
    sourceEffectiveAt: { type: Date, required: true },
    fetchedAt: { type: Date, required: true },
    sourceUrl: { type: String, required: true, trim: true }
  },
  { _id: false }
)

const statusHistorySchema = new mongoose.Schema(
  {
    status: { type: String, required: true, enum: ORDER_STATUSES },
    changedAt: { type: Date, required: true },
    reason: { type: String, trim: true, maxlength: 500, default: '' }
  },
  { _id: false }
)

const fulfillmentHistorySchema = new mongoose.Schema(
  {
    status: { type: String, required: true, enum: ORDER_FULFILLMENT_STATUSES },
    changedAt: { type: Date, required: true },
    changedBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'users',
      default: null
    },
    reason: { type: String, trim: true, maxlength: 500, default: '' }
  },
  { _id: false }
)

const orderSchema = new mongoose.Schema(
  {
    orderNumber: {
      type: String,
      required: true,
      trim: true,
      uppercase: true,
      immutable: true
    },
    userId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'users',
      required: true
    },
    checkoutIdempotencyKey: {
      type: String,
      trim: true,
      maxlength: 128,
      default: null,
      immutable: true
    },
    checkoutRequestHash: {
      type: String,
      trim: true,
      match: /^[a-f0-9]{64}$/,
      default: null,
      immutable: true
    },
    buyerSnapshot: {
      type: buyerSnapshotSchema,
      required: true
    },
    fulfillmentMode: {
      type: String,
      enum: ORDER_FULFILLMENT_MODES,
      default: 'pickup'
    },
    fulfillmentStatus: {
      type: String,
      enum: ORDER_FULFILLMENT_STATUSES,
      default: 'pending'
    },
    status: {
      type: String,
      enum: ORDER_STATUSES,
      default: 'pending_payment'
    },
    commercialCurrency: {
      type: String,
      enum: ['USD'],
      default: 'USD'
    },
    paymentCurrency: {
      type: String,
      enum: ['ARS'],
      default: 'ARS'
    },
    totals: {
      type: totalsSchema,
      required: true
    },
    exchangeRateSnapshot: {
      type: exchangeRateSnapshotSchema,
      default: null,
      immutable: true
    },
    reservationExpiresAt: { type: Date, default: null },
    paidAt: { type: Date, default: null },
    cancelledAt: { type: Date, default: null },
    expiredAt: { type: Date, default: null },
    readyForPickupAt: { type: Date, default: null },
    pickedUpAt: { type: Date, default: null },
    cancellationReason: { type: String, trim: true, maxlength: 500, default: '' },
    attentionReason: { type: String, trim: true, maxlength: 500, default: '' },
    statusHistory: {
      type: [statusHistorySchema],
      default: []
    },
    fulfillmentHistory: {
      type: [fulfillmentHistorySchema],
      default: []
    }
  },
  {
    timestamps: true,
    collection: 'orders'
  }
)

orderSchema.index({ orderNumber: 1 }, { unique: true })
orderSchema.index({ userId: 1, createdAt: -1 })
orderSchema.index(
  { userId: 1, checkoutIdempotencyKey: 1 },
  {
    unique: true,
    partialFilterExpression: { checkoutIdempotencyKey: { $type: 'string' } }
  }
)
orderSchema.index({ status: 1 })
orderSchema.index({ fulfillmentStatus: 1, createdAt: -1 })

const OrderModel = mongoose.model('orders', orderSchema)

export default OrderModel
