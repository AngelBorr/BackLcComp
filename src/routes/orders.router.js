import MyOwnRouter from './router.js'
import OrderStatusController from '../controllers/orderStatus.controller.js'

const registerOrderRoutes = (router, controller = OrderStatusController) => {
  router.get('/:orderNumber/status', ['USER', 'PREMIUM'], controller.getStatus)
}

class OrdersRouter extends MyOwnRouter {
  init() {
    registerOrderRoutes(this)
  }
}

export { OrdersRouter, registerOrderRoutes }
export default OrdersRouter
