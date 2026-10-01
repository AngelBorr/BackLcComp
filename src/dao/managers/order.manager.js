import OrderModel from '../models/order.model.js'

class OrderManager {
  async create(data, { session } = {}) {
    const order = new OrderModel(data)
    return order.save({ session })
  }

  async getById(id, { session } = {}) {
    const query = OrderModel.findById(id).lean()
    if (session) query.session(session)
    return query
  }

  async getByOrderNumber(orderNumber, { session } = {}) {
    const query = OrderModel.findOne({
      orderNumber: String(orderNumber || '').trim().toUpperCase()
    }).lean()

    if (session) query.session(session)
    return query
  }

  async getByOrderNumberAndUserId(orderNumber, userId, { session } = {}) {
    const query = OrderModel.findOne({
      orderNumber: String(orderNumber || '').trim().toUpperCase(),
      userId
    }).lean()

    if (session) query.session(session)
    return query
  }

  async getByUserId(userId, { session } = {}) {
    const query = OrderModel.find({ userId }).sort({ createdAt: -1 }).lean()
    if (session) query.session(session)
    return query
  }

  async getByUserAndCheckoutIdempotencyKey(userId, checkoutIdempotencyKey, { session } = {}) {
    const query = OrderModel.findOne({ userId, checkoutIdempotencyKey }).lean()
    if (session) query.session(session)
    return query
  }

  async list({ status } = {}, { session } = {}) {
    const filter = status ? { status } : {}
    const query = OrderModel.find(filter).sort({ createdAt: -1 }).lean()
    if (session) query.session(session)
    return query
  }

  async updateStatus(
    orderId,
    expectedStatus,
    { nextStatus, changedAt, reason = '' },
    { session } = {}
  ) {
    const set = { status: nextStatus }

    if (nextStatus === 'paid') set.paidAt = changedAt
    if (nextStatus === 'cancelled') {
      set.cancelledAt = changedAt
      set.cancellationReason = reason
    }
    if (nextStatus === 'expired') set.expiredAt = changedAt
    if (nextStatus === 'requires_attention') set.attentionReason = reason

    return OrderModel.findOneAndUpdate(
      { _id: orderId, status: expectedStatus },
      {
        $set: set,
        $push: {
          statusHistory: {
            status: nextStatus,
            changedAt,
            reason
          }
        }
      },
      { new: true, session, runValidators: true }
    ).lean()
  }
}

export { OrderManager }
export default new OrderManager()
