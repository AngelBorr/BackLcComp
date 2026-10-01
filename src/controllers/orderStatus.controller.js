import OrderStatusService from '../services/orderStatus.service.js'
import { ServiceError } from '../services/service.products.js'

class OrderStatusController {
  constructor({ orderStatusService = OrderStatusService } = {}) {
    this.orderStatusService = orderStatusService
    this.getStatus = this.getStatus.bind(this)
  }

  async getStatus(req, res, next) {
    try {
      const userId = req.user?.id || req.user?._id
      const role = String(req.user?.role || '').trim().toUpperCase()

      if (!userId) {
        throw new ServiceError('Usuario no autenticado', 'ORDER_STATUS_UNAUTHENTICATED', 401)
      }

      if (!['USER', 'PREMIUM'].includes(role)) {
        throw new ServiceError(
          'El rol del usuario no está habilitado para consultar pedidos',
          'ORDER_STATUS_FORBIDDEN_ROLE',
          403
        )
      }

      const result = await this.orderStatusService.getForBuyer({
        orderNumber: req.params.orderNumber,
        userId
      })

      return res.status(200).json(result)
    } catch (error) {
      return next(error)
    }
  }
}

export { OrderStatusController }
export default new OrderStatusController()
