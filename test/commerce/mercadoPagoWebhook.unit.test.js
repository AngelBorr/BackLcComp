/* eslint-env mocha */
import assert from 'node:assert/strict'
import { createHash, createHmac } from 'node:crypto'
import express from 'express'
import mongoose from 'mongoose'
import request from 'supertest'
import PaymentModel from '../../src/dao/models/payment.model.js'
import PaymentEventModel from '../../src/dao/models/paymentEvent.model.js'
import PaymentManager from '../../src/dao/managers/payment.manager.js'
import OrderManager from '../../src/dao/managers/order.manager.js'
import OrderItemManager from '../../src/dao/managers/orderItem.manager.js'
import ProductUnitManager from '../../src/dao/managers/productUnit.manager.js'
import ProductUnitService from '../../src/services/productUnit.service.js'
import {
  MercadoPagoReconciliationService
} from '../../src/services/mercadoPagoReconciliation.service.js'
import {
  MercadoPagoWebhookService
} from '../../src/services/mercadoPagoWebhook.service.js'
import WebhooksRouter from '../../src/routes/webhooks.router.js'
import MercadoPagoWebhookControllerInstance, {
  MercadoPagoWebhookController
} from '../../src/controllers/mercadoPagoWebhook.controller.js'
import {
  buildSignatureManifest,
  constantTimeHexEqual,
  validateMercadoPagoWebhookSignature
} from '../../src/utils/mercadoPagoWebhookSignature.js'
import {
  MercadoPagoProviderError,
  normalizeProviderOrder
} from '../../src/providers/mercadoPago.provider.js'

const secret = 'synthetic-webhook-secret'
const timestamp = '1742505638'
const requestId = '2066ca19-c6f1-498a-be75-1923005edd06'
const providerOrderId = 'ORD01M28P44G5FG8RJPM579EH56FV'
const providerEventId = '123456'
const orderId = new mongoose.Types.ObjectId().toString()
const paymentId = new mongoose.Types.ObjectId().toString()
const orderItemId = new mongoose.Types.ObjectId().toString()
const productId = new mongoose.Types.ObjectId().toString()
const unitId = new mongoose.Types.ObjectId().toString()
const now = new Date('2026-09-29T12:00:00.000Z')

const signatureFor = (
  dataId = providerOrderId,
  valueSecret = secret,
  valueRequestId = requestId
) => {
  const manifest = buildSignatureManifest({
    dataId,
    xRequestId: valueRequestId,
    timestamp
  })
  const hash = createHmac('sha256', valueSecret).update(manifest).digest('hex')
  return `ts=${timestamp},v1=${hash}`
}

const deliveryEventIdFor = (dataId, valueRequestId) =>
  `delivery:${createHash('sha256')
    .update(`mercado_pago:order:${dataId}:${valueRequestId}`)
    .digest('hex')}`

const webhookInput = (overrides = {}) => ({
  query: { type: 'order', 'data.id': providerOrderId, ...overrides.query },
  headers: {
    xSignature: signatureFor(),
    xRequestId: requestId,
    ...overrides.headers
  },
  body: {
    id: providerEventId,
    type: 'order',
    action: 'order.processed',
    data: { id: providerOrderId },
    ...overrides.body
  }
})

const sandboxWebhookBody = ({
  eventId,
  dataId = providerOrderId
} = {}) => ({
  action: 'order.processed',
  api_version: 'v1',
  application_id: 'sandbox-application',
  data: { id: dataId },
  date_created: '2026-10-04T20:00:00.000Z',
  live_mode: false,
  type: 'order',
  user_id: 123456,
  ...(eventId !== undefined && { id: eventId })
})

const providerOrder = (overrides = {}) => ({
  providerOrderId,
  status: 'processed',
  statusDetail: 'accredited',
  externalReference: 'LC-2026-000001',
  totalAmount: '154500.00',
  totalPaidAmount: '154500.00',
  currency: 'ARS',
  lastUpdatedDate: '2026-09-29T11:59:59.000Z',
  payments: [
    {
      providerPaymentId: 'PAY01M28P44GDSD4JYTSK5SYZT6BH',
      status: 'processed',
      statusDetail: 'accredited',
      amount: '154500.00',
      paidAmount: '154500.00'
    }
  ],
  ...overrides
})

const clone = (value) => structuredClone(value)

const createTransactionHarness = (state) => ({
  async startSession() {
    let active = false
    return {
      hasEnded: false,
      inTransaction: () => active,
      async withTransaction(callback) {
        const snapshot = clone(state)
        active = true
        try {
          await callback()
        } catch (error) {
          for (const key of Object.keys(state)) delete state[key]
          Object.assign(state, snapshot)
          throw error
        } finally {
          active = false
        }
      },
      async endSession() {
        this.hasEnded = true
      }
    }
  }
})

