import BuyerPaymentReconciliationService from '../services/buyerPaymentReconciliation.service.js'
import { ServiceError } from '../services/service.products.js'

class BuyerPaymentReconciliationController {
  constructor({
    buyerPaymentReconciliationService = BuyerPaymentReconciliationService
  } = {}) {
    this.reconciliation = buyerPaymentReconciliationService
    this.reconcile = this.reconcile.bind(this)
  }

  #getAuthenticatedBuyer(req) {
    const userId = req.user?.id || req.user?._id
    const role = String(req.user?.role || '').trim().toUpperCase()

    if (!userId) {
      throw new ServiceError(
        'Usuario no autenticado',
        'BUYER_RECONCILIATION_UNAUTHENTICATED',
        401
      )
    }

    if (!['USER', 'PREMIUM'].includes(role)) {
      throw new ServiceError(
        'El rol del usuario no está habilitado para reconciliar pedidos',
        'BUYER_RECONCILIATION_FORBIDDEN_ROLE',
        403
      )
    }

    return userId
  }

  #assertEmptyClientInput(req) {
    const body = req.body
    const hasBodyFields = body && typeof body === 'object' && Object.keys(body).length > 0
    const hasQueryFields = req.query && Object.keys(req.query).length > 0

    if (hasBodyFields || hasQueryFields) {
      throw new ServiceError(
        'La reconciliación no acepta datos financieros del cliente',
        'BUYER_RECONCILIATION_INVALID_INPUT',
        400
      )
    }
  }

  async reconcile(req, res, next) {
    try {
      const userId = this.#getAuthenticatedBuyer(req)
      this.#assertEmptyClientInput(req)
      const result = await this.reconciliation.reconcileForBuyer({
        orderNumber: req.params.orderNumber,
        userId
      })
      return res.status(200).json(result)
    } catch (error) {
      return next(error)
    }
  }
}

export { BuyerPaymentReconciliationController }
export default new BuyerPaymentReconciliationController()
