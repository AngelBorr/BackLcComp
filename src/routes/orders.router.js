import MyOwnRouter from './router.js'
import OrderStatusController from '../controllers/orderStatus.controller.js'
import OrderQueryController from '../controllers/orderQuery.controller.js'
import BuyerPaymentReconciliationController from '../controllers/buyerPaymentReconciliation.controller.js'

const registerOrderRoutes = (
  router,
  controller = OrderStatusController,
  reconciliationController = BuyerPaymentReconciliationController
) => {
  router.get('/:orderNumber/status', ['USER', 'PREMIUM'], controller.getStatus)
  router.post(
    '/:orderNumber/reconcile-payment',
    ['USER', 'PREMIUM'],
    reconciliationController.reconcile
  )
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