const createReconciliationHarness = (overrides = {}) => {
  const state = {
    order: {
      _id: orderId,
      orderNumber: 'LC-2026-000001',
      status: 'pending_payment',
      totals: { totalArs: '154500.00' },
      reservationExpiresAt: new Date('2026-09-29T18:00:00.000Z'),
      statusHistory: []
    },
    payment: {
      _id: paymentId,
      orderId,
      provider: 'mercado_pago',
      providerOrderId,
      providerPaymentId: null,
      providerStatus: 'created',
      providerStatusDetail: null,
      externalReference: 'LC-2026-000001',
      normalizedStatus: 'pending',
      amountArs: '154500.00',
      approvedAt: null
    },
    units: [
      {
        _id: unitId,
        productId,
        orderId,
        orderItemId,
        reservedByOrderId: orderId,
        status: 'reserved',
        isDeleted: false,
        soldAt: null
      }
    ],
    prodStock: 0,
    providerCalls: 0,
    confirmCalls: 0,
    associationCalls: 0,
    ...clone(overrides.state || {})
  }

  Object.assign(state.order, overrides.order || {})
  Object.assign(state.payment, overrides.payment || {})
  if (overrides.units) state.units = clone(overrides.units)

  const orderManager = {
    async getById(id) {
      return String(id) === String(state.order._id) ? clone(state.order) : null
    },
    async getByOrderNumber(orderNumber) {
      return orderNumber === state.order.orderNumber ? clone(state.order) : null
    },
    async updateStatus(id, expectedStatus, { nextStatus, changedAt, reason }) {
      if (String(id) !== String(state.order._id) || state.order.status !== expectedStatus) return null
      state.order.status = nextStatus
      state.order.statusHistory.push({ status: nextStatus, changedAt, reason })
      if (nextStatus === 'paid') state.order.paidAt = changedAt
      if (nextStatus === 'requires_attention') state.order.attentionReason = reason
      return clone(state.order)
    }
  }

  const paymentManager = {
    async getByProviderOrderId(_provider, id) {
      return state.payment.providerOrderId === id ? clone(state.payment) : null
    },
    async getById(id) {
      return String(id) === String(state.payment._id) ? clone(state.payment) : null
    },
    async getLatestByOrderId(id) {
      return String(id) === String(state.payment.orderId) ? clone(state.payment) : null
    },
    async getByProviderPaymentId(id) {
      if (overrides.conflictingProviderPaymentId === id) {
        return { _id: new mongoose.Types.ObjectId().toString(), providerPaymentId: id }
      }
      return state.payment.providerPaymentId === id ? clone(state.payment) : null
    },
    async associateProviderOrderIfMissing(id, newProviderOrderId, metadata) {
      state.associationCalls += 1
      if (
        String(id) !== String(state.payment._id) ||
        state.payment.providerOrderId ||
        state.payment.normalizedStatus !== 'pending'
      ) return null
      state.payment.providerOrderId = newProviderOrderId
      Object.assign(state.payment, metadata)
      return clone(state.payment)
    },
    async updateProviderObservation(id, update) {
      if (String(id) !== String(state.payment._id)) return null
      Object.assign(state.payment, update)
      return clone(state.payment)
    },
    async updateStatus(id, expectedStatus, update) {
      if (String(id) !== String(state.payment._id) || state.payment.normalizedStatus !== expectedStatus) {
        return null
      }
      Object.assign(state.payment, update)
      return clone(state.payment)
    }
  }

  const productUnitService = {
    async inspectOrderReservation() {
      if (overrides.inspection) return clone(overrides.inspection)
      const reserved = state.units.filter((unit) =>
        unit.status === 'reserved' &&
        unit.isDeleted === false &&
        unit.orderId === orderId &&
        unit.orderItemId === orderItemId
      )
      return {
        valid: reserved.length === 1,
        reason: reserved.length === 1 ? null : 'RESERVATION_QUANTITY_MISMATCH',
        expectedCount: 1,
        units: clone(reserved)
      }
    },
    async confirmReservedUnitsSold(_input, { session }) {
      state.confirmCalls += 1
      assert.equal(session.inTransaction(), true)
      assert.equal(state.payment.normalizedStatus, 'approved')
      if (overrides.confirmConflict) {
        const error = new Error('simulated reservation race')
        error.code = 'RESERVATION_SALE_CONFLICT'
        throw error
      }
      for (const unit of state.units) {
        if (unit.status === 'reserved' && unit.orderId === orderId) {
          unit.status = 'sold'
          unit.soldAt = now
        }
      }
      return { soldCount: 1 }
    }
  }

  const provider = {
    async getOrder(id) {
      state.providerCalls += 1
      if (overrides.providerError) throw overrides.providerError
      assert.equal(id, providerOrderId)
      return providerOrder(overrides.providerOrder || {})
    }
  }

  const service = new MercadoPagoReconciliationService({
    mongooseInstance: createTransactionHarness(state),
    orderManager,
    paymentManager,
    productUnitService,
    provider
  })

  return { service, state }
}

