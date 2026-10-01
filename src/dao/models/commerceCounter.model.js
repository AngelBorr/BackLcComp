import mongoose from 'mongoose'

const commerceCounterSchema = new mongoose.Schema(
  {
    _id: { type: String, required: true, trim: true },
    sequence: {
      type: Number,
      required: true,
      min: 0,
      validate: {
        validator: Number.isSafeInteger,
        message: 'La secuencia debe ser un entero seguro'
      }
    }
  },
  {
    timestamps: true,
    collection: 'commerce_counters'
  }
)

const CommerceCounterModel = mongoose.model('commerce_counters', commerceCounterSchema)

export default CommerceCounterModel
