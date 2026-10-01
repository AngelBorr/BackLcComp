import MyOwnRouter from './router.js'
import MercadoPagoWebhookController from '../controllers/mercadoPagoWebhook.controller.js'

class WebhooksRouter extends MyOwnRouter {
  init() {
    this.post('/mercadopago', ['PUBLIC'], MercadoPagoWebhookController.handle)
  }
}

export default WebhooksRouter
