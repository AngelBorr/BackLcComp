import OrderItemModel from '../models/orderItem.model.js'

const managerError = (message, code, status) => {
  const error = new Error(message)
  error.name = 'OrderItemManagerError'
  error.code = code
  error.status = status
  error.statusCode = status
  return error
}

const assertActiveTransaction = (session) => {
  let isActive = false

  try {
    isActive = Boolean(
      session &&
      !session.hasEnded &&
      typeof session.inTransaction === 'function' &&
      session.inTransaction()
    )
  } catch {
    isActive = false
  }

  if (!isActive) {
    throw managerError(
      'La captura de la reserva original requiere una transacción activa',
      'EXTERNAL_TRANSACTION_REQUIRED',
      500
    )
  }
}

class OrderItemManager {
  async createMany(items, { session } = {}) {
    return OrderItemModel.insertMany(items, { ordered: true, session })
  }

  async getByOrderId(orderId, { session } = {}) {
    const query = OrderItemModel.find({ orderId }).sort({ createdAt: 1 }).lean()
    if (session) query.session(session)
    return query
  }

  async captureOriginalReservation(
    { orderItemId, orderId, productId, quantity, originalReservation },
    { session } = {}
  ) {
    assertActiveTransaction(session)

    const result = await OrderItemModel.updateOne(
      {
        _id: orderItemId,
        orderId,
        productId,
        quantity,
        originalReservation: { $exists: false }
      },
      {
        $set: { originalReservation }
      },
      { session, runValidators: true }
    )

    if (result?.modifiedCount !== 1) {
      throw managerError(
        'No se pudo capturar la reserva original del item',
        'ORIGINAL_RESERVATION_CAPTURE_CONFLICT',
        409
      )
    }

    return result
  }
}

export { OrderItemManager }
export default new OrderItemManager()
