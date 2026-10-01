import config from '../config.js'
import PaymentEventManager from '../dao/managers/paymentEvent.manager.js'
import MercadoPagoReconciliationService from './mercadoPagoReconciliation.service.js'
import { ServiceError } from './service.products.js'
import {
  MercadoPagoWebhookSignatureError,
  validateMercadoPagoWebhookSignature
} from '../utils/mercadoPagoWebhookSignature.js'
import { error as logError, secureLog } from '../utils/logger.js'

const PROCESSING_LEASE_MS = 30 * 1000

const requiredText = (value, code, message) => {
  if (Array.isArray(value)) {
    throw new ServiceError(message, code, 400)
  }

  const normalized = String(value ?? '').trim()
  if (!normalized) throw new ServiceError(message, code, 400)
  return normalized
}

class MercadoPagoWebhookService {
  constructor({
    paymentEventManager = PaymentEventManager,
    reconciliationService = MercadoPagoReconciliationService,
    webhookSecret = config.mercadoPago?.webhookSecret,
    signatureValidator = validateMercadoPagoWebhookSignature
  } = {}) {
    this.paymentEvents = paymentEventManager
    this.reconciliation = reconciliationService
    this.webhookSecret = webhookSecret
    this.signatureValidator = signatureValidator
  }

  #normalizeInput({ query = {}, headers = {}, body = {} } = {}) {
    const type = requiredText(
      query.type,
      'MERCADOPAGO_WEBHOOK_TYPE_REQUIRED',
      'Tipo de webhook requerido'
    ).toLowerCase()

    if (type !== 'order') {
      throw new ServiceError(
        'Tipo de webhook de Mercado Pago no soportado',
        'MERCADOPAGO_WEBHOOK_TYPE_INVALID',
        400
      )
    }

    const providerOrderId = requiredText(
      query['data.id'],
      'MERCADOPAGO_WEBHOOK_ORDER_ID_REQUIRED',
      'ID de order de Mercado Pago requerido'
    )
    const providerEventId = requiredText(
      body?.id,
      'MERCADOPAGO_WEBHOOK_EVENT_ID_REQUIRED',
      'ID de evento de Mercado Pago requerido'
    )

    if (body?.type !== undefined && String(body.type).trim().toLowerCase() !== 'order') {
      throw new ServiceError(
        'El body del webhook no corresponde a una order',
        'MERCADOPAGO_WEBHOOK_BODY_TYPE_INVALID',
        400
      )
    }

    if (
      body?.data?.id !== undefined &&
      String(body.data.id).trim() !== providerOrderId
    ) {
      throw new ServiceError(
        'El ID de order del webhook es inconsistente',
        'MERCADOPAGO_WEBHOOK_ORDER_ID_MISMATCH',
        400
      )
    }

    return {
      providerOrderId,
      providerEventId,
      xSignature: headers.xSignature,
      xRequestId: headers.xRequestId
    }
  }

  async handleWebhook(input, { now = new Date() } = {}) {
    const receivedAt = new Date(now)

    if (Number.isNaN(receivedAt.getTime())) {
      throw new ServiceError(
        'Fecha de webhook invÃ¡lida',
        'MERCADOPAGO_WEBHOOK_DATE_INVALID',
        400
      )
    }

    const normalized = this.#normalizeInput(input)

    try {
      this.signatureValidator({
        xSignature: normalized.xSignature,
        xRequestId: normalized.xRequestId,
        dataId: normalized.providerOrderId,
        secret: this.webhookSecret
      })
    } catch (error) {
      if (error instanceof MercadoPagoWebhookSignatureError) throw error
      throw new MercadoPagoWebhookSignatureError(
        'Firma de Mercado Pago invÃ¡lida',
        'MERCADOPAGO_WEBHOOK_SIGNATURE_INVALID',
        401
      )
    }

    const claim = await this.paymentEvents.claimForProcessing({
      provider: 'mercado_pago',
      providerEventId: normalized.providerEventId,
      providerOrderId: normalized.providerOrderId,
      receivedAt,
      processingStartedAt: receivedAt,
      staleBefore: new Date(receivedAt.getTime() - PROCESSING_LEASE_MS)
    })

    if (!claim.claimed) {
      if (['processed', 'ignored'].includes(claim.event.processingStatus)) {
        return { received: true, duplicate: true }
      }

      throw new ServiceError(
        'El evento de Mercado Pago ya estÃ¡ siendo procesado',
        'MERCADOPAGO_WEBHOOK_IN_PROGRESS',
        503
      )
    }

    try {
      const result = await this.reconciliation.reconcileProviderOrder(
        normalized.providerOrderId,
        { now: receivedAt }
      )
      const processingStatus = result.outcome === 'ignored' ? 'ignored' : 'processed'
      const event = await this.paymentEvents.markProcessed(
        claim.event._id,
        {
          processingStatus,
          processedAt: receivedAt,
          orderId: result.orderId,
          providerPaymentId: result.providerPaymentId
        }
      )

      if (!event) {
        throw new ServiceError(
          'El evento cambiÃ³ durante el procesamiento',
          'MERCADOPAGO_WEBHOOK_EVENT_CONFLICT',
          503
        )
      }

      secureLog('Mercado Pago webhook procesado', {
        providerEventId: normalized.providerEventId,
        providerOrderId: normalized.providerOrderId,
        processingStatus,
        outcome: result.outcome,
        attempt: event.attempts
      })

      return { received: true, duplicate: false }
    } catch (error) {
      try {
        await this.paymentEvents.markFailed(claim.event._id, {
          code: String(error?.code || 'MERCADOPAGO_WEBHOOK_PROCESSING_FAILED').slice(0, 100),
          message: 'No se pudo procesar el evento de Mercado Pago'
        })
      } catch (markError) {
        logError('Mercado Pago webhook no pudo registrar fallo', {
          providerEventId: normalized.providerEventId,
          code: markError?.code || 'PAYMENT_EVENT_FAILURE_UPDATE_FAILED'
        })
      }

      throw error
    }
  }
}

export { MercadoPagoWebhookService, PROCESSING_LEASE_MS }
export default new MercadoPagoWebhookService()