const createWebhookHarness = (overrides = {}) => {
  const events = new Map()
  let reconciliationCalls = 0
  let createdEvents = 0

  if (overrides.existingEvent) {
    events.set(providerEventId, clone(overrides.existingEvent))
  }

  const paymentEventManager = {
    async claimForProcessing(input) {
      const existing = events.get(input.providerEventId)
      if (existing && !['failed', 'received'].includes(existing.processingStatus)) {
        return { event: clone(existing), claimed: false }
      }
      const event = existing || {
        _id: new mongoose.Types.ObjectId().toString(),
        providerEventId: input.providerEventId,
        attempts: 0
      }
      if (!existing) createdEvents += 1
      Object.assign(event, input, {
        processingStatus: 'processing',
        attempts: event.attempts + 1
      })
      events.set(input.providerEventId, event)
      return { event: clone(event), claimed: true }
    },
    async markProcessed(id, update) {
      const event = [...events.values()].find((candidate) => candidate._id === id)
      if (!event || event.processingStatus !== 'processing') return null
      Object.assign(event, update, { processingStartedAt: null })
      return clone(event)
    },
    async markFailed(id, lastError) {
      const event = [...events.values()].find((candidate) => candidate._id === id)
      if (!event) return null
      Object.assign(event, {
        processingStatus: 'failed',
        processingStartedAt: null,
        lastError
      })
      return clone(event)
    }
  }
  const reconciliationService = {
    async reconcileProviderOrder(id) {
      reconciliationCalls += 1
      assert.equal(id, providerOrderId)
      if (overrides.reconciliationGate) await overrides.reconciliationGate()
      if (overrides.reconciliationError) throw overrides.reconciliationError
      return overrides.reconciliationResult || {
        outcome: 'paid',
        orderId,
        paymentId,
        providerPaymentId: 'PAY-1'
      }
    }
  }
  const service = new MercadoPagoWebhookService({
    paymentEventManager,
    reconciliationService,
    webhookSecret: secret
  })

  return {
    service,
    events,
    get reconciliationCalls() { return reconciliationCalls },
    get createdEvents() { return createdEvents }
  }
}

const createWebhookHttpHarness = (overrides = {}) => {
  const harness = createWebhookHarness(overrides)
  const previousService = MercadoPagoWebhookControllerInstance.webhookService
  MercadoPagoWebhookControllerInstance.webhookService = harness.service

  const app = express()
  app.use(express.json())
  app.use('/api/webhooks', new WebhooksRouter().getRouter())

  return {
    app,
    harness,
    restore() {
      MercadoPagoWebhookControllerInstance.webhookService = previousService
    }
  }
}

const postWebhook = ({
  app,
  body,
  dataId = providerOrderId,
  valueRequestId = requestId,
  xSignature = signatureFor(dataId, secret, valueRequestId)
}) => request(app)
  .post('/api/webhooks/mercadopago')
  .query({ type: 'order', 'data.id': dataId })
  .set('x-signature', xSignature)
  .set('x-request-id', valueRequestId)
  .set('content-type', 'application/json')
  .send(body)

