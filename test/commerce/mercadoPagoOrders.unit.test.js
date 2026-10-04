/* eslint-env mocha */
import assert from 'node:assert/strict'
import mongoose from 'mongoose'
import PaymentModel from '../../src/dao/models/payment.model.js'
import {
  MERCADOPAGO_API_URL,
  MercadoPagoProvider,
  MercadoPagoProviderError
} from '../../src/providers/mercadoPago.provider.js'
import {
  MercadoPagoCheckoutService,
  toIsoDuration
} from '../../src/services/mercadoPagoCheckout.service.js'
import { PaymentService } from '../../src/services/payment.service.js'

const paymentId = new mongoose.Types.ObjectId().toString()
const orderId = new mongoose.Types.ObjectId().toString()
const now = new Date('2026-09-29T12:00:00.000Z')
const expiration = new Date('2026-09-29T17:59:30.000Z')
const providerIdempotencyKey = '123e4567-e89b-42d3-a456-426614174000'
const providerOrderId = 'ORD01TESTLCOMPCHECKOUT'
const checkoutUrl = `https://www.mercadopago.com.ar/checkout/v1/redirect?order_id=${providerOrderId}`

const providerPayload = (overrides = {}) => ({
  id: providerOrderId,
  status: 'created',
  checkout_url: checkoutUrl,
  external_reference: 'LC-2026-000001',
  total_amount: '154500.00',
  created_date: '2026-09-29T12:00:01.000Z',
  client_token: 'must-not-be-normalized',
  ...overrides
})

const jsonResponse = (payload, { status = 201, ok = status >= 200 && status < 300 } = {}) => ({
  ok,
  status,
  async json() {
    return payload
  }
})

const makeProvider = (fetchImplementation, options = {}) =>
  new MercadoPagoProvider({
    fetchImplementation,
    accessToken: 'test-access-token',
    timeoutMs: 100,
    ...options
  })

const makeServiceHarness = (overrides = {}) => {
  const state = {
    payment: {
      _id: paymentId,
      orderId,
      provider: 'mercado_pago',
      normalizedStatus: 'pending',
      externalReference: 'LC-2026-000001',
      amountArs: '154500.00',
      providerOrderId: null,
      providerCheckoutUrl: null,
      providerIdempotencyKey,
      providerStatus: null,
      preferenceId: null,
      providerPaymentId: null,
      ...(overrides.payment || {})
    },
    order: {
      _id: orderId,
      orderNumber: 'LC-2026-000001',
      status: 'pending_payment',
      totals: { totalUsd: '100.00', totalArs: '154500.00' },
      exchangeRateSnapshot: { source: 'BNA', rate: '1545.00' },
      reservationExpiresAt: expiration,
      buyerSnapshot: {
        email: 'buyer@example.com',
        firstName: 'Ada',
        lastName: 'Lovelace'
      },
      ...(overrides.order || {})
    },
    providerCalls: [],
    providerKeys: [],
    keyClaims: 0,
    attachAttempts: 0,
    successfulAttachments: 0
  }
  const paymentManager = {
    async getById() {
      return { ...state.payment }
    },
    async assignProviderIdempotencyKeyIfMissing(_id, provider, key) {
      state.keyClaims += 1
      if (state.payment.providerIdempotencyKey) return null
      if (state.payment.provider !== provider || state.payment.normalizedStatus !== 'pending') return null
      state.payment.providerIdempotencyKey = key
      return { ...state.payment }
    },
    async attachProviderOrder(_id, key, data) {
      state.attachAttempts += 1
      if (
        state.payment.providerOrderId ||
        state.payment.providerIdempotencyKey !== key ||
        state.payment.normalizedStatus !== 'pending'
      ) {
        return null
      }

      Object.assign(state.payment, data)
      state.successfulAttachments += 1
      return { ...state.payment }
    }
  }
  const orderManager = {
    async getById() {
      return { ...state.order }
    }
  }
  const provider = {
    async createCheckoutOrder(input) {
      state.providerCalls.push(input)
      state.providerKeys.push(input.providerIdempotencyKey)
      if (overrides.providerDelay) await overrides.providerDelay()
      if (overrides.providerError) throw overrides.providerError
      return {
        providerOrderId,
        status: 'created',
        checkoutUrl,
        externalReference: 'LC-2026-000001',
        totalAmount: '154500.00',
        createdAt: '2026-09-29T12:00:01.000Z',
        ...(overrides.providerResult || {})
      }
    }
  }
  const service = new MercadoPagoCheckoutService({
    paymentManager,
    orderManager,
    provider,
    returnBaseUrl: overrides.returnBaseUrl ?? 'https://www.lccomp.com.ar',
    uuidFactory: () => providerIdempotencyKey
  })

  return { service, state, provider }
}

