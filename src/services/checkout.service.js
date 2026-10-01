import { createHash } from 'node:crypto'
import mongoose from 'mongoose'
import OrderManager from '../dao/managers/order.manager.js'
import OrderItemManager from '../dao/managers/orderItem.manager.js'
import PaymentManager from '../dao/managers/payment.manager.js'
import CommercePricingService from './service.commercePricing.js'
import ExchangeRateService from './exchangeRate.service.js'
import OrderService from './order.service.js'
import PaymentService from './payment.service.js'
import ProductUnitService from './productUnit.service.js'
import { ServiceError } from './service.products.js'
import { log, error as logError, secureLog } from '../utils/logger.js'

const RESERVATION_DURATION_MS = 6 * 60 * 60 * 1000
const TRANSACTION_OPTIONS = Object.freeze({
  readConcern: { level: 'snapshot' },
  writeConcern: { w: 'majority' }
})
const IDEMPOTENCY_KEY_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/
const CHECKOUT_INPUT_FIELDS = new Set(['userId', 'items', 'idempotencyKey'])
const CHECKOUT_ITEM_FIELDS = new Set(['productId', 'quantity'])

const toPlainObject = (document) =>
  typeof document?.toObject === 'function' ? document.toObject() : document

const decimalToString = (value) => value?.toString?.() ?? String(value)

const dateToIsoString = (value) => {
  const date = new Date(value)
  return Number.isNaN(date.getTime()) ? null : date.toISOString()
}

class CheckoutService {
  constructor({
    mongooseInstance = mongoose,
    orderManager = OrderManager,
    orderItemManager = OrderItemManager,
    paymentManager = PaymentManager,
    commercePricingService = CommercePricingService,
    exchangeRateService = ExchangeRateService,
    orderService = OrderService,
    productUnitService = ProductUnitService,
    paymentService = PaymentService
  } = {}) {
    this.mongoose = mongooseInstance
    this.orders = orderManager
    this.orderItems = orderItemManager
    this.payments = paymentManager
    this.pricing = commercePricingService
    this.exchangeRates = exchangeRateService
    this.orderService = orderService
    this.productUnits = productUnitService
    this.paymentService = paymentService
  }

