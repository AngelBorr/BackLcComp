import assert from 'node:assert/strict'
import express from 'express'
import request from 'supertest'
import OrderModel from '../../src/dao/models/order.model.js'
import { OrderManager } from '../../src/dao/managers/order.manager.js'
import { OrderQueryService } from '../../src/services/orderQuery.service.js'
import { OrderFulfillmentService } from '../../src/services/orderFulfillment.service.js'
import { OrderService } from '../../src/services/order.service.js'
import { OrderFulfillmentController } from '../../src/controllers/orderFulfillment.controller.js'
import { mapServiceErrorToHttp } from '../../src/middlewares/serviceErrorMapper.js'
import { registerOrderQueryRoutes } from '../../src/routes/orders.router.js'
import { registerAdminOrderRoutes } from '../../src/routes/adminOrders.router.js'

const userId = '507f1f77bcf86cd799439011'
const otherUserId = '507f1f77bcf86cd799439099'
const adminUserId = '507f1f77bcf86cd799439088'
const orderId = '507f1f77bcf86cd799439012'
const itemId = '507f1f77bcf86cd799439013'
const productId = '507f1f77bcf86cd799439014'
const orderNumber = 'LC-2026-000002'
const createdAt = new Date('2026-09-29T12:00:00.000Z')
const approvedAt = new Date('2026-09-29T12:05:00.000Z')

const makeOrder = (overrides = {}) => ({
  _id: orderId,
  orderNumber,
  userId,
  buyerSnapshot: {
    firstName: 'Ada',
    lastName: 'Lovelace',
    email: 'ada@example.com',
    role: 'USER'
  },
  status: 'paid',
  fulfillmentStatus: 'preparing',
  fulfillmentHistory: [],
  statusHistory: [],
  totals: { totalUsd: '100.00', totalArs: '150000.00' },
  exchangeRateSnapshot: {
    source: 'BNA',
    quoteType: 'billete_venta',
    baseCurrency: 'USD',
    quoteCurrency: 'ARS',
    rate: '1500.00',
    sourceDate: '2026-09-29',
    sourceUpdatedTime: '11:00',
    sourceEffectiveAt: createdAt,
    fetchedAt: createdAt,
    sourceUrl: 'https://internal.example/rate'
  },
  createdAt,
  updatedAt: approvedAt,
  paidAt: approvedAt,
  checkoutIdempotencyKey: 'local-key-secret',
  checkoutRequestHash: 'hash-secret',
  ...overrides
})

const item = {
  _id: itemId,
  orderId,
  productId,
  productSnapshot: { name: 'Notebook LC' },
  quantity: 1,
  priceType: 'retail',
  unitPriceUsd: '100.00',
  vatRate: '0.21',
  lineNetUsd: '82.64',
  lineVatUsd: '17.36',
  totalUsd: '100.00'
}

const payment = {
  _id: '507f1f77bcf86cd799439015',
  orderId,
  provider: 'mercado_pago',
  normalizedStatus: 'approved',
  providerStatus: 'processed',
  providerStatusDetail: 'accredited',
  providerOrderId: 'ORD-ALLOWED-ADMIN',
  providerPaymentId: 'PAY-ALLOWED-ADMIN',
  providerIdempotencyKey: 'provider-key-secret',
  providerRequestSnapshot: { payer: { email: 'private@example.com' } },
  providerCheckoutUrl: 'https://checkout.example/secret',
  approvedAt,
  lastProviderCheckAt: approvedAt
}

const soldUnit = {
  _id: '507f1f77bcf86cd799439016',
  orderId,
  orderItemId: itemId,
  productId,
  serialNumber: 'SERIAL-SOLD-001',
  status: 'sold',
  isDeleted: false,
  reservedAt: new Date('2026-09-29T12:01:00.000Z'),
  reservationExpiresAt: new Date('2026-09-29T18:00:00.000Z'),
  soldAt: approvedAt
}

