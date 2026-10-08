import CheckoutLeaseModel from '../models/checkoutLease.model.js'

class CheckoutLeaseManager {
  async acquire(userId, ownerToken, { now, expiresAt }) {
    return CheckoutLeaseModel.findOneAndUpdate(
      {
        _id: userId,
        $or: [
          { expiresAt: { $lte: now } },
          { expiresAt: null },
          { expiresAt: { $exists: false } }
        ]
      },
      {
        $set: { ownerToken, expiresAt }
      },
      {
        new: true,
        upsert: true,
        runValidators: true,
        setDefaultsOnInsert: true
      }
    ).lean()
  }

  async renew(userId, ownerToken, { now, expiresAt, session } = {}) {
    return CheckoutLeaseModel.findOneAndUpdate(
      {
        _id: userId,
        ownerToken,
        expiresAt: { $gt: now }
      },
      {
        $set: { expiresAt }
      },
      {
        new: true,
        session,
        runValidators: true
      }
    ).lean()
  }

  async release(userId, ownerToken) {
    return CheckoutLeaseModel.deleteOne({ _id: userId, ownerToken })
  }
}

export { CheckoutLeaseManager }
export default new CheckoutLeaseManager()
