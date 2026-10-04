import assert from 'node:assert/strict'
import express from 'express'
import request from 'supertest'
import { CheckoutController } from '../../src/controllers/checkout.controller.js'
import { CheckoutHttpService } from '../../src/services/checkoutHttp.service.js'
import { ServiceError } from '../../src/services/service.products.js'
import { mapServiceErrorToHttp } from '../../src/middlewares/serviceErrorMapper.js'
import { registerCheckoutRoute } from '../../src/routes/checkout.router.js'

const userId = '507f1f77bcf86cd799439011'
const otherUserId = '507f1f77bcf86cd799439099'
const productId = '507f191e810c19729de860ea'
const paymentId = '507f1f77bcf86cd799439012'
const now = new Date('2026-09-29T12:00:00.000Z')

const validBody = () => ({ items: [{ productId, quantity: 1 }] })

const localResult = (overrides = {}) => ({
  order: {
    id: '507f1f77bcf86cd799439013',
    orderNumber: 'LC-2026-000001',
    status: 'pending_payment',
    reservationExpiresAt: '2026-09-29T18:00:00.000Z'
  },
  items: [{ productId, serialNumbers: ['SHOULD-NOT-LEAK'] }],
  totals: { totalUsd: '100.00', totalArs: '154500.00' },
  exchangeRate: {
    source: 'BNA',
    quoteType: 'billete_venta',
    rate: '1545.0000',
    sourceDate: '2026-09-29',
    fetchedAt: '2026-09-29T11:59:00.000Z'
  },
  payment: { id: paymentId, status: 'pending', provider: 'mercado_pago' },
  isIdempotent: false,
  ...overrides
})

const providerResult = {
  paymentId,
  paymentStatus: 'pending',
  provider: 'mercado_pago',
  providerOrderId: '01JTESTORDER',
  providerStatus: 'created',
  checkoutUrl: 'https://www.mercadopago.com.ar/checkout/v1/redirect?pref_id=test'
}

const makeFacadeHarness = ({ localResults, localError, providerError } = {}) => {
  const state = { localCalls: [], providerCalls: [] }
  let localAttempt = 0
  let providerAttempt = 0
  const checkoutService = {
    async createCheckout(input, options) {
      state.localCalls.push({ input, options })
      if (localError) throw localError
      const selected = localResults?.[localAttempt] || localResults?.at(-1) || localResult()
      localAttempt += 1
      return selected
    }
  }
  const mercadoPagoCheckoutService = {
    async ensureCheckoutOrderForPayment(id, options) {
      state.providerCalls.push({ id, options })
      const error = Array.isArray(providerError)
        ? providerError[providerAttempt]
        : providerError
      providerAttempt += 1
      if (error) throw error
      return providerResult
    }
  }

  return {
    state,
    service: new CheckoutHttpService({ checkoutService, mercadoPagoCheckoutService })
  }
}

const createControllerApp = ({ user, service }) => {
  const app = express()
  const controller = new CheckoutController({ checkoutHttpService: service })

  app.use(express.json())
  app.use((req, _res, next) => {
    if (user) req.user = user
    next()
  })
  app.post('/api/checkout', controller.create)
  app.use((error, _req, res, _next) => {
    void _next
    const mapped = mapServiceErrorToHttp(error)
    res.status(mapped.status).json({ status: 'error', message: mapped.message })
  })

  return app
}