const makeQueryHarness = ({ order = makeOrder(), units = [soldUnit] } = {}) => {
  const state = { customerListCalls: [], adminListCalls: [], unitCalls: [] }
  const service = new OrderQueryService({
    orderManager: {
      async listCustomerPage(filters) {
        state.customerListCalls.push(filters)
        return { orders: filters.userId === userId ? [order] : [], total: 1 }
      },
      async getByOrderNumberAndUserId(receivedOrderNumber, receivedUserId) {
        return receivedOrderNumber === orderNumber && receivedUserId === userId ? order : null
      },
      async listAdminPage(filters) {
        state.adminListCalls.push(filters)
        return {
          orders: [{ ...order, _itemsCount: 1, _payment: payment }],
          total: 1
        }
      },
      async getByOrderNumber(receivedOrderNumber) {
        return receivedOrderNumber === orderNumber ? order : null
      }
    },
    orderItemManager: {
      async getByOrderId() { return [item] }
    },
    paymentManager: {
      async getLatestByOrderId() { return payment }
    },
    productUnitManager: {
      async getAssignedByOrderId(receivedOrderId, options = {}) {
        state.unitCalls.push({ receivedOrderId, options })
        return options.statuses
          ? units.filter((unit) => options.statuses.includes(unit.status))
          : units
      }
    }
  })
  return { service, state }
}

describe('Order fulfillment initialization (isolated)', () => {
  it('declares the fulfillment state, audit actor and operational timestamps in Order', () => {
    assert.deepEqual(OrderModel.schema.path('fulfillmentStatus').enumValues, [
      'pending',
      'preparing',
      'ready_for_pickup',
      'picked_up',
      'cancelled'
    ])
    assert.equal(
      OrderModel.schema.path('fulfillmentHistory').schema.path('changedBy').options.ref,
      'users'
    )
    assert.equal(OrderModel.schema.path('readyForPickupAt').instance, 'Date')
    assert.equal(OrderModel.schema.path('pickedUpAt').instance, 'Date')
  })

  it('creates new Orders with pending fulfillment and an auditable initial event', async () => {
    const now = new Date('2026-09-29T12:00:00.000Z')
    const session = { hasEnded: false, inTransaction: () => true }
    let createdOrder
    const service = new OrderService({
      orderManager: {
        async create(data) {
          createdOrder = data
          return { _id: orderId, ...data }
        }
      },
      orderItemManager: {
        async createMany(items) { return items }
      },
      orderNumberManager: {
        async nextOrderNumber() { return orderNumber }
      },
      commercePricingService: {
        async getOrderItemSnapshot() {
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
              productSnapshot: { name: 'Notebook LC' },
              quantity: 1,
              priceType: 'retail',
              unitPriceUsd: '100.00',
              vatRate: '0.21'
            }
          }
        }
      }
    })

    await service.createBaseOrder(
      { userId, items: [{ productId, quantity: 1 }] },
      { session, now }
    )

    assert.equal(createdOrder.fulfillmentStatus, 'pending')
    assert.deepEqual(createdOrder.fulfillmentHistory, [{
      status: 'pending',
      changedAt: now,
      changedBy: null,
      reason: 'order_created'
    }])
  })
})

