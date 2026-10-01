import mongoose from 'mongoose'

const productUnitCollectionName = 'product_units'

const productUnitSchema = new mongoose.Schema(
  {
    productId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'products',
      required: true,
      index: true
    },

    serialNumber: {
      type: String,
      required: true,
      trim: true,
      uppercase: true,
      index: true
    },

    status: {
      type: String,
      enum: ['available', 'reserved', 'sold', 'inactive', 'warranty', 'returned'],
      default: 'available',
      index: true
    },

    reservedByOrderId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'orders',
      default: null
    },

    soldByOrderId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'orders',
      default: null
    },

    reservedAt: {
      type: Date,
      default: null
    },

    reservationExpiresAt: {
      type: Date,
      default: null
    },

    orderId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'orders',
      default: null
    },

    orderItemId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'order_items',
      default: null
    },

    soldAt: {
      type: Date,
      default: null
    },

    invoiceId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'invoices',
      default: null
    },

    entryDate: {
      type: Date,
      default: Date.now
    },

    supplier: {
      type: String,
      trim: true,
      default: ''
    },

    invoiceNumber: {
      type: String,
      trim: true,
      default: ''
    },

    notes: {
      type: String,
      trim: true,
      default: ''
    },

    createdBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'users',
      required: true
    },

    updatedBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'users',
      default: null
    },

    isDeleted: {
      type: Boolean,
      default: false,
      index: true
    }
  },
  {
    timestamps: true,
    collection: 'product_units'
  }
)

productUnitSchema.index(
  { serialNumber: 1 },
  {
    unique: true,
    partialFilterExpression: { isDeleted: false }
  }
)

productUnitSchema.index({ productId: 1, status: 1, isDeleted: 1, createdAt: 1 })
productUnitSchema.index({ status: 1, isDeleted: 1, reservationExpiresAt: 1 })

const ProductUnitModel = mongoose.model(productUnitCollectionName, productUnitSchema)

export default ProductUnitModel
