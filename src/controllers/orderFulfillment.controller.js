import OrderFulfillmentService from '../services/orderFulfillment.service.js'
import { ServiceError } from '../services/service.products.js'

const toIsoString = (value) => {
  if (!value) return null
  const date = new Date(value)
  return Number.isNaN(date.getTime()) ? null : date.toISOString()
}

class OrderFulfillmentController {
  constructor({ orderFulfillmentService = OrderFulfillmentService } = {}) {
    this.orderFulfillmentService = orderFulfillmentService
    this.update = this.update.bind(this)
  }

  async update(req, res, next) {
    try {
      const adminUserId = req.user?.id || req.user?._id
      const role = String(req.user?.role || '').trim().toUpperCase()

      if (!adminUserId) {
        throw new ServiceError('Administrador no autenticado', 'ADMIN_UNAUTHENTICATED', 401)
      }

      if (!['ADMIN', 'SUPERADMIN'].includes(role)) {
        throw new ServiceError('Acceso administrativo requerido', 'ORDERS_ADMIN_FORBIDDEN', 403)
      }

      const order = await this.orderFulfillmentService.updateByAdmin({
        orderNumber: req.params.orderNumber,
        status: req.body?.status,
        adminUserId
      })

      return res.status(200).json({
        orderNumber: order.orderNumber,
        fulfillmentStatus: order.fulfillmentStatus,
        readyForPickupAt: toIsoString(order.readyForPickupAt),
        pickedUpAt: toIsoString(order.pickedUpAt),
        idempotent: order.idempotent
      })
    } catch (error) {
      return next(error)
    }
  }
}

export { OrderFulfillmentController }
export default new OrderFulfillmentController()
