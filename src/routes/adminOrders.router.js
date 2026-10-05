import MyOwnRouter from './router.js'
import OrderQueryController from '../controllers/orderQuery.controller.js'
import OrderFulfillmentController from '../controllers/orderFulfillment.controller.js'

const registerAdminOrderRoutes = (
  router,
  {
    queryController = OrderQueryController,
    fulfillmentController = OrderFulfillmentController
  } = {}
) => {
  router.get('/', ['ADMIN'], queryController.listAdmin)
  router.get('/:orderNumber', ['ADMIN'], queryController.getAdmin)
  router.patch('/:orderNumber/fulfillment', ['ADMIN'], fulfillmentController.update)
}

class AdminOrdersRouter extends MyOwnRouter {
  init() {
    registerAdminOrderRoutes(this)
  }
}

export { AdminOrdersRouter, registerAdminOrderRoutes }
export default AdminOrdersRouter
