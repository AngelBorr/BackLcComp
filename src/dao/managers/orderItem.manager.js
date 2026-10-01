import OrderItemModel from '../models/orderItem.model.js'

class OrderItemManager {
  async createMany(items, { session } = {}) {
    return OrderItemModel.insertMany(items, { ordered: true, session })
  }

  async getByOrderId(orderId, { session } = {}) {
    const query = OrderItemModel.find({ orderId }).sort({ createdAt: 1 }).lean()
    if (session) query.session(session)
    return query
  }
}

export { OrderItemManager }
export default new OrderItemManager()
