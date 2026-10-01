import mongoose from 'mongoose'
import OrderManager from '../dao/managers/order.manager.js'
import PaymentManager from '../dao/managers/payment.manager.js'
import { ServiceError } from './service.products.js'

const ORDER_NUMBER_PATTERN = /^LC-\d{4}-\d{6,}$/

const toIsoString = (value) => {
  if (!value) return null
  const date = new Date(value)
  return Number.isNaN(date.getTime()) ? null : date.toISOString()
}

class OrderStatusService {
  constructor({ orderManager = OrderManager, paymentManager = PaymentManager } = {}) {
    this.orders = orderManager
    this.payments = paymentManager
  }

  async getForBuyer({ orderNumber, userId }) {
    const normalizedOrderNumber = String(orderNumber || '').trim().toUpperCase()

    if (!ORDER_NUMBER_PATTERN.test(normalizedOrderNumber)) {
      throw new ServiceError(
        'Número de orden inválido',
        'INVALID_ORDER_NUMBER',
        400
      )
    }

    if (!mongoose.Types.ObjectId.isValid(userId)) {
      throw new ServiceError('Usuario no autenticado', 'ORDER_STATUS_UNAUTHENTICATED', 401)
    }

    const order = await this.orders.getByOrderNumberAndUserId(
      normalizedOrderNumber,
      userId
    )

    if (!order) {
      throw new ServiceError('Orden no encontrada', 'ORDER_NOT_FOUND', 404)
    }

    const payment = await this.payments.getLatestByOrderId(order._id)

    if (!payment) {
      throw new ServiceError(
        'No se pudo consultar el estado del pago',
        'ORDER_PAYMENT_NOT_FOUND',
        404
      )
    }

    return {
      orderNumber: order.orderNumber,
      orderStatus: order.status,
      paymentStatus: payment.normalizedStatus,
      reservationExpiresAt: toIsoString(order.reservationExpiresAt),
      paidAt: toIsoString(order.paidAt),
      updatedAt: toIsoString(order.updatedAt),
      ...(order.status === 'requires_attention' ? { requiresAttention: true } : {})
    }
  }
}

export { OrderStatusService }
export default new OrderStatusService()
