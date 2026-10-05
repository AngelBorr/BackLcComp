import MyOwnRouter from './router.js'
import OrderStatusController from '../controllers/orderStatus.controller.js'
import OrderQueryController from '../controllers/orderQuery.controller.js'

const registerOrderRoutes = (router, controller = OrderStatusController) => {
  router.get('/:orderNumber/status', ['USER', 'PREMIUM'], controller.getStatus)
}

const registerOrderQueryRoutes = (router, controller = OrderQueryController) => {
  router.get('/', ['USER', 'PREMIUM'], controller.listCustomer)
  router.get('/:orderNumber', ['USER', 'PREMIUM'], controller.getCustomer)
}

class OrdersRouter extends MyOwnRouter {
  init() {
    registerOrderRoutes(this)
    registerOrderQueryRoutes(this)
  }
}

export { OrdersRouter, registerOrderRoutes, registerOrderQueryRoutes }
export default OrdersRouter