describe('Order customer queries (isolated)', () => {
  it('uses only authenticated user identity and forwards pagination/filters', async () => {
    const { service, state } = makeQueryHarness()
    const result = await service.listCustomerOrders({
      userId,
      filters: { page: '2', limit: '5', status: 'paid', fulfillmentStatus: 'preparing' }
    })

    assert.deepEqual(state.customerListCalls, [{
      userId,
      page: 2,
      limit: 5,
      status: 'paid',
      fulfillmentStatus: 'preparing'
    }])
    assert.deepEqual(result.pagination, { page: 2, limit: 5, total: 1, totalPages: 1 })
  })

  it('returns 404 for an Order owned by another user without reading its relations', async () => {
    const { service, state } = makeQueryHarness()
    await assert.rejects(
      service.getCustomerOrder({ orderNumber, userId: otherUserId }),
      (error) => error.code === 'ORDER_NOT_FOUND' && error.status === 404
    )
    assert.equal(state.unitCalls.length, 0)
  })

  it('shows only sold serials and never leaks provider technical fields', async () => {
    const reservedUnit = { ...soldUnit, serialNumber: 'SERIAL-RESERVED', status: 'reserved' }
    const { service, state } = makeQueryHarness({ units: [soldUnit, reservedUnit] })
    const result = await service.getCustomerOrder({ orderNumber, userId })

    assert.deepEqual(result.items[0].serialNumbers, ['SERIAL-SOLD-001'])
    assert.deepEqual(state.unitCalls[0].options, { statuses: ['sold'] })
    assert.deepEqual(result.payment, {
      provider: 'mercado_pago',
      status: 'approved',
      approvedAt: approvedAt.toISOString()
    })

    const serialized = JSON.stringify(result)
    for (const forbidden of [
      'provider-key-secret',
      'private@example.com',
      'checkout.example',
      'local-key-secret',
      'hash-secret',
      'ORD-ALLOWED-ADMIN',
      'PAY-ALLOWED-ADMIN'
    ]) assert.equal(serialized.includes(forbidden), false)
  })

  for (const [orderStatus, expected] of [
    ['paid', 'preparing'],
    ['pending_payment', 'pending'],
    ['cancelled', 'cancelled'],
    ['expired', 'cancelled']
  ]) {
    it(`normalizes historical ${orderStatus} Orders as ${expected}`, async () => {
      const { service } = makeQueryHarness({
        order: makeOrder({ status: orderStatus, fulfillmentStatus: undefined })
      })
      const result = await service.getCustomerOrder({ orderNumber, userId })
      assert.equal(result.fulfillmentStatus, expected)
    })
  }
})

