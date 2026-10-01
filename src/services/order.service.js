import mongoose from 'mongoose'
import OrderManager from '../dao/managers/order.manager.js'
import OrderItemManager from '../dao/managers/orderItem.manager.js'
import OrderNumberManager from '../dao/managers/orderNumber.manager.js'
import CommercePricingService from './service.commercePricing.js'
import ExchangeRateService from './exchangeRate.service.js'
import { ServiceError } from './service.products.js'
import { calculateUsdLineAmounts, minorUnitsToDecimalString } from '../utils/commerceMoney.js'
import { log, error as logError, secureLog } from '../utils/logger.js'

const TRANSACTION_OPTIONS = {
  readConcern: { level: 'snapshot' },
  writeConcern: { w: 'majority' }
}

export const ORDER_STATUS_TRANSITIONS = Object.freeze({
  pending_payment: new Set(['paid', 'cancelled', 'expired', 'requires_attention']),
  paid: new Set(['requires_attention']),
  cancelled: new Set(['requires_attention']),
  expired: new Set(['requires_attention']),
  requires_attention: new Set()
})

const toPlainObject = (document) =>
  typeof document?.toObject === 'function' ? document.toObject() : document

class OrderService {
  constructor({
    orderManager = OrderManager,
    orderItemManager = OrderItemManager,
    orderNumberManager = OrderNumberManager,
    commercePricingService = CommercePricingService,
    exchangeRateService = ExchangeRateService
  } = {}) {
    this.orders = orderManager
    this.orderItems = orderItemManager
    this.orderNumbers = orderNumberManager
    this.pricing = commercePricingService
    this.exchangeRates = exchangeRateService
  }

