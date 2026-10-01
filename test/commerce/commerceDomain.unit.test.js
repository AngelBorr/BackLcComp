/* eslint-env mocha */
import assert from 'node:assert/strict'
import mongoose from 'mongoose'
import CommerceCounterModel from '../../src/dao/models/commerceCounter.model.js'
import OrderModel from '../../src/dao/models/order.model.js'
import OrderItemModel from '../../src/dao/models/orderItem.model.js'
import PaymentModel from '../../src/dao/models/payment.model.js'
import PaymentEventModel from '../../src/dao/models/paymentEvent.model.js'
import ProductUnitModel from '../../src/dao/models/productUnit.model.js'
import ProductModel from '../../src/dao/models/produtc.model.js'
import { OrderNumberManager } from '../../src/dao/managers/orderNumber.manager.js'
import { OrderManager } from '../../src/dao/managers/order.manager.js'
import { OrderItemManager } from '../../src/dao/managers/orderItem.manager.js'
import { PaymentManager } from '../../src/dao/managers/payment.manager.js'
import { PaymentEventManager } from '../../src/dao/managers/paymentEvent.manager.js'
import { CommercePricingService } from '../../src/services/service.commercePricing.js'
import { OrderService } from '../../src/services/order.service.js'
import { PaymentService } from '../../src/services/payment.service.js'
import { calculateUsdLineAmounts } from '../../src/utils/commerceMoney.js'

const userId = new mongoose.Types.ObjectId().toString()
const otherUserId = new mongoose.Types.ObjectId().toString()
const orderId = new mongoose.Types.ObjectId().toString()
const orderItemId = new mongoose.Types.ObjectId().toString()
const productId = new mongoose.Types.ObjectId().toString()
const paymentId = new mongoose.Types.ObjectId().toString()

const externalSession = {
  hasEnded: false,
  inTransaction: () => true
}

const queryResult = (value) => ({
  session() {
    return this
  },
  lean: async () => value
})

