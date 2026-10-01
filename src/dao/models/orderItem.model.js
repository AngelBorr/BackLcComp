import mongoose from 'mongoose'

export const ORDER_ITEM_PRICE_TYPES = ['retail', 'wholesale']

const positiveDecimal = {
  validator: (value) => Number(value.toString()) > 0,
  message: 'El importe debe ser mayor que cero'
}

const nonNegativeDecimal = {
  validator: (value) => Number(value.toString()) >= 0,
  message: 'El importe no puede ser negativo'
}

const productSnapshotSchema = new mongoose.Schema(
  {
    name: { type: String, required: true, trim: true },
    brand: { type: String, trim: true, default: '' },
    category: { type: String, trim: true, default: '' }
  },
  { _id: false }
)

const orderItemSchema = new mongoose.Schema(
  {
    orderId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'orders',
      required: true
    },
    productId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'products',
      required: true
    },
    productSnapshot: {
      type: productSnapshotSchema,
      required: true
    },
    quantity: {
      type: Number,
      required: true,
      min: 1,
      validate: {
        validator: Number.isInteger,
        message: 'La cantidad debe ser un entero'
      }
    },
    priceType: {
      type: String,
      enum: ORDER_ITEM_PRICE_TYPES,
      required: true
    },
    currency: {
      type: String,
      enum: ['USD'],
      default: 'USD'
    },
    vatRate: {
      type: mongoose.Schema.Types.Decimal128,
      required: true,
      validate: {
        validator: (value) => ['0.105', '0.21'].includes(value.toString()),
        message: 'La alícuota de IVA no es válida'
      }
    },
    unitPriceUsd: {
      type: mongoose.Schema.Types.Decimal128,
      required: true,
      validate: positiveDecimal
    },
    netUnitPriceUsd: {
      type: mongoose.Schema.Types.Decimal128,
      required: true,
      validate: nonNegativeDecimal
    },
    vatAmountPerUnitUsd: {
      type: mongoose.Schema.Types.Decimal128,
      required: true,
      validate: nonNegativeDecimal
    },
    lineNetUsd: {
      type: mongoose.Schema.Types.Decimal128,
      required: true,
      validate: nonNegativeDecimal
    },
    lineVatUsd: {
      type: mongoose.Schema.Types.Decimal128,
      required: true,
      validate: nonNegativeDecimal
    },
    totalUsd: {
      type: mongoose.Schema.Types.Decimal128,
      required: true,
      validate: positiveDecimal
    }
  },
  {
    timestamps: true,
    collection: 'order_items'
  }
)

orderItemSchema.index({ orderId: 1 })

const OrderItemModel = mongoose.model('order_items', orderItemSchema)

export default OrderItemModel
