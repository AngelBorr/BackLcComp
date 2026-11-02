import mongoose from 'mongoose'

export const ORDER_ATTENTION_RESOLUTION_STATUSES = [
  'prepared',
  'completed',
  'failed'
]

export const ORDER_ATTENTION_RESOLUTION_ACTIONS = [
  'complete_existing_reservation_sale',
  'close_terminal_unpaid',
  'reassign_inventory',
  'refund'
]

const providerEvidenceSchema = new mongoose.Schema(
  {
    provider: { type: String, trim: true, maxlength: 50, default: '' },
    providerOrderId: { type: String, trim: true, maxlength: 200, default: null },
    providerPaymentId: { type: String, trim: true, maxlength: 200, default: null },
    externalReference: { type: String, trim: true, maxlength: 100, default: null },
    providerStatus: { type: String, trim: true, maxlength: 100, default: null },
    providerStatusDetail: { type: String, trim: true, maxlength: 200, default: null },
    amountArs: { type: String, trim: true, maxlength: 100, default: null },
    totalAmount: { type: String, trim: true, maxlength: 100, default: null },
    totalPaidAmount: { type: String, trim: true, maxlength: 100, default: null },
    currency: { type: String, trim: true, maxlength: 10, default: null },
    observedAt: { type: Date, default: null },
    remoteClassification: { type: String, trim: true, maxlength: 100, default: null },
    accreditedPayment: {
      type: new mongoose.Schema(
        {
          providerPaymentId: { type: String, trim: true, maxlength: 200, default: null },
          status: { type: String, trim: true, maxlength: 100, default: null },
          statusDetail: { type: String, trim: true, maxlength: 200, default: null },
          amount: { type: String, trim: true, maxlength: 100, default: null },
          paidAmount: { type: String, trim: true, maxlength: 100, default: null }
        },
        { _id: false }
      ),
      default: null
    }
  },
  { _id: false }
)

const stateSnapshotSchema = new mongoose.Schema(
  {
    orderStatus: { type: String, trim: true, maxlength: 100, default: null },
    paymentStatus: { type: String, trim: true, maxlength: 100, default: null },
    fulfillmentStatus: { type: String, trim: true, maxlength: 100, default: null },
    attentionReason: { type: String, trim: true, maxlength: 500, default: '' },
    attentionResolutionVersion: { type: Number, min: 0, default: 0 },
    paymentApprovedAt: { type: Date, default: null },
    paymentLastProviderCheckAt: { type: Date, default: null }
  },
  { _id: false }
)

const productUnitSnapshotSchema = new mongoose.Schema(
  {
    productUnitId: { type: mongoose.Schema.Types.ObjectId, ref: 'product_units', required: true },
    serialNumber: { type: String, trim: true, maxlength: 200, default: '' },
    status: { type: String, trim: true, maxlength: 100, default: '' },
    productId: { type: mongoose.Schema.Types.ObjectId, ref: 'products', default: null },
    orderId: { type: mongoose.Schema.Types.ObjectId, ref: 'orders', default: null },
    orderItemId: { type: mongoose.Schema.Types.ObjectId, ref: 'order_items', default: null },
    reservedByOrderId: { type: mongoose.Schema.Types.ObjectId, ref: 'orders', default: null },
    reservedAt: { type: Date, default: null },
    reservationExpiresAt: { type: Date, default: null },
    soldByOrderId: { type: mongoose.Schema.Types.ObjectId, ref: 'orders', default: null },
    soldAt: { type: Date, default: null },
    isDeleted: { type: Boolean, default: false }
  },
  { _id: false }
)

const finalResultSchema = new mongoose.Schema(
  {
    outcome: { type: String, trim: true, maxlength: 100, default: '' },
    reason: { type: String, trim: true, maxlength: 500, default: '' },
    orderStatus: { type: String, trim: true, maxlength: 100, default: null },
    paymentStatus: { type: String, trim: true, maxlength: 100, default: null },
    fulfillmentStatus: { type: String, trim: true, maxlength: 100, default: null },
    attentionResolutionVersion: { type: Number, min: 0, default: null },
    soldCount: { type: Number, min: 0, default: 0 }
  },
  { _id: false }
)

const sanitizedErrorSchema = new mongoose.Schema(
  {
    code: { type: String, trim: true, maxlength: 100, default: '' },
    message: { type: String, trim: true, maxlength: 500, default: '' }
  },
  { _id: false }
)

const orderAttentionResolutionSchema = new mongoose.Schema(
  {
    orderId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'orders',
      required: true,
      immutable: true
    },
    paymentId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'payments',
      required: true,
      immutable: true
    },
    idempotencyKey: {
      type: String,
      required: true,
      trim: true,
      maxlength: 128,
      immutable: true
    },
    action: {
      type: String,
      required: true,
      enum: ORDER_ATTENTION_RESOLUTION_ACTIONS,
      immutable: true
    },
    originalAttentionReason: {
      type: String,
      required: true,
      trim: true,
      maxlength: 500,
      immutable: true
    },
    actorUserId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'users',
      required: true,
      immutable: true
    },
    actorRole: {
      type: String,
      required: true,
      enum: ['ADMIN', 'SUPERADMIN'],
      immutable: true
    },
    note: { type: String, trim: true, maxlength: 2000, default: '' },
    requestedAt: { type: Date, required: true, immutable: true },
    completedAt: { type: Date, default: null },
    status: {
      type: String,
      enum: ORDER_ATTENTION_RESOLUTION_STATUSES,
      default: 'prepared'
    },
    activeAttemptToken: { type: String, trim: true, maxlength: 128, default: null },
    providerEvidence: { type: providerEvidenceSchema, default: null },
    previousState: { type: stateSnapshotSchema, default: null },
    previousProductUnits: { type: [productUnitSnapshotSchema], default: [] },
    finalProductUnits: { type: [productUnitSnapshotSchema], default: [] },
    finalResult: { type: finalResultSchema, default: null },
    sanitizedError: { type: sanitizedErrorSchema, default: null }
  },
  {
    timestamps: true,
    collection: 'order_attention_resolutions'
  }
)

orderAttentionResolutionSchema.index(
  { orderId: 1, idempotencyKey: 1 },
  { unique: true }
)
orderAttentionResolutionSchema.index({ orderId: 1, requestedAt: 1, _id: 1 })

const OrderAttentionResolutionModel = mongoose.model(
  'order_attention_resolutions',
  orderAttentionResolutionSchema
)

export default OrderAttentionResolutionModel