describe('Order administration queries and routes (isolated)', () => {
  it('registers customer and ADMIN routes with the expected policies', () => {
    const customerRoutes = []
    const adminRoutes = []
    registerOrderQueryRoutes({
      get(path, policies, handler) { customerRoutes.push({ method: 'get', path, policies, handler }) }
    }, { listCustomer() {}, getCustomer() {} })
    registerAdminOrderRoutes({
      get(path, policies, handler) { adminRoutes.push({ method: 'get', path, policies, handler }) },
      patch(path, policies, handler) { adminRoutes.push({ method: 'patch', path, policies, handler }) }
    }, {
      queryController: { listAdmin() {}, getAdmin() {} },
      fulfillmentController: { update() {} }
    })

    assert.deepEqual(customerRoutes.map(({ method, path, policies }) => ({ method, path, policies })), [
      { method: 'get', path: '/', policies: ['USER', 'PREMIUM'] },
      { method: 'get', path: '/:orderNumber', policies: ['USER', 'PREMIUM'] }
    ])
    assert.deepEqual(adminRoutes.map(({ method, path, policies }) => ({ method, path, policies })), [
      { method: 'get', path: '/', policies: ['ADMIN'] },
      { method: 'get', path: '/:orderNumber', policies: ['ADMIN'] },
      { method: 'patch', path: '/:orderNumber/fulfillment', policies: ['ADMIN'] }
    ])
  })

  for (const search of [orderNumber, 'ada@example.com', 'SERIAL-SOLD-001']) {
    it(`forwards admin search ${search} without loading all Orders`, async () => {
      const { service, state } = makeQueryHarness()
      await service.listAdminOrders({ filters: { search, page: '1', limit: '10' } })
      assert.equal(state.adminListCalls[0].search, search)
      assert.equal(state.adminListCalls[0].limit, 10)
    })
  }

  it('forwards all supported admin filters with parsed date boundaries', async () => {
    const { service, state } = makeQueryHarness()
    await service.listAdminOrders({ filters: {
      status: 'paid',
      paymentStatus: 'approved',
      fulfillmentStatus: 'preparing',
      dateFrom: '2026-09-01',
      dateTo: '2026-09-30'
    } })
    const filters = state.adminListCalls[0]
    assert.equal(filters.status, 'paid')
    assert.equal(filters.paymentStatus, 'approved')
    assert.equal(filters.fulfillmentStatus, 'preparing')
    assert.equal(filters.createdFrom.toISOString(), '2026-09-01T00:00:00.000Z')
    assert.equal(filters.createdTo.toISOString(), '2026-09-30T23:59:59.999Z')
  })

  it('builds database-side search for order, buyer, email and serial', async () => {
    let pipeline
    const originalAggregate = OrderModel.aggregate
    OrderModel.aggregate = (receivedPipeline) => {
      pipeline = receivedPipeline
      return Promise.resolve([{ rows: [], metadata: [] }])
    }

    try {
      await new OrderManager().listAdminPage({
        page: 1,
        limit: 20,
        search: 'needle',
        status: 'paid',
        paymentStatus: 'approved',
        fulfillmentStatus: 'preparing'
      })
    } finally {
      OrderModel.aggregate = originalAggregate
    }

    const serializedPipeline = JSON.stringify(pipeline)
    for (const field of [
      'orderNumber',
      'buyerSnapshot.firstName',
      'buyerSnapshot.lastName',
      'buyerSnapshot.email',
      '_units.serialNumber',
      '_payment.normalizedStatus'
    ]) assert.equal(serializedPipeline.includes(field), true)
    assert.equal(serializedPipeline.includes('$facet'), true)
  })

  it('returns complete safe admin detail and a chronological timeline', async () => {
    const order = makeOrder({
      statusHistory: [{ status: 'paid', changedAt: approvedAt, reason: '' }],
      fulfillmentHistory: [{
        status: 'preparing', changedAt: approvedAt, changedBy: null, reason: 'payment_approved'
      }]
    })
    const { service } = makeQueryHarness({ order })
    const result = await service.getAdminOrder({ orderNumber })

    assert.equal(result.order.fulfillmentStatus, 'preparing')
    assert.equal(result.items[0].productUnits[0].serialNumber, 'SERIAL-SOLD-001')
    assert.equal(result.payment.providerOrderId, 'ORD-ALLOWED-ADMIN')
    assert.equal(result.financial.exchangeRateSnapshot.source, 'BNA')
    assert.deepEqual(
      result.timeline.map((event) => event.at),
      [...result.timeline.map((event) => event.at)].sort()
    )

    const serialized = JSON.stringify(result)
    for (const forbidden of ['provider-key-secret', 'private@example.com', 'checkout.example']) {
      assert.equal(serialized.includes(forbidden), false)
    }
  })
})

const makeFulfillmentHarness = ({ initialStatus = 'preparing', updateResults } = {}) => {
  const state = {
    order: makeOrder({ fulfillmentStatus: initialStatus, fulfillmentHistory: [] }),
    updates: []
  }
  const service = new OrderFulfillmentService({
    orderManager: {
      async getByOrderNumber() { return { ...state.order } },
      async updateFulfillmentStatus(id, expectedStatus, update) {
        state.updates.push({ id, expectedStatus, update })
        if (updateResults && state.updates.length > updateResults.length) return null
        if (state.order.fulfillmentStatus !== expectedStatus) return null
        state.order = {
          ...state.order,
          fulfillmentStatus: update.nextStatus,
          ...(update.nextStatus === 'ready_for_pickup' && { readyForPickupAt: update.changedAt }),
          ...(update.nextStatus === 'picked_up' && { pickedUpAt: update.changedAt }),
          fulfillmentHistory: [...state.order.fulfillmentHistory, update]
        }
        return { ...state.order }
      }
    }
  })
  return { service, state }
}