describe('Mercado Pago webhook HTTP delivery identity (isolated)', () => {
  const restorations = []

  afterEach(() => {
    while (restorations.length) restorations.pop()()
  })

  const setup = (overrides) => {
    const context = createWebhookHttpHarness(overrides)
    restorations.push(context.restore)
    return context
  }

  it('uses the real provider event id when body.id is present', async () => {
    const { app, harness } = setup()

    const response = await postWebhook({
      app,
      body: sandboxWebhookBody({ eventId: providerEventId })
    })

    assert.equal(response.status, 200)
    assert.equal(harness.events.has(providerEventId), true)
    assert.equal(harness.createdEvents, 1)
    assert.equal(harness.reconciliationCalls, 1)
  })

  it('accepts a finite numeric body.id and persists it as text', async () => {
    const { app, harness } = setup()

    const response = await postWebhook({
      app,
      body: sandboxWebhookBody({ eventId: 123456 })
    })

    assert.equal(response.status, 200)
    assert.equal(harness.events.has('123456'), true)
  })

  it('generates a stable delivery id after valid signature when body.id is absent', async () => {
    const { app, harness } = setup()
    const expectedEventId = deliveryEventIdFor(providerOrderId, requestId)

    const first = await postWebhook({ app, body: sandboxWebhookBody() })
    const second = await postWebhook({ app, body: sandboxWebhookBody() })

    assert.equal(first.status, 200)
    assert.equal(second.status, 200)
    assert.match(expectedEventId, /^delivery:[a-f0-9]{64}$/)
    assert.equal(harness.events.has(expectedEventId), true)
    assert.equal(harness.createdEvents, 1)
    assert.equal(harness.reconciliationCalls, 1)
  })

  it('uses a different fallback for a different signed x-request-id', async () => {
    const { app, harness } = setup()
    const otherRequestId = 'd03c5bb9-5837-4edf-9034-1b5a32f9ffb8'

    const first = await postWebhook({ app, body: sandboxWebhookBody() })
    const second = await postWebhook({
      app,
      body: sandboxWebhookBody(),
      valueRequestId: otherRequestId
    })

    const firstEventId = deliveryEventIdFor(providerOrderId, requestId)
    const secondEventId = deliveryEventIdFor(providerOrderId, otherRequestId)

    assert.equal(first.status, 200)
    assert.equal(second.status, 200)
    assert.notEqual(firstEventId, secondEventId)
    assert.equal(harness.events.has(firstEventId), true)
    assert.equal(harness.events.has(secondEventId), true)
    assert.equal(harness.reconciliationCalls, 2)
  })

  it('does not generate or process an event without body.id when signature is invalid', async () => {
    const { app, harness } = setup()

    const response = await postWebhook({
      app,
      body: sandboxWebhookBody(),
      xSignature: `ts=${timestamp},v1=${'0'.repeat(64)}`
    })

    assert.equal(response.status, 401)
    assert.equal(harness.events.size, 0)
    assert.equal(harness.createdEvents, 0)
    assert.equal(harness.reconciliationCalls, 0)
  })

  it('rejects a query/body provider order mismatch without effects', async () => {
    const { app, harness } = setup()

    const response = await postWebhook({
      app,
      body: sandboxWebhookBody({ dataId: 'OTHER-ORDER' })
    })

    assert.equal(response.status, 400)
    assert.equal(harness.events.size, 0)
    assert.equal(harness.reconciliationCalls, 0)
  })

  for (const invalidEventId of ['', null, [], {}, true]) {
    it(`rejects an invalid explicit body.id (${JSON.stringify(invalidEventId)})`, async () => {
      const { app, harness } = setup()

      const response = await postWebhook({
        app,
        body: sandboxWebhookBody({ eventId: invalidEventId })
      })

      assert.equal(response.status, 400)
      assert.equal(harness.events.size, 0)
      assert.equal(harness.reconciliationCalls, 0)
    })
  }
})

describe('Mercado Pago webhook signature (isolated)', () => {
  it('accepts a valid HMAC-SHA256 signature', () => {
    assert.equal(validateMercadoPagoWebhookSignature({
      xSignature: signatureFor(), xRequestId: requestId, dataId: providerOrderId, secret
    }), true)
  })

  it('preserves data.id casing exactly like the current official SDK', () => {
    assert.throws(() => validateMercadoPagoWebhookSignature({
      xSignature: signatureFor(providerOrderId.toLowerCase()),
      xRequestId: requestId,
      dataId: providerOrderId,
      secret
    }), (error) => error.code === 'MERCADOPAGO_WEBHOOK_SIGNATURE_INVALID')
  })

  it('rejects an invalid signature', () => {
    assert.throws(() => validateMercadoPagoWebhookSignature({
      xSignature: `ts=${timestamp},v1=${'0'.repeat(64)}`,
      xRequestId: requestId,
      dataId: providerOrderId,
      secret
    }), (error) => error.status === 401)
  })

  it('rejects a missing x-signature', () => {
    assert.throws(() => validateMercadoPagoWebhookSignature({
      xRequestId: requestId, dataId: providerOrderId, secret
    }), (error) => error.code === 'MERCADOPAGO_WEBHOOK_SIGNATURE_REQUIRED')
  })

  it('rejects a missing x-request-id', () => {
    assert.throws(() => validateMercadoPagoWebhookSignature({
      xSignature: signatureFor(), dataId: providerOrderId, secret
    }), (error) => error.code === 'MERCADOPAGO_WEBHOOK_REQUEST_ID_REQUIRED')
  })

  it('rejects a missing data.id', () => {
    assert.throws(() => validateMercadoPagoWebhookSignature({
      xSignature: signatureFor(), xRequestId: requestId, secret
    }), (error) => error.code === 'MERCADOPAGO_WEBHOOK_ORDER_ID_REQUIRED')
  })

  it('fails safely when the secret is missing', () => {
    assert.throws(() => validateMercadoPagoWebhookSignature({
      xSignature: signatureFor(), xRequestId: requestId, dataId: providerOrderId
    }), (error) => error.code === 'MERCADOPAGO_WEBHOOK_NOT_CONFIGURED' && error.status === 503)
  })

  it('uses the constant-time comparison helper for equal-length hashes', () => {
    assert.equal(constantTimeHexEqual('aa'.repeat(32), 'aa'.repeat(32)), true)
    assert.equal(constantTimeHexEqual('aa'.repeat(32), 'ab'.repeat(32)), false)
    assert.equal(constantTimeHexEqual('aa'.repeat(32), 'aa'), false)
  })
})