describe('Mercado Pago Checkout Pro Orders API (isolated unit tests)', () => {
  it('uses POST /v1/orders and never the Preferences API', async () => {
    let captured
    const provider = makeProvider(async (url, options) => {
      captured = { url, options }
      return jsonResponse(providerPayload())
    })

    await provider.createCheckoutOrder({
      providerIdempotencyKey,
      request: { type: 'online' }
    })

    assert.equal(captured.url, `${MERCADOPAGO_API_URL}/v1/orders`)
    assert.equal(captured.options.method, 'POST')
    assert.equal(captured.url.includes('/checkout/preferences'), false)
  })

  it('sends Authorization and X-Idempotency-Key without normalizing secrets into the result', async () => {
    let headers
    const provider = makeProvider(async (_url, options) => {
      headers = options.headers
      return jsonResponse(providerPayload())
    })
    const result = await provider.createCheckoutOrder({
      providerIdempotencyKey,
      request: { type: 'online' }
    })

    assert.equal(headers.Authorization, 'Bearer test-access-token')
    assert.equal(headers['X-Idempotency-Key'], providerIdempotencyKey)
    assert.equal(JSON.stringify(result).includes('test-access-token'), false)
    assert.equal(JSON.stringify(result).includes('client_token'), false)
  })

  it('fails explicitly only when a real provider call lacks configuration', async () => {
    const provider = new MercadoPagoProvider({
      fetchImplementation: async () => jsonResponse(providerPayload()),
      accessToken: ''
    })

    await assert.rejects(
      provider.createCheckoutOrder({ providerIdempotencyKey, request: {} }),
      (error) => error.code === 'MERCADOPAGO_NOT_CONFIGURED'
    )
  })

  it('aborts provider calls at the configured timeout', async () => {
    const provider = makeProvider(
      async (_url, { signal }) => new Promise((_resolve, reject) => {
        signal.addEventListener('abort', () => {
          const error = new Error('aborted')
          error.name = 'AbortError'
          reject(error)
        })
      }),
      { timeoutMs: 5 }
    )

    await assert.rejects(
      provider.createCheckoutOrder({ providerIdempotencyKey, request: {} }),
      (error) => error.code === 'MERCADOPAGO_TIMEOUT'
    )
  })

  it('maps HTTP 401 without exposing the provider body', async () => {
    const provider = makeProvider(async () =>
      jsonResponse({ message: 'secret provider detail' }, { status: 401 }))

    await assert.rejects(
      provider.createCheckoutOrder({ providerIdempotencyKey, request: {} }),
      (error) => error.code === 'MERCADOPAGO_AUTH_ERROR' && !error.message.includes('secret')
    )
  })

  it('logs a sanitized HTTP 400 detail while preserving MERCADOPAGO_ORDER_REJECTED', async () => {
    const logged = []
    const accessToken = 'sensitive-access-token'
    const payerEmail = 'buyer-sensitive@example.com'
    const provider = makeProvider(
      async () => jsonResponse({
        code: 'invalid_order',
        message:
          `Invalid payer ${payerEmail}; Authorization: Bearer ${accessToken}; ` +
          `Cookie=session-secret; X-Idempotency-Key=${providerIdempotencyKey}`,
        cause: [{
          code: 'invalid_item',
          description: `Invalid item for ${payerEmail}`,
          data: { payerEmail, token: accessToken }
        }],
        details: [{
          code: 'invalid_total',
          message: `Rejected key ${providerIdempotencyKey}`,
          authorization: accessToken
        }],
        headers: { Authorization: `Bearer ${accessToken}` },
        payer: { email: payerEmail },
        cookie: 'session-secret'
      }, { status: 400 }),
      {
        accessToken,
        errorLogger: (...args) => logged.push(args)
      }
    )

    await assert.rejects(
      provider.createCheckoutOrder({ providerIdempotencyKey, request: { type: 'online' } }),
      (error) => (
        error instanceof MercadoPagoProviderError &&
        error.code === 'MERCADOPAGO_ORDER_REJECTED' &&
        error.status === 502 &&
        !error.message.includes('invalid_order') &&
        !error.message.includes(payerEmail)
      )
    )

    assert.equal(logged.length, 1)
    assert.equal(logged[0][0], 'Mercado Pago HTTP request rejected')
    assert.deepEqual(logged[0][1], {
      httpStatus: 400,
      providerCode: 'invalid_order',
      message:
        'Invalid payer [REDACTED_EMAIL]; [REDACTED]; [REDACTED]; [REDACTED]',
      cause: [{
        code: 'invalid_item',
        description: 'Invalid item for [REDACTED_EMAIL]'
      }],
      details: [{
        code: 'invalid_total',
        message: 'Rejected key [REDACTED]'
      }],
      path: '/v1/orders',
      method: 'POST'
    })

    const serializedLog = JSON.stringify(logged)
    for (const sensitiveValue of [
      accessToken,
      providerIdempotencyKey,
      payerEmail,
      'session-secret',
      'Authorization',
      'X-Idempotency-Key'
    ]) {
      assert.equal(serializedLog.includes(sensitiveValue), false)
    }
  })

  it('preserves existing HTTP mappings for 401, 403, 409, 423 and 5xx', async () => {
    const cases = [
      [401, {}, 'MERCADOPAGO_AUTH_ERROR', 502],
      [403, {}, 'MERCADOPAGO_AUTH_ERROR', 502],
      [409, { code: 'idempotency_key_already_used' }, 'MERCADOPAGO_IDEMPOTENCY_CONFLICT', 409],
      [423, { code: 'resource_locked' }, 'MERCADOPAGO_ORDER_CONFLICT', 409],
      [503, {}, 'MERCADOPAGO_UNAVAILABLE', 503]
    ]

    for (const [httpStatus, payload, expectedCode, expectedStatus] of cases) {
      const provider = makeProvider(
        async () => jsonResponse(payload, { status: httpStatus }),
        { errorLogger: () => {} }
      )

      await assert.rejects(
        provider.createCheckoutOrder({ providerIdempotencyKey, request: {} }),
        (error) => error.code === expectedCode && error.status === expectedStatus
      )
    }
  })

  it('maps HTTP 429 as rate limiting', async () => {
    const provider = makeProvider(async () => jsonResponse({}, { status: 429 }))
    await assert.rejects(
      provider.createCheckoutOrder({ providerIdempotencyKey, request: {} }),
      (error) => error.code === 'MERCADOPAGO_RATE_LIMIT'
    )
  })

  it('maps HTTP 5xx as provider unavailable', async () => {
    const provider = makeProvider(async () => jsonResponse({}, { status: 503 }))
    await assert.rejects(
      provider.createCheckoutOrder({ providerIdempotencyKey, request: {} }),
      (error) => error.code === 'MERCADOPAGO_UNAVAILABLE'
    )
  })

  it('maps documented HTTP 409 idempotency errors', async () => {
    const provider = makeProvider(async () =>
      jsonResponse({ code: 'idempotency_key_already_used' }, { status: 409 }))
    await assert.rejects(
      provider.createCheckoutOrder({ providerIdempotencyKey, request: {} }),
      (error) => error.code === 'MERCADOPAGO_IDEMPOTENCY_CONFLICT'
    )
  })

  it('maps documented HTTP 423 resource locks', async () => {
    const provider = makeProvider(async () =>
      jsonResponse({ code: 'resource_locked' }, { status: 423 }))
    await assert.rejects(
      provider.createCheckoutOrder({ providerIdempotencyKey, request: {} }),
      (error) => error.code === 'MERCADOPAGO_ORDER_CONFLICT'
    )
  })

  it('rejects a provider response without id', async () => {
    const provider = makeProvider(async () => jsonResponse(providerPayload({ id: null })))
    await assert.rejects(
      provider.createCheckoutOrder({ providerIdempotencyKey, request: {} }),
      (error) => error.code === 'MERCADOPAGO_INVALID_RESPONSE'
    )
  })

  it('rejects a provider response without status', async () => {
    const provider = makeProvider(async () => jsonResponse(providerPayload({ status: null })))
    await assert.rejects(
      provider.createCheckoutOrder({ providerIdempotencyKey, request: {} }),
      (error) => error.code === 'MERCADOPAGO_INVALID_RESPONSE'
    )
  })

  it('rejects a create response without checkout_url', async () => {
    const provider = makeProvider(async () =>
      jsonResponse(providerPayload({ checkout_url: null })))
    await assert.rejects(
      provider.createCheckoutOrder({ providerIdempotencyKey, request: {} }),
      (error) => error.code === 'MERCADOPAGO_INVALID_RESPONSE'
    )
  })

  it('rejects a checkout_url outside the expected Mercado Pago HTTPS host', async () => {
    const provider = makeProvider(async () =>
      jsonResponse(providerPayload({ checkout_url: 'https://evil.example/checkout' })))
    await assert.rejects(
      provider.createCheckoutOrder({ providerIdempotencyKey, request: {} }),
      (error) => error.code === 'MERCADOPAGO_INVALID_RESPONSE'
    )
  })

  it('normalizes only the necessary provider order fields', async () => {
    const provider = makeProvider(async () => jsonResponse(providerPayload()))
    const result = await provider.createCheckoutOrder({
      providerIdempotencyKey,
      request: {}
    })

    assert.deepEqual(result, {
      providerOrderId,
      status: 'created',
      checkoutUrl,
      externalReference: 'LC-2026-000001',
      totalAmount: '154500.00',
      createdAt: '2026-09-29T12:00:01.000Z'
    })
  })

  it('implements GET /v1/orders/{providerOrderId} as read-only normalization', async () => {
    let captured
    const provider = makeProvider(async (url, options) => {
      captured = { url, options }
      return jsonResponse(providerPayload({ checkout_url: undefined }), { status: 200 })
    })
    const result = await provider.getOrder(providerOrderId)

    assert.equal(captured.url, `${MERCADOPAGO_API_URL}/v1/orders/${providerOrderId}`)
    assert.equal(captured.options.method, 'GET')
    assert.equal(captured.options.headers.Authorization, 'Bearer test-access-token')
    assert.equal(result.providerOrderId, providerOrderId)
    assert.equal(result.checkoutUrl, null)
  })

  it('keeps legacy preferenceId and declares unique partial Orders API indexes', () => {
    const indexes = PaymentModel.schema.indexes()

    assert.ok(PaymentModel.schema.path('preferenceId'))
    assert.ok(PaymentModel.schema.path('providerOrderId'))
    assert.ok(PaymentModel.schema.path('providerCheckoutUrl'))
    assert.ok(PaymentModel.schema.path('providerIdempotencyKey'))
    assert.ok(indexes.some(([fields, options]) =>
      fields.provider === 1 && fields.providerOrderId === 1 && options.unique === true))
    assert.ok(indexes.some(([fields, options]) =>
      fields.provider === 1 && fields.providerIdempotencyKey === 1 && options.unique === true))
  })

  it('generates a backend provider idempotency key when Payment is created', async () => {
    let createdData
    const service = new PaymentService({
      orderManager: {
        async getById() {
          return {
            _id: orderId,
            orderNumber: 'LC-2026-000001',
            status: 'pending_payment',
            totals: { totalArs: '154500.00' },
            exchangeRateSnapshot: { source: 'BNA' }
          }
        }
      },
      paymentManager: {
        async create(data) {
          createdData = data
          return { _id: paymentId, ...data }
        }
      }
    })

    await service.createPayment({ orderId })
    assert.match(createdData.providerIdempotencyKey, /^[0-9a-f-]{36}$/)
    assert.equal(createdData.providerOrderId, null)
    assert.equal(createdData.providerCheckoutUrl, null)
    assert.equal(createdData.preferenceId, null)
  })

  it('builds Checkout Pro online/manual from authoritative local entities', async () => {
    const { service, state } = makeServiceHarness()
    await service.ensureCheckoutOrderForPayment(paymentId, { now })
    const request = state.providerCalls[0].request

    assert.equal(request.type, 'online')
    assert.equal(request.processing_mode, 'manual')
  })

  it('uses Order.totalArs and orderNumber without recalculating BNA', async () => {
    const { service, state } = makeServiceHarness()
    await service.ensureCheckoutOrderForPayment(paymentId, { now })
    const request = state.providerCalls[0].request

    assert.equal(request.total_amount, '154500.00')
    assert.equal(request.external_reference, 'LC-2026-000001')
    assert.equal(Object.hasOwn(request, 'exchangeRate'), false)
  })

  it('uses buyerSnapshot for payer data', async () => {
    const { service, state } = makeServiceHarness()
    await service.ensureCheckoutOrderForPayment(paymentId, { now })
    assert.deepEqual(state.providerCalls[0].request.payer, {
      email: 'buyer@example.com',
      first_name: 'Ada',
      last_name: 'Lovelace'
    })
  })

  it('uses one exact ARS summary item instead of converting OrderItems separately', async () => {
    const { service, state } = makeServiceHarness()
    await service.ensureCheckoutOrderForPayment(paymentId, { now })
    assert.deepEqual(state.providerCalls[0].request.items, [{
      title: 'Pedido LC COMP LC-2026-000001',
      external_code: 'LC-2026-000001',
      quantity: 1,
      unit_price: '154500.00',
      total_amount: '154500.00',
      unit_measure: 'unit'
    }])
  })

  it('builds return URLs and approved auto_return from backend configuration', async () => {
    const { service, state } = makeServiceHarness()
    await service.ensureCheckoutOrderForPayment(paymentId, { now })
    assert.deepEqual(state.providerCalls[0].request.config.online, {
      available_from: now.toISOString(),
      success_url: 'https://www.lccomp.com.ar/checkout/success',
      failure_url: 'https://www.lccomp.com.ar/checkout/failure',
      pending_url: 'https://www.lccomp.com.ar/checkout/pending',
      auto_return: 'approved'
    })
  })

  it('uses the exact remaining reservation duration as ISO 8601 expiration_time', async () => {
    const { service, state } = makeServiceHarness()
    await service.ensureCheckoutOrderForPayment(paymentId, { now })
    assert.equal(state.providerCalls[0].request.expiration_time, 'PT5H59M30S')
    assert.equal(toIsoDuration(6 * 60 * 60 * 1000), 'PT6H')
  })

  it('rejects localhost return configuration before calling Mercado Pago', async () => {
    const { service, state } = makeServiceHarness({
      returnBaseUrl: 'http://localhost:5173'
    })
    await assert.rejects(
      service.ensureCheckoutOrderForPayment(paymentId, { now }),
      (error) => error.code === 'MERCADOPAGO_RETURN_URL_INVALID'
    )
    assert.equal(state.providerCalls.length, 0)
  })

  it('returns an already-associated provider order without another HTTP call', async () => {
    const { service, state } = makeServiceHarness({
      payment: {
        providerOrderId,
        providerCheckoutUrl: checkoutUrl,
        providerStatus: 'created'
      }
    })
    const result = await service.ensureCheckoutOrderForPayment(paymentId, { now })

    assert.equal(result.providerOrderId, providerOrderId)
    assert.equal(state.providerCalls.length, 0)
  })

  it('creates a provider order when Payment has no providerOrderId', async () => {
    const { service, state } = makeServiceHarness()
    const result = await service.ensureCheckoutOrderForPayment(paymentId, { now })
    assert.equal(state.providerCalls.length, 1)
    assert.equal(result.providerOrderId, providerOrderId)
  })

  it('rejects a Payment that is not pending', async () => {
    const { service, state } = makeServiceHarness({
      payment: { normalizedStatus: 'approved' }
    })
    await assert.rejects(
      service.ensureCheckoutOrderForPayment(paymentId, { now }),
      (error) => error.code === 'PAYMENT_NOT_PENDING'
    )
    assert.equal(state.providerCalls.length, 0)
  })

  it('rejects a non-Mercado Pago Payment', async () => {
    const { service } = makeServiceHarness({ payment: { provider: 'other' } })
    await assert.rejects(
      service.ensureCheckoutOrderForPayment(paymentId, { now }),
      (error) => error.code === 'PAYMENT_PROVIDER_NOT_SUPPORTED'
    )
  })

  it('rejects an Order that is not pending_payment', async () => {
    const { service, state } = makeServiceHarness({ order: { status: 'paid' } })
    await assert.rejects(
      service.ensureCheckoutOrderForPayment(paymentId, { now }),
      (error) => error.code === 'ORDER_NOT_PENDING_PAYMENT'
    )
    assert.equal(state.providerCalls.length, 0)
  })

  it('rejects an expired local reservation', async () => {
    const { service, state } = makeServiceHarness({
      order: { reservationExpiresAt: new Date(now.getTime() - 1) }
    })
    await assert.rejects(
      service.ensureCheckoutOrderForPayment(paymentId, { now }),
      (error) => error.code === 'MERCADOPAGO_CHECKOUT_EXPIRED'
    )
    assert.equal(state.providerCalls.length, 0)
  })

  it('requires the authoritative exchange-rate snapshot', async () => {
    const { service } = makeServiceHarness({ order: { exchangeRateSnapshot: null } })
    await assert.rejects(
      service.ensureCheckoutOrderForPayment(paymentId, { now }),
      (error) => error.code === 'ORDER_ARS_TOTAL_REQUIRED'
    )
  })

  it('rejects Payment and Order amount divergence', async () => {
    const { service, state } = makeServiceHarness({ payment: { amountArs: '1.00' } })
    await assert.rejects(
      service.ensureCheckoutOrderForPayment(paymentId, { now }),
      (error) => error.code === 'MERCADOPAGO_ORDER_CONFLICT'
    )
    assert.equal(state.providerCalls.length, 0)
  })

  it('rejects a provider external_reference mismatch without persisting it', async () => {
    const { service, state } = makeServiceHarness({
      providerResult: { externalReference: 'OTHER-ORDER' }
    })
    await assert.rejects(
      service.ensureCheckoutOrderForPayment(paymentId, { now }),
      (error) => error.code === 'MERCADOPAGO_INVALID_RESPONSE'
    )
    assert.equal(state.payment.providerOrderId, null)
  })

  it('rejects a provider total mismatch when total_amount is returned', async () => {
    const { service, state } = makeServiceHarness({
      providerResult: { totalAmount: '154499.99' }
    })
    await assert.rejects(
      service.ensureCheckoutOrderForPayment(paymentId, { now }),
      (error) => error.code === 'MERCADOPAGO_INVALID_RESPONSE'
    )
    assert.equal(state.payment.providerOrderId, null)
  })

  it('persists providerOrderId, checkoutUrl and providerStatus while local states remain pending', async () => {
    const { service, state } = makeServiceHarness()
    await service.ensureCheckoutOrderForPayment(paymentId, { now })

    assert.equal(state.payment.providerOrderId, providerOrderId)
    assert.equal(state.payment.providerCheckoutUrl, checkoutUrl)
    assert.equal(state.payment.providerStatus, 'created')
    assert.equal(state.payment.normalizedStatus, 'pending')
    assert.equal(state.order.status, 'pending_payment')
  })

  it('keeps local Checkout committed when Mercado Pago fails', async () => {
    const { service, state } = makeServiceHarness({
      payment: { providerIdempotencyKey: null },
      providerError: new MercadoPagoProviderError(
        'No disponible',
        'MERCADOPAGO_UNAVAILABLE',
        503
      )
    })
    await assert.rejects(
      service.ensureCheckoutOrderForPayment(paymentId, { now }),
      (error) => error.code === 'MERCADOPAGO_UNAVAILABLE'
    )

    assert.equal(state.payment.normalizedStatus, 'pending')
    assert.equal(state.order.status, 'pending_payment')
    assert.equal(state.payment.providerOrderId, null)
    assert.equal(state.payment.providerIdempotencyKey, providerIdempotencyKey)
  })

  it('keeps HTTP 400 provider details out of the public ServiceError', async () => {
    const providerMessage = 'internal provider validation detail'
    const httpProvider = makeProvider(
      async () => jsonResponse({
        code: 'invalid_order',
        message: providerMessage,
        payer: { email: 'private@example.com' }
      }, { status: 400 }),
      { errorLogger: () => {} }
    )
    const { service, state, provider } = makeServiceHarness({
      payment: { providerIdempotencyKey: null }
    })
    provider.createCheckoutOrder = (input) => httpProvider.createCheckoutOrder(input)

    await assert.rejects(
      service.ensureCheckoutOrderForPayment(paymentId, { now }),
      (error) => (
        error.code === 'MERCADOPAGO_ORDER_REJECTED' &&
        error.status === 502 &&
        !error.message.includes(providerMessage) &&
        !error.message.includes('private@example.com')
      )
    )

    assert.equal(state.payment.normalizedStatus, 'pending')
    assert.equal(state.order.status, 'pending_payment')
    assert.equal(state.payment.providerOrderId, null)
  })

  it('reuses the same providerIdempotencyKey after a failed external attempt', async () => {
    const { service, state, provider } = makeServiceHarness({
      payment: { providerIdempotencyKey: null }
    })
    let attempt = 0
    provider.createCheckoutOrder = async (input) => {
      state.providerKeys.push(input.providerIdempotencyKey)
      attempt += 1
      if (attempt === 1) {
        throw new MercadoPagoProviderError('timeout', 'MERCADOPAGO_TIMEOUT', 504)
      }
      return {
        providerOrderId,
        status: 'created',
        checkoutUrl,
        externalReference: 'LC-2026-000001',
        totalAmount: '154500.00'
      }
    }

    await assert.rejects(service.ensureCheckoutOrderForPayment(paymentId, { now }))
    await service.ensureCheckoutOrderForPayment(paymentId, { now })
    assert.deepEqual(state.providerKeys, [providerIdempotencyKey, providerIdempotencyKey])
  })

  it('uses one stable key and one local association during concurrent calls', async () => {
    let releaseProvider
    let arrived = 0
    const gate = new Promise((resolve) => { releaseProvider = resolve })
    const { service, state, provider } = makeServiceHarness({
      payment: { providerIdempotencyKey: null }
    })
    provider.createCheckoutOrder = async (input) => {
      state.providerKeys.push(input.providerIdempotencyKey)
      arrived += 1
      if (arrived === 2) releaseProvider()
      await gate
      return {
        providerOrderId,
        status: 'created',
        checkoutUrl,
        externalReference: 'LC-2026-000001',
        totalAmount: '154500.00'
      }
    }

    const [first, second] = await Promise.all([
      service.ensureCheckoutOrderForPayment(paymentId, { now }),
      service.ensureCheckoutOrderForPayment(paymentId, { now })
    ])

    assert.equal(first.providerOrderId, providerOrderId)
    assert.equal(second.providerOrderId, providerOrderId)
    assert.deepEqual(state.providerKeys, [providerIdempotencyKey, providerIdempotencyKey])
    assert.equal(state.successfulAttachments, 1)
  })

  it('does not expose caller authority for amount or provider status', async () => {
    const { service, state } = makeServiceHarness()
    await service.ensureCheckoutOrderForPayment(paymentId, {
      now,
      amountArs: '0.01',
      providerStatus: 'approved'
    })

    assert.equal(state.providerCalls[0].request.total_amount, '154500.00')
    assert.equal(state.payment.normalizedStatus, 'pending')
  })
})