  #assertActiveExternalSession(session) {
    if (
      session &&
      (session.hasEnded ||
        typeof session.inTransaction !== 'function' ||
        !session.inTransaction())
    ) {
      throw new ServiceError(
        'La sesión externa debe tener una transacción activa',
        'EXTERNAL_TRANSACTION_REQUIRED',
        400
      )
    }
  }

  async #runInTransaction(operation, { session: externalSession } = {}) {
    this.#assertActiveExternalSession(externalSession)

    if (externalSession) return operation(externalSession)

    const ownedSession = await mongoose.startSession()
    let result

    try {
      await ownedSession.withTransaction(async () => {
        result = await operation(ownedSession)
      }, TRANSACTION_OPTIONS)

      return result
    } finally {
      await ownedSession.endSession()
    }
  }

  #isDuplicateKeyError(error) {
    return error?.code === 11000 || error?.errorResponse?.code === 11000
  }

  #assertObjectId(id, code, message) {
    if (!mongoose.Types.ObjectId.isValid(id)) {
      throw new ServiceError(message, code, 400)
    }
  }

  async createBaseOrder(
    {
      userId,
      items,
      fulfillmentMode = 'pickup',
      reservationExpiresAt = null,
      exchangeRateQuote = null,
      checkoutIdempotencyKey = null,
      checkoutRequestHash = null
    },
    { session: externalSession, now = new Date() } = {}
  ) {
    try {
      log('🧾 OrderService → creando orden base autoritativa')
      this.#assertObjectId(userId, 'INVALID_USER_ID', 'ID de usuario inválido')

      if (!Array.isArray(items) || !items.length) {
        throw new ServiceError(
          'La orden debe contener al menos un producto',
          'ORDER_ITEMS_REQUIRED',
          400
        )
      }

      if (fulfillmentMode !== 'pickup') {
        throw new ServiceError(
          'El modo de entrega no está soportado',
          'INVALID_FULFILLMENT_MODE',
          400
        )
      }

      const createdAt = new Date(now)

      if (Number.isNaN(createdAt.getTime())) {
        throw new ServiceError('Fecha de orden inválida', 'INVALID_ORDER_DATE', 400)
      }

      const result = await this.#runInTransaction(
        async (session) => {
          const authoritativeItems = []
          let authoritativeUser
          let totalUsdCents = 0

          for (const requestedItem of items) {
            const { user, item } = await this.pricing.getOrderItemSnapshot(
              {
                userId,
                productId: requestedItem?.productId,
                quantity: requestedItem?.quantity
              },
              { session }
            )

            authoritativeUser ||= user

            if (String(authoritativeUser._id) !== String(user._id)) {
              throw new ServiceError(
                'No se pudo establecer un comprador autoritativo único',
                'ORDER_BUYER_CONTEXT_CONFLICT',
                409
              )
            }

            const amounts = calculateUsdLineAmounts({
              unitPriceUsd: item.unitPriceUsd,
              vatRate: item.vatRate,
              quantity: item.quantity
            })

            totalUsdCents += amounts.totalUsdCents

            if (!Number.isSafeInteger(totalUsdCents)) {
              throw new ServiceError(
                'El total de la orden excede la precisión soportada',
                'ORDER_TOTAL_OUT_OF_RANGE',
                400
              )
            }

            authoritativeItems.push({
              productId: item.productId,
              productSnapshot: { ...item.productSnapshot },
              quantity: item.quantity,
              priceType: item.priceType,
              currency: 'USD',
              vatRate: String(item.vatRate),
              unitPriceUsd: amounts.unitPriceUsd,
              netUnitPriceUsd: amounts.netUnitPriceUsd,
              vatAmountPerUnitUsd: amounts.vatAmountPerUnitUsd,
              lineNetUsd: amounts.lineNetUsd,
              lineVatUsd: amounts.lineVatUsd,
              totalUsd: amounts.totalUsd
            })
          }

          const role = String(authoritativeUser?.role || '').trim().toUpperCase()

          if (!['USER', 'PREMIUM'].includes(role)) {
            throw new ServiceError(
              'El usuario no está habilitado como comprador',
              'BUYER_ROLE_NOT_ALLOWED',
              403
            )
          }

          const totalUsd = minorUnitsToDecimalString(totalUsdCents)
          const conversion = exchangeRateQuote
            ? this.exchangeRates.calculateOrderTotalsFromQuote(totalUsd, exchangeRateQuote)
            : null

          const orderNumber = await this.orderNumbers.nextOrderNumber({
            at: createdAt,
            session
          })
          const order = await this.orders.create(
            {
              orderNumber,
              userId: authoritativeUser._id,
              checkoutIdempotencyKey,
              checkoutRequestHash,
              buyerSnapshot: {
                firstName: authoritativeUser.firstName,
                lastName: authoritativeUser.lastName,
                email: authoritativeUser.email,
                role
              },
              fulfillmentMode,
              status: 'pending_payment',
              commercialCurrency: 'USD',
              paymentCurrency: 'ARS',
              totals: {
                totalUsd,
                totalArs: conversion?.totalArs ?? null
              },
              exchangeRateSnapshot: conversion?.exchangeRateSnapshot ?? null,
              reservationExpiresAt,
              statusHistory: [
                {
                  status: 'pending_payment',
                  changedAt: createdAt,
                  reason: ''
                }
              ]
            },
            { session }
          )
          const orderObject = toPlainObject(order)
          const orderItems = await this.orderItems.createMany(
            authoritativeItems.map((item) => ({
              ...item,
              orderId: orderObject._id
            })),
            { session }
          )

          return {
            order: orderObject,
            items: orderItems.map(toPlainObject)
          }
        },
        { session: externalSession }
      )

      secureLog('✅ OrderService orden base creada', {
        orderId: result.order._id,
        orderNumber: result.order.orderNumber,
        userId: result.order.userId,
        itemCount: result.items.length,
        status: result.order.status
      })

      return result
    } catch (error) {
      logError('❌ OrderService createBaseOrder error:', error)
      if (error instanceof ServiceError) throw error

      if (this.#isDuplicateKeyError(error)) {
        if (
          error?.keyPattern?.checkoutIdempotencyKey ||
          error?.errorResponse?.keyPattern?.checkoutIdempotencyKey ||
          Object.hasOwn(error?.keyValue || {}, 'checkoutIdempotencyKey') ||
          Object.hasOwn(error?.errorResponse?.keyValue || {}, 'checkoutIdempotencyKey')
        ) {
          throw new ServiceError(
            'La clave de idempotencia ya fue utilizada',
            'CHECKOUT_IDEMPOTENCY_CONFLICT',
            409
          )
        }

        throw new ServiceError(
          'No se pudo asignar un número de orden único',
          'ORDER_NUMBER_CONFLICT',
          409
        )
      }

      throw new ServiceError(
        'No se pudo crear la orden',
        'CREATE_ORDER_FAILED',
        500,
        { cause: error?.message }
      )
    }
  }

  async getOrderById(orderId, { session } = {}) {
    this.#assertObjectId(orderId, 'INVALID_ORDER_ID', 'ID de orden inválido')
    const order = await this.orders.getById(orderId, { session })

    if (!order) throw new ServiceError('Orden no encontrada', 'ORDER_NOT_FOUND', 404)

    const items = await this.orderItems.getByOrderId(orderId, { session })
    return { order, items }
  }

  async getOrderByNumber(orderNumber, { session } = {}) {
    const normalizedOrderNumber = String(orderNumber || '').trim().toUpperCase()

    if (!normalizedOrderNumber) {
      throw new ServiceError('Número de orden requerido', 'ORDER_NUMBER_REQUIRED', 400)
    }

    const order = await this.orders.getByOrderNumber(normalizedOrderNumber, { session })
    if (!order) throw new ServiceError('Orden no encontrada', 'ORDER_NOT_FOUND', 404)

    const items = await this.orderItems.getByOrderId(order._id, { session })
    return { order, items }
  }

  async getOrdersForUser(userId, { session } = {}) {
    this.#assertObjectId(userId, 'INVALID_USER_ID', 'ID de usuario inválido')
    return this.orders.getByUserId(userId, { session })
  }

  async getOrderForUser(orderId, userId, { session } = {}) {
    this.#assertObjectId(orderId, 'INVALID_ORDER_ID', 'ID de orden inválido')
    this.#assertObjectId(userId, 'INVALID_USER_ID', 'ID de usuario inválido')
    const order = await this.orders.getById(orderId, { session })

    if (!order) throw new ServiceError('Orden no encontrada', 'ORDER_NOT_FOUND', 404)

    if (String(order.userId) !== String(userId)) {
      throw new ServiceError(
        'La orden no pertenece al usuario autenticado',
        'ORDER_ACCESS_DENIED',
        403
      )
    }

    const items = await this.orderItems.getByOrderId(orderId, { session })
    return { order, items }
  }

  async getOrdersForAdmin(filters = {}, { session } = {}) {
    return this.orders.list(filters, { session })
  }

  async transitionOrderStatus(
    { orderId, nextStatus, reason = '' },
    { session, now = new Date() } = {}
  ) {
    this.#assertObjectId(orderId, 'INVALID_ORDER_ID', 'ID de orden inválido')
    const changedAt = new Date(now)

    if (Number.isNaN(changedAt.getTime())) {
      throw new ServiceError('Fecha de transición inválida', 'INVALID_ORDER_DATE', 400)
    }

    const order = await this.orders.getById(orderId, { session })
    if (!order) throw new ServiceError('Orden no encontrada', 'ORDER_NOT_FOUND', 404)

    const allowedTransitions = ORDER_STATUS_TRANSITIONS[order.status]

    if (!allowedTransitions?.has(nextStatus)) {
      throw new ServiceError(
        `No se permite cambiar una orden de ${order.status} a ${nextStatus}`,
        'INVALID_ORDER_STATUS_TRANSITION',
        409
      )
    }

    const updated = await this.orders.updateStatus(
      orderId,
      order.status,
      { nextStatus, changedAt, reason: String(reason || '').trim() },
      { session }
    )

    if (!updated) {
      throw new ServiceError(
        'El estado de la orden cambió durante la operación',
        'ORDER_STATUS_CONFLICT',
        409
      )
    }

    return updated
  }
}

export { OrderService }
export default new OrderService()
