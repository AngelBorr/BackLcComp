import PaymentRefundService from '../services/paymentRefund.service.js'
import { ServiceError } from '../services/service.products.js'

const adminIdentity = (req) => {
  const adminUserId = req.user?.id || req.user?._id
  const adminRole = String(req.user?.role || '').trim().toUpperCase()
  if (!adminUserId) {
    throw new ServiceError('Administrador no autenticado', 'ADMIN_UNAUTHENTICATED', 401)
  }
  if (!['ADMIN', 'SUPERADMIN'].includes(adminRole)) {
    throw new ServiceError('Acceso administrativo requerido', 'ORDERS_ADMIN_FORBIDDEN', 403)
  }
  return { adminUserId, adminRole }
}

class PaymentRefundController {
  constructor({ paymentRefundService = PaymentRefundService } = {}) {
    this.refunds = paymentRefundService
    this.create = this.create.bind(this)
    this.reconcile = this.reconcile.bind(this)
  }

  async create(req, res, next) {
    try {
      const identity = adminIdentity(req)
      const result = await this.refunds.requestTotalRefund({
        orderNumber: req.params.orderNumber,
        idempotencyKey: req.get('Idempotency-Key'),
        body: req.body,
        ...identity
      })
      const { httpStatus, ...payload } = result
      return res.status(httpStatus).json(payload)
    } catch (error) {
      return next(error)
    }
  }

  async reconcile(req, res, next) {
    try {
      const identity = adminIdentity(req)
      const result = await this.refunds.reconcile({
        orderNumber: req.params.orderNumber,
        refundId: req.params.refundId,
        ...identity
      })
      const { httpStatus, ...payload } = result
      return res.status(httpStatus).json(payload)
    } catch (error) {
      return next(error)
    }
  }
}

export { PaymentRefundController }
export default new PaymentRefundController()
