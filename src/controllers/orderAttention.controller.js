import OrderAttentionRecoveryService from '../services/orderAttentionRecovery.service.js'
import OrderAttentionTerminalUnpaidService from '../services/orderAttentionTerminalUnpaid.service.js'
import OrderInventoryRepairCommandService from '../services/orderInventoryRepairCommand.service.js'
import { ServiceError } from '../services/service.products.js'

const ALLOWED_BODY_FIELDS = new Set(['note'])

const inventoryRepairResponse = (result) => ({
  orderNumber: result.orderNumber,
  resolutionId: result.resolutionId,
  resolutionStatus: result.resolutionStatus,
  action: result.action,
  outcome: result.outcome,
  orderStatus: result.orderStatus,
  paymentStatus: result.paymentStatus,
  fulfillmentStatus: result.fulfillmentStatus,
  repairAt: result.repairAt,
  resolvedAt: result.resolvedAt,
  attentionResolutionVersion: result.attentionResolutionVersion,
  summary: {
    alreadySoldCount: result.summary?.alreadySoldCount,
    preservedReservedCount: result.summary?.preservedReservedCount,
    reclaimedOriginalCount: result.summary?.reclaimedOriginalCount,
    replacementCount: result.summary?.replacementCount,
    soldCount: result.summary?.soldCount
  },
  idempotent: result.idempotent === true
})

class OrderAttentionController {
  constructor({
    orderAttentionRecoveryService = OrderAttentionRecoveryService,
    orderAttentionTerminalUnpaidService = OrderAttentionTerminalUnpaidService,
    orderInventoryRepairCommandService = OrderInventoryRepairCommandService
  } = {}) {
    this.orderAttentionRecoveryService = orderAttentionRecoveryService
    this.orderAttentionTerminalUnpaidService = orderAttentionTerminalUnpaidService
    this.orderInventoryRepairCommandService = orderInventoryRepairCommandService
    this.completeExistingReservationSale = this.completeExistingReservationSale.bind(this)
    this.closeTerminalUnpaid = this.closeTerminalUnpaid.bind(this)
    this.reassignInventory = this.reassignInventory.bind(this)
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

  async closeTerminalUnpaid(req, res, next) {
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

      const result = await this.orderAttentionTerminalUnpaidService.closeTerminalUnpaid({
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

  async reassignInventory(req, res, next) {
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

      const result = await this.orderInventoryRepairCommandService
        .repairApprovedOrderInventory({
          orderNumber: req.params.orderNumber,
          idempotencyKey: req.get?.('Idempotency-Key') || req.headers?.['idempotency-key'],
          actorUserId,
          actorRole,
          note: body.note
        })

      return res.status(200).json(inventoryRepairResponse(result))
    } catch (error) {
      return next(error)
    }
  }
}

export { OrderAttentionController }
export default new OrderAttentionController()