  #isDuplicateKeyError(error) {
    return error?.code === 11000 || error?.errorResponse?.code === 11000
  }

  #normalizeInput(input) {
    if (!input || typeof input !== 'object' || Array.isArray(input)) {
      throw new ServiceError('El checkout es inválido', 'CHECKOUT_INVALID_INPUT', 400)
    }

    const unexpectedFields = Object.keys(input).filter(
      (field) => !CHECKOUT_INPUT_FIELDS.has(field)
    )

    if (unexpectedFields.length) {
      throw new ServiceError(
        'El checkout contiene campos no permitidos',
        'CHECKOUT_INVALID_INPUT',
        400
      )
    }

    const userId = String(input.userId || '').trim()

    if (!mongoose.Types.ObjectId.isValid(userId)) {
      throw new ServiceError('ID de usuario inválido', 'INVALID_USER_ID', 400)
    }

    const idempotencyKey = String(input.idempotencyKey || '').trim()

    if (!IDEMPOTENCY_KEY_PATTERN.test(idempotencyKey)) {
      throw new ServiceError(
        'La clave de idempotencia es inválida',
        'CHECKOUT_INVALID_IDEMPOTENCY_KEY',
        400
      )
    }

    if (!Array.isArray(input.items) || input.items.length === 0) {
      throw new ServiceError(
        'El checkout debe contener al menos un producto',
        'CHECKOUT_EMPTY',
        400
      )
    }

    const groupedItems = new Map()

    for (const requestedItem of input.items) {
      if (!requestedItem || typeof requestedItem !== 'object' || Array.isArray(requestedItem)) {
        throw new ServiceError('El producto solicitado es inválido', 'CHECKOUT_INVALID_ITEM', 400)
      }

      const unexpectedItemFields = Object.keys(requestedItem).filter(
        (field) => !CHECKOUT_ITEM_FIELDS.has(field)
      )

      if (unexpectedItemFields.length) {
        throw new ServiceError(
          'Los productos del checkout sólo admiten productId y quantity',
          'CHECKOUT_INVALID_ITEM',
          400
        )
      }

      const productId = String(requestedItem.productId || '').trim()
      const quantity = Number(requestedItem.quantity)

      if (!mongoose.Types.ObjectId.isValid(productId) || !Number.isSafeInteger(quantity) || quantity <= 0) {
        throw new ServiceError('El producto solicitado es inválido', 'CHECKOUT_INVALID_ITEM', 400)
      }

      const normalizedProductId = new mongoose.Types.ObjectId(productId).toString()
      const groupedQuantity = (groupedItems.get(normalizedProductId) || 0) + quantity

      if (!Number.isSafeInteger(groupedQuantity) || groupedQuantity <= 0) {
        throw new ServiceError(
          'La cantidad agrupada excede la precisión soportada',
          'CHECKOUT_INVALID_ITEM',
          400
        )
      }

      groupedItems.set(normalizedProductId, groupedQuantity)
    }

    const items = [...groupedItems.entries()]
      .map(([productId, quantity]) => ({ productId, quantity }))
      .sort((left, right) => left.productId.localeCompare(right.productId))
    const requestHash = createHash('sha256').update(JSON.stringify(items)).digest('hex')

    return { userId, idempotencyKey, items, requestHash }
  }

  #assertEligibleBuyer(context) {
    const role = String(context?.role || context?.user?.role || '').trim().toUpperCase()

    if (role === 'USER') {
      if (context?.user?.emailVerified !== true) {
        throw new ServiceError(
          'Debes verificar tu correo antes de comprar',
          'CHECKOUT_EMAIL_NOT_VERIFIED',
          403
        )
      }

      return
    }

    if (role === 'PREMIUM') return

    throw new ServiceError(
      'El rol del usuario no está habilitado para comprar',
      'CHECKOUT_FORBIDDEN_ROLE',
      403
    )
  }

  async #preflight({ userId, items }) {
    const userContext = await this.pricing.getAuthoritativeUserContext(userId)
    this.#assertEligibleBuyer(userContext)

    for (const item of items) {
      await this.pricing.getOrderItemSnapshot({ userId, ...item })
    }
  }

  #assertCompatibleRequest(order, requestHash) {
    if (order.checkoutRequestHash !== requestHash) {
      throw new ServiceError(
        'La clave de idempotencia ya fue utilizada para otro checkout',
        'CHECKOUT_IDEMPOTENCY_CONFLICT',
        409
      )
    }
  }

  #toCheckoutDto({
    order: orderDocument,
    items,
    payment: paymentDocument,
    isIdempotent = false
  }) {
    const order = toPlainObject(orderDocument)
    const payment = toPlainObject(paymentDocument)

    return {
      order: {
        id: String(order._id),
        orderNumber: order.orderNumber,
        status: order.status,
        reservationExpiresAt: dateToIsoString(order.reservationExpiresAt)
      },
      items: items.map((itemDocument) => {
        const item = toPlainObject(itemDocument)

        return {
          productId: String(item.productId),
          name: item.productSnapshot?.name || '',
          quantity: item.quantity,
          priceType: item.priceType,
          unitPriceUsd: decimalToString(item.unitPriceUsd),
          totalUsd: decimalToString(item.totalUsd)
        }
      }),
      totals: {
        totalUsd: decimalToString(order.totals?.totalUsd),
        totalArs: decimalToString(order.totals?.totalArs)
      },
      exchangeRate: {
        source: order.exchangeRateSnapshot?.source,
        quoteType: order.exchangeRateSnapshot?.quoteType,
        rate: decimalToString(order.exchangeRateSnapshot?.rate),
        sourceDate: order.exchangeRateSnapshot?.sourceDate,
        fetchedAt: dateToIsoString(order.exchangeRateSnapshot?.fetchedAt)
      },
      payment: {
        id: String(payment._id),
        status: payment.normalizedStatus,
        provider: payment.provider
      },
      isIdempotent
    }
  }

  async #loadExistingCheckout(
    { userId, idempotencyKey, requestHash },
    { session, knownOrder = null } = {}
  ) {
    const order =
      knownOrder ||
      (await this.orders.getByUserAndCheckoutIdempotencyKey(userId, idempotencyKey, {
        session
      }))

    if (!order) return null

    this.#assertCompatibleRequest(order, requestHash)

    const [items, payment] = await Promise.all([
      this.orderItems.getByOrderId(order._id, { session }),
      this.payments.getLatestByOrderId(order._id, { session })
    ])

    if (!payment || !items.length) {
      throw new ServiceError(
        'El checkout idempotente no está completo',
        'CHECKOUT_IDEMPOTENCY_CONFLICT',
        409
      )
    }

    return this.#toCheckoutDto({ order, items, payment, isIdempotent: true })
  }

  async createCheckout(input, { now = new Date() } = {}) {
    const normalized = this.#normalizeInput(input)

    log('🛒 CheckoutService → iniciando checkout transaccional')
    secureLog('🛒 CheckoutService inicio', {
      userId: normalized.userId,
      lineCount: normalized.items.length
    })

    const existing = await this.#loadExistingCheckout(normalized)
    if (existing) return existing

    await this.#preflight(normalized)

    // La única llamada externa ocurre antes de abrir la sesión/transacción.
    const exchangeRateQuote = await this.exchangeRates.getUsdArsSellingQuote()
    const reservationCreatedAt = new Date(now)

    if (Number.isNaN(reservationCreatedAt.getTime())) {
      throw new ServiceError('Fecha de checkout inválida', 'CHECKOUT_INVALID_DATE', 400)
    }

    const reservationExpiresAt = new Date(
      reservationCreatedAt.getTime() + RESERVATION_DURATION_MS
    )
    const session = await this.mongoose.startSession()
    let checkoutResult

    try {
      await session.withTransaction(async () => {
        const transactionExisting = await this.#loadExistingCheckout(normalized, { session })

        if (transactionExisting) {
          checkoutResult = transactionExisting
          return
        }

        const userContext = await this.pricing.getAuthoritativeUserContext(normalized.userId, {
          session
        })
        this.#assertEligibleBuyer(userContext)

        const created = await this.orderService.createBaseOrder(
          {
            userId: normalized.userId,
            items: normalized.items,
            reservationExpiresAt,
            exchangeRateQuote,
            checkoutIdempotencyKey: normalized.idempotencyKey,
            checkoutRequestHash: normalized.requestHash
          },
          { session, now: reservationCreatedAt }
        )

        for (const item of created.items) {
          await this.productUnits.reserveAvailableUnits(
            {
              productId: item.productId,
              quantity: item.quantity,
              orderId: created.order._id,
              orderItemId: item._id,
              reservationExpiresAt
            },
            { session }
          )
        }

        const payment = await this.paymentService.createPayment(
          { orderId: created.order._id },
          { session }
        )

        checkoutResult = this.#toCheckoutDto({
          order: created.order,
          items: created.items,
          payment
        })
      }, TRANSACTION_OPTIONS)

      secureLog('✅ CheckoutService checkout confirmado', {
        userId: normalized.userId,
        orderId: checkoutResult.order.id,
        orderNumber: checkoutResult.order.orderNumber,
        paymentId: checkoutResult.payment.id,
        status: checkoutResult.order.status
      })

      return checkoutResult
    } catch (error) {
      const reasonCode = error?.code || 'CHECKOUT_FAILED'
      logError('❌ CheckoutService rollback', { code: reasonCode })

      if (this.#isDuplicateKeyError(error) || reasonCode === 'CHECKOUT_IDEMPOTENCY_CONFLICT') {
        const idempotentResult = await this.#loadExistingCheckout(normalized)
        if (idempotentResult) return idempotentResult
      }

      if (error instanceof ServiceError) throw error

      throw new ServiceError(
        'No se pudo completar el checkout',
        'CHECKOUT_FAILED',
        500,
        { cause: error?.message }
      )
    } finally {
      await session.endSession()
    }
  }
}

export {
  CheckoutService,
  IDEMPOTENCY_KEY_PATTERN,
  RESERVATION_DURATION_MS,
  TRANSACTION_OPTIONS
}
export default new CheckoutService()
