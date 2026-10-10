/* eslint-env mocha */
import assert from 'node:assert/strict'
import mongoose from 'mongoose'
import { MercadoPagoProviderError } from '../../src/providers/mercadoPago.provider.js'
import {
  MercadoPagoOrderCancellationService
} from '../../src/services/mercadoPagoOrderCancellation.service.js'

const paymentId = new mongoose.Types.ObjectId().toString()
const providerOrderId = 'ORD01TESTLCOMPCANCEL'
const cancellationKey = 'cancel-123e4567-e89b-42d3-a456-426614174000'
const now = new Date('2026-10-09T12:00:00.000Z')

const canceledOrder = () => ({
  providerOrderId,
  status: 'canceled',
  statusDetail: 'canceled',
  externalReference: 'LC-2026-000010',
  totalAmount: '154500.00',
  totalPaidAmount: '0.00',
  currency: 'ARS',
  payments: []
})

const payableOrder = (status = 'created') => ({
  ...canceledOrder(),
  status,
  statusDetail: null
})

const makeHarness = ({
  payment: paymentOverrides = {},
  providerError = null,
  getOrderError = null,
  remoteOrder = payableOrder(),
  cancelResult = canceledOrder()
} = {}) => {
  const state = {
    payment: {
      _id: paymentId,
      provider: 'mercado_pago',
      normalizedStatus: 'pending',
      providerOrderId,
      externalReference: 'LC-2026-000010',
      amountArs: '154500.00',
      currency: 'ARS',
      providerCancellationIdempotencyKey: null,
      providerCancellationStatus: null,
      providerCancellationAttemptedAt: null,
      providerCancellationCompletedAt: null,
      ...paymentOverrides
    },
    preparations: 0,
    attempts: 0,
    updates: [],
    providerGetCalls: [],
    providerCalls: [],
    generatedKeys: 0
  }

  const paymentManager = {
    async getById() {
      return { ...state.payment }
    },
    async prepareProviderCancellationIfMissing(_paymentId, expectedOrderId, key) {
      if (
        state.payment.providerCancellationIdempotencyKey ||
        state.payment.providerCancellationStatus ||
        state.payment.providerOrderId !== expectedOrderId
      ) return null

      state.preparations += 1
      state.payment.providerCancellationIdempotencyKey = key
      state.payment.providerCancellationStatus = 'prepared'
      return { ...state.payment }
    },
    async markProviderCancellationAttempt(_paymentId, key, attemptedAt) {
      if (
        state.payment.providerCancellationIdempotencyKey !== key ||
        !['prepared', 'uncertain'].includes(state.payment.providerCancellationStatus)
      ) return null

      state.attempts += 1
      state.payment.providerCancellationAttemptedAt = attemptedAt
      return { ...state.payment }
    },
    async updateProviderCancellationStatus(_paymentId, key, status, { completedAt = null } = {}) {
      if (
        state.payment.providerCancellationIdempotencyKey !== key ||
        !['prepared', 'uncertain'].includes(state.payment.providerCancellationStatus)
      ) return null

      state.updates.push(status)
      state.payment.providerCancellationStatus = status
      if (completedAt) state.payment.providerCancellationCompletedAt = completedAt
      return { ...state.payment }
    }
  }
  const provider = {
    async getOrder(id) {
      state.providerGetCalls.push(id)
      if (getOrderError) throw getOrderError
      return remoteOrder
    },
    async cancelOrder(id, options) {
      state.providerCalls.push({ id, ...options })
      if (providerError) throw providerError
      return cancelResult
    }
  }
  const service = new MercadoPagoOrderCancellationService({
    paymentManager,
    provider,
    uuidFactory: () => {
      state.generatedKeys += 1
      return cancellationKey
    }
  })

  return { service, state, provider }
}