describe('Commerce domain foundation (isolated unit tests)', () => {
  const restorations = []

  const stub = (target, property, replacement) => {
    const original = target[property]
    restorations.push(() => {
      target[property] = original
    })
    target[property] = replacement
  }

  afterEach(() => {
    while (restorations.length) restorations.pop()()
  })

  it('calculates USD amounts through integer cents', () => {
    assert.deepEqual(
      calculateUsdLineAmounts({ unitPriceUsd: 121, vatRate: 0.21, quantity: 2 }),
      {
        unitPriceUsd: '121.00',
        netUnitPriceUsd: '100.00',
        vatAmountPerUnitUsd: '21.00',
        lineNetUsd: '200.00',
        lineVatUsd: '42.00',
        totalUsd: '242.00',
        totalUsdCents: 24200
      }
    )
  })

  it('declares the required unique commerce indexes', () => {
    const orderIndexes = OrderModel.schema.indexes()
    const paymentIndexes = PaymentModel.schema.indexes()
    const eventIndexes = PaymentEventModel.schema.indexes()

    assert.ok(
      orderIndexes.some(
        ([fields, options]) => fields.orderNumber === 1 && options.unique === true
      )
    )
    assert.ok(
      orderIndexes.some(
        ([fields, options]) =>
          fields.userId === 1 &&
          fields.checkoutIdempotencyKey === 1 &&
          options.unique === true &&
          options.partialFilterExpression?.checkoutIdempotencyKey?.$type === 'string'
      )
    )
    assert.ok(
      paymentIndexes.some(
        ([fields, options]) =>
          fields.provider === 1 && fields.providerPaymentId === 1 && options.unique === true
      )
    )
    assert.ok(
      eventIndexes.some(
        ([fields, options]) =>
          fields.provider === 1 && fields.providerEventId === 1 && options.unique === true
      )
    )
  })

  it('validates the minimum Order, Payment and PaymentEvent persistence shapes', async () => {
    const order = new OrderModel({
      orderNumber: 'LC-2026-000010',
      userId,
      buyerSnapshot: {
        firstName: 'Ada',
        lastName: 'Lovelace',
        email: 'ada@example.com',
        role: 'USER'
      },
      totals: { totalUsd: '121.00', totalArs: null }
    })
    const payment = new PaymentModel({
      orderId,
      externalReference: 'LC-2026-000010',
      amountArs: '150000.00'
    })
    const event = new PaymentEventModel({
      provider: 'mercado_pago',
      providerEventId: 'event-shape-1'
    })

    await order.validate()
    await payment.validate()
    await event.validate()

    assert.equal(order.status, 'pending_payment')
    assert.equal(payment.normalizedStatus, 'pending')
    assert.equal(event.processingStatus, 'received')
  })

  it('persists the reproducible BNA exchange-rate snapshot precision', async () => {
    const order = new OrderModel({
      orderNumber: 'LC-2026-000011',
      userId,
      buyerSnapshot: {
        firstName: 'Ada',
        lastName: 'Lovelace',
        email: 'ada@example.com',
        role: 'USER'
      },
      totals: { totalUsd: '100.00', totalArs: '154512.50' },
      exchangeRateSnapshot: {
        source: 'BNA',
        quoteType: 'billete_venta',
        baseCurrency: 'USD',
        quoteCurrency: 'ARS',
        rate: '1545.1250',
        sourceDate: '2026-09-28',
        sourceUpdatedTime: '17:01',
        sourceEffectiveAt: '2026-09-28T20:01:00.000Z',
        fetchedAt: '2026-09-28T20:15:00.000Z',
        sourceUrl: 'https://www.bna.com.ar/Personas'
      }
    })

    await order.validate()

    assert.equal(order.exchangeRateSnapshot.rate.toString(), '1545.1250')
    assert.equal(order.exchangeRateSnapshot.quoteType, 'billete_venta')
    assert.equal(OrderModel.schema.path('exchangeRateSnapshot').options.immutable, true)
  })

  it('generates a readable order number using one atomic counter increment and session', async () => {
    const manager = new OrderNumberManager()
    let captured

    stub(CommerceCounterModel, 'findOneAndUpdate', (filter, update, options) => {
      captured = { filter, update, options }
      return queryResult({ _id: 'order:2026', sequence: 42 })
    })

    const orderNumber = await manager.nextOrderNumber({
      at: new Date('2026-09-28T12:00:00.000Z'),
      session: externalSession
    })

    assert.equal(orderNumber, 'LC-2026-000042')
    assert.deepEqual(captured.filter, { _id: 'order:2026' })
    assert.deepEqual(captured.update, { $inc: { sequence: 1 } })
    assert.equal(captured.options.upsert, true)
    assert.equal(captured.options.session, externalSession)
  })

  it('creates Order and OrderItems from authoritative snapshots in the same session', async () => {
    const sourceProduct = {
      name: 'Notebook LC',
      brand: 'LC',
      category: 'Notebooks'
    }
    let createdOrderData
    let createdItemsData
    const sessions = []
    let pricingRequest

    const orderManager = {
      async create(data, options) {
        createdOrderData = data
        sessions.push(options.session)
        return { _id: orderId, ...data }
      }
    }
    const orderItemManager = {
      async createMany(data, options) {
        createdItemsData = data
        sessions.push(options.session)
        return data.map((item) => ({ _id: orderItemId, ...item }))
      }
    }
    const orderNumberManager = {
      async nextOrderNumber(options) {
        sessions.push(options.session)
        return 'LC-2026-000001'
      }
    }
    const commercePricingService = {
      async getOrderItemSnapshot(request, options) {
        pricingRequest = request
        sessions.push(options.session)
        return {
          user: {
            _id: userId,
            firstName: 'Ada',
            lastName: 'Lovelace',
            email: 'ada@example.com',
            role: 'USER'
          },
          item: {
            productId,
            productSnapshot: { ...sourceProduct },
            quantity: request.quantity,
            priceType: 'retail',
            unitPriceUsd: 121,
            vatRate: 0.21,
            currency: 'USD'
          }
        }
      }
    }
    const service = new OrderService({
      orderManager,
      orderItemManager,
      orderNumberManager,
      commercePricingService
    })

    const result = await service.createBaseOrder(
      {
        userId,
        items: [{ productId, quantity: 2, unitPriceUsd: 0.01, vatRate: 0 }]
      },
      { session: externalSession, now: new Date('2026-09-28T12:00:00.000Z') }
    )

    sourceProduct.name = 'Nombre modificado posteriormente'

    assert.deepEqual(pricingRequest, { userId, productId, quantity: 2 })
    assert.equal(createdOrderData.buyerSnapshot.role, 'USER')
    assert.equal(createdOrderData.totals.totalUsd, '242.00')
    assert.equal(createdItemsData[0].unitPriceUsd, '121.00')
    assert.equal(createdItemsData[0].vatRate, '0.21')
    assert.equal(createdItemsData[0].productSnapshot.name, 'Notebook LC')
    assert.equal(result.items[0].orderId, orderId)
    assert.ok(sessions.every((session) => session === externalSession))
  })

  it('maps a concurrent checkout idempotency index collision to a semantic error', async () => {
    const duplicateError = new Error('duplicate key internals')
    duplicateError.code = 11000
    duplicateError.keyPattern = { userId: 1, checkoutIdempotencyKey: 1 }
    const service = new OrderService({
      commercePricingService: {
        async getOrderItemSnapshot(request) {
          return {
            user: {
              _id: request.userId,
              firstName: 'Ada',
              lastName: 'Lovelace',
              email: 'ada@example.com',
              role: 'USER'
            },
            item: {
              productId: request.productId,
              productSnapshot: { name: 'Notebook' },
              quantity: request.quantity,
              priceType: 'retail',
              unitPriceUsd: '10.00',
              vatRate: 0.21,
              currency: 'USD'
            }
          }
        }
      },
      orderNumberManager: {
        async nextOrderNumber() {
          return 'LC-2026-000001'
        }
      },
      orderManager: {
        async create() {
          throw duplicateError
        }
      }
    })

    await assert.rejects(
      service.createBaseOrder(
        {
          userId,
          items: [{ productId, quantity: 1 }],
          checkoutIdempotencyKey: 'concurrent-key',
          checkoutRequestHash: 'a'.repeat(64)
        },
        { session: externalSession }
      ),
      (error) =>
        error.code === 'CHECKOUT_IDEMPOTENCY_CONFLICT' &&
        !error.message.includes('duplicate key internals')
    )
  })

  it('keeps OrderItem snapshot data independent from Product changes', async () => {
    const item = new OrderItemModel({
      orderId,
      productId,
      productSnapshot: {
        name: 'Producto histórico',
        brand: 'Marca original',
        category: 'Categoría original'
      },
      quantity: 1,
      priceType: 'wholesale',
      currency: 'USD',
      vatRate: '0.105',
      unitPriceUsd: '110.50',
      netUnitPriceUsd: '100.00',
      vatAmountPerUnitUsd: '10.50',
      lineNetUsd: '100.00',
      lineVatUsd: '10.50',
      totalUsd: '110.50'
    })

    await item.validate()
    const snapshot = item.toObject().productSnapshot

    assert.equal(snapshot.name, 'Producto histórico')
    assert.equal(snapshot.brand, 'Marca original')
  })

  it('rejects an invalid OrderItem quantity at model level', async () => {
    const item = new OrderItemModel({
      orderId,
      productId,
      productSnapshot: { name: 'Producto' },
      quantity: 0,
      priceType: 'retail',
      vatRate: '0.21',
      unitPriceUsd: '121.00',
      netUnitPriceUsd: '100.00',
      vatAmountPerUnitUsd: '21.00',
      lineNetUsd: '100.00',
      lineVatUsd: '21.00',
      totalUsd: '121.00'
    })

    await assert.rejects(item.validate(), /less than minimum allowed value/)
  })

  it('builds an OrderItem snapshot from authoritative Product pricing and IVA', async () => {
    const pricing = new CommercePricingService()

    stub(pricing, 'getProductPurchaseContext', async () => ({
      user: { _id: userId, role: 'PREMIUM' },
      product: {
        _id: productId,
        prodName: 'Servidor LC',
        prodMarca: 'LC',
        prodCategoria: 'Servidores',
        prodStock: 5
      },
      pricing: {
        priceType: 'wholesale',
        unitPrice: 999.99,
        vatRate: 0.105,
        currency: 'USD'
      }
    }))

    const snapshot = await pricing.getOrderItemSnapshot({ userId, productId, quantity: 2 })

    assert.equal(snapshot.item.priceType, 'wholesale')
    assert.equal(snapshot.item.unitPriceUsd, 999.99)
    assert.equal(snapshot.item.vatRate, 0.105)
    assert.deepEqual(snapshot.item.productSnapshot, {
      name: 'Servidor LC',
      brand: 'LC',
      category: 'Servidores'
    })
  })

  it('keeps final USER and PREMIUM prices without adding IVA again', async () => {
    const pricing = new CommercePricingService()
    const product = {
      _id: productId,
      prodName: 'Notebook LC',
      prodMarca: 'LC',
      prodCategoria: 'Notebooks',
      prodStock: 5,
      prodIva: 0.21,
      prodPrecioMinorista: 133.10,
      prodPrecioMayorista: 121.00,
      inventoryMode: 'serialized',
      isActive: true
    }

    stub(pricing.users, 'getUserById', async (requestedUserId) => ({
      _id: requestedUserId,
      role: String(requestedUserId) === userId ? 'USER' : 'PREMIUM'
    }))
    stub(ProductModel, 'findById', () => queryResult(product))

    const userSnapshot = await pricing.getOrderItemSnapshot({
      userId,
      productId,
      quantity: 1
    })
    const premiumSnapshot = await pricing.getOrderItemSnapshot({
      userId: otherUserId,
      productId,
      quantity: 1
    })

    assert.equal(userSnapshot.item.priceType, 'retail')
    assert.equal(userSnapshot.item.unitPriceUsd, 133.10)
    assert.equal(premiumSnapshot.item.priceType, 'wholesale')
    assert.equal(premiumSnapshot.item.unitPriceUsd, 121.00)
  })

  it('rejects an OrderItem quantity greater than authoritative stock', async () => {
    const pricing = new CommercePricingService()

    stub(pricing, 'getProductPurchaseContext', async () => ({
      user: { _id: userId, role: 'USER' },
      product: { _id: productId, prodStock: 1 },
      pricing: { priceType: 'retail', unitPrice: 10, vatRate: 0.21, currency: 'USD' }
    }))

    await assert.rejects(
      pricing.getOrderItemSnapshot({ userId, productId, quantity: 2 }),
      (error) => error.code === 'INSUFFICIENT_SERIALIZED_STOCK'
    )
  })

  it('allows a valid Order transition with compare-and-set', async () => {
    let updateArguments
    const orderManager = {
      async getById() {
        return { _id: orderId, status: 'pending_payment' }
      },
      async updateStatus(...args) {
        updateArguments = args
        return { _id: orderId, status: 'paid' }
      }
    }
    const service = new OrderService({ orderManager })

    const updated = await service.transitionOrderStatus(
      { orderId, nextStatus: 'paid' },
      { session: externalSession, now: new Date('2026-09-28T13:00:00.000Z') }
    )

    assert.equal(updated.status, 'paid')
    assert.equal(updateArguments[1], 'pending_payment')
    assert.equal(updateArguments[2].nextStatus, 'paid')
    assert.equal(updateArguments[3].session, externalSession)
  })

  it('blocks a degrading Order transition', async () => {
    let updated = false
    const orderManager = {
      async getById() {
        return { _id: orderId, status: 'paid' }
      },
      async updateStatus() {
        updated = true
      }
    }
    const service = new OrderService({ orderManager })

    await assert.rejects(
      service.transitionOrderStatus({ orderId, nextStatus: 'pending_payment' }),
      (error) => error.code === 'INVALID_ORDER_STATUS_TRANSITION'
    )
    assert.equal(updated, false)
  })

  it('enforces Order ownership separately from administrative lookup', async () => {
    const orderManager = {
      async getById() {
        return { _id: orderId, userId, status: 'pending_payment' }
      }
    }
    const orderItemManager = {
      async getByOrderId() {
        return []
      }
    }
    const service = new OrderService({ orderManager, orderItemManager })

    await assert.rejects(
      service.getOrderForUser(orderId, otherUserId),
      (error) => error.code === 'ORDER_ACCESS_DENIED'
    )
  })

  it('propagates session through Order and OrderItem manager writes', async () => {
    const orders = new OrderManager()
    const items = new OrderItemManager()
    const calls = []

    stub(OrderModel.prototype, 'save', async function (options) {
      calls.push({ operation: 'createOrder', session: options.session })
      return this
    })
    stub(OrderModel, 'findOneAndUpdate', (filter, update, options) => {
      calls.push({ operation: 'updateOrder', session: options.session, filter })
      return queryResult({ _id: orderId, status: 'cancelled' })
    })
    stub(OrderItemModel, 'insertMany', async (data, options) => {
      calls.push({ operation: 'createItems', session: options.session })
      return data
    })

    await orders.create(
      {
        orderNumber: 'LC-2026-000099',
        userId,
        buyerSnapshot: {
          firstName: 'Ada',
          lastName: 'Lovelace',
          email: 'ada@example.com',
          role: 'USER'
        },
        totals: { totalUsd: '10.00' }
      },
      { session: externalSession }
    )
    await items.createMany([], { session: externalSession })
    await orders.updateStatus(
      orderId,
      'pending_payment',
      { nextStatus: 'cancelled', changedAt: new Date(), reason: 'test' },
      { session: externalSession }
    )

    assert.equal(calls.length, 3)
    assert.ok(calls.every((call) => call.session === externalSession))
  })

  it('creates a pending Payment using the backend Order reference', async () => {
    let paymentData
    let paymentSession
    const paymentManager = {
      async create(data, options) {
        paymentData = data
        paymentSession = options.session
        return { _id: paymentId, ...data }
      }
    }
    const orderManager = {
      async getById() {
        return {
          _id: orderId,
          orderNumber: 'LC-2026-000001',
          status: 'pending_payment',
          totals: { totalArs: '1234.56' },
          exchangeRateSnapshot: { source: 'BNA' }
        }
      }
    }
    const service = new PaymentService({ orderManager, paymentManager })

    const payment = await service.createPayment({ orderId }, { session: externalSession })

    assert.equal(payment.normalizedStatus, 'pending')
    assert.equal(paymentData.externalReference, 'LC-2026-000001')
    assert.equal(paymentData.amountArs, '1234.56')
    assert.equal(paymentSession, externalSession)
  })

  it('rejects an amountArs supplied by a Payment caller', async () => {
    let orderRead = false
    const service = new PaymentService({
      orderManager: {
        async getById() {
          orderRead = true
        }
      }
    })

    await assert.rejects(
      service.createPayment({ orderId, amountArs: '0.01' }),
      (error) => error.code === 'PAYMENT_AMOUNT_NOT_ALLOWED'
    )
    assert.equal(orderRead, false)
  })

  it('rejects Payment creation when Order has no authoritative ARS total', async () => {
    const service = new PaymentService({
      orderManager: {
        async getById() {
          return {
            _id: orderId,
            orderNumber: 'LC-2026-000001',
            status: 'pending_payment',
            totals: { totalArs: null },
            exchangeRateSnapshot: null
          }
        }
      }
    })

    await assert.rejects(
      service.createPayment({ orderId }),
      (error) => error.code === 'ORDER_ARS_TOTAL_REQUIRED'
    )
  })

  it('propagates session through Payment and PaymentEvent manager writes', async () => {
    const payments = new PaymentManager()
    const events = new PaymentEventManager()
    const sessions = []

    stub(PaymentModel.prototype, 'save', async function (options) {
      sessions.push(options.session)
      return this
    })
    stub(PaymentEventModel.prototype, 'save', async function (options) {
      sessions.push(options.session)
      return this
    })

    await payments.create(
      {
        orderId,
        externalReference: 'LC-2026-000001',
        amountArs: '1000.00'
      },
      { session: externalSession }
    )
    await events.create(
      {
        provider: 'mercado_pago',
        providerEventId: 'event-session-test'
      },
      { session: externalSession }
    )

    assert.deepEqual(sessions, [externalSession, externalSession])
  })

  it('allows a valid Payment transition with compare-and-set', async () => {
    let updateArguments
    const paymentManager = {
      async getById() {
        return { _id: paymentId, normalizedStatus: 'pending', approvedAt: null }
      },
      async updateStatus(...args) {
        updateArguments = args
        return { _id: paymentId, normalizedStatus: 'approved' }
      }
    }
    const service = new PaymentService({ paymentManager })

    const updated = await service.transitionPaymentStatus(
      {
        paymentId,
        nextStatus: 'approved',
        providerStatus: 'approved',
        providerPaymentId: 'mp-123',
        checkedAt: new Date('2026-09-28T14:00:00.000Z')
      },
      { session: externalSession }
    )

    assert.equal(updated.normalizedStatus, 'approved')
    assert.equal(updateArguments[1], 'pending')
    assert.equal(updateArguments[2].providerPaymentId, 'mp-123')
    assert.equal(updateArguments[3].session, externalSession)
  })

  it('blocks a degrading Payment transition', async () => {
    let updated = false
    const paymentManager = {
      async getById() {
        return { _id: paymentId, normalizedStatus: 'approved' }
      },
      async updateStatus() {
        updated = true
      }
    }
    const service = new PaymentService({ paymentManager })

    await assert.rejects(
      service.transitionPaymentStatus({ paymentId, nextStatus: 'pending' }),
      (error) => error.code === 'INVALID_PAYMENT_STATUS_TRANSITION'
    )
    assert.equal(updated, false)
  })

  it('maps a duplicate provider event to an idempotency domain error', async () => {
    const duplicateError = new Error('duplicate key internals')
    duplicateError.code = 11000
    const paymentEventManager = {
      async create() {
        throw duplicateError
      }
    }
    const service = new PaymentService({ paymentEventManager })

    await assert.rejects(
      service.recordPaymentEvent(
        { providerEventId: 'event-123', providerPaymentId: 'payment-123', orderId },
        { session: externalSession }
      ),
      (error) =>
        error.code === 'PAYMENT_EVENT_DUPLICATE' &&
        !error.message.includes('duplicate key internals')
    )
  })

  it('keeps ProductUnit order references compatible without opening sold', () => {
    assert.equal(ProductUnitModel.schema.path('orderId').options.ref, 'orders')
    assert.equal(ProductUnitModel.schema.path('orderItemId').options.ref, 'order_items')
    assert.equal(ProductUnitModel.schema.path('soldAt').options.default, null)
  })
})
