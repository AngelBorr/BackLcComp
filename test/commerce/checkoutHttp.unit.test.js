/* eslint-env mocha */
import assert from 'node:assert/strict'
import express from 'express'
import request from 'supertest'
import { CheckoutController } from '../../src/controllers/checkout.controller.js'
import { CheckoutService } from '../../src/services/checkout.service.js'
import { CheckoutHttpService } from '../../src/services/checkoutHttp.service.js'
import { CheckoutLeaseService } from '../../src/services/checkoutLease.service.js'
import { ServiceError } from '../../src/services/service.products.js'
import { mapServiceErrorToHttp } from '../../src/middlewares/serviceErrorMapper.js'
import { serviceErrorHandler } from '../../src/middlewares/serviceErrorHandler.js'
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

const makeFacadeHarness = ({
  localResults,
  localError,
  providerError,
  checkoutLeaseService,
  checkoutFinancialGuardService
} = {}) => {
  const state = {
    localCalls: [],
    providerCalls: [],
    leaseAcquisitions: 0,
    leaseReleases: 0,
    leaseAssertions: 0,
    heartbeatStops: 0,
    lease: { userId, ownerToken: 'owner-1' }
  }
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
  const leases = checkoutLeaseService || {
    async acquire(requestedUserId) {
      state.leaseAcquisitions += 1
      return { ...state.lease, userId: requestedUserId }
    },
    startHeartbeat(lease) {
      return {
        async assertOwnership() {
          state.leaseAssertions += 1
          return lease
        },
        isLost() {
          return false
        },
        async stop() {
          state.heartbeatStops += 1
        }
      }
    },
    async release() {
      state.leaseReleases += 1
      return true
    }
  }
  const financialGuard = checkoutFinancialGuardService || {
    assertCheckoutCanContinue() {},
    async getEligibility() {
      return { allowed: true, blocker: null }
    }
  }

  return {
    state,
    service: new CheckoutHttpService({
      checkoutService,
      mercadoPagoCheckoutService,
      checkoutLeaseService: leases,
      checkoutFinancialGuardService: financialGuard
    })
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
  app.get('/api/checkout/eligibility', controller.getEligibility)
  app.post('/api/checkout', controller.create)
  app.use(serviceErrorHandler)

  return app
}

describe('POST /api/checkout HTTP orchestration (isolated unit tests)', () => {
  it('registers the route for USER and PREMIUM only', () => {
    const registered = []
    registerCheckoutRoute({
      get(path, policies, handler) {
        registered.push({ method: 'GET', path, policies, handler })
      },
      post(path, policies, handler) {
        registered.push({ method: 'POST', path, policies, handler })
      }
    }, { create() {}, getEligibility() {} })

    assert.deepEqual(registered.map(({ method, path }) => ({ method, path })), [
      { method: 'GET', path: '/eligibility' },
      { method: 'POST', path: '/' }
    ])
    assert.ok(registered.every(({ policies }) => (
      JSON.stringify(policies) === JSON.stringify(['USER', 'PREMIUM'])
    )))
    assert.ok(registered.every(({ handler }) => typeof handler === 'function'))
  })

  it('returns 401 without an authenticated user', async () => {
    const response = await request(createControllerApp({ service: {} }))
      .post('/api/checkout')
      .set('Idempotency-Key', 'checkout-1')
      .send(validBody())

    assert.equal(response.status, 401)
  })

  it('returns read-only eligibility for the authenticated buyer', async () => {
    let received
    const blocker = {
      code: 'CHECKOUT_BLOCKED_BY_APPROVED_PAYMENT',
      orderNumber: 'LC-2026-000003',
      orderStatus: 'requires_attention',
      paymentStatus: 'approved',
      attentionReason: 'RESERVATION_EXPIRED'
    }
    const app = createControllerApp({
      user: { id: userId, role: 'USER' },
      service: {
        async getEligibility(input) {
          received = input
          return { allowed: false, blocker }
        }
      }
    })
    const response = await request(app).get('/api/checkout/eligibility')

    assert.equal(response.status, 200)
    assert.deepEqual(received, { userId, idempotencyKey: undefined })
    assert.deepEqual(response.body, { allowed: false, blocker })
  })

  it('returns only the safe blocker DTO for a guarded POST', async () => {
    const blocker = {
      code: 'CHECKOUT_BLOCKED_BY_APPROVED_PAYMENT',
      orderNumber: 'LC-2026-000003',
      orderStatus: 'requires_attention',
      paymentStatus: 'approved',
      attentionReason: 'RESERVATION_EXPIRED',
      providerOrderId: 'MUST-NOT-LEAK'
    }
    const app = createControllerApp({
      user: { id: userId, role: 'USER' },
      service: {
        async createCheckout() {
          throw new ServiceError(
            'Tu pago ya fue acreditado',
            blocker.code,
            409,
            { checkoutBlocker: blocker }
          )
        }
      }
    })
    const response = await request(app)
      .post('/api/checkout')
      .set('Idempotency-Key', 'new-key')
      .send(validBody())

    assert.equal(response.status, 409)
    assert.equal(response.body.code, blocker.code)
    assert.equal(response.body.blocker.orderNumber, blocker.orderNumber)
    assert.equal(JSON.stringify(response.body).includes('MUST-NOT-LEAK'), false)
  })

  it('returns a sanitized controlled response when this request reconciled a prior payment', async () => {
    const blocker = {
      code: 'CHECKOUT_PRIOR_PAYMENT_CONFIRMED',
      orderNumber: 'LC-2026-000003',
      orderStatus: 'paid',
      paymentStatus: 'approved',
      providerOrderId: 'MUST-NOT-LEAK'
    }
    const app = createControllerApp({
      user: { id: userId, role: 'USER' },
      service: {
        async createCheckout() {
          throw new ServiceError(
            'Tu pago anterior fue confirmado. No es necesario volver a pagar.',
            blocker.code,
            409,
            { checkoutBlocker: blocker }
          )
        }
      }
    })

    const response = await request(app)
      .post('/api/checkout')
      .set('Idempotency-Key', 'new-key-after-reconciliation')
      .send(validBody())

    assert.equal(response.status, 409)
    assert.deepEqual(response.body.blocker, {
      code: blocker.code,
      orderNumber: blocker.orderNumber,
      orderStatus: 'paid',
      paymentStatus: 'approved'
    })
    assert.equal(JSON.stringify(response.body).includes('MUST-NOT-LEAK'), false)
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

    assert.deepEqual(state.localCalls[0].input, {
      userId,
      items: validBody().items,
      idempotencyKey: 'checkout-valid-key'
    })
    assert.equal(state.localCalls[0].options.now, now)
    assert.deepEqual(state.localCalls[0].options.checkoutLease, { ...state.lease })
    assert.equal(
      typeof state.localCalls[0].options.assertCheckoutLeaseOwnership,
      'function'
    )
    assert.equal(state.leaseAcquisitions, 1)
    assert.equal(state.leaseReleases, 1)
    assert.equal(state.heartbeatStops, 1)
    assert.equal(state.leaseAssertions, 4)
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

  it('does not call the provider when a same-key checkout is already approved and unresolved', async () => {
    const blocker = {
      code: 'CHECKOUT_BLOCKED_BY_APPROVED_PAYMENT',
      orderNumber: 'LC-2026-000003',
      orderStatus: 'requires_attention',
      paymentStatus: 'approved',
      attentionReason: 'RESERVATION_EXPIRED'
    }
    const { service, state } = makeFacadeHarness({
      localResults: [localResult({
        order: {
          ...localResult().order,
          orderNumber: blocker.orderNumber,
          status: blocker.orderStatus,
          attentionReason: blocker.attentionReason
        },
        payment: { id: paymentId, status: 'approved', provider: 'mercado_pago' },
        isIdempotent: true
      })],
      checkoutFinancialGuardService: {
        assertCheckoutCanContinue() {
          throw new ServiceError(
            'Tu pago ya fue acreditado',
            blocker.code,
            409,
            { checkoutBlocker: blocker }
          )
        }
      }
    })

    await assert.rejects(service.createCheckout({
      userId,
      idempotencyKey: 'same-approved-key',
      body: validBody()
    }), (error) => error.code === blocker.code)

    assert.equal(state.providerCalls.length, 0)
    assert.equal(state.leaseReleases, 1)
  })

  it('does not call the provider when a same-key retry loads an already paid checkout', async () => {
    const blocker = {
      code: 'CHECKOUT_BLOCKED_BY_APPROVED_PAYMENT',
      orderNumber: 'LC-2026-000003',
      orderStatus: 'paid',
      paymentStatus: 'approved'
    }
    const { service, state } = makeFacadeHarness({
      localResults: [localResult({
        order: {
          ...localResult().order,
          orderNumber: blocker.orderNumber,
          status: 'paid'
        },
        payment: { id: paymentId, status: 'approved', provider: 'mercado_pago' },
        isIdempotent: true
      })],
      checkoutFinancialGuardService: {
        assertCheckoutCanContinue(checkout) {
          if (checkout.order.status === 'paid' && checkout.payment.status === 'approved') {
            throw new ServiceError(
              'Tu pago ya fue acreditado',
              blocker.code,
              409,
              { checkoutBlocker: blocker }
            )
          }
        }
      }
    })

    await assert.rejects(service.createCheckout({
      userId,
      idempotencyKey: 'same-paid-key',
      body: validBody()
    }), (error) => error.code === blocker.code)

    assert.equal(state.providerCalls.length, 0)
    assert.equal(state.leaseReleases, 1)
  })

  it('does not call the provider for a same-key checkout with an idempotency conflict', async () => {
    const uncertainty = new ServiceError(
      'Existe un intento anterior cuyo resultado no pudo confirmarse',
      'CHECKOUT_PRIOR_PAYMENT_UNCERTAIN',
      409
    )
    const { service, state } = makeFacadeHarness({ localError: uncertainty })

    await assert.rejects(service.createCheckout({
      userId,
      idempotencyKey: 'same-conflicted-key',
      body: validBody()
    }), (error) => error.code === 'CHECKOUT_PRIOR_PAYMENT_UNCERTAIN')

    assert.equal(state.providerCalls.length, 0)
    assert.equal(state.leaseReleases, 1)
  })

  it('serializes different keys for the same buyer across the provider window', async () => {
    const records = new Map()
    const manager = {
      async acquire(requestedUserId, ownerToken, { now: acquiredAt, expiresAt }) {
        const current = records.get(String(requestedUserId))
        if (current && current.expiresAt > acquiredAt) {
          const duplicate = new Error('duplicate lease')
          duplicate.code = 11000
          throw duplicate
        }
        const lease = { _id: requestedUserId, ownerToken, expiresAt }
        records.set(String(requestedUserId), lease)
        return lease
      },
      async renew(requestedUserId, ownerToken, { now: renewedAt, expiresAt }) {
        const current = records.get(String(requestedUserId))
        if (
          !current ||
          current.ownerToken !== ownerToken ||
          current.expiresAt <= renewedAt
        ) return null
        const renewed = { ...current, expiresAt }
        records.set(String(requestedUserId), renewed)
        return renewed
      },
      async release(requestedUserId, ownerToken) {
        const current = records.get(String(requestedUserId))
        if (!current || current.ownerToken !== ownerToken) return { deletedCount: 0 }
        records.delete(String(requestedUserId))
        return { deletedCount: 1 }
      }
    }
    const leases = new CheckoutLeaseService({ checkoutLeaseManager: manager })
    let releaseProvider
    let providerStarted
    const started = new Promise((resolve) => { providerStarted = resolve })
    const gate = new Promise((resolve) => { releaseProvider = resolve })
    const effects = {
      ordersCreated: 0,
      paymentsCreated: 0,
      reservationsCreated: 0,
      providerOrdersCreated: 0
    }
    const stored = {
      orders: new Map(),
      items: new Map(),
      payments: new Map()
    }
    const session = {
      inTransaction: () => true,
      async withTransaction(operation) {
        await operation()
      },
      async endSession() {}
    }
    const localCheckoutService = new CheckoutService({
      mongooseInstance: { async startSession() { return session } },
      orderManager: {
        async getByUserAndCheckoutIdempotencyKey(requestedUserId, key) {
          return stored.orders.get(`${requestedUserId}:${key}`) || null
        }
      },
      orderItemManager: {
        async getByOrderId(requestedOrderId) {
          return stored.items.get(String(requestedOrderId)) || []
        }
      },
      paymentManager: {
        async getLatestByOrderId(requestedOrderId) {
          return stored.payments.get(String(requestedOrderId)) || null
        }
      },
      commercePricingService: {
        async getAuthoritativeUserContext() {
          return { user: { role: 'USER', emailVerified: true } }
        },
        async getOrderItemSnapshot({ productId: requestedProductId, quantity }) {
          return {
            user: { role: 'USER', emailVerified: true },
            item: {
              productId: requestedProductId,
              productSnapshot: { name: 'Producto', brand: 'LC', category: 'IT' },
              quantity,
              priceType: 'retail',
              unitPriceUsd: '100.00',
              totalUsd: '100.00',
              vatRate: 0.21,
              currency: 'USD'
            }
          }
        }
      },
      exchangeRateService: {
        async getUsdArsSellingQuote() {
          return {
            source: 'BNA',
            quoteType: 'billete_venta',
            rate: '1545.0000',
            sourceDate: '2026-09-29',
            fetchedAt: '2026-09-29T11:59:00.000Z'
          }
        }
      },
      orderService: {
        async createBaseOrder(input) {
          effects.ordersCreated += 1
          const createdOrderId = '507f1f77bcf86cd799439013'
          const order = {
            _id: createdOrderId,
            orderNumber: 'LC-2026-000001',
            userId: input.userId,
            status: 'pending_payment',
            reservationExpiresAt: input.reservationExpiresAt,
            checkoutIdempotencyKey: input.checkoutIdempotencyKey,
            checkoutRequestHash: input.checkoutRequestHash,
            totals: { totalUsd: '100.00', totalArs: '154500.00' },
            exchangeRateSnapshot: {
              source: 'BNA',
              quoteType: 'billete_venta',
              rate: '1545.0000',
              sourceDate: '2026-09-29',
              fetchedAt: '2026-09-29T11:59:00.000Z'
            }
          }
          const createdItems = [{
            _id: '507f1f77bcf86cd799439014',
            orderId: createdOrderId,
            productId,
            productSnapshot: { name: 'Producto', brand: 'LC', category: 'IT' },
            quantity: 1,
            priceType: 'retail',
            unitPriceUsd: '100.00',
            totalUsd: '100.00',
            vatRate: 0.21,
            currency: 'USD'
          }]
          stored.orders.set(`${input.userId}:${input.checkoutIdempotencyKey}`, order)
          stored.items.set(createdOrderId, createdItems)
          return { order, items: createdItems }
        }
      },
      productUnitService: {
        async reserveAvailableUnits() {
          effects.reservationsCreated += 1
        }
      },
      paymentService: {
        async createPayment({ orderId: requestedOrderId }) {
          effects.paymentsCreated += 1
          const payment = {
            _id: paymentId,
            orderId: requestedOrderId,
            provider: 'mercado_pago',
            normalizedStatus: 'pending'
          }
          stored.payments.set(String(requestedOrderId), payment)
          return payment
        }
      },
      checkoutFinancialGuardService: {
        async assertCanCreateCheckout() {},
        async assertCanContinueCheckout() {}
      }
    })
    const service = new CheckoutHttpService({
      checkoutLeaseService: leases,
      checkoutFinancialGuardService: { assertCheckoutCanContinue() {} },
      checkoutService: localCheckoutService,
      mercadoPagoCheckoutService: {
        async ensureCheckoutOrderForPayment() {
          effects.providerOrdersCreated += 1
          providerStarted()
          await gate
          return providerResult
        }
      }
    })

    const first = service.createCheckout({
      userId,
      idempotencyKey: 'key-a',
      body: validBody()
    })
    await started

    await assert.rejects(service.createCheckout({
      userId,
      idempotencyKey: 'key-b',
      body: { items: [{ productId, quantity: 2 }] }
    }), (error) => error.code === 'CHECKOUT_IN_PROGRESS')

    releaseProvider()
    await first

    assert.deepEqual(effects, {
      ordersCreated: 1,
      paymentsCreated: 1,
      reservationsCreated: 1,
      providerOrdersCreated: 1
    })
  })

  it('does not reach the provider after the lease owner loses its fencing token', async () => {
    let assertion = 0
    let providerCalls = 0
    const lost = new ServiceError(
      'El checkout perdió su protección de concurrencia',
      'CHECKOUT_LOCK_LOST',
      409
    )
    const leases = {
      async acquire() {
        return { userId, ownerToken: 'stale-owner' }
      },
      startHeartbeat(lease) {
        return {
          async assertOwnership() {
            assertion += 1
            if (assertion >= 3) throw lost
            return lease
          },
          isLost() {
            return assertion >= 3
          },
          async stop() {}
        }
      },
      async release() {
        return false
      }
    }
    const { service } = makeFacadeHarness({ checkoutLeaseService: leases })
    service.mercadoPagoCheckout = {
      async ensureCheckoutOrderForPayment() {
        providerCalls += 1
        return providerResult
      }
    }

    await assert.rejects(service.createCheckout({
      userId,
      idempotencyKey: 'stale-owner-key',
      body: validBody()
    }), (error) => error.code === 'CHECKOUT_LOCK_LOST')

    assert.equal(providerCalls, 0)
  })
})
