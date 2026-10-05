import MyOwnRouter from './router.js'
import CommerceController from '../controllers/commerce.controller.js'

const registerCommerceRoutes = (router, controller = CommerceController) => {
  router.get('/exchange-rate', ['PUBLIC'], controller.getExchangeRate)
}

class CommerceRouter extends MyOwnRouter {
  init() {
    registerCommerceRoutes(this)
  }
}

export { CommerceRouter, registerCommerceRoutes }
export default CommerceRouter