describe('Mercado Pago idempotent Order cancellation (isolated)', () => {
  it('GET created permits cancel, prepares one key and persists succeeded', async () => {
    const { service, state } = makeHarness()
    const result = await service.cancelPaymentOrder(paymentId, { now })

    assert.equal(state.preparations, 1)
    assert.equal(state.generatedKeys, 1)
    assert.deepEqual(state.providerGetCalls, [providerOrderId])
    assert.deepEqual(state.providerCalls, [{ id: providerOrderId, idempotencyKey: cancellationKey }])
    assert.equal(state.payment.providerCancellationStatus, 'succeeded')
    assert.equal(state.payment.providerCancellationAttemptedAt.toISOString(), now.toISOString())
    assert.equal(state.payment.providerCancellationCompletedAt.toISOString(), now.toISOString())
    assert.equal(result.providerCancellationStatus, 'succeeded')
  })

  it('allows action_required only after the authoritative GET classifies it PAYABLE', async () => {
    const { service, state } = makeHarness({ remoteOrder: payableOrder('action_required') })

    await service.cancelPaymentOrder(paymentId, { now })

    assert.deepEqual(state.providerGetCalls, [providerOrderId])
    assert.equal(state.providerCalls.length, 1)
    assert.equal(state.payment.providerCancellationStatus, 'succeeded')
  })

  for (const [name, remoteOrder] of [
    ['processing', payableOrder('processing')],
    ['processed/accredited', {
      ...payableOrder('processed'),
      statusDetail: 'accredited',
      totalPaidAmount: '154500.00',
      payments: [{ status: 'processed', statusDetail: 'accredited', paidAmount: '154500.00' }]
    }],
    ['failed', payableOrder('failed')],
    ['refunded', payableOrder('refunded')],
    ['unknown', payableOrder('future_status')],
    ['inconsistent providerOrderId', {
      ...payableOrder(),
      providerOrderId: 'ORD01OTHERORDER'
    }],
    ['inconsistent externalReference', {
      ...payableOrder(),
      externalReference: 'OTHER-ORDER'
    }],
    ['inconsistent amount', { ...payableOrder(), totalAmount: '1.00' }],
    ['inconsistent currency', { ...payableOrder(), currency: 'USD' }],
    ['incomplete payload', { providerOrderId, status: 'created', payments: [] }]
  ]) {
    it(`does not POST cancel when the authoritative GET is ${name}`, async () => {
      const { service, state } = makeHarness({ remoteOrder })

      await assert.rejects(
        service.cancelPaymentOrder(paymentId, { now }),
        (error) => Boolean(
          error.code === 'MERCADOPAGO_ORDER_NOT_CANCELABLE' &&
          error.details?.remoteClassification
        )
      )

      assert.equal(state.providerCalls.length, 0)
      assert.equal(state.preparations, 0)
      assert.equal(state.generatedKeys, 0)
    })
  }

  it('returns terminal_unpaid without another POST when GET already reports canceled', async () => {
    const { service, state } = makeHarness({ remoteOrder: canceledOrder() })

    const result = await service.cancelPaymentOrder(paymentId, { now })

    assert.equal(result.outcome, 'terminal_unpaid')
    assert.equal(result.alreadyCanceled, true)
    assert.equal(result.remoteClassification, 'TERMINAL_UNPAID')
    assert.equal(state.providerCalls.length, 0)
    assert.equal(state.preparations, 0)
    assert.equal(state.payment.normalizedStatus, 'pending')
  })

  for (const [name, getOrderError] of [
    ['timeout', new MercadoPagoProviderError('timeout', 'MERCADOPAGO_TIMEOUT', 504, {
      failureKind: 'timeout'
    })],
    ['network', new MercadoPagoProviderError('network', 'MERCADOPAGO_UNAVAILABLE', 503, {
      failureKind: 'network_error'
    })],
    ['5xx', new MercadoPagoProviderError('server', 'MERCADOPAGO_UNAVAILABLE', 503, {
      failureKind: 'server_error'
    })],
    ['429', new MercadoPagoProviderError('rate', 'MERCADOPAGO_RATE_LIMIT', 503, {
      failureKind: 'rate_limit'
    })],
    ['TLS', new Error('certificate failure')]
  ]) {
    it(`fails closed without preparing a key when authoritative GET fails by ${name}`, async () => {
      const existingKey = 'existing-cancel-key'
      const { service, state } = makeHarness({
        getOrderError,
        payment: {
          providerCancellationIdempotencyKey: existingKey,
          providerCancellationStatus: 'uncertain'
        }
      })

      await assert.rejects(service.cancelPaymentOrder(paymentId, { now }))

      assert.equal(state.providerCalls.length, 0)
      assert.equal(state.generatedKeys, 0)
      assert.equal(state.payment.providerCancellationIdempotencyKey, existingKey)
      assert.equal(state.payment.providerCancellationStatus, 'uncertain')
    })
  }

  for (const [name, error] of [
    ['timeout', new MercadoPagoProviderError('timeout', 'MERCADOPAGO_TIMEOUT', 504, {
      failureKind: 'timeout'
    })],
    ['network', new MercadoPagoProviderError('network', 'MERCADOPAGO_UNAVAILABLE', 503, {
      failureKind: 'network_error'
    })],
    ['5xx', new MercadoPagoProviderError('server', 'MERCADOPAGO_UNAVAILABLE', 503, {
      failureKind: 'server_error'
    })],
    ['429', new MercadoPagoProviderError('rate', 'MERCADOPAGO_RATE_LIMIT', 503, {
      failureKind: 'rate_limit'
    })],
    ['409', new MercadoPagoProviderError('conflict', 'MERCADOPAGO_CANCELLATION_CONFLICT', 502, {
      failureKind: 'state_conflict'
    })],
    ['resource lock', new MercadoPagoProviderError('locked', 'MERCADOPAGO_ORDER_CONFLICT', 409, {
      failureKind: 'resource_locked'
    })]
  ]) {
    it(`keeps ${name} cancellation fail-closed as uncertain`, async () => {
      const { service, state } = makeHarness({ providerError: error })

      await assert.rejects(
        service.cancelPaymentOrder(paymentId, { now }),
        (caught) => caught.code === error.code
      )

      assert.equal(state.payment.providerCancellationStatus, 'uncertain')
      assert.equal(state.payment.providerCancellationIdempotencyKey, cancellationKey)
      assert.equal(state.providerCalls.length, 1)
      assert.equal(state.generatedKeys, 1)
    })
  }

  it('retries prepared/uncertain with the same key and never rotates it', async () => {
    const { service, state, provider } = makeHarness()
    let calls = 0
    provider.cancelOrder = async (id, options) => {
      state.providerCalls.push({ id, ...options })
      calls += 1
      if (calls === 1) {
        throw new MercadoPagoProviderError('timeout', 'MERCADOPAGO_TIMEOUT', 504, {
          failureKind: 'timeout'
        })
      }
      return canceledOrder()
    }

    await assert.rejects(service.cancelPaymentOrder(paymentId, { now }))
    await service.cancelPaymentOrder(paymentId, { now: new Date(now.getTime() + 1000) })

    assert.equal(state.preparations, 1)
    assert.equal(state.generatedKeys, 1)
    assert.deepEqual(
      state.providerCalls.map(({ idempotencyKey }) => idempotencyKey),
      [cancellationKey, cancellationKey]
    )
    assert.equal(state.payment.providerCancellationStatus, 'succeeded')
  })

  it('uses an already prepared key without generating another one', async () => {
    const { service, state } = makeHarness({
      payment: {
        providerCancellationIdempotencyKey: cancellationKey,
        providerCancellationStatus: 'prepared'
      }
    })

    await service.cancelPaymentOrder(paymentId, { now })
    assert.equal(state.generatedKeys, 0)
    assert.equal(state.preparations, 0)
    assert.equal(state.providerCalls[0].idempotencyKey, cancellationKey)
  })

  it('uses an already uncertain key without generating another one', async () => {
    const { service, state } = makeHarness({
      payment: {
        providerCancellationIdempotencyKey: cancellationKey,
        providerCancellationStatus: 'uncertain'
      }
    })

    await service.cancelPaymentOrder(paymentId, { now })
    assert.equal(state.generatedKeys, 0)
    assert.equal(state.preparations, 0)
    assert.equal(state.providerCalls[0].idempotencyKey, cancellationKey)
  })

  it('does not call Mercado Pago again after succeeded', async () => {
    const { service, state } = makeHarness({
      payment: {
        providerCancellationIdempotencyKey: cancellationKey,
        providerCancellationStatus: 'succeeded'
      }
    })

    const result = await service.cancelPaymentOrder(paymentId, { now })
    assert.equal(result.alreadyCompleted, true)
    assert.equal(state.providerCalls.length, 0)
  })

  it('marks only a demonstrated definitive rejection as rejected', async () => {
    const { service, state } = makeHarness({
      providerError: new MercadoPagoProviderError(
        'rejected',
        'MERCADOPAGO_CANCELLATION_REJECTED',
        502,
        { failureKind: 'definitive_rejection', retryStrategy: 'fail_closed' }
      )
    })

    await assert.rejects(service.cancelPaymentOrder(paymentId, { now }))
    assert.equal(state.payment.providerCancellationStatus, 'rejected')
  })

  it('does not treat a non-terminal cancellation response as success', async () => {
    const { service, state, provider } = makeHarness()
    provider.cancelOrder = async () => ({ ...canceledOrder(), totalPaidAmount: '1.00' })

    await assert.rejects(
      service.cancelPaymentOrder(paymentId, { now }),
      (error) => error.code === 'MERCADOPAGO_CANCELLATION_UNCONFIRMED'
    )
    assert.equal(state.payment.providerCancellationStatus, 'uncertain')
  })

  for (const [name, cancelResult] of [
    ['created', payableOrder('created')],
    ['action_required', payableOrder('action_required')],
    ['processing', payableOrder('processing')],
    ['processed', { ...payableOrder('processed'), statusDetail: 'accredited' }],
    ['failed', payableOrder('failed')],
    ['incomplete payload', { providerOrderId, status: 'canceled', payments: [] }],
    ['different providerOrderId', { ...canceledOrder(), providerOrderId: 'ORD01OTHERORDER' }],
    ['different externalReference', { ...canceledOrder(), externalReference: 'LC-OTHER' }],
    ['different total', { ...canceledOrder(), totalAmount: '1.00' }],
    ['different currency', { ...canceledOrder(), currency: 'USD' }]
  ]) {
    it(`does not mark succeeded when cancel HTTP 200 returns ${name}`, async () => {
      const { service, state } = makeHarness({ cancelResult })

      await assert.rejects(
        service.cancelPaymentOrder(paymentId, { now }),
        (error) => error.code === 'MERCADOPAGO_CANCELLATION_UNCONFIRMED'
      )

      assert.equal(state.providerCalls.length, 1)
      assert.equal(state.payment.providerCancellationStatus, 'uncertain')
      assert.notEqual(state.payment.providerCancellationStatus, 'succeeded')
    })
  }

  it('persists one authoritative cancellation key across two concurrent services', async () => {
    const state = {
      payment: {
        _id: paymentId,
        provider: 'mercado_pago',
        normalizedStatus: 'pending',
        providerOrderId,
        externalReference: 'LC-2026-000010',
        amountArs: '154500.00',
        currency: 'ARS',
        providerCancellationIdempotencyKey: null,
        providerCancellationStatus: null
      },
      providerCalls: []
    }
    const paymentManager = {
      async getById() { return { ...state.payment } },
      async prepareProviderCancellationIfMissing(_paymentId, expectedOrderId, key) {
        if (
          state.payment.providerOrderId !== expectedOrderId ||
          state.payment.providerCancellationIdempotencyKey ||
          state.payment.providerCancellationStatus
        ) return null

        state.payment.providerCancellationIdempotencyKey = key
        state.payment.providerCancellationStatus = 'prepared'
        return { ...state.payment }
      },
      async markProviderCancellationAttempt(_paymentId, key, attemptedAt) {
        if (
          state.payment.providerCancellationIdempotencyKey !== key ||
          !['prepared', 'uncertain'].includes(state.payment.providerCancellationStatus)
        ) return null
        state.payment.providerCancellationAttemptedAt = attemptedAt
        return { ...state.payment }
      },
      async updateProviderCancellationStatus(_paymentId, key, status, { completedAt = null } = {}) {
        if (
          state.payment.providerCancellationIdempotencyKey !== key ||
          !['prepared', 'uncertain'].includes(state.payment.providerCancellationStatus)
        ) return null
        state.payment.providerCancellationStatus = status
        if (completedAt) state.payment.providerCancellationCompletedAt = completedAt
        return { ...state.payment }
      }
    }
    let getArrivals = 0
    let releaseGets
    const getGate = new Promise((resolve) => { releaseGets = resolve })
    let cancelArrivals = 0
    let releaseCancels
    const cancelGate = new Promise((resolve) => { releaseCancels = resolve })
    const provider = {
      async getOrder() {
        getArrivals += 1
        if (getArrivals === 2) releaseGets()
        await getGate
        return payableOrder()
      },
      async cancelOrder(_id, { idempotencyKey }) {
        state.providerCalls.push(idempotencyKey)
        cancelArrivals += 1
        if (cancelArrivals === 2) releaseCancels()
        await cancelGate
        return canceledOrder()
      }
    }
    const serviceA = new MercadoPagoOrderCancellationService({
      paymentManager,
      provider,
      uuidFactory: () => 'cancel-key-a'
    })
    const serviceB = new MercadoPagoOrderCancellationService({
      paymentManager,
      provider,
      uuidFactory: () => 'cancel-key-b'
    })

    const results = await Promise.allSettled([
      serviceA.cancelPaymentOrder(paymentId, { now }),
      serviceB.cancelPaymentOrder(paymentId, { now })
    ])

    assert.equal(results.some(({ status }) => status === 'fulfilled'), true)
    assert.equal(state.providerCalls.length, 2)
    assert.equal(new Set(state.providerCalls).size, 1)
    assert.equal(state.providerCalls[0], state.payment.providerCancellationIdempotencyKey)
    assert.ok(['cancel-key-a', 'cancel-key-b'].includes(state.providerCalls[0]))
    assert.equal(state.payment.providerCancellationStatus, 'succeeded')
  })
})