describe('Mercado Pago provider reconciliation normalization (isolated)', () => {
  it('normalizes only reconciliation fields and excludes sensitive payment data', () => {
    const result = normalizeProviderOrder({
      id: providerOrderId,
      status: 'processed',
      status_detail: 'accredited',
      external_reference: 'LC-2026-000001',
      total_amount: '154500.00',
      total_paid_amount: '154500.00',
      currency: 'ARS',
      client_token: 'must-not-leak',
      transactions: {
        payments: [{
          id: 'PAY-1',
          status: 'processed',
          status_detail: 'accredited',
          amount: '154500.00',
          paid_amount: '154500.00',
          payment_method: { token: 'must-not-leak', qr_code: 'must-not-leak' }
        }]
      }
    }, { includeReconciliation: true })

    assert.equal(result.statusDetail, 'accredited')
    assert.equal(result.payments[0].providerPaymentId, 'PAY-1')
    assert.equal(Object.hasOwn(result, 'clientToken'), false)
    assert.equal(Object.hasOwn(result.payments[0], 'paymentMethod'), false)
  })
})

describe('Mercado Pago webhook orchestration (isolated)', () => {
  it('processes a valid order webhook synchronously and records PaymentEvent', async () => {
    const harness = createWebhookHarness()
    const result = await harness.service.handleWebhook(webhookInput(), { now })
    assert.deepEqual(result, { received: true, duplicate: false })
    assert.equal(harness.createdEvents, 1)
    assert.equal(harness.reconciliationCalls, 1)
    assert.equal(harness.events.get(providerEventId).processingStatus, 'processed')
  })

  it('rejects invalid signature before PaymentEvent or provider work', async () => {
    const harness = createWebhookHarness()
    await assert.rejects(
      harness.service.handleWebhook(webhookInput({
        headers: { xSignature: `ts=${timestamp},v1=${'0'.repeat(64)}` }
      }), { now }),
      (error) => error.status === 401
    )
    assert.equal(harness.createdEvents, 0)
    assert.equal(harness.reconciliationCalls, 0)
  })

  it('rejects query/body provider order mismatch before effects', async () => {
    const harness = createWebhookHarness()
    await assert.rejects(
      harness.service.handleWebhook(webhookInput({ body: { data: { id: 'OTHER' } } }), { now }),
      (error) => error.code === 'MERCADOPAGO_WEBHOOK_ORDER_ID_MISMATCH'
    )
    assert.equal(harness.createdEvents, 0)
    assert.equal(harness.reconciliationCalls, 0)
  })

  it('returns an already processed duplicate without another provider GET', async () => {
    const harness = createWebhookHarness({
      existingEvent: {
        _id: new mongoose.Types.ObjectId().toString(),
        providerEventId,
        processingStatus: 'processed',
        attempts: 1
      }
    })
    const result = await harness.service.handleWebhook(webhookInput(), { now })
    assert.deepEqual(result, { received: true, duplicate: true })
    assert.equal(harness.reconciliationCalls, 0)
  })

  it('allows a failed event to be claimed and retried', async () => {
    const harness = createWebhookHarness({
      existingEvent: {
        _id: new mongoose.Types.ObjectId().toString(),
        providerEventId,
        processingStatus: 'failed',
        attempts: 1
      }
    })
    await harness.service.handleWebhook(webhookInput(), { now })
    assert.equal(harness.reconciliationCalls, 1)
    assert.equal(harness.events.get(providerEventId).attempts, 2)
  })

  it('marks transient provider failure as failed with sanitized error', async () => {
    const error = new Error('raw provider response with sensitive details')
    error.code = 'MERCADOPAGO_UNAVAILABLE'
    error.status = 503
    const harness = createWebhookHarness({ reconciliationError: error })

    await assert.rejects(harness.service.handleWebhook(webhookInput(), { now }))
    const event = harness.events.get(providerEventId)
    assert.equal(event.processingStatus, 'failed')
    assert.equal(event.lastError.code, 'MERCADOPAGO_UNAVAILABLE')
    assert.equal(event.lastError.message.includes('sensitive'), false)
  })

  it('marks an unknown signed provider order ignored instead of creating commerce data', async () => {
    const harness = createWebhookHarness({
      reconciliationResult: {
        outcome: 'ignored', orderId: null, paymentId: null, providerPaymentId: null
      }
    })
    await harness.service.handleWebhook(webhookInput(), { now })
    assert.equal(harness.events.get(providerEventId).processingStatus, 'ignored')
  })

  it('allows only one concurrent webhook to run financial effects', async () => {
    let release
    const gate = new Promise((resolve) => { release = resolve })
    const harness = createWebhookHarness({ reconciliationGate: () => gate })
    const first = harness.service.handleWebhook(webhookInput(), { now })
    await Promise.resolve()
    const second = harness.service.handleWebhook(webhookInput(), { now })
    await assert.rejects(second, (error) => error.code === 'MERCADOPAGO_WEBHOOK_IN_PROGRESS')
    release()
    await first
    assert.equal(harness.reconciliationCalls, 1)
  })

  it('controller maps an invalid signature to 401 without exposing internals', async () => {
    const signatureError = new Error('Firma de Mercado Pago invÃ¡lida')
    signatureError.code = 'MERCADOPAGO_WEBHOOK_SIGNATURE_INVALID'
    signatureError.status = 401
    const controller = new MercadoPagoWebhookController({
      webhookService: { async handleWebhook() { throw signatureError } }
    })
    const response = {
      statusCode: null,
      body: null,
      status(code) { this.statusCode = code; return this },
      json(body) { this.body = body; return this }
    }
    await controller.handle({ query: {}, body: {}, get: () => undefined }, response)
    assert.equal(response.statusCode, 401)
    assert.deepEqual(response.body, { received: false, message: 'Firma de Mercado Pago invÃ¡lida' })
  })
})

