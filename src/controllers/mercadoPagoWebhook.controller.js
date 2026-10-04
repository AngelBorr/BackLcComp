import MercadoPagoWebhookService from '../services/mercadoPagoWebhook.service.js'
import { error as logError, secureLog } from '../utils/logger.js'

class MercadoPagoWebhookController {
  constructor({ webhookService = MercadoPagoWebhookService } = {}) {
    this.webhookService = webhookService
    this.handle = this.handle.bind(this)
  }

  async handle(req, res) {
    try {
      const hasObjectBody = req.body !== null && typeof req.body === 'object'

      secureLog('Mercado Pago webhook estructura recibida', {
        bodyType: typeof req.body,
        bodyKeys: hasObjectBody ? Object.keys(req.body) : [],
        bodyIdType: typeof req.body?.id,
        hasBodyId: hasObjectBody && Object.hasOwn(req.body, 'id'),
        hasBodyDataId:
          req.body?.data !== null &&
          typeof req.body?.data === 'object' &&
          Object.hasOwn(req.body.data, 'id'),
        queryKeys:
          req.query !== null && typeof req.query === 'object'
            ? Object.keys(req.query)
            : [],
        hasSignature: Boolean(req.get('x-signature')),
        hasRequestId: Boolean(req.get('x-request-id')),
        contentType: req.get('content-type') || null
      })

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
