import mongoose from 'mongoose'
import { randomUUID } from 'node:crypto'
import OrderManager from '../dao/managers/order.manager.js'
import PaymentManager from '../dao/managers/payment.manager.js'
import PaymentEventManager from '../dao/managers/paymentEvent.manager.js'
import { ServiceError } from './service.products.js'
import { minorUnitsToDecimalString, toMinorUnits } from '../utils/commerceMoney.js'
import { log, error as logError, secureLog } from '../utils/logger.js'

export const PAYMENT_STATUS_TRANSITIONS = Object.freeze({
  pending: new Set(['approved', 'rejected', 'cancelled', 'requires_attention']),
  approved: new Set(['refunded', 'requires_attention']),
  rejected: new Set(['requires_attention']),
  cancelled: new Set(['requires_attention']),
  refunded: new Set(['requires_attention']),
  requires_attention: new Set()
})

class PaymentService {
  constructor({
    orderManager = OrderManager,
    paymentManager = PaymentManager,
    paymentEventManager = PaymentEventManager
  } = {}) {
    this.orders = orderManager
    this.payments = paymentManager
    this.paymentEvents = paymentEventManager
  }

  #assertObjectId(id, code, message) {
    if (!mongoose.Types.ObjectId.isValid(id)) {
      throw new ServiceError(message, code, 400)
    }
  }

  #isDuplicateKeyError(error) {
    return error?.code === 11000 || error?.errorResponse?.code === 11000
  }

  async createPayment(input = {}, { session } = {}) {
    try {
      log('💳 PaymentService → preparando pago interno')
      const { orderId } = input

      if (Object.prototype.hasOwnProperty.call(input, 'amountArs')) {
        throw new ServiceError(
          'El importe ARS debe provenir de la orden autoritativa',
          'PAYMENT_AMOUNT_NOT_ALLOWED',
          400
        )
      }

      this.#assertObjectId(orderId, 'INVALID_ORDER_ID', 'ID de orden inválido')

      const order = await this.orders.getById(orderId, { session })
      if (!order) throw new ServiceError('Orden no encontrada', 'ORDER_NOT_FOUND', 404)

      if (order.status !== 'pending_payment') {
        throw new ServiceError(
          'Sólo pueden prepararse pagos para órdenes pendientes',
          'ORDER_NOT_PENDING_PAYMENT',
          409
        )
      }

      const amountArs = order.totals?.totalArs?.toString?.() ?? order.totals?.totalArs

      if (!order.exchangeRateSnapshot || amountArs === null || amountArs === undefined) {
        throw new ServiceError(
          'La orden no tiene una conversión ARS autoritativa',
          'ORDER_ARS_TOTAL_REQUIRED',
          409
        )
      }

      let amountArsCents

      try {
        amountArsCents = toMinorUnits(amountArs, 'amountArs')
      } catch {
        throw new ServiceError('El importe ARS es inválido', 'INVALID_PAYMENT_AMOUNT', 400)
      }

      if (amountArsCents <= 0) {
        throw new ServiceError('El importe ARS debe ser mayor que cero', 'INVALID_PAYMENT_AMOUNT', 400)
      }

      const payment = await this.payments.create(
        {
          orderId: order._id,
          provider: 'mercado_pago',
          preferenceId: null,
          providerOrderId: null,
          providerCheckoutUrl: null,
          providerIdempotencyKey: randomUUID(),
          providerPaymentId: null,
          externalReference: order.orderNumber,
          providerStatus: null,
          normalizedStatus: 'pending',
          amountArs: minorUnitsToDecimalString(amountArsCents),
          currency: 'ARS',
          approvedAt: null,
          lastProviderCheckAt: null
        },
        { session }
      )

      secureLog('✅ PaymentService pago interno preparado', {
        paymentId: payment._id,
        orderId: order._id,
        status: payment.normalizedStatus
      })

      return payment
    } catch (error) {
      logError('❌ PaymentService createPayment error:', error)
      if (error instanceof ServiceError) throw error

      throw new ServiceError(
        'No se pudo preparar el pago',
        'CREATE_PAYMENT_FAILED',
        500,
        { cause: error?.message }
      )
    }
  }

  async getPaymentById(paymentId, { session } = {}) {
    this.#assertObjectId(paymentId, 'INVALID_PAYMENT_ID', 'ID de pago inválido')
    const payment = await this.payments.getById(paymentId, { session })
    if (!payment) throw new ServiceError('Pago no encontrado', 'PAYMENT_NOT_FOUND', 404)
    return payment
  }

  async getPaymentsByOrderId(orderId, { session } = {}) {
    this.#assertObjectId(orderId, 'INVALID_ORDER_ID', 'ID de orden inválido')
    return this.payments.getByOrderId(orderId, { session })
  }

  async getPaymentByProviderPaymentId(providerPaymentId, { session } = {}) {
    const normalizedId = String(providerPaymentId || '').trim()

    if (!normalizedId) {
      throw new ServiceError(
        'ID de pago del proveedor requerido',
        'PROVIDER_PAYMENT_ID_REQUIRED',
        400
      )
    }

    const payment = await this.payments.getByProviderPaymentId(normalizedId, { session })
    if (!payment) throw new ServiceError('Pago no encontrado', 'PAYMENT_NOT_FOUND', 404)
    return payment
  }

  async transitionPaymentStatus(
    {
      paymentId,
      nextStatus,
      providerStatus,
      providerPaymentId,
      checkedAt = new Date()
    },
    { session } = {}
  ) {
    this.#assertObjectId(paymentId, 'INVALID_PAYMENT_ID', 'ID de pago inválido')
    const payment = await this.payments.getById(paymentId, { session })
    if (!payment) throw new ServiceError('Pago no encontrado', 'PAYMENT_NOT_FOUND', 404)

    const allowedTransitions = PAYMENT_STATUS_TRANSITIONS[payment.normalizedStatus]

    if (!allowedTransitions?.has(nextStatus)) {
      throw new ServiceError(
        `No se permite cambiar un pago de ${payment.normalizedStatus} a ${nextStatus}`,
        'INVALID_PAYMENT_STATUS_TRANSITION',
        409
      )
    }

    const normalizedCheckedAt = new Date(checkedAt)

    if (Number.isNaN(normalizedCheckedAt.getTime())) {
      throw new ServiceError(
        'Fecha de comprobación de pago inválida',
        'INVALID_PAYMENT_CHECK_DATE',
        400
      )
    }

    const update = {
      normalizedStatus: nextStatus,
      lastProviderCheckAt: normalizedCheckedAt,
      approvedAt: nextStatus === 'approved' ? normalizedCheckedAt : payment.approvedAt
    }

    if (providerStatus !== undefined) {
      update.providerStatus = providerStatus ? String(providerStatus).trim() : null
    }

    if (providerPaymentId !== undefined) {
      update.providerPaymentId = providerPaymentId ? String(providerPaymentId).trim() : null
    }

    try {
      const updated = await this.payments.updateStatus(
        paymentId,
        payment.normalizedStatus,
        update,
        { session }
      )

      if (!updated) {
        throw new ServiceError(
          'El estado del pago cambió durante la operación',
          'PAYMENT_STATUS_CONFLICT',
          409
        )
      }

      return updated
    } catch (error) {
      if (error instanceof ServiceError) throw error

      if (this.#isDuplicateKeyError(error)) {
        throw new ServiceError(
          'El identificador de pago del proveedor ya está registrado',
          'PAYMENT_PROVIDER_ID_CONFLICT',
          409
        )
      }

      throw new ServiceError(
        'No se pudo actualizar el estado del pago',
        'UPDATE_PAYMENT_STATUS_FAILED',
        500,
        { cause: error?.message }
      )
    }
  }

  async recordPaymentEvent(
    { provider = 'mercado_pago', providerEventId, providerPaymentId = null, orderId = null },
    { session, receivedAt = new Date() } = {}
  ) {
    const normalizedEventId = String(providerEventId || '').trim()

    if (!normalizedEventId) {
      throw new ServiceError(
        'ID de evento del proveedor requerido',
        'PROVIDER_EVENT_ID_REQUIRED',
        400
      )
    }

    if (provider !== 'mercado_pago') {
      throw new ServiceError('Proveedor de pago inválido', 'INVALID_PAYMENT_PROVIDER', 400)
    }

    if (orderId) this.#assertObjectId(orderId, 'INVALID_ORDER_ID', 'ID de orden inválido')

    const normalizedReceivedAt = new Date(receivedAt)

    if (Number.isNaN(normalizedReceivedAt.getTime())) {
      throw new ServiceError('Fecha de evento inválida', 'INVALID_PAYMENT_EVENT_DATE', 400)
    }

    try {
      return await this.paymentEvents.create(
        {
          provider,
          providerEventId: normalizedEventId,
          providerPaymentId: providerPaymentId ? String(providerPaymentId).trim() : null,
          orderId: orderId || null,
          receivedAt: normalizedReceivedAt,
          processedAt: null,
          processingStatus: 'received',
          attempts: 0,
          lastError: null
        },
        { session }
      )
    } catch (error) {
      if (this.#isDuplicateKeyError(error)) {
        throw new ServiceError(
          'El evento de pago ya fue registrado',
          'PAYMENT_EVENT_DUPLICATE',
          409
        )
      }

      if (error instanceof ServiceError) throw error

      throw new ServiceError(
        'No se pudo registrar el evento de pago',
        'CREATE_PAYMENT_EVENT_FAILED',
        500,
        { cause: error?.message }
      )
    }
  }

  async getPaymentEvent(provider, providerEventId, { session } = {}) {
    const event = await this.paymentEvents.getByProviderEventId(
      provider,
      String(providerEventId || '').trim(),
      { session }
    )

    if (!event) {
      throw new ServiceError('Evento de pago no encontrado', 'PAYMENT_EVENT_NOT_FOUND', 404)
    }

    return event
  }
}

export { PaymentService }
export default new PaymentService()
