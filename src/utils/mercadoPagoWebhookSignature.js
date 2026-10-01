import { createHmac, timingSafeEqual } from 'node:crypto'

class MercadoPagoWebhookSignatureError extends Error {
  constructor(message, code = 'MERCADOPAGO_WEBHOOK_SIGNATURE_INVALID', status = 401) {
    super(message)
    this.name = 'MercadoPagoWebhookSignatureError'
    this.code = code
    this.status = status
    this.statusCode = status
  }
}

const normalizeRequiredValue = (value, code, message) => {
  const normalized = Array.isArray(value) ? value[0] : value
  const text = String(normalized ?? '').trim()

  if (!text) throw new MercadoPagoWebhookSignatureError(message, code, 401)
  return text
}

const parseSignatureHeader = (xSignature) => {
  const header = normalizeRequiredValue(
    xSignature,
    'MERCADOPAGO_WEBHOOK_SIGNATURE_REQUIRED',
    'Firma de Mercado Pago requerida'
  )
  const components = {}

  for (const part of header.split(',')) {
    const separator = part.indexOf('=')
    if (separator < 1) continue

    const key = part.slice(0, separator).trim().toLowerCase()
    const value = part.slice(separator + 1).trim()
    if (key && value) components[key] = value
  }

  if (!/^\d+$/.test(components.ts || '') || !/^[a-fA-F0-9]{64}$/.test(components.v1 || '')) {
    throw new MercadoPagoWebhookSignatureError(
      'Firma de Mercado Pago invÃ¡lida',
      'MERCADOPAGO_WEBHOOK_SIGNATURE_INVALID',
      401
    )
  }

  return { timestamp: components.ts, receivedHash: components.v1.toLowerCase() }
}

const buildSignatureManifest = ({ dataId, xRequestId, timestamp }) =>
  `id:${dataId};request-id:${xRequestId};ts:${timestamp};`

const constantTimeHexEqual = (expected, received) => {
  const expectedBuffer = Buffer.from(expected, 'hex')
  const receivedBuffer = Buffer.from(received, 'hex')

  if (expectedBuffer.length !== receivedBuffer.length) return false
  return timingSafeEqual(expectedBuffer, receivedBuffer)
}

const validateMercadoPagoWebhookSignature = ({
  xSignature,
  xRequestId,
  dataId,
  secret
}) => {
  const requestId = normalizeRequiredValue(
    xRequestId,
    'MERCADOPAGO_WEBHOOK_REQUEST_ID_REQUIRED',
    'Identificador de solicitud de Mercado Pago requerido'
  )
  const providerOrderId = normalizeRequiredValue(
    dataId,
    'MERCADOPAGO_WEBHOOK_ORDER_ID_REQUIRED',
    'Identificador de order de Mercado Pago requerido'
  )
  const configuredSecret = String(secret ?? '').trim()

  if (!configuredSecret) {
    throw new MercadoPagoWebhookSignatureError(
      'El webhook de Mercado Pago no estÃ¡ configurado',
      'MERCADOPAGO_WEBHOOK_NOT_CONFIGURED',
      503
    )
  }

  const { timestamp, receivedHash } = parseSignatureHeader(xSignature)
  const manifest = buildSignatureManifest({
    dataId: providerOrderId,
    xRequestId: requestId,
    timestamp
  })
  const expectedHash = createHmac('sha256', configuredSecret).update(manifest).digest('hex')

  if (!constantTimeHexEqual(expectedHash, receivedHash)) {
    throw new MercadoPagoWebhookSignatureError(
      'Firma de Mercado Pago invÃ¡lida',
      'MERCADOPAGO_WEBHOOK_SIGNATURE_INVALID',
      401
    )
  }

  return true
}

export {
  MercadoPagoWebhookSignatureError,
  buildSignatureManifest,
  constantTimeHexEqual,
  parseSignatureHeader,
  validateMercadoPagoWebhookSignature
}
