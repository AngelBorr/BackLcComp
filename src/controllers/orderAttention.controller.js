import OrderAttentionRecoveryService from '../services/orderAttentionRecovery.service.js'
import { ServiceError } from '../services/service.products.js'

const ALLOWED_BODY_FIELDS = new Set(['note'])

class OrderAttentionController {
  constructor({ orderAttentionRecoveryService = OrderAttentionRecoveryService } = {}) {
    this.orderAttentionRecoveryService = orderAttentionRecoveryService
    this.completeExistingReservationSale = this.completeExistingReservationSale.bind(this)
  }

  async completeExistingReservationSale(req, res, next) {
    try {
      const actorUserId = req.user?.id || req.user?._id
      const actorRole = String(req.user?.role || '').trim().toUpperCase()

      if (!actorUserId) {
        throw new ServiceError('Administrador no autenticado', 'ADMIN_UNAUTHENTICATED', 401)
      }
      if (!['ADMIN', 'SUPERADMIN'].includes(actorRole)) {
        throw new ServiceError('Acceso administrativo requerido', 'ORDERS_ADMIN_FORBIDDEN', 403)
      }

      const body = req.body && typeof req.body === 'object' && !Array.isArray(req.body)
        ? req.body
        : {}
      if (Object.keys(body).some((field) => !ALLOWED_BODY_FIELDS.has(field))) {
        throw new ServiceError(
          'El comando solo admite una nota administrativa',
          'INVALID_ATTENTION_RESOLUTION_BODY',
          400
        )
      }

      const result = await this.orderAttentionRecoveryService.completeExistingReservationSale({
        orderNumber: req.params.orderNumber,
        idempotencyKey: req.get?.('Idempotency-Key') || req.headers?.['idempotency-key'],
        actorUserId,
        actorRole,
        note: body.note
      })

      return res.status(200).json(result)
    } catch (error) {
      return next(error)
    }
  }
}

export { OrderAttentionController }
export default new OrderAttentionController()
