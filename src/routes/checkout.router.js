import MyOwnRouter from './router.js'
import CheckoutController from '../controllers/checkout.controller.js'

const registerCheckoutRoute = (router, controller = CheckoutController) => {
  router.post('/', ['USER', 'PREMIUM'], controller.create)
}

class CheckoutRouter extends MyOwnRouter {
  init() {
    registerCheckoutRoute(this)
  }
}

export { CheckoutRouter, registerCheckoutRoute }
export default CheckoutRouter