describe('POST /api/checkout HTTP orchestration (isolated unit tests)', () => {
  it('registers the route for USER and PREMIUM only', () => {
    let registered
    registerCheckoutRoute({
      post(path, policies, handler) {
        registered = { path, policies, handler }
      }
    }, { create() {} })

    assert.equal(registered.path, '/')
    assert.deepEqual(registered.policies, ['USER', 'PREMIUM'])
    assert.equal(typeof registered.handler, 'function')
  })

  it('returns 401 without an authenticated user', async () => {
    const response = await request(createControllerApp({ service: {} }))
      .post('/api/checkout')
      .set('Idempotency-Key', 'checkout-1')
      .send(validBody())

    assert.equal(response.status, 401)
  })

  for (const role of ['USER', 'PREMIUM']) {
    it(`accepts ${role} and obtains userId only from req.user`, async () => {
      let received
      const app = createControllerApp({
        user: { id: userId, role },
        service: {
          async createCheckout(input) {
            received = input
            return { isIdempotent: false, checkout: { checkoutUrl: providerResult.checkoutUrl } }
          }
        }
      })
      const response = await request(app)
        .post('/api/checkout')
        .set('Idempotency-Key', 'checkout-1')
        .send(validBody())

      assert.equal(response.status, 201)
      assert.equal(received.userId, userId)
    })
  }

  it('returns 403 for ADMIN before invoking checkout services', async () => {
    let calls = 0
    const app = createControllerApp({
      user: { id: userId, role: 'ADMIN' },
      service: { async createCheckout() { calls += 1 } }
    })
    const response = await request(app)
      .post('/api/checkout')
      .set('Idempotency-Key', 'checkout-1')
      .send(validBody())

    assert.equal(response.status, 403)
    assert.equal(calls, 0)
  })

  it('rejects userId and financial authority in the body', async () => {
    const { service, state } = makeFacadeHarness()

    for (const extra of [
      { userId: otherUserId },
      { price: '0.01' },
      { totalArs: '0.01' },
      { paymentStatus: 'approved' }
    ]) {
      await assert.rejects(service.createCheckout({
        userId,
        idempotencyKey: 'checkout-authority-test',
        body: { ...validBody(), ...extra }
      }), (error) => error.code === 'CHECKOUT_INVALID_INPUT')
    }

    assert.equal(state.localCalls.length, 0)
    assert.equal(state.providerCalls.length, 0)
  })

  it('requires a valid Idempotency-Key', async () => {
    const { service, state } = makeFacadeHarness()

    for (const key of [undefined, '', ' contains spaces ', 'x'.repeat(129)]) {
      await assert.rejects(
        service.createCheckout({ userId, idempotencyKey: key, body: validBody() }),
        (error) => error.code === 'CHECKOUT_INVALID_IDEMPOTENCY_KEY'
      )
    }

    assert.equal(state.localCalls.length, 0)
  })

  it('rejects an empty or invalid body without calling MP', async () => {
    const { service, state } = makeFacadeHarness()

    for (const body of [undefined, {}, { items: [] }, { items: 'invalid' }]) {
      await assert.rejects(service.createCheckout({
        userId,
        idempotencyKey: 'checkout-valid-key',
        body
      }))
    }

    assert.equal(state.localCalls.length, 0)
    assert.equal(state.providerCalls.length, 0)
  })

  it('passes only identity, items and trimmed key to CheckoutService', async () => {
    const { service, state } = makeFacadeHarness()
    await service.createCheckout({
      userId,
      idempotencyKey: ' checkout-valid-key ',
      body: validBody()
    }, { now })

    assert.deepEqual(state.localCalls[0], {
      input: { userId, items: validBody().items, idempotencyKey: 'checkout-valid-key' },
      options: { now }
    })
  })

  it('returns 201 and a minimal safe DTO for a new checkout', async () => {
    const { service } = makeFacadeHarness()
    const app = createControllerApp({ user: { id: userId, role: 'USER' }, service })
    const response = await request(app)
      .post('/api/checkout')
      .set('Idempotency-Key', 'checkout-1')
      .send(validBody())

    assert.equal(response.status, 201)
    assert.equal(response.body.order.orderNumber, 'LC-2026-000001')
    assert.equal(response.body.checkoutUrl, providerResult.checkoutUrl)
    assert.deepEqual(response.body.payment, { status: 'pending', provider: 'mercado_pago' })
  })

  it('returns 200 for retry and does not expose internal data', async () => {
    const { service } = makeFacadeHarness({
      localResults: [localResult({ isIdempotent: true })]
    })
    const app = createControllerApp({ user: { id: userId, role: 'PREMIUM' }, service })
    const response = await request(app)
      .post('/api/checkout')
      .set('Idempotency-Key', 'checkout-retry')
      .send(validBody())
    const serialized = JSON.stringify(response.body)

    assert.equal(response.status, 200)
    for (const forbidden of [
      'providerOrderId',
      'providerIdempotencyKey',
      'checkoutIdempotencyKey',
      'serialNumbers',
      paymentId,
      'JWT',
      'cookie'
    ]) assert.equal(serialized.includes(forbidden), false)
  })

  it('keeps local checkout after MP timeout and retries the same Payment', async () => {
    const timeout = new ServiceError('MP timeout', 'MERCADOPAGO_TIMEOUT', 504)
    const { service, state } = makeFacadeHarness({
      localResults: [localResult(), localResult({ isIdempotent: true })],
      providerError: [timeout, null]
    })

    await assert.rejects(service.createCheckout({
      userId,
      idempotencyKey: 'checkout-retry',
      body: validBody()
    }, { now }), (error) => error.code === 'MERCADOPAGO_TIMEOUT')

    const retry = await service.createCheckout({
      userId,
      idempotencyKey: 'checkout-retry',
      body: validBody()
    }, { now })

    assert.equal(retry.isIdempotent, true)
    assert.deepEqual(state.providerCalls.map((call) => call.id), [paymentId, paymentId])
  })

  it('does not call MP on idempotency conflict, BNA failure or local failure', async () => {
    const errors = [
      new ServiceError('Key conflict', 'CHECKOUT_IDEMPOTENCY_CONFLICT', 409),
      new ServiceError('BNA unavailable', 'BNA_QUOTE_UNAVAILABLE', 503),
      new ServiceError('Checkout failed', 'CHECKOUT_FAILED', 500)
    ]

    for (const localError of errors) {
      const { service, state } = makeFacadeHarness({ localError })
      await assert.rejects(service.createCheckout({
        userId,
        idempotencyKey: 'checkout-local-failure',
        body: validBody()
      }))
      assert.equal(state.providerCalls.length, 0)
    }
  })

  it('maps MP timeout to retryable HTTP 503', () => {
    const timeout = new ServiceError('MP unavailable', 'MERCADOPAGO_TIMEOUT', 504)
    assert.deepEqual(mapServiceErrorToHttp(timeout), {
      status: 503,
      message: 'MP unavailable'
    })
  })

  it('does not expose a provider idempotency conflict as a local cart fingerprint conflict', async () => {
    const providerConflict = new ServiceError(
      'Mercado Pago rechazó la clave de idempotencia del intento',
      'MERCADOPAGO_IDEMPOTENCY_CONFLICT',
      502
    )
    const { service } = makeFacadeHarness({ providerError: providerConflict })
    const app = createControllerApp({ user: { id: userId, role: 'USER' }, service })
    const response = await request(app)
      .post('/api/checkout')
      .set('Idempotency-Key', 'checkout-provider-conflict')
      .send(validBody())

    assert.equal(response.status, 502)
    assert.equal(response.body.message, providerConflict.message)
    assert.notEqual(response.status, 409)
    assert.equal(response.body.message.includes('carrito'), false)
  })

  it('returns MP configuration errors without secrets or stacks', async () => {
    const error = new ServiceError(
      'Mercado Pago no está configurado',
      'MERCADOPAGO_NOT_CONFIGURED',
      500
    )
    const { service } = makeFacadeHarness({ providerError: error })
    const app = createControllerApp({ user: { id: userId, role: 'USER' }, service })
    const response = await request(app)
      .post('/api/checkout')
      .set('Idempotency-Key', 'checkout-config')
      .send(validBody())

    assert.equal(response.status, 500)
    assert.equal(JSON.stringify(response.body).includes('access_token'), false)
    assert.equal(Object.hasOwn(response.body, 'stack'), false)
  })

  it('propagates an expired reservation without a second provider attempt', async () => {
    const expired = new ServiceError(
      'La reserva del checkout ya expiró',
      'MERCADOPAGO_CHECKOUT_EXPIRED',
      409
    )
    const { service, state } = makeFacadeHarness({ providerError: expired })

    await assert.rejects(service.createCheckout({
      userId,
      idempotencyKey: 'checkout-expired',
      body: validBody()
    }, { now }), (error) => error.code === 'MERCADOPAGO_CHECKOUT_EXPIRED')
    assert.equal(state.providerCalls.length, 1)
  })

  it('keeps equal keys independent for different authenticated users', async () => {
    const { service, state } = makeFacadeHarness()
    await service.createCheckout({ userId, idempotencyKey: 'same-key', body: validBody() })
    await service.createCheckout({
      userId: otherUserId,
      idempotencyKey: 'same-key',
      body: validBody()
    })

    assert.deepEqual(state.localCalls.map((call) => call.input.userId), [userId, otherUserId])
  })
})