describe('Mercado Pago authoritative reconciliation (isolated)', () => {
  for (const status of ['created', 'processing', 'action_required']) {
    it(`keeps local entities pending for provider status ${status}`, async () => {
      const { service, state } = createReconciliationHarness({
        providerOrder: { status, statusDetail: null, payments: [] }
      })
      const result = await service.reconcileProviderOrder(providerOrderId, { now })
      assert.equal(result.outcome, 'pending')
      assert.equal(state.payment.normalizedStatus, 'pending')
      assert.equal(state.order.status, 'pending_payment')
      assert.equal(state.units[0].status, 'reserved')
    })
  }

  it('atomically approves Payment, pays Order and sells all reserved units', async () => {
    const { service, state } = createReconciliationHarness()
    const result = await service.reconcileProviderOrder(providerOrderId, { now })
    assert.equal(result.outcome, 'paid')
    assert.equal(state.payment.normalizedStatus, 'approved')
    assert.equal(state.payment.providerPaymentId, 'PAY01M28P44GDSD4JYTSK5SYZT6BH')
    assert.equal(state.order.status, 'paid')
    assert.equal(state.units[0].status, 'sold')
    assert.deepEqual(state.units[0].soldAt, now)
    assert.equal(state.prodStock, 0)
  })

  it('recovers an early webhook through externalReference and CAS association', async () => {
    const { service, state } = createReconciliationHarness({ payment: { providerOrderId: null } })
    await service.reconcileProviderOrder(providerOrderId, { now })
    assert.equal(state.associationCalls, 1)
    assert.equal(state.payment.providerOrderId, providerOrderId)
    assert.equal(state.order.status, 'paid')
  })

  for (const mismatch of [
    { name: 'external reference', providerOrder: { externalReference: 'OTHER' } },
    { name: 'total amount', providerOrder: { totalAmount: '1.00' } },
    { name: 'currency', providerOrder: { currency: 'USD' } }
  ]) {
    it(`prevents paid/sold on ${mismatch.name} mismatch`, async () => {
      const { service, state } = createReconciliationHarness(mismatch)
      const result = await service.reconcileProviderOrder(providerOrderId, { now })
      assert.equal(result.outcome, 'requires_attention')
      assert.equal(state.payment.normalizedStatus, 'requires_attention')
      assert.equal(state.order.status, 'requires_attention')
      assert.equal(state.units[0].status, 'reserved')
    })
  }

  for (const invalidPayment of [
    { name: 'missing transaction', payments: [] },
    {
      name: 'ambiguous transactions',
      payments: [providerOrder().payments[0], { ...providerOrder().payments[0], providerPaymentId: 'PAY-2' }]
    },
    {
      name: 'inconsistent transaction amount',
      payments: [{ ...providerOrder().payments[0], paidAmount: '1.00' }]
    }
  ]) {
    it(`requires attention for ${invalidPayment.name}`, async () => {
      const { service, state } = createReconciliationHarness({
        providerOrder: { payments: invalidPayment.payments }
      })
      await service.reconcileProviderOrder(providerOrderId, { now })
      assert.equal(state.payment.normalizedStatus, 'requires_attention')
      assert.equal(state.order.status, 'requires_attention')
      assert.equal(state.units[0].status, 'reserved')
    })
  }

  it('approves Payment but requires attention when one ProductUnit is missing', async () => {
    const { service, state } = createReconciliationHarness({ units: [] })
    await service.reconcileProviderOrder(providerOrderId, { now })
    assert.equal(state.payment.normalizedStatus, 'approved')
    assert.equal(state.order.status, 'requires_attention')
    assert.equal(state.confirmCalls, 0)
  })

  it('approves Payment but does not sell an expired reservation', async () => {
    const { service, state } = createReconciliationHarness({
      order: { reservationExpiresAt: new Date('2026-09-29T11:59:59.000Z') }
    })
    await service.reconcileProviderOrder(providerOrderId, { now })
    assert.equal(state.payment.normalizedStatus, 'approved')
    assert.equal(state.order.status, 'requires_attention')
    assert.equal(state.units[0].status, 'reserved')
  })

  it('approves Payment but does not sell a unit already available', async () => {
    const units = [{
      _id: unitId, productId, orderId: null, orderItemId: null,
      reservedByOrderId: null, status: 'available', isDeleted: false, soldAt: null
    }]
    const { service, state } = createReconciliationHarness({ units })
    await service.reconcileProviderOrder(providerOrderId, { now })
    assert.equal(state.payment.normalizedStatus, 'approved')
    assert.equal(state.order.status, 'requires_attention')
    assert.equal(state.units[0].status, 'available')
  })

  it('approves Payment but does not steal a unit reassigned to another Order', async () => {
    const otherOrderId = new mongoose.Types.ObjectId().toString()
    const units = [{
      _id: unitId, productId, orderId: otherOrderId, orderItemId,
      reservedByOrderId: otherOrderId, status: 'reserved', isDeleted: false, soldAt: null
    }]
    const { service, state } = createReconciliationHarness({ units })
    await service.reconcileProviderOrder(providerOrderId, { now })
    assert.equal(state.payment.normalizedStatus, 'approved')
    assert.equal(state.order.status, 'requires_attention')
    assert.equal(state.units[0].orderId, otherOrderId)
  })

  it('resolves release-vs-approval CAS conflict as approved plus requires_attention', async () => {
    const { service, state } = createReconciliationHarness({ confirmConflict: true })
    await service.reconcileProviderOrder(providerOrderId, { now })
    assert.equal(state.payment.normalizedStatus, 'approved')
    assert.equal(state.order.status, 'requires_attention')
    assert.equal(state.units[0].status, 'reserved')
  })

  for (const statusDetail of ['refunded', 'partially_refunded']) {
    it(`does not restore stock automatically for ${statusDetail}`, async () => {
      const soldUnit = {
        _id: unitId, productId, orderId, orderItemId, reservedByOrderId: orderId,
        status: 'sold', isDeleted: false, soldAt: now
      }
      const { service, state } = createReconciliationHarness({
        payment: {
          normalizedStatus: 'approved',
          providerPaymentId: 'PAY01M28P44GDSD4JYTSK5SYZT6BH'
        },
        order: { status: 'paid' },
        units: [soldUnit],
        providerOrder: { status: 'processed', statusDetail }
      })
      await service.reconcileProviderOrder(providerOrderId, { now })
      assert.equal(state.payment.normalizedStatus, 'requires_attention')
      assert.equal(state.order.status, 'requires_attention')
      assert.equal(state.units[0].status, 'sold')
    })
  }

  it('is idempotent for an already approved and paid Order', async () => {
    const soldUnit = {
      _id: unitId, productId, orderId, orderItemId, reservedByOrderId: orderId,
      status: 'sold', isDeleted: false, soldAt: now
    }
    const { service, state } = createReconciliationHarness({
      payment: {
        normalizedStatus: 'approved',
        providerPaymentId: 'PAY01M28P44GDSD4JYTSK5SYZT6BH'
      },
      order: { status: 'paid' },
      units: [soldUnit]
    })
    const result = await service.reconcileProviderOrder(providerOrderId, { now })
    assert.equal(result.outcome, 'paid')
    assert.equal(state.confirmCalls, 0)
  })

  it('ignores an authoritative provider Order unrelated to local commerce', async () => {
    const { service, state } = createReconciliationHarness({
      order: { orderNumber: 'LOCAL-OTHER' },
      payment: { providerOrderId: null }
    })
    const result = await service.reconcileProviderOrder(providerOrderId, { now })
    assert.equal(result.outcome, 'ignored')
    assert.equal(state.payment.normalizedStatus, 'pending')
    assert.equal(state.order.status, 'pending_payment')
  })

  it('propagates a transient provider failure before opening local effects', async () => {
    const { service, state } = createReconciliationHarness({
      providerError: new MercadoPagoProviderError('temporary', 'MERCADOPAGO_UNAVAILABLE', 503)
    })
    await assert.rejects(
      service.reconcileProviderOrder(providerOrderId, { now }),
      (error) => error.code === 'MERCADOPAGO_UNAVAILABLE' && error.status === 503
    )
    assert.equal(state.payment.normalizedStatus, 'pending')
    assert.equal(state.units[0].status, 'reserved')
  })
})

