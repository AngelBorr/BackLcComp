import MercadoPagoWebhookService from '../services/mercadoPagoWebhook.service.js'
import { error as logError } from '../utils/logger.js'

class MercadoPagoWebhookController {
  constructor({ webhookService = MercadoPagoWebhookService } = {}) {
    this.webhookService = webhookService
    this.handle = this.handle.bind(this)
  }

  async handle(req, res) {
    try {
      await this.webhookService.handleWebhook({
        query: req.query,
        headers: {
          xSignature: req.get('x-signature'),
          xRequestId: req.get('x-request-id')
        },
        body: req.body
      })

      return res.status(200).json({ received: true })
    } catch (error) {
      const status = Number(error?.statusCode || error?.status || 500)
      const safeStatus = status >= 400 && status <= 599 ? status : 500

      logError('Mercado Pago webhook rechazado', {
        code: error?.code || 'MERCADOPAGO_WEBHOOK_FAILED',
        status: safeStatus
      })

      return res.status(safeStatus).json({
        received: false,
        message: safeStatus >= 500
          ? 'No se pudo procesar el webhook de Mercado Pago'
          : error.message
      })
    }
  }
}

export { MercadoPagoWebhookController }
export default new MercadoPagoWebhookController()
