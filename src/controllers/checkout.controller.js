import CheckoutHttpService from '../services/checkoutHttp.service.js'
import { ServiceError } from '../services/service.products.js'

class CheckoutController {
  constructor({ checkoutHttpService = CheckoutHttpService } = {}) {
    this.checkoutHttpService = checkoutHttpService
    this.create = this.create.bind(this)
    this.getEligibility = this.getEligibility.bind(this)
  }

  #getAuthenticatedBuyer(req) {
    const userId = req.user?.id || req.user?._id
    const role = String(req.user?.role || '').trim().toUpperCase()

    if (!userId) {
      throw new ServiceError(
        'Usuario no autenticado',
        'CHECKOUT_UNAUTHENTICATED',
        401
      )
    }

    if (!['USER', 'PREMIUM'].includes(role)) {
      throw new ServiceError(
        'El rol del usuario no está habilitado para comprar',
        'CHECKOUT_FORBIDDEN_ROLE',
        403
      )
    }

    return userId
  }

  async create(req, res, next) {
    try {
      const userId = this.#getAuthenticatedBuyer(req)

      const result = await this.checkoutHttpService.createCheckout({
        userId,
        idempotencyKey: req.get('Idempotency-Key'),
        body: req.body
      })

      return res.status(result.isIdempotent ? 200 : 201).json(result.checkout)
    } catch (error) {
      return next(error)
    }
  }

  async getEligibility(req, res, next) {
    try {
      const userId = this.#getAuthenticatedBuyer(req)
      const result = await this.checkoutHttpService.getEligibility({
        userId,
        idempotencyKey: req.get('Idempotency-Key')
      })
      return res.status(200).json(result)
    } catch (error) {
      return next(error)
    }
  }
}

export { CheckoutController }
export default new CheckoutController()
