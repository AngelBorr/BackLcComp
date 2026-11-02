import MyOwnRouter from './router.js'
import OrderQueryController from '../controllers/orderQuery.controller.js'
import OrderFulfillmentController from '../controllers/orderFulfillment.controller.js'
import OrderAttentionController from '../controllers/orderAttention.controller.js'

const registerAdminOrderRoutes = (
  router,
  {
    queryController = OrderQueryController,
    fulfillmentController = OrderFulfillmentController,
    attentionController = OrderAttentionController
  } = {}
) => {
  router.get('/', ['ADMIN'], queryController.listAdmin)
  router.get('/:orderNumber', ['ADMIN'], queryController.getAdmin)
  router.post(
    '/:orderNumber/attention/complete-existing-reservation-sale',
    ['ADMIN'],
    attentionController.completeExistingReservationSale
  )
  router.patch('/:orderNumber/fulfillment', ['ADMIN'], fulfillmentController.update)
}

class AdminOrdersRouter extends MyOwnRouter {
  init() {
    registerAdminOrderRoutes(this)
  }
}

export { AdminOrdersRouter, registerAdminOrderRoutes }
export default AdminOrdersRouter
