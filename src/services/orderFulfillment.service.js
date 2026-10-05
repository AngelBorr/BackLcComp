import mongoose from 'mongoose'
import OrderManager from '../dao/managers/order.manager.js'
import { ServiceError } from './service.products.js'
import { getEffectiveFulfillmentStatus } from '../utils/orderFulfillment.js'

const ORDER_NUMBER_PATTERN = /^LC-\d{4}-\d{6,}$/

export const ADMIN_FULFILLMENT_TRANSITIONS = Object.freeze({
  preparing: new Set(['ready_for_pickup']),
  ready_for_pickup: new Set(['picked_up'])
})

const ADMIN_TARGET_STATUSES = new Set(['ready_for_pickup', 'picked_up'])

class OrderFulfillmentService {
  constructor({ orderManager = OrderManager } = {}) {
    this.orders = orderManager
  }

  async updateByAdmin({ orderNumber, status, adminUserId }, { now = new Date() } = {}) {
    const normalizedOrderNumber = String(orderNumber || '').trim().toUpperCase()
    const nextStatus = String(status || '').trim().toLowerCase()
    const changedAt = new Date(now)

    if (!ORDER_NUMBER_PATTERN.test(normalizedOrderNumber)) {
      throw new ServiceError('NÃºmero de orden invÃ¡lido', 'INVALID_ORDER_NUMBER', 400)
    }

    if (!mongoose.Types.ObjectId.isValid(adminUserId)) {
      throw new ServiceError('Administrador no autenticado', 'ADMIN_UNAUTHENTICATED', 401)
    }

    if (!ADMIN_TARGET_STATUSES.has(nextStatus)) {
      throw new ServiceError(
        'Estado operativo no permitido para administraciÃ³n',
        'INVALID_ADMIN_FULFILLMENT_STATUS',
        400
      )
    }

    if (Number.isNaN(changedAt.getTime())) {
      throw new ServiceError('Fecha de transiciÃ³n invÃ¡lida', 'INVALID_ORDER_DATE', 400)
    }

    const order = await this.orders.getByOrderNumber(normalizedOrderNumber)
    if (!order) throw new ServiceError('Orden no encontrada', 'ORDER_NOT_FOUND', 404)

    const currentStatus = getEffectiveFulfillmentStatus(order)

    // Repetir exactamente el estado alcanzado es seguro y no agrega historial duplicado.
    if (currentStatus === nextStatus) {
      return { ...order, fulfillmentStatus: currentStatus, idempotent: true }
    }

    if (!ADMIN_FULFILLMENT_TRANSITIONS[currentStatus]?.has(nextStatus)) {
      throw new ServiceError(
        `No se permite cambiar el estado operativo de ${currentStatus} a ${nextStatus}`,
        'INVALID_FULFILLMENT_TRANSITION',
        409
      )
    }

    const updated = await this.orders.updateFulfillmentStatus(
      order._id,
      currentStatus,
      {
        nextStatus,
        changedAt,
        changedBy: adminUserId,
        reason: 'admin_update'
      }
    )

    if (!updated) {
      throw new ServiceError(
        'El estado operativo cambiÃ³ durante la operaciÃ³n',
        'ORDER_FULFILLMENT_CONFLICT',
        409
      )
    }

    return { ...updated, fulfillmentStatus: nextStatus, idempotent: false }
  }
}

export { OrderFulfillmentService }
export default new OrderFulfillmentService()
