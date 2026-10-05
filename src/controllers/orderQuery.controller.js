import OrderQueryService from '../services/orderQuery.service.js'
import { ServiceError } from '../services/service.products.js'

const getAuthenticatedBuyer = (req) => {
  const userId = req.user?.id || req.user?._id
  const role = String(req.user?.role || '').trim().toUpperCase()

  if (!userId) {
    throw new ServiceError('Usuario no autenticado', 'ORDERS_UNAUTHENTICATED', 401)
  }

  if (!['USER', 'PREMIUM'].includes(role)) {
    throw new ServiceError(
      'El rol del usuario no estÃ¡ habilitado para consultar pedidos',
      'ORDERS_FORBIDDEN_ROLE',
      403
    )
  }

  return userId
}

const assertAuthenticatedAdmin = (req) => {
  const role = String(req.user?.role || '').trim().toUpperCase()
  if (!['ADMIN', 'SUPERADMIN'].includes(role)) {
    throw new ServiceError('Acceso administrativo requerido', 'ORDERS_ADMIN_FORBIDDEN', 403)
  }
}

class OrderQueryController {
  constructor({ orderQueryService = OrderQueryService } = {}) {
    this.orderQueryService = orderQueryService
    this.listCustomer = this.listCustomer.bind(this)
    this.getCustomer = this.getCustomer.bind(this)
    this.listAdmin = this.listAdmin.bind(this)
    this.getAdmin = this.getAdmin.bind(this)
  }

  async listCustomer(req, res, next) {
    try {
      const userId = getAuthenticatedBuyer(req)
      const result = await this.orderQueryService.listCustomerOrders({
        userId,
        filters: req.query
      })
      return res.status(200).json(result)
    } catch (error) {
      return next(error)
    }
  }

  async getCustomer(req, res, next) {
    try {
      const userId = getAuthenticatedBuyer(req)
      const result = await this.orderQueryService.getCustomerOrder({
        orderNumber: req.params.orderNumber,
        userId
      })
      return res.status(200).json(result)
    } catch (error) {
      return next(error)
    }
  }

  async listAdmin(req, res, next) {
    try {
      assertAuthenticatedAdmin(req)
      const result = await this.orderQueryService.listAdminOrders({ filters: req.query })
      return res.status(200).json(result)
    } catch (error) {
      return next(error)
    }
  }

  async getAdmin(req, res, next) {
    try {
      assertAuthenticatedAdmin(req)
      const result = await this.orderQueryService.getAdminOrder({
        orderNumber: req.params.orderNumber
      })
      return res.status(200).json(result)
    } catch (error) {
      return next(error)
    }
  }
}

export { OrderQueryController }
export default new OrderQueryController()
