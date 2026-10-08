import mongoose from 'mongoose'

const checkoutLeaseSchema = new mongoose.Schema(
  {
    _id: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'users',
      required: true
    },
    ownerToken: {
      type: String,
      required: true,
      trim: true,
      maxlength: 100
    },
    expiresAt: {
      type: Date,
      required: true
    }
  },
  {
    timestamps: true,
    collection: 'checkout_leases'
  }
)

checkoutLeaseSchema.index({ expiresAt: 1 })

const CheckoutLeaseModel = mongoose.model('checkout_leases', checkoutLeaseSchema)

export default CheckoutLeaseModel