describe('ProductUnit internal reserved-to-sold gate (isolated)', () => {
  const restorations = []
  const stub = (target, property, replacement) => {
    const original = target[property]
    restorations.push(() => { target[property] = original })
    target[property] = replacement
  }
  const session = { hasEnded: false, inTransaction: () => true }

  afterEach(() => {
    while (restorations.length) restorations.pop()()
  })

  it('keeps sold forbidden through the generic administrative status operation', async () => {
    await assert.rejects(
      ProductUnitService.updateStatus({
        unitId,
        status: 'sold',
        userId: new mongoose.Types.ObjectId().toString()
      }),
      (error) => error.code === 'MANUAL_STATUS_TRANSITION_FORBIDDEN'
    )
  })

  it('requires approved Mercado Pago Payment and sells the exact expected units', async () => {
    stub(PaymentManager, 'getById', async () => ({
      _id: paymentId, orderId, provider: 'mercado_pago', normalizedStatus: 'approved'
    }))
    stub(OrderManager, 'getById', async () => ({ _id: orderId, status: 'pending_payment' }))
    stub(OrderItemManager, 'getByOrderId', async () => ([{
      _id: orderItemId, orderId, productId, quantity: 1
    }]))
    stub(ProductUnitManager, 'findReservedUnitsByOrder', async () => ([{
      _id: unitId, productId, orderId, orderItemId,
      reservedByOrderId: orderId, status: 'reserved', isDeleted: false
    }]))
    stub(ProductUnitManager, 'markReservedUnitsSold', async () => ({ modifiedCount: 1 }))

    const result = await ProductUnitService.confirmReservedUnitsSold(
      { orderId, paymentId, soldAt: now },
      { session }
    )
    assert.equal(result.soldCount, 1)
    assert.deepEqual(result.soldAt, now)
  })

  it('rejects reserved-to-sold when Payment is not approved', async () => {
    let saleCalled = false
    stub(PaymentManager, 'getById', async () => ({
      _id: paymentId, orderId, provider: 'mercado_pago', normalizedStatus: 'pending'
    }))
    stub(OrderManager, 'getById', async () => ({ _id: orderId, status: 'pending_payment' }))
    stub(ProductUnitManager, 'markReservedUnitsSold', async () => { saleCalled = true })

    await assert.rejects(
      ProductUnitService.confirmReservedUnitsSold({ orderId, paymentId }, { session }),
      (error) => error.code === 'APPROVED_PAYMENT_REQUIRED'
    )
    assert.equal(saleCalled, false)
  })

  it('rejects partial inventory before any unit is marked sold', async () => {
    let saleCalled = false
    stub(PaymentManager, 'getById', async () => ({
      _id: paymentId, orderId, provider: 'mercado_pago', normalizedStatus: 'approved'
    }))
    stub(OrderManager, 'getById', async () => ({ _id: orderId, status: 'pending_payment' }))
    stub(OrderItemManager, 'getByOrderId', async () => ([{
      _id: orderItemId, orderId, productId, quantity: 2
    }]))
    stub(ProductUnitManager, 'findReservedUnitsByOrder', async () => ([{
      _id: unitId, productId, orderId, orderItemId,
      reservedByOrderId: orderId, status: 'reserved', isDeleted: false
    }]))
    stub(ProductUnitManager, 'markReservedUnitsSold', async () => { saleCalled = true })

    await assert.rejects(
      ProductUnitService.confirmReservedUnitsSold({ orderId, paymentId }, { session }),
      (error) => error.code === 'RESERVATION_INTEGRITY_CONFLICT'
    )
    assert.equal(saleCalled, false)
  })
})

describe('Mercado Pago webhook persistence shape (isolated)', () => {
  it('keeps provider reconciliation metadata without raw provider payloads', () => {
    assert.ok(PaymentModel.schema.path('providerStatusDetail'))
    assert.ok(PaymentEventModel.schema.path('providerOrderId'))
    assert.ok(PaymentEventModel.schema.path('processingStartedAt'))
    assert.equal(PaymentEventModel.schema.path('providerPayload'), undefined)
  })
})
