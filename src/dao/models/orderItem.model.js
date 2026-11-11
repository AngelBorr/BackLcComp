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

const originalReservationUnitSchema = new mongoose.Schema(
  {
    productUnitId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'product_units',
      required: true
    },
    serial: {
      type: String,
      required: true,
      trim: true
    }
  },
  { _id: false }
)

const originalReservationSchema = new mongoose.Schema(
  {
    capturedAt: {
      type: Date,
      required: true
    },
    units: {
      type: [originalReservationUnitSchema],
      required: true,
      validate: [
        {
          validator: (units) => Array.isArray(units) && units.length > 0,
          message: 'La reserva original debe contener al menos una unidad'
        },
        {
          validator: (units) => {
            if (!Array.isArray(units)) return false
            const unitIds = units.map((unit) => String(unit.productUnitId))
            return new Set(unitIds).size === unitIds.length
          },
          message: 'La reserva original no puede contener unidades duplicadas'
        }
      ]
    }
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
    },
    originalReservation: {
      type: originalReservationSchema,
      default: undefined
    }
  },
  {
    timestamps: true,
    collection: 'order_items'
  }
)

orderItemSchema.path('originalReservation').validate({
  validator: function (originalReservation) {
    if (originalReservation === undefined) return true
    if (originalReservation === null) {
      return this?.isNew === false && !this.isModified?.('originalReservation')
    }
    const expectedQuantity = this.quantity ?? this.getQuery?.().quantity
    return originalReservation.units.length === Number(expectedQuantity)
  },
  message: 'La reserva original debe coincidir con la cantidad del item y no puede ser null'
})

const explicitlySetsOriginalReservationNull = (update) => {
  if (Array.isArray(update)) {
    return update.some((stage) => (
      stage?.$set?.originalReservation === null ||
      stage?.$addFields?.originalReservation === null
    ))
  }

  return update?.originalReservation === null || update?.$set?.originalReservation === null
}

orderItemSchema.pre(
  ['updateOne', 'updateMany', 'findOneAndUpdate', 'replaceOne', 'findOneAndReplace'],
  function rejectNewNullLedger(next) {
    if (!explicitlySetsOriginalReservationNull(this.getUpdate())) return next()

    const error = new mongoose.Error.ValidationError()
    error.addError(
      'originalReservation',
      new mongoose.Error.ValidatorError({
        path: 'originalReservation',
        value: null,
        message: 'La reserva original no puede ser null en una escritura nueva'
      })
    )
    next(error)
  }
)

orderItemSchema.index({ orderId: 1 })

const OrderItemModel = mongoose.model('order_items', orderItemSchema)

export default OrderItemModel