describe('Order fulfillment workflow (isolated)', () => {
  it('moves preparing to ready_for_pickup and records actor/time', async () => {
    const now = new Date('2026-09-30T10:00:00.000Z')
    const { service, state } = makeFulfillmentHarness()
    const result = await service.updateByAdmin(
      { orderNumber, status: 'ready_for_pickup', adminUserId },
      { now }
    )
    assert.equal(result.fulfillmentStatus, 'ready_for_pickup')
    assert.deepEqual(state.updates[0].update, {
      nextStatus: 'ready_for_pickup',
      changedAt: now,
      changedBy: adminUserId,
      reason: 'admin_update'
    })
  })

  it('moves ready_for_pickup to picked_up', async () => {
    const { service } = makeFulfillmentHarness({ initialStatus: 'ready_for_pickup' })
    const result = await service.updateByAdmin({
      orderNumber,
      status: 'picked_up',
      adminUserId
    })
    assert.equal(result.fulfillmentStatus, 'picked_up')
  })

  for (const [initialStatus, targetStatus] of [
    ['pending', 'ready_for_pickup'],
    ['preparing', 'picked_up'],
    ['picked_up', 'ready_for_pickup']
  ]) {
    it(`rejects invalid ${initialStatus} to ${targetStatus} jumps`, async () => {
      const { service, state } = makeFulfillmentHarness({ initialStatus })
      await assert.rejects(
        service.updateByAdmin({ orderNumber, status: targetStatus, adminUserId }),
        (error) => error.code === 'INVALID_FULFILLMENT_TRANSITION'
      )
      assert.equal(state.updates.length, 0)
    })
  }

  it('does not let ADMIN manually produce preparing or alter Payment/ProductUnit', async () => {
    const { service, state } = makeFulfillmentHarness({ initialStatus: 'pending' })
    await assert.rejects(
      service.updateByAdmin({ orderNumber, status: 'preparing', adminUserId }),
      (error) => error.code === 'INVALID_ADMIN_FULFILLMENT_STATUS'
    )
    assert.equal(state.updates.length, 0)
    assert.equal(service.payments, undefined)
    assert.equal(service.productUnits, undefined)
  })

  it('is idempotent for the exact current state without duplicating history', async () => {
    const { service, state } = makeFulfillmentHarness({ initialStatus: 'ready_for_pickup' })
    const result = await service.updateByAdmin({
      orderNumber,
      status: 'ready_for_pickup',
      adminUserId
    })
    assert.equal(result.idempotent, true)
    assert.equal(state.updates.length, 0)
  })

  it('rejects a lost CAS race so incompatible concurrent effects cannot both apply', async () => {
    const order = makeOrder({ fulfillmentStatus: 'preparing' })
    let calls = 0
    const service = new OrderFulfillmentService({
      orderManager: {
        async getByOrderNumber() { return { ...order } },
        async updateFulfillmentStatus() {
          calls += 1
          return calls === 1 ? { ...order, fulfillmentStatus: 'ready_for_pickup' } : null
        }
      }
    })
    const results = await Promise.allSettled([
      service.updateByAdmin({ orderNumber, status: 'ready_for_pickup', adminUserId }),
      service.updateByAdmin({ orderNumber, status: 'ready_for_pickup', adminUserId })
    ])
    assert.equal(results.filter((result) => result.status === 'fulfilled').length, 1)
    assert.equal(results.filter((result) => result.status === 'rejected').length, 1)
    assert.equal(results.find((result) => result.status === 'rejected').reason.code, 'ORDER_FULFILLMENT_CONFLICT')
  })

  it('rejects a normal USER at the HTTP controller boundary', async () => {
    const { service } = makeFulfillmentHarness()
    const controller = new OrderFulfillmentController({ orderFulfillmentService: service })
    const app = express()
    app.use(express.json())
    app.use((req, _res, next) => {
      req.user = { id: userId, role: 'USER' }
      next()
    })
    app.patch('/api/admin/orders/:orderNumber/fulfillment', controller.update)
    app.use((error, _req, res, _next) => {
      void _next
      const mapped = mapServiceErrorToHttp(error)
      res.status(mapped.status).json({ status: 'error', message: mapped.message })
    })

    const response = await request(app)
      .patch(`/api/admin/orders/${orderNumber}/fulfillment`)
      .send({ status: 'ready_for_pickup' })
    assert.equal(response.status, 403)
  })
})
