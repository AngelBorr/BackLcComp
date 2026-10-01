import assert from 'node:assert/strict'
import express from 'express'
import request from 'supertest'
import { OrderStatusService } from '../../src/services/orderStatus.service.js'
import { OrderStatusController } from '../../src/controllers/orderStatus.controller.js'
import { mapServiceErrorToHttp } from '../../src/middlewares/serviceErrorMapper.js'
import { registerOrderRoutes } from '../../src/routes/orders.router.js'

const userId = '507f1f77bcf86cd799439011'
const otherUserId = '507f1f77bcf86cd799439099'
const orderId = '507f1f77bcf86cd799439012'
const paymentId = '507f1f77bcf86cd799439013'
const orderNumber = 'LC-2026-000001'

const makeOrder = (overrides = {}) => ({
  _id: orderId,
  orderNumber,
  userId,
  status: 'pending_payment',
  reservationExpiresAt: new Date('2026-09-29T18:00:00.000Z'),
  paidAt: null,
  updatedAt: new Date('2026-09-29T12:00:00.000Z'),
  checkoutIdempotencyKey: 'must-not-leak',
  attentionReason: 'internal detail',
  serialNumbers: ['must-not-leak'],
  ...overrides
})

const makePayment = (overrides = {}) => ({
  _id: paymentId,
  orderId,
  normalizedStatus: 'pending',
  providerOrderId: 'provider-order-secret',
  providerPaymentId: 'provider-payment-secret',
  providerIdempotencyKey: 'provider-key-secret',
  ...overrides
})

const makeServiceHarness = ({ order = makeOrder(), payment = makePayment() } = {}) => {
  const state = { orderReads: [], paymentReads: [], writes: 0, providerCalls: 0 }
  const service = new OrderStatusService({
    orderManager: {
      async getByOrderNumberAndUserId(receivedOrderNumber, receivedUserId) {
        state.orderReads.push({ orderNumber: receivedOrderNumber, userId: receivedUserId })
        if (!order || receivedUserId === otherUserId) return null
        return order
      },
      async updateStatus() { state.writes += 1 }
    },
    paymentManager: {
      async getLatestByOrderId(receivedOrderId) {
        state.paymentReads.push(receivedOrderId)
        return payment
      },
      async updateStatus() { state.writes += 1 }
    }
  })

  return { service, state }
}

const createControllerApp = ({ user, service }) => {
  const app = express()
  const controller = new OrderStatusController({ orderStatusService: service })

  app.use((req, _res, next) => {
    if (user) req.user = user
    next()
  })
  app.get('/api/orders/:orderNumber/status', controller.getStatus)
  app.use((error, _req, res, _next) => {
    void _next
    const mapped = mapServiceErrorToHttp(error)
    res.status(mapped.status).json({ status: 'error', message: mapped.message })
  })

  return app
}

describe('GET /api/orders/:orderNumber/status (isolated unit tests)', () => {
  it('registers an authenticated buyer route for USER and PREMIUM only', () => {
    let registered
    registerOrderRoutes({
      get(path, policies, handler) {
        registered = { path, policies, handler }
      }
    }, { getStatus() {} })

    assert.equal(registered.path, '/:orderNumber/status')
    assert.deepEqual(registered.policies, ['USER', 'PREMIUM'])
    assert.equal(typeof registered.handler, 'function')
  })

  for (const role of ['USER', 'PREMIUM']) {
    it(`${role} can query its Order using identity only from req.user`, async () => {
      const { service, state } = makeServiceHarness()
      const app = createControllerApp({ user: { id: userId, role }, service })
      const response = await request(app).get(`/api/orders/${orderNumber}/status`)

      assert.equal(response.status, 200)
      assert.deepEqual(state.orderReads, [{ orderNumber, userId }])
      assert.equal(response.body.orderNumber, orderNumber)
    })
  }

  it('returns 401 without an authenticated session', async () => {
    const response = await request(createControllerApp({ service: {} }))
      .get(`/api/orders/${orderNumber}/status`)

    assert.equal(response.status, 401)
  })

  it('does not expose a foreign Order and does not read its Payment', async () => {
    const { service, state } = makeServiceHarness()
    const response = await request(createControllerApp({
      user: { id: otherUserId, role: 'USER' },
      service
    })).get(`/api/orders/${orderNumber}/status`)

    assert.equal(response.status, 404)
    assert.equal(state.paymentReads.length, 0)
  })

  it('uses the same non-disclosing response for a missing Order', async () => {
    const { service } = makeServiceHarness({ order: null })
    const response = await request(createControllerApp({
      user: { id: userId, role: 'USER' },
      service
    })).get(`/api/orders/${orderNumber}/status`)

    assert.equal(response.status, 404)
    assert.equal(response.body.message, 'Orden no encontrada')
  })

  const statusCases = [
    ['paid + approved', 'paid', 'approved'],
    ['pending_payment + pending', 'pending_payment', 'pending'],
    ['requires_attention + approved', 'requires_attention', 'approved'],
    ['expired', 'expired', 'pending'],
    ['cancelled', 'cancelled', 'cancelled']
  ]

  for (const [label, orderStatus, paymentStatus] of statusCases) {
    it(`returns persisted ${label} without deriving a new state`, async () => {
      const paidAt = orderStatus === 'paid' ? new Date('2026-09-29T12:05:00.000Z') : null
      const { service } = makeServiceHarness({
        order: makeOrder({ status: orderStatus, paidAt }),
        payment: makePayment({ normalizedStatus: paymentStatus })
      })
      const result = await service.getForBuyer({ orderNumber, userId })

      assert.equal(result.orderStatus, orderStatus)
      assert.equal(result.paymentStatus, paymentStatus)
      assert.equal(result.paidAt, paidAt?.toISOString() ?? null)
      assert.equal(result.requiresAttention, orderStatus === 'requires_attention' ? true : undefined)
    })
  }

  it('returns a strict DTO without Mongo, provider, serial or internal fields', async () => {
    const { service } = makeServiceHarness({
      order: makeOrder({ status: 'requires_attention' }),
      payment: makePayment({ normalizedStatus: 'approved' })
    })
    const result = await service.getForBuyer({ orderNumber, userId })

    assert.deepEqual(Object.keys(result).sort(), [
      'orderNumber',
      'orderStatus',
      'paidAt',
      'paymentStatus',
      'requiresAttention',
      'reservationExpiresAt',
      'updatedAt'
    ])
    const serialized = JSON.stringify(result)
    for (const forbidden of [
      orderId,
      paymentId,
      'provider-order-secret',
      'provider-payment-secret',
      'provider-key-secret',
      'must-not-leak',
      'attentionReason'
    ]) assert.equal(serialized.includes(forbidden), false)
  })

  it('does not call Mercado Pago or mutate Order/Payment', async () => {
    const { service, state } = makeServiceHarness()
    await service.getForBuyer({ orderNumber, userId })

    assert.equal(state.providerCalls, 0)
    assert.equal(state.writes, 0)
    assert.equal(state.orderReads.length, 1)
    assert.equal(state.paymentReads.length, 1)
  })
})
