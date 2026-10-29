/* eslint-env mocha */
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import mongoose from 'mongoose'
import {
  PaymentReconciliationWorkerService,
  WORKER_OUTCOMES,
  calculateCandidateLimit,
  calculateNextReconciliationAt,
  calculateProviderFailureBackoffMs
} from '../../src/services/paymentReconciliationWorker.service.js'
import { REMOTE_ORDER_CLASSIFICATIONS } from '../../src/services/mercadoPagoOrderClassification.service.js'

const baseNow = new Date('2026-10-10T12:00:00.000Z')
const fiveMinutes = 5 * 60 * 1000

const makeOrder = (number, overrides = {}) => ({
  _id: `order-${number}`,
  orderNumber: `LC-2026-${String(number).padStart(6, '0')}`,
  status: 'pending_payment',
  createdAt: new Date(baseNow.getTime() - 30 * 60 * 1000),
  reservationExpiresAt: new Date(baseNow.getTime() + 5 * 60 * 60 * 1000),
  reconciliationNextAt: null,
  reconciliationLeaseOwner: null,
  reconciliationLeaseUntil: null,
  reconciliationAttempts: 0,
  reconciliationFailures: 0,
  ...overrides
})

const makePayment = (order, overrides = {}) => ({
  _id: `payment-${order._id}`,
  orderId: order._id,
  normalizedStatus: 'pending',
  provider: 'mercado_pago',
  providerOrderId: `provider-${order._id}`,
  providerStatus: null,
  lastProviderCheckAt: null,
  providerAttemptStatus: 'succeeded',
  externalReference: order.orderNumber,
  amountArs: '154500.00',
  currency: 'ARS',
  providerPaymentId: null,
  approvedAt: null,
  providerCancellationIdempotencyKey: null,
  providerCancellationStatus: null,
  providerCancellationAttemptedAt: null,
  providerCancellationPayableStatus: null,
  providerCancellationPayableObservedAt: null,
  ...overrides
})

const clonePaymentRead = (payment) => ({
  ...payment,
  ...(payment.lastProviderCheckAt instanceof Date && {
    lastProviderCheckAt: new Date(payment.lastProviderCheckAt.getTime())
  }),
  ...(payment.amountArs?._bsontype === 'Decimal128' && {
    amountArs: mongoose.Types.Decimal128.fromString(payment.amountArs.toString())
  })
})

const verifiedProviderContextFor = (order) => ({
  providerOrderId: `provider-${order._id}`,
  externalReference: order.orderNumber,
  totalAmount: '154500.00',
  currency: 'ARS'
})

const compareOrders = (left, right) => {
  const leftExpiry = left.reservationExpiresAt?.getTime() ?? Number.NEGATIVE_INFINITY
  const rightExpiry = right.reservationExpiresAt?.getTime() ?? Number.NEGATIVE_INFINITY
  return leftExpiry - rightExpiry || left._id.localeCompare(right._id)
}

const remoteStatusFor = (classification) => ({
  [REMOTE_ORDER_CLASSIFICATIONS.PAYABLE]: 'created',
  [REMOTE_ORDER_CLASSIFICATIONS.PROCESSING]: 'processing',
  [REMOTE_ORDER_CLASSIFICATIONS.FAILED_UNCERTAIN]: 'failed',
  [REMOTE_ORDER_CLASSIFICATIONS.TERMINAL_UNPAID]: 'canceled',
  [REMOTE_ORDER_CLASSIFICATIONS.CANCELED_PAYMENT_AGGREGATES_OMITTED]: 'canceled'
})[classification] || null

const makeHarness = ({
  orders = [makeOrder(1)],
  payments,
  reconcile,
  cancel,
  expire,
  renewHook,
  claimFailure,
  releaseFailure,
  scheduleFailure,
  getOrderFailure,
  clock = () => baseNow,
  leaseMs = 60 * 1000
} = {}) => {
  const state = {
    orders: orders.map((order) => ({ ...order })),
    payments: new Map(),
    providerCalls: 0,
    activeProviderCalls: 0,
    maxActiveProviderCalls: 0,
    cancelCalls: 0,
    expirationCalls: [],
    renewCalls: 0,
    releaseInventoryCalls: 0,
    units: [{ status: 'reserved' }],
    releaseAttempts: [],
    cursors: [],
    limits: [],
    logs: []
  }
  for (const order of state.orders) {
    const payment = payments instanceof Map
      ? payments.get(order._id)
      : payments?.[order._id] ?? makePayment(order)
    if (payment) state.payments.set(order._id, { ...payment })
  }
  let ownerSequence = 0

  const findOrder = (id) => state.orders.find((order) => order._id === id)
  const owns = (order, ownerToken, now) => order &&
    order.status === 'pending_payment' &&
    order.reconciliationLeaseOwner === ownerToken &&
    order.reconciliationLeaseUntil > now

  const claimService = {
    async findCandidates({ now, limit, afterCursor }) {
      state.cursors.push(afterCursor)
      state.limits.push(limit)
      const sorted = state.orders
        .filter((order) => order.status === 'pending_payment')
        .filter((order) => !order.reconciliationNextAt || order.reconciliationNextAt <= now)
        .filter((order) => !order.reconciliationLeaseUntil || order.reconciliationLeaseUntil <= now)
        .sort(compareOrders)
      const afterIndex = afterCursor
        ? sorted.findIndex((order) => order._id === afterCursor._id)
        : -1
      return sorted.slice(afterIndex + 1, afterIndex + 1 + limit).map((order) => ({ ...order }))
    },
    async claim(orderId, { now }) {
      const claimError = claimFailure?.({ orderId, state })
      if (claimError) throw claimError
      const order = findOrder(orderId)
      if (
        !order ||
        order.status !== 'pending_payment' ||
        (order.reconciliationNextAt && order.reconciliationNextAt > now) ||
        (order.reconciliationLeaseUntil && order.reconciliationLeaseUntil > now)
      ) return null
      ownerSequence += 1
      const ownerToken = `owner-${ownerSequence}`
      order.reconciliationLeaseOwner = ownerToken
      order.reconciliationLeaseUntil = new Date(now.getTime() + leaseMs)
      order.reconciliationAttempts += 1
      return { order: { ...order }, ownerToken }
    },
    async assertOwnership(orderId, ownerToken, { now }) {
      const order = findOrder(orderId)
      if (!owns(order, ownerToken, now)) {
        const error = new Error('claim lost')
        error.code = 'RECONCILIATION_CLAIM_LOST'
        throw error
      }
      return { ...order }
    },
    async renew(orderId, ownerToken, { now }) {
      state.renewCalls += 1
      if (renewHook?.({ orderId, ownerToken, now, call: state.renewCalls, state }) === false) {
        return null
      }
      const order = findOrder(orderId)
      if (!owns(order, ownerToken, now)) return null
      order.reconciliationLeaseUntil = new Date(now.getTime() + leaseMs)
      return { ...order }
    },
    async scheduleNext(orderId, ownerToken, nextAt, { now }) {
      const error = scheduleFailure?.({ orderId, operation: 'scheduleNext', state })
      if (error) throw error
      const order = findOrder(orderId)
      if (!owns(order, ownerToken, now)) return null
      order.reconciliationNextAt = nextAt
      return { ...order }
    },
    async scheduleSuccess(orderId, ownerToken, nextAt, { now }) {
      const error = scheduleFailure?.({ orderId, operation: 'scheduleSuccess', state })
      if (error) throw error
      const order = findOrder(orderId)
      if (!owns(order, ownerToken, now)) return null
      order.reconciliationNextAt = nextAt
      order.reconciliationFailures = 0
      return { ...order }
    },
    async markFailure(orderId, ownerToken, nextAt, { now }) {
      const order = findOrder(orderId)
      if (!owns(order, ownerToken, now)) return null
      order.reconciliationNextAt = nextAt
      order.reconciliationFailures += 1
      return { ...order }
    },
    async release(orderId, ownerToken) {
      state.releaseAttempts.push({ orderId, ownerToken })
      const releaseError = releaseFailure?.({ orderId, ownerToken, state })
      if (releaseError) throw releaseError
      const order = findOrder(orderId)
      if (!order || order.reconciliationLeaseOwner !== ownerToken) return null
      order.reconciliationLeaseOwner = null
      order.reconciliationLeaseUntil = null
      return { ...order }
    }
  }
  const orderManager = {
    async getById(id) {
      const error = getOrderFailure?.({ orderId: id, state })
      if (error) throw error
      const order = findOrder(id)
      return order ? { ...order } : null
    }
  }
  const paymentManager = {
    async getLatestByOrderId(id) {
      const payment = state.payments.get(id)
      return payment ? clonePaymentRead(payment) : null
    }
  }
  const reconciliationService = {
    async reconcileProviderOrder(providerOrderId, options) {
      state.providerCalls += 1
      state.activeProviderCalls += 1
      state.maxActiveProviderCalls = Math.max(
        state.maxActiveProviderCalls,
        state.activeProviderCalls
      )
      try {
        const result = reconcile
          ? await reconcile({ providerOrderId, options, state, findOrder })
          : {
              outcome: 'pending',
              remoteClassification: REMOTE_ORDER_CLASSIFICATIONS.PAYABLE
            }
        if (result.outcome === 'pending') {
          const order = state.orders.find((candidate) => (
            state.payments.get(candidate._id)?.providerOrderId === providerOrderId
          ))
          const payment = order ? state.payments.get(order._id) : null
          if (payment) {
            payment.providerStatus = result.remoteStatus ||
              remoteStatusFor(result.remoteClassification)
            const observedAt = new Date(result.observedAt || options.now)
            payment.lastProviderCheckAt = observedAt
            return {
              paymentId: payment._id,
              ...result,
              observedAt: new Date(observedAt.getTime())
            }
          }
        }
        return result
      } finally {
        state.activeProviderCalls -= 1
      }
    }
  }
  const cancellationService = {
    async cancelPaymentOrder(paymentId, options) {
      state.cancelCalls += 1
      if (cancel) return cancel({ paymentId, options, state, findOrder })
      return {
        paymentId,
        providerCancellationStatus: 'succeeded',
        alreadyCompleted: false
      }
    }
  }
  const expirationService = {
    async expirePendingOrderWithTerminalUnpaidEvidence(value) {
      state.expirationCalls.push(value)
      if (expire) return expire({ input: value, state, findOrder })

      const order = findOrder(value.orderId)
      const payment = state.payments.get(value.orderId)
      order.status = 'expired'
      order.reconciliationNextAt = null
      order.reconciliationLeaseOwner = null
      order.reconciliationLeaseUntil = null
      payment.normalizedStatus = 'cancelled'
      for (const unit of state.units) unit.status = 'available'
      state.releaseInventoryCalls += 1
      return { outcome: 'expired', releasedCount: state.units.length }
    }
  }
  const worker = new PaymentReconciliationWorkerService({
    orderManager,
    paymentManager,
    claimService,
    reconciliationService,
    cancellationService,
    expirationService,
    clock,
    workerConfig: { batchSize: 20, maxOrdersPerRun: 100, concurrency: 2 },
    log(message, metadata) { state.logs.push({ message, metadata }) }
  })
  const run = (options = {}) => worker.run({
    now: baseNow,
    runId: 'run-test',
    ...options
  })

  return { worker, run, state, claimService, findOrder }
}

describe('P1B.2 autonomous reconcile-only worker (isolated)', () => {
  it('reconciles approved provider state through the shared reconciler', async () => {
    const { run, state } = makeHarness({
      reconcile: async ({ state, findOrder }) => {
        const order = findOrder('order-1')
        order.status = 'paid'
        state.payments.get(order._id).normalizedStatus = 'approved'
        return { outcome: 'paid' }
      }
    })
    const result = await run()
    assert.equal(result.paid, 1)
    assert.equal(state.orders[0].status, 'paid')
  })

  for (const [providerStatus, classification] of [
    ['created', REMOTE_ORDER_CLASSIFICATIONS.PAYABLE],
    ['action_required', REMOTE_ORDER_CLASSIFICATIONS.PAYABLE],
    ['processing', REMOTE_ORDER_CLASSIFICATIONS.PROCESSING],
    ['failed', REMOTE_ORDER_CLASSIFICATIONS.FAILED_UNCERTAIN]
  ]) {
    it(`keeps ${providerStatus} pending and schedules another observation`, async () => {
      const { run, state } = makeHarness({
        reconcile: async () => ({ outcome: 'pending', remoteClassification: classification })
      })
      const result = await run()
      assert.equal(result.stillPending, 1)
      assert.equal(state.orders[0].status, 'pending_payment')
      assert.equal(state.orders[0].reconciliationNextAt.toISOString(), new Date(baseNow.getTime() + fiveMinutes).toISOString())
    })
  }

  it('observes terminal unpaid without expiring or releasing anything', async () => {
    const { run, state } = makeHarness({
      reconcile: async () => ({
        outcome: 'pending',
        remoteClassification: REMOTE_ORDER_CLASSIFICATIONS.TERMINAL_UNPAID
      })
    })
    const result = await run()
    assert.equal(result.terminalUnpaid, 1)
    assert.equal(state.orders[0].status, 'pending_payment')
    assert.equal(state.releaseInventoryCalls, 0)
    assert.equal(state.expirationCalls.length, 0)
  })

  it('cancels an expired PAYABLE Order, performs a second GET and expires once', async () => {
    const order = makeOrder(1, { reservationExpiresAt: new Date(baseNow.getTime() - 1) })
    const { run, state } = makeHarness({
      orders: [order],
      reconcile: async ({ state }) => ({
        outcome: 'pending',
        remoteClassification: state.providerCalls === 1
          ? REMOTE_ORDER_CLASSIFICATIONS.PAYABLE
          : REMOTE_ORDER_CLASSIFICATIONS.TERMINAL_UNPAID
      })
    })

    const result = await run()

    assert.equal(result.expired, 1)
    assert.equal(state.providerCalls, 2)
    assert.equal(state.cancelCalls, 1)
    assert.equal(state.expirationCalls.length, 1)
    assert.equal(state.releaseInventoryCalls, 1)
    assert.equal(state.orders[0].status, 'expired')
    assert.equal(state.orders[0].reconciliationNextAt, null)
    assert.equal(
      state.expirationCalls[0].terminalEvidence.observedAt.getTime(),
      state.payments.get(order._id).lastProviderCheckAt.getTime()
    )
  })

  for (const { name, reservationExpiresAt } of [
    { name: 'null', reservationExpiresAt: null },
    { name: 'undefined', reservationExpiresAt: undefined },
    { name: 'an invalid date', reservationExpiresAt: 'invalid-date' }
  ]) {
    it(`does not cancel or expire a PAYABLE Order when reservationExpiresAt is ${name}`, async () => {
      const order = makeOrder(1, { reservationExpiresAt })
      const { run, state } = makeHarness({ orders: [order] })

      const result = await run()

      assert.equal(result.stillPending, 1)
      assert.equal(result.expired, 0)
      assert.equal(result.alreadyExpired, 0)
      assert.equal(state.providerCalls, 1)
      assert.equal(state.cancelCalls, 0)
      assert.equal(state.expirationCalls.length, 0)
      assert.equal(state.releaseInventoryCalls, 0)
      assert.equal(state.units[0].status, 'reserved')
      assert.equal(state.orders[0].status, 'pending_payment')
      assert.equal(state.orders[0].reservationExpiresAt, reservationExpiresAt)
      assert.equal(
        state.orders[0].reconciliationNextAt.toISOString(),
        new Date(baseNow.getTime() + fiveMinutes).toISOString()
      )
    })
  }

  it('expires direct TERMINAL_UNPAID without POST cancel when the reservation expired', async () => {
    const order = makeOrder(1, { reservationExpiresAt: new Date(baseNow.getTime() - 1) })
    const { run, state } = makeHarness({
      orders: [order],
      reconcile: async () => ({
        outcome: 'pending',
        remoteClassification: REMOTE_ORDER_CLASSIFICATIONS.TERMINAL_UNPAID
      })
    })

    const result = await run()

    assert.equal(result.expired, 1)
    assert.equal(state.providerCalls, 1)
    assert.equal(state.cancelCalls, 0)
    assert.equal(state.expirationCalls.length, 1)
  })

  it('does not expire direct TERMINAL_UNPAID while the reservation is active', async () => {
    const { run, state } = makeHarness({
      reconcile: async () => ({
        outcome: 'pending',
        remoteClassification: REMOTE_ORDER_CLASSIFICATIONS.TERMINAL_UNPAID
      })
    })

    const result = await run()

    assert.equal(result.terminalUnpaid, 1)
    assert.equal(state.cancelCalls, 0)
    assert.equal(state.expirationCalls.length, 0)
    assert.equal(state.units[0].status, 'reserved')
  })

  it('keeps stock reserved and backs off when cancellation is uncertain', async () => {
    const order = makeOrder(1, { reservationExpiresAt: new Date(baseNow.getTime() - 1) })
    const timeout = Object.assign(new Error('timeout'), {
      code: 'MERCADOPAGO_TIMEOUT',
      status: 503
    })
    const { run, state } = makeHarness({
      orders: [order],
      cancel: async () => { throw timeout }
    })

    const result = await run()

    assert.equal(result.cancelUncertain, 1)
    assert.equal(state.cancelCalls, 1)
    assert.equal(state.providerCalls, 1)
    assert.equal(state.expirationCalls.length, 0)
    assert.equal(state.units[0].status, 'reserved')
    assert.equal(state.orders[0].reconciliationFailures, 1)
  })

  it('recovers an uncertain cancel when the next authoritative GET confirms terminal unpaid', async () => {
    let currentNow = baseNow
    const order = makeOrder(1, { reservationExpiresAt: new Date(baseNow.getTime() - 1) })
    const timeout = Object.assign(new Error('timeout'), {
      code: 'MERCADOPAGO_TIMEOUT',
      status: 503
    })
    const harness = makeHarness({
      orders: [order],
      clock: () => currentNow,
      reconcile: async ({ state }) => ({
        outcome: 'pending',
        remoteClassification: state.providerCalls === 1
          ? REMOTE_ORDER_CLASSIFICATIONS.PAYABLE
          : REMOTE_ORDER_CLASSIFICATIONS.TERMINAL_UNPAID
      }),
      cancel: async ({ state }) => {
        state.payments.get(order._id).providerCancellationStatus = 'uncertain'
        throw timeout
      }
    })

    const first = await harness.run({ runId: 'cancel-uncertain' })
    currentNow = new Date(baseNow.getTime() + fiveMinutes)
    const second = await harness.run({
      now: currentNow,
      runId: 'terminal-unpaid-recovery'
    })

    assert.equal(first.cancelUncertain, 1)
    assert.equal(second.expired, 1)
    assert.equal(harness.state.providerCalls, 2)
    assert.equal(harness.state.cancelCalls, 1)
    assert.equal(harness.state.expirationCalls.length, 1)
    assert.equal(harness.state.releaseInventoryCalls, 1)
    assert.equal(harness.state.orders[0].status, 'expired')
    assert.equal(harness.state.payments.get(order._id).normalizedStatus, 'cancelled')
    assert.equal(
      harness.state.payments.get(order._id).providerCancellationStatus,
      'uncertain'
    )
    assert.equal(harness.state.units[0].status, 'available')
  })

  it('expires worker-only when its persisted cancellation chain precedes omitted aggregates', async () => {
    const order = makeOrder(1, { reservationExpiresAt: new Date(baseNow.getTime() - 1) })
    const cancellationKey = 'cancel-worker-only-chain'
    const { run, state } = makeHarness({
      orders: [order],
      reconcile: async ({ state }) => ({
        outcome: 'pending',
        remoteClassification: state.providerCalls === 1
          ? REMOTE_ORDER_CLASSIFICATIONS.PAYABLE
          : REMOTE_ORDER_CLASSIFICATIONS.CANCELED_PAYMENT_AGGREGATES_OMITTED,
        verifiedProviderContext: verifiedProviderContextFor(order)
      }),
      cancel: async ({ paymentId, state }) => {
        Object.assign(state.payments.get(order._id), {
          providerCancellationIdempotencyKey: cancellationKey,
          providerCancellationStatus: 'succeeded',
          providerCancellationAttemptedAt: baseNow,
          providerCancellationPayableStatus: 'created',
          providerCancellationPayableObservedAt: baseNow
        })
        return { paymentId, providerCancellationStatus: 'succeeded' }
      }
    })

    const result = await run()

    assert.equal(result.expired, 1)
    assert.equal(state.providerCalls, 2)
    assert.equal(state.cancelCalls, 1)
    assert.equal(state.expirationCalls.length, 1)
    assert.equal(state.expirationCalls[0].terminalEvidence.source, 'worker_cancellation_chain')
    assert.equal(
      state.expirationCalls[0].terminalEvidence.cancellationContext
        .providerCancellationIdempotencyKey,
      cancellationKey
    )
    assert.equal(state.releaseInventoryCalls, 1)
  })

  it('reconstructs an uncertain cancellation chain after a crash before expiration', async () => {
    let currentNow = baseNow
    const order = makeOrder(1, { reservationExpiresAt: new Date(baseNow.getTime() - 1) })
    const cancellationKey = 'cancel-crash-recovery-chain'
    const unconfirmed = Object.assign(new Error('cancel result omitted aggregates'), {
      code: 'MERCADOPAGO_CANCELLATION_UNCONFIRMED',
      status: 409
    })
    const harness = makeHarness({
      orders: [order],
      clock: () => currentNow,
      reconcile: async ({ state }) => ({
        outcome: 'pending',
        remoteClassification: state.providerCalls === 1
          ? REMOTE_ORDER_CLASSIFICATIONS.PAYABLE
          : REMOTE_ORDER_CLASSIFICATIONS.CANCELED_PAYMENT_AGGREGATES_OMITTED,
        verifiedProviderContext: verifiedProviderContextFor(order)
      }),
      cancel: async ({ state }) => {
        Object.assign(state.payments.get(order._id), {
          providerCancellationIdempotencyKey: cancellationKey,
          providerCancellationStatus: 'uncertain',
          providerCancellationAttemptedAt: baseNow,
          providerCancellationPayableStatus: 'created',
          providerCancellationPayableObservedAt: baseNow
        })
        throw unconfirmed
      }
    })

    const first = await harness.run({ runId: 'before-crash' })
    currentNow = new Date(baseNow.getTime() + fiveMinutes)
    const second = await harness.run({ now: currentNow, runId: 'after-crash' })

    assert.equal(first.cancelUncertain, 1)
    assert.equal(second.expired, 1)
    assert.equal(harness.state.cancelCalls, 1)
    assert.equal(harness.state.providerCalls, 2)
    assert.equal(harness.state.expirationCalls.length, 1)
    assert.equal(
      harness.state.expirationCalls[0].terminalEvidence.source,
      'worker_cancellation_chain'
    )
    assert.equal(harness.state.releaseInventoryCalls, 1)
  })

  it('keeps generic canceled omitted aggregates fail-closed without worker evidence', async () => {
    const order = makeOrder(1, { reservationExpiresAt: new Date(baseNow.getTime() - 1) })
    const { run, state } = makeHarness({
      orders: [order],
      reconcile: async () => ({
        outcome: 'pending',
        remoteClassification: REMOTE_ORDER_CLASSIFICATIONS.CANCELED_PAYMENT_AGGREGATES_OMITTED
      })
    })

    const result = await run()

    assert.equal(result.stillPending, 1)
    assert.equal(state.expirationCalls.length, 0)
    assert.equal(state.releaseInventoryCalls, 0)
    assert.equal(state.units[0].status, 'reserved')
  })

  for (const { name, paymentOverrides } of [
    {
      name: 'missing PAYABLE metadata',
      paymentOverrides: {
        providerCancellationPayableStatus: null,
        providerCancellationPayableObservedAt: null
      }
    },
    {
      name: 'PAYABLE observed after cancellation attempt',
      paymentOverrides: {
        providerCancellationPayableObservedAt: new Date(baseNow.getTime() + 1)
      }
    },
    {
      name: 'prepared cancellation status',
      paymentOverrides: { providerCancellationStatus: 'prepared' }
    },
    {
      name: 'rejected cancellation status',
      paymentOverrides: { providerCancellationStatus: 'rejected' }
    },
    {
      name: 'provider payment identity',
      paymentOverrides: { providerPaymentId: 'PAY-UNEXPECTED' }
    },
    {
      name: 'local approval timestamp',
      paymentOverrides: { approvedAt: baseNow }
    },
    {
      name: 'external reference mismatch',
      paymentOverrides: { externalReference: 'LC-OTHER' }
    },
    {
      name: 'amount mismatch',
      paymentOverrides: { amountArs: '1.00' }
    },
    {
      name: 'currency mismatch',
      paymentOverrides: { currency: 'USD' }
    }
  ]) {
    it(`does not elevate omitted aggregates with ${name}`, async () => {
      const order = makeOrder(1, { reservationExpiresAt: new Date(baseNow.getTime() - 1) })
      const payment = makePayment(order, {
        providerCancellationIdempotencyKey: 'cancel-invalid-context',
        providerCancellationStatus: 'uncertain',
        providerCancellationAttemptedAt: baseNow,
        providerCancellationPayableStatus: 'created',
        providerCancellationPayableObservedAt: baseNow,
        ...paymentOverrides
      })
      const { run, state } = makeHarness({
        orders: [order],
        payments: { [order._id]: payment },
        reconcile: async () => ({
          outcome: 'pending',
          remoteClassification: REMOTE_ORDER_CLASSIFICATIONS.CANCELED_PAYMENT_AGGREGATES_OMITTED,
          verifiedProviderContext: verifiedProviderContextFor(order)
        })
      })

      const result = await run()

      assert.equal(result.stillPending, 1)
      assert.equal(state.expirationCalls.length, 0)
      assert.equal(state.releaseInventoryCalls, 0)
      assert.equal(state.units[0].status, 'reserved')
    })
  }

  it('rejects a concurrent cancellation-key mutation before expiration', async () => {
    const order = makeOrder(1, { reservationExpiresAt: new Date(baseNow.getTime() - 1) })
    const payment = makePayment(order, {
      providerCancellationIdempotencyKey: 'cancel-original',
      providerCancellationStatus: 'uncertain',
      providerCancellationAttemptedAt: baseNow,
      providerCancellationPayableStatus: 'created',
      providerCancellationPayableObservedAt: baseNow
    })
    const { run, state } = makeHarness({
      orders: [order],
      payments: { [order._id]: payment },
      reconcile: async () => ({
        outcome: 'pending',
        remoteClassification: REMOTE_ORDER_CLASSIFICATIONS.CANCELED_PAYMENT_AGGREGATES_OMITTED,
        verifiedProviderContext: verifiedProviderContextFor(order)
      }),
      renewHook: ({ call, state }) => {
        if (call === 2) {
          state.payments.get(order._id).providerCancellationIdempotencyKey = 'cancel-mutated'
        }
        return true
      }
    })

    const result = await run()

    assert.equal(result.errors, 1)
    assert.equal(state.expirationCalls.length, 0)
    assert.equal(state.releaseInventoryCalls, 0)
    assert.equal(state.units[0].status, 'reserved')
  })

  it('rejects canceled evidence observed before the persisted cancellation attempt', async () => {
    const order = makeOrder(1, { reservationExpiresAt: new Date(baseNow.getTime() - 1) })
    const payment = makePayment(order, {
      providerCancellationIdempotencyKey: 'cancel-future-attempt',
      providerCancellationStatus: 'uncertain',
      providerCancellationAttemptedAt: new Date(baseNow.getTime() + 1),
      providerCancellationPayableStatus: 'created',
      providerCancellationPayableObservedAt: baseNow
    })
    const { run, state } = makeHarness({
      orders: [order],
      payments: { [order._id]: payment },
      reconcile: async () => ({
        outcome: 'pending',
        remoteClassification: REMOTE_ORDER_CLASSIFICATIONS.CANCELED_PAYMENT_AGGREGATES_OMITTED,
        verifiedProviderContext: verifiedProviderContextFor(order)
      })
    })

    const result = await run()

    assert.equal(result.errors, 1)
    assert.equal(state.expirationCalls.length, 0)
    assert.equal(state.releaseInventoryCalls, 0)
    assert.equal(state.units[0].status, 'reserved')
  })

  it('does not release contextual cancellation evidence after losing the claim', async () => {
    const order = makeOrder(1, { reservationExpiresAt: new Date(baseNow.getTime() - 1) })
    const payment = makePayment(order, {
      providerCancellationIdempotencyKey: 'cancel-claim-lost',
      providerCancellationStatus: 'uncertain',
      providerCancellationAttemptedAt: baseNow,
      providerCancellationPayableStatus: 'created',
      providerCancellationPayableObservedAt: baseNow
    })
    const { run, state } = makeHarness({
      orders: [order],
      payments: { [order._id]: payment },
      reconcile: async () => ({
        outcome: 'pending',
        remoteClassification: REMOTE_ORDER_CLASSIFICATIONS.CANCELED_PAYMENT_AGGREGATES_OMITTED,
        verifiedProviderContext: verifiedProviderContextFor(order)
      }),
      renewHook: ({ call }) => call !== 2
    })

    const result = await run()

    assert.equal(result.claimLost, 1)
    assert.equal(state.expirationCalls.length, 0)
    assert.equal(state.releaseInventoryCalls, 0)
    assert.equal(state.units[0].status, 'reserved')
  })

  it('keeps stock reserved and backs off on definitive cancellation rejection', async () => {
    const order = makeOrder(1, { reservationExpiresAt: new Date(baseNow.getTime() - 1) })
    const rejected = Object.assign(new Error('rejected'), {
      code: 'MERCADOPAGO_CANCELLATION_REJECTED',
      status: 409
    })
    const { run, state } = makeHarness({
      orders: [order],
      cancel: async () => { throw rejected }
    })

    const result = await run()

    assert.equal(result.cancelRejected, 1)
    assert.equal(state.expirationCalls.length, 0)
    assert.equal(state.units[0].status, 'reserved')
    assert.equal(state.orders[0].reconciliationFailures, 1)
  })

  it('never expires when the post-cancel GET discovers APPROVED', async () => {
    const order = makeOrder(1, { reservationExpiresAt: new Date(baseNow.getTime() - 1) })
    const { run, state } = makeHarness({
      orders: [order],
      reconcile: async ({ state, findOrder }) => {
        if (state.providerCalls === 1) {
          return {
            outcome: 'pending',
            remoteClassification: REMOTE_ORDER_CLASSIFICATIONS.PAYABLE
          }
        }
        const current = findOrder(order._id)
        current.status = 'paid'
        state.payments.get(order._id).normalizedStatus = 'approved'
        state.units[0].status = 'sold'
        return { outcome: 'paid' }
      }
    })

    const result = await run()

    assert.equal(result.paid, 1)
    assert.equal(state.providerCalls, 2)
    assert.equal(state.expirationCalls.length, 0)
    assert.equal(state.units[0].status, 'sold')
  })

  it('does not release when the post-cancel GET remains PROCESSING', async () => {
    const order = makeOrder(1, { reservationExpiresAt: new Date(baseNow.getTime() - 1) })
    const { run, state } = makeHarness({
      orders: [order],
      reconcile: async ({ state }) => ({
        outcome: 'pending',
        remoteClassification: state.providerCalls === 1
          ? REMOTE_ORDER_CLASSIFICATIONS.PAYABLE
          : REMOTE_ORDER_CLASSIFICATIONS.PROCESSING
      })
    })

    const result = await run()

    assert.equal(result.stillPending, 1)
    assert.equal(state.providerCalls, 2)
    assert.equal(state.expirationCalls.length, 0)
    assert.equal(state.units[0].status, 'reserved')
  })

  it('does not release when the mandatory post-cancel GET is unavailable', async () => {
    const order = makeOrder(1, { reservationExpiresAt: new Date(baseNow.getTime() - 1) })
    const unavailable = Object.assign(new Error('unavailable'), {
      code: 'MERCADOPAGO_UNAVAILABLE',
      status: 503
    })
    const { run, state } = makeHarness({
      orders: [order],
      reconcile: async ({ state }) => {
        if (state.providerCalls === 2) throw unavailable
        return {
          outcome: 'pending',
          remoteClassification: REMOTE_ORDER_CLASSIFICATIONS.PAYABLE
        }
      }
    })

    const result = await run()

    assert.equal(result.providerUnavailable, 1)
    assert.equal(state.providerCalls, 2)
    assert.equal(state.expirationCalls.length, 0)
    assert.equal(state.units[0].status, 'reserved')
    assert.equal(state.orders[0].reconciliationFailures, 1)
  })

  it('does not POST cancel after losing the claim immediately before cancellation', async () => {
    const order = makeOrder(1, { reservationExpiresAt: new Date(baseNow.getTime() - 1) })
    const { run, state } = makeHarness({
      orders: [order],
      renewHook: ({ call }) => call !== 2
    })

    const result = await run()

    assert.equal(result.claimLost, 1)
    assert.equal(state.cancelCalls, 0)
    assert.equal(state.expirationCalls.length, 0)
  })

  it('lets a later worker converge after claim loss between cancel and the second GET', async () => {
    const order = makeOrder(1, { reservationExpiresAt: new Date(baseNow.getTime() - 1) })
    const harness = makeHarness({
      orders: [order],
      renewHook: ({ call, state }) => {
        if (call !== 3) return true
        state.orders[0].reconciliationLeaseUntil = new Date(baseNow.getTime() - 1)
        return false
      },
      reconcile: async ({ state }) => ({
        outcome: 'pending',
        remoteClassification: state.providerCalls === 1
          ? REMOTE_ORDER_CLASSIFICATIONS.PAYABLE
          : REMOTE_ORDER_CLASSIFICATIONS.TERMINAL_UNPAID
      })
    })

    const first = await harness.run({ runId: 'worker-before-loss' })
    const second = await harness.run({ runId: 'worker-after-loss' })

    assert.equal(first.claimLost, 1)
    assert.equal(second.expired, 1)
    assert.equal(harness.state.cancelCalls, 1)
    assert.equal(harness.state.expirationCalls.length, 1)
  })

  it('does not call expiration after losing the claim immediately before it', async () => {
    const order = makeOrder(1, { reservationExpiresAt: new Date(baseNow.getTime() - 1) })
    const { run, state } = makeHarness({
      orders: [order],
      renewHook: ({ call }) => call !== 2,
      reconcile: async () => ({
        outcome: 'pending',
        remoteClassification: REMOTE_ORDER_CLASSIFICATIONS.TERMINAL_UNPAID
      })
    })

    const result = await run()

    assert.equal(result.claimLost, 1)
    assert.equal(state.expirationCalls.length, 0)
    assert.equal(state.units[0].status, 'reserved')
  })

  it('converges to paid when a webhook approves between cancel and the second GET', async () => {
    const order = makeOrder(1, { reservationExpiresAt: new Date(baseNow.getTime() - 1) })
    const { run, state } = makeHarness({
      orders: [order],
      cancel: async ({ state, findOrder, paymentId }) => {
        findOrder(order._id).status = 'paid'
        state.payments.get(order._id).normalizedStatus = 'approved'
        state.units[0].status = 'sold'
        return { paymentId, providerCancellationStatus: 'succeeded' }
      },
      reconcile: async ({ state }) => state.providerCalls === 1
        ? {
            outcome: 'pending',
            remoteClassification: REMOTE_ORDER_CLASSIFICATIONS.PAYABLE
          }
        : { outcome: 'paid' }
    })

    const result = await run()

    assert.equal(result.paid, 1)
    assert.equal(state.expirationCalls.length, 0)
    assert.equal(state.units[0].status, 'sold')
  })

  it('fails closed when buyer recovery approves during OrderExpirationService', async () => {
    const order = makeOrder(1, { reservationExpiresAt: new Date(baseNow.getTime() - 1) })
    const conflict = Object.assign(new Error('payment changed'), {
      code: 'PAYMENT_EXPIRATION_CONFLICT'
    })
    const { run, state } = makeHarness({
      orders: [order],
      reconcile: async () => ({
        outcome: 'pending',
        remoteClassification: REMOTE_ORDER_CLASSIFICATIONS.TERMINAL_UNPAID
      }),
      expire: async ({ state, findOrder }) => {
        findOrder(order._id).status = 'paid'
        state.payments.get(order._id).normalizedStatus = 'approved'
        state.units[0].status = 'sold'
        throw conflict
      }
    })

    const result = await run()

    assert.equal(result.errors, 1)
    assert.equal(state.expirationCalls.length, 1)
    assert.equal(state.units[0].status, 'sold')
    assert.equal(state.units.some(({ status }) => status === 'available'), false)
  })

  it('rejects terminal evidence when the persisted observation differs by exactly 1ms', async () => {
    const order = makeOrder(1, { reservationExpiresAt: new Date(baseNow.getTime() - 1) })
    const returnedObservation = new Date('2026-10-29T02:44:05.366Z')
    const { run, state } = makeHarness({
      orders: [order],
      renewHook: ({ call, state }) => {
        if (call === 2) {
          state.payments.get(order._id).lastProviderCheckAt = new Date(
            returnedObservation.getTime() + 1
          )
        }
        return true
      },
      reconcile: async () => ({
        outcome: 'pending',
        remoteClassification: REMOTE_ORDER_CLASSIFICATIONS.TERMINAL_UNPAID,
        observedAt: returnedObservation
      })
    })

    const result = await run()

    assert.equal(result.errors, 1)
    assert.equal(state.expirationCalls.length, 0)
    assert.equal(state.units[0].status, 'reserved')
    assert.equal(
      state.logs.some(({ metadata }) => metadata.code === 'TERMINAL_EVIDENCE_STALE'),
      true
    )
  })

  it('accepts different Date instances representing the exact same millisecond', async () => {
    const order = makeOrder(1, { reservationExpiresAt: new Date(baseNow.getTime() - 1) })
    const returnedObservation = new Date('2026-10-29T02:44:05.366Z')
    const { run, state } = makeHarness({
      orders: [order],
      reconcile: async () => ({
        outcome: 'pending',
        remoteClassification: REMOTE_ORDER_CLASSIFICATIONS.TERMINAL_UNPAID,
        observedAt: returnedObservation
      })
    })

    const result = await run()
    const persistedObservation = state.payments.get(order._id).lastProviderCheckAt

    assert.notEqual(persistedObservation, returnedObservation)
    assert.equal(persistedObservation.getTime(), returnedObservation.getTime())
    assert.equal(result.expired, 1)
    assert.equal(state.expirationCalls.length, 1)
    assert.equal(
      state.expirationCalls[0].terminalEvidence.observedAt.getTime(),
      persistedObservation.getTime()
    )
  })

  it('uses the persisted canceled observation for a recovered worker cancellation chain', async () => {
    const order = makeOrder(1, { reservationExpiresAt: new Date(baseNow.getTime() - 1) })
    const attemptedAt = new Date(baseNow.getTime() - 1000)
    const persistedObservation = new Date(baseNow.getTime() + 250)
    const payment = makePayment(order, {
      amountArs: mongoose.Types.Decimal128.fromString('154500.00'),
      providerCancellationIdempotencyKey: 'cancel-e2e-recovery',
      providerCancellationStatus: 'uncertain',
      providerCancellationAttemptedAt: attemptedAt,
      providerCancellationPayableStatus: 'created',
      providerCancellationPayableObservedAt: attemptedAt
    })
    const { run, state } = makeHarness({
      orders: [order],
      payments: { [order._id]: payment },
      reconcile: async () => ({
        outcome: 'pending',
        remoteClassification:
          REMOTE_ORDER_CLASSIFICATIONS.CANCELED_PAYMENT_AGGREGATES_OMITTED,
        observedAt: persistedObservation,
        verifiedProviderContext: verifiedProviderContextFor(order)
      })
    })

    const result = await run()

    assert.equal(result.expired, 1)
    assert.equal(state.cancelCalls, 0)
    assert.equal(state.releaseInventoryCalls, 1)
    assert.equal(state.expirationCalls[0].terminalEvidence.source, 'worker_cancellation_chain')
    assert.equal(
      state.expirationCalls[0].terminalEvidence.observedAt.getTime(),
      persistedObservation.getTime()
    )
  })

  it('does not reschedule an integrity-attention expiration outcome', async () => {
    const order = makeOrder(1, { reservationExpiresAt: new Date(baseNow.getTime() - 1) })
    const { run, state } = makeHarness({
      orders: [order],
      reconcile: async () => ({
        outcome: 'pending',
        remoteClassification: REMOTE_ORDER_CLASSIFICATIONS.TERMINAL_UNPAID
      }),
      expire: async ({ state, findOrder }) => {
        const current = findOrder(order._id)
        current.status = 'requires_attention'
        current.reconciliationNextAt = null
        current.reconciliationLeaseOwner = null
        current.reconciliationLeaseUntil = null
        state.payments.get(order._id).normalizedStatus = 'requires_attention'
        return { outcome: 'requires_attention', reason: 'RESERVATION_INTEGRITY_CONFLICT' }
      }
    })

    const result = await run()

    assert.equal(result.integrityAttention, 1)
    assert.equal(state.orders[0].reconciliationNextAt, null)
    assert.equal(state.units[0].status, 'reserved')
  })

  it('treats already_expired as an idempotent terminal outcome', async () => {
    const order = makeOrder(1, { reservationExpiresAt: new Date(baseNow.getTime() - 1) })
    const { run, state } = makeHarness({
      orders: [order],
      reconcile: async () => ({
        outcome: 'pending',
        remoteClassification: REMOTE_ORDER_CLASSIFICATIONS.TERMINAL_UNPAID
      }),
      expire: async ({ findOrder }) => {
        const current = findOrder(order._id)
        current.status = 'expired'
        current.reconciliationNextAt = null
        current.reconciliationLeaseOwner = null
        current.reconciliationLeaseUntil = null
        return { outcome: 'already_expired' }
      }
    })

    const result = await run()

    assert.equal(result.alreadyExpired, 1)
    assert.equal(state.orders[0].reconciliationNextAt, null)
  })

  it('expires when the post-cancel terminal observation occurs exactly at reservation expiry', async () => {
    const order = makeOrder(1, { reservationExpiresAt: baseNow })
    const { run, state } = makeHarness({
      orders: [order],
      reconcile: async ({ state }) => ({
        outcome: 'pending',
        remoteClassification: state.providerCalls === 1
          ? REMOTE_ORDER_CLASSIFICATIONS.PAYABLE
          : REMOTE_ORDER_CLASSIFICATIONS.TERMINAL_UNPAID
      })
    })

    const result = await run()

    assert.equal(result.expired, 1)
    assert.equal(state.providerCalls, 2)
    assert.equal(state.cancelCalls, 1)
    assert.equal(state.expirationCalls.length, 1)
    assert.equal(state.releaseInventoryCalls, 1)
  })

  it('allows only the current claim owner to expire under two concurrent workers', async () => {
    let releaseProvider
    const providerGate = new Promise((resolve) => { releaseProvider = resolve })
    const order = makeOrder(1, { reservationExpiresAt: new Date(baseNow.getTime() - 1) })
    const harness = makeHarness({
      orders: [order],
      reconcile: async () => {
        await providerGate
        return {
          outcome: 'pending',
          remoteClassification: REMOTE_ORDER_CLASSIFICATIONS.TERMINAL_UNPAID
        }
      }
    })

    const first = harness.run({ runId: 'expiration-worker-a' })
    await Promise.resolve()
    const second = harness.run({ runId: 'expiration-worker-b' })
    releaseProvider()
    const [left, right] = await Promise.all([first, second])

    assert.equal(left.expired + right.expired, 1)
    assert.equal(harness.state.expirationCalls.length, 1)
    assert.equal(harness.state.releaseInventoryCalls, 1)
  })

  it('reconciles after cancellation preflight discovers a non-cancelable approved state', async () => {
    const order = makeOrder(1, { reservationExpiresAt: new Date(baseNow.getTime() - 1) })
    const notCancelable = Object.assign(new Error('approved'), {
      code: 'MERCADOPAGO_ORDER_NOT_CANCELABLE',
      details: { remoteClassification: REMOTE_ORDER_CLASSIFICATIONS.APPROVED }
    })
    const { run, state } = makeHarness({
      orders: [order],
      cancel: async () => { throw notCancelable },
      reconcile: async ({ state, findOrder }) => {
        if (state.providerCalls === 1) {
          return {
            outcome: 'pending',
            remoteClassification: REMOTE_ORDER_CLASSIFICATIONS.PAYABLE
          }
        }
        findOrder(order._id).status = 'paid'
        state.payments.get(order._id).normalizedStatus = 'approved'
        state.units[0].status = 'sold'
        return { outcome: 'paid' }
      }
    })

    const result = await run()

    assert.equal(result.paid, 1)
    assert.equal(state.providerCalls, 2)
    assert.equal(state.expirationCalls.length, 0)
    assert.equal(state.units[0].status, 'sold')
  })

  it('always performs a fresh reconciler GET when cancellation reports alreadyCanceled', async () => {
    const order = makeOrder(1, { reservationExpiresAt: new Date(baseNow.getTime() - 1) })
    const { run, state } = makeHarness({
      orders: [order],
      cancel: async ({ paymentId }) => ({
        paymentId,
        outcome: 'terminal_unpaid',
        alreadyCanceled: true
      }),
      reconcile: async ({ state }) => ({
        outcome: 'pending',
        remoteClassification: state.providerCalls === 1
          ? REMOTE_ORDER_CLASSIFICATIONS.PAYABLE
          : REMOTE_ORDER_CLASSIFICATIONS.TERMINAL_UNPAID
      })
    })

    const result = await run()

    assert.equal(result.expired, 1)
    assert.equal(state.providerCalls, 2)
    assert.equal(state.expirationCalls.length, 1)
  })

  for (const [name, error] of [
    ['provider unavailable', Object.assign(new Error('unavailable'), { code: 'MERCADOPAGO_UNAVAILABLE', status: 503 })],
    ['timeout', Object.assign(new Error('timeout'), { code: 'MERCADOPAGO_TIMEOUT', status: 503 })],
    ['rate limit', Object.assign(new Error('rate limit'), { code: 'MERCADOPAGO_RATE_LIMITED', status: 429 })]
  ]) {
    it(`fails closed with backoff on ${name}`, async () => {
      const { run, state } = makeHarness({ reconcile: async () => { throw error } })
      const result = await run()
      assert.equal(result.providerUnavailable, 1)
      assert.equal(state.orders[0].reconciliationFailures, 1)
      assert.equal(state.orders[0].status, 'pending_payment')
      assert.equal(state.orders[0].reconciliationNextAt.toISOString(), new Date(baseNow.getTime() + fiveMinutes).toISOString())
    })
  }

  it('does no provider GET for a locally approved Payment', async () => {
    const order = makeOrder(1)
    const payments = { [order._id]: makePayment(order, { normalizedStatus: 'approved' }) }
    const { run, state } = makeHarness({ orders: [order], payments })
    const result = await run()
    assert.equal(result.uncertain, 1)
    assert.equal(state.providerCalls, 0)
  })

  it('does not discover an already paid Order', async () => {
    const { run, state } = makeHarness({ orders: [makeOrder(1, { status: 'paid' })] })
    const result = await run()
    assert.equal(result.candidates, 0)
    assert.equal(state.providerCalls, 0)
  })

  it('does not discover an Order that requires attention', async () => {
    const { run, state } = makeHarness({ orders: [makeOrder(1, { status: 'requires_attention' })] })
    const result = await run()
    assert.equal(result.candidates, 0)
    assert.equal(state.providerCalls, 0)
  })

  for (const providerAttemptStatus of ['prepared', 'conflict', 'uncertain']) {
    it(`fails closed without POST when providerOrderId is absent and attempt is ${providerAttemptStatus}`, async () => {
      const order = makeOrder(1)
      const payments = {
        [order._id]: makePayment(order, { providerOrderId: null, providerAttemptStatus })
      }
      const { run, state } = makeHarness({ orders: [order], payments })
      const result = await run()
      assert.equal(result.uncertain, 1)
      assert.equal(state.providerCalls, 0)
      assert.equal(state.orders[0].status, 'pending_payment')
    })
  }

  it('fails closed and schedules succeeded without providerOrderId', async () => {
    const order = makeOrder(1)
    const payments = {
      [order._id]: makePayment(order, {
        providerOrderId: null,
        providerAttemptStatus: 'succeeded'
      })
    }
    const { run, state } = makeHarness({ orders: [order], payments })
    const result = await run()

    assert.equal(result.uncertain, 1)
    assert.equal(state.providerCalls, 0)
    assert.equal(state.orders[0].status, 'pending_payment')
    assert.equal(
      state.orders[0].reconciliationNextAt.toISOString(),
      new Date(baseNow.getTime() + fiveMinutes).toISOString()
    )
    assert.equal(state.cancelCalls, 0)
    assert.equal(state.releaseInventoryCalls, 0)
  })

  it('fails closed for legacy Payment without provider attempt metadata', async () => {
    const order = makeOrder(1)
    const payment = makePayment(order, { providerOrderId: null })
    delete payment.providerAttemptStatus
    const { run, state } = makeHarness({ orders: [order], payments: { [order._id]: payment } })
    const result = await run()
    assert.equal(result.uncertain, 1)
    assert.equal(state.providerCalls, 0)
  })

  for (const providerAttemptStatus of ['rejected', null]) {
    it(`does not expire a no-provider Payment with attempt ${providerAttemptStatus}`, async () => {
      const order = makeOrder(1, { reservationExpiresAt: new Date(baseNow.getTime() - 1) })
      const payments = {
        [order._id]: makePayment(order, { providerOrderId: null, providerAttemptStatus })
      }
      const { run, state } = makeHarness({ orders: [order], payments })
      await run()
      assert.equal(state.orders[0].status, 'pending_payment')
      assert.equal(state.releaseInventoryCalls, 0)
      assert.equal(state.cancelCalls, 0)
    })
  }

  it('lets only one of two workers claim the same Order', async () => {
    let releaseProvider
    const providerGate = new Promise((resolve) => { releaseProvider = resolve })
    const harness = makeHarness({
      reconcile: async () => {
        await providerGate
        return { outcome: 'pending', remoteClassification: REMOTE_ORDER_CLASSIFICATIONS.PAYABLE }
      }
    })
    const first = harness.run({ runId: 'worker-a' })
    await Promise.resolve()
    const second = harness.run({ runId: 'worker-b' })
    releaseProvider()
    const [left, right] = await Promise.all([first, second])
    assert.equal(left.claimed + right.claimed, 1)
    assert.equal(harness.state.providerCalls, 1)
  })

  it('takes over an expired claim', async () => {
    const order = makeOrder(1, {
      reconciliationLeaseOwner: 'stale',
      reconciliationLeaseUntil: new Date(baseNow.getTime() - 1)
    })
    const { run, state } = makeHarness({ orders: [order] })
    const result = await run()
    assert.equal(result.claimed, 1)
    assert.equal(state.orders[0].reconciliationAttempts, 1)
  })

  it('prevents a stale owner from scheduling after takeover during GET', async () => {
    const harness = makeHarness({
      reconcile: async ({ findOrder }) => {
        const order = findOrder('order-1')
        order.reconciliationLeaseOwner = 'new-owner'
        order.reconciliationLeaseUntil = new Date(baseNow.getTime() + 60 * 1000)
        return { outcome: 'pending', remoteClassification: REMOTE_ORDER_CLASSIFICATIONS.PAYABLE }
      }
    })
    const result = await harness.run()
    assert.equal(result.claimLost, 1)
    assert.equal(harness.state.orders[0].reconciliationNextAt, null)
    assert.equal(harness.state.orders[0].reconciliationLeaseOwner, 'new-owner')
    assert.equal(harness.state.releaseAttempts.length, 0)
  })

  it('keeps financial CAS single when a stale worker finishes approved after takeover', async () => {
    let clockNow = baseNow
    let enterA
    let enterB
    let releaseA
    let releaseB
    const aEntered = new Promise((resolve) => { enterA = resolve })
    const bEntered = new Promise((resolve) => { enterB = resolve })
    const gateA = new Promise((resolve) => { releaseA = resolve })
    const gateB = new Promise((resolve) => { releaseB = resolve })
    let reconciliationCalls = 0
    const financialTransitions = { payment: 0, order: 0, unit: 0 }
    const harness = makeHarness({
      clock: () => clockNow,
      reconcile: async ({ state, findOrder }) => {
        reconciliationCalls += 1
        if (reconciliationCalls === 1) {
          enterA()
          await gateA
        } else {
          enterB()
          await gateB
        }

        const order = findOrder('order-1')
        const payment = state.payments.get(order._id)
        if (payment.normalizedStatus === 'pending') {
          payment.normalizedStatus = 'approved'
          financialTransitions.payment += 1
        }
        if (order.status === 'pending_payment') {
          order.status = 'paid'
          order.statusHistory.push({ status: 'paid' })
          financialTransitions.order += 1
        }
        if (state.units[0].status === 'reserved') {
          state.units[0].status = 'sold'
          financialTransitions.unit += 1
        }
        return { outcome: 'paid' }
      }
    })
    harness.state.orders[0].statusHistory = []

    const workerA = harness.run({ runId: 'worker-a' })
    await aEntered
    clockNow = new Date(baseNow.getTime() + 60 * 1000 + 1)
    const workerB = harness.run({ runId: 'worker-b', now: clockNow })
    await bEntered

    releaseA()
    const resultA = await workerA
    assert.equal(resultA.paid, 1)
    assert.equal(harness.state.orders[0].reconciliationLeaseOwner, 'owner-2')
    assert.equal(harness.state.orders[0].reconciliationNextAt, null)
    assert.deepEqual(financialTransitions, { payment: 1, order: 1, unit: 1 })
    assert.equal(harness.state.orders[0].statusHistory.length, 1)
    assert.deepEqual(harness.state.releaseAttempts, [{
      orderId: 'order-1',
      ownerToken: 'owner-1'
    }])

    releaseB()
    const resultB = await workerB
    assert.equal(resultB.paid, 1)
    assert.deepEqual(financialTransitions, { payment: 1, order: 1, unit: 1 })
    assert.equal(harness.state.orders[0].statusHistory.length, 1)
    assert.equal(harness.state.units[0].status, 'sold')
    assert.equal(harness.state.orders[0].reconciliationLeaseOwner, null)
  })

  it('isolates a claim failure and continues with independent candidates', async () => {
    const claimError = Object.assign(new Error('claim failed'), { code: 'CLAIM_FAILED' })
    const orders = [makeOrder(1), makeOrder(2)]
    const { run, state } = makeHarness({
      orders,
      claimFailure: ({ orderId }) => orderId === 'order-1' ? claimError : null
    })
    const result = await run({ concurrency: 1 })

    assert.equal(result.candidates, 2)
    assert.equal(result.claimed, 1)
    assert.equal(result.processed, 1)
    assert.equal(result.errors, 1)
    assert.equal(result.stillPending, 1)
    assert.equal(state.providerCalls, 1)
    assert.equal(
      state.logs.some(({ metadata }) => metadata.code === 'CLAIM_FAILED'),
      true
    )
  })

  it('isolates a schedule failure and continues with independent candidates', async () => {
    const scheduleError = Object.assign(new Error('schedule failed'), { code: 'SCHEDULE_FAILED' })
    const orders = [makeOrder(1), makeOrder(2)]
    const { run, state } = makeHarness({
      orders,
      scheduleFailure: ({ orderId }) => orderId === 'order-1' ? scheduleError : null
    })
    const result = await run({ concurrency: 1 })

    assert.equal(result.errors, 1)
    assert.equal(result.stillPending, 1)
    assert.equal(result.processed, 2)
    assert.equal(state.providerCalls, 2)
    assert.equal(
      state.logs.some(({ metadata }) => metadata.code === 'SCHEDULE_FAILED'),
      true
    )
  })

  it('keeps a successful outcome when best-effort claim release fails', async () => {
    const releaseError = Object.assign(new Error('release failed'), { code: 'RELEASE_FAILED' })
    const { run, state } = makeHarness({ releaseFailure: () => releaseError })
    const result = await run()

    assert.equal(result.stillPending, 1)
    assert.equal(result.errors, 0)
    assert.equal(result.claimReleaseFailures, 1)
    assert.equal(
      state.logs.some(({ message }) => message === 'payment_reconciliation_run'),
      true
    )
    assert.equal(
      state.logs.some(({ metadata }) => (
        metadata.outcome === WORKER_OUTCOMES.CLAIM_RELEASE_FAILED &&
        metadata.code === 'RELEASE_FAILED' &&
        metadata.primaryCode === null
      )),
      true
    )
  })

  it('preserves the process error when process and release both fail', async () => {
    const processError = Object.assign(new Error('process failed'), { code: 'PROCESS_FAILED' })
    const releaseError = Object.assign(new Error('release failed'), { code: 'RELEASE_FAILED' })
    const { run, state } = makeHarness({
      getOrderFailure: () => processError,
      releaseFailure: () => releaseError
    })
    const result = await run()

    assert.equal(result.errors, 1)
    assert.equal(result.claimReleaseFailures, 1)
    const primaryLog = state.logs.find(({ metadata }) => metadata.outcome === WORKER_OUTCOMES.ERROR)
    const releaseLog = state.logs.find(({ metadata }) => (
      metadata.outcome === WORKER_OUTCOMES.CLAIM_RELEASE_FAILED
    ))
    assert.equal(primaryLog.metadata.code, 'PROCESS_FAILED')
    assert.equal(releaseLog.metadata.code, 'RELEASE_FAILED')
    assert.equal(releaseLog.metadata.primaryCode, 'PROCESS_FAILED')
  })

  it('continues after provider unavailable and claim release failure', async () => {
    const orders = [makeOrder(1), makeOrder(2)]
    const providerError = Object.assign(new Error('provider unavailable'), {
      code: 'MERCADOPAGO_UNAVAILABLE',
      status: 503
    })
    const releaseError = Object.assign(new Error('release failed'), { code: 'RELEASE_FAILED' })
    const { run, state } = makeHarness({
      orders,
      reconcile: async ({ providerOrderId }) => {
        if (providerOrderId === 'provider-order-1') throw providerError
        return { outcome: 'pending', remoteClassification: REMOTE_ORDER_CLASSIFICATIONS.PAYABLE }
      },
      releaseFailure: ({ orderId }) => orderId === 'order-1' ? releaseError : null
    })
    const result = await run({ concurrency: 1 })

    assert.equal(result.providerUnavailable, 1)
    assert.equal(result.stillPending, 1)
    assert.equal(result.claimReleaseFailures, 1)
    assert.equal(result.processed, 2)
    assert.equal(state.providerCalls, 2)
  })

  for (const actor of ['webhook', 'buyer recovery', 'P0 guard']) {
    it(`converges when ${actor} wins the concurrent approval`, async () => {
      const { run, state } = makeHarness({
        reconcile: async ({ state, findOrder }) => {
          const order = findOrder('order-1')
          const payment = state.payments.get(order._id)
          if (payment.normalizedStatus === 'pending') payment.normalizedStatus = 'approved'
          if (order.status === 'pending_payment') {
            order.status = 'paid'
            order.statusHistory.push({ status: 'paid', actor })
          }
          if (state.units[0].status === 'reserved') state.units[0].status = 'sold'
          return { outcome: 'paid' }
        }
      })
      state.orders[0].statusHistory = []
      const result = await run()
      assert.equal(result.paid, 1)
      assert.equal(state.providerCalls, 1)
      assert.equal(state.orders[0].status, 'paid')
      assert.equal(state.payments.get('order-1').normalizedStatus, 'approved')
      assert.equal(state.units[0].status, 'sold')
      assert.equal(state.orders[0].statusHistory.length, 1)

      const repeated = await run({ runId: `worker-after-${actor.replaceAll(' ', '-')}` })
      assert.equal(repeated.candidates, 0)
      assert.equal(state.providerCalls, 1)
      assert.equal(state.orders[0].statusHistory.length, 1)
    })
  }

  it('never imports or creates a PaymentEvent', async () => {
    const source = await readFile(new URL('../../src/services/paymentReconciliationWorker.service.js', import.meta.url), 'utf8')
    assert.equal(source.includes('PaymentEvent'), false)
  })

  for (const { name, ageMs, expiresInMs, delayMinutes } of [
    { name: '59m59s', ageMs: 59 * 60 * 1000 + 59 * 1000, expiresInMs: 5 * 60 * 60 * 1000, delayMinutes: 5 },
    { name: 'exactly one hour', ageMs: 60 * 60 * 1000, expiresInMs: 5 * 60 * 60 * 1000, delayMinutes: 15 },
    { name: 'one hour plus 1ms', ageMs: 60 * 60 * 1000 + 1, expiresInMs: 5 * 60 * 60 * 1000, delayMinutes: 15 },
    { name: '30m01s before expiry', ageMs: 2 * 60 * 60 * 1000, expiresInMs: 30 * 60 * 1000 + 1000, delayMinutes: 15 },
    { name: 'exactly 30m before expiry', ageMs: 2 * 60 * 60 * 1000, expiresInMs: 30 * 60 * 1000, delayMinutes: 5 },
    { name: 'exactly at expiry', ageMs: 2 * 60 * 60 * 1000, expiresInMs: 0, delayMinutes: 5 },
    { name: 'after expiry', ageMs: 2 * 60 * 60 * 1000, expiresInMs: -1, delayMinutes: 5 }
  ]) {
    it(`uses the expected scheduling boundary at ${name}`, () => {
      const nextAt = calculateNextReconciliationAt({
        now: baseNow,
        createdAt: new Date(baseNow.getTime() - ageMs),
        reservationExpiresAt: new Date(baseNow.getTime() + expiresInMs)
      })
      assert.equal(
        nextAt.toISOString(),
        new Date(baseNow.getTime() + delayMinutes * 60 * 1000).toISOString()
      )
    })
  }

  it('implements 5/10/20/30-minute provider failure backoff', () => {
    assert.deepEqual(
      [1, 2, 3, 4, 8].map((failure) => calculateProviderFailureBackoffMs(failure) / 60000),
      [5, 10, 20, 30, 30]
    )
  })

  it('resets previous failures after a successful provider response', async () => {
    const { run, state } = makeHarness({ orders: [makeOrder(1, { reconciliationFailures: 3 })] })
    await run()
    assert.equal(state.orders[0].reconciliationFailures, 0)
  })

  it('honors batch size with keyset discovery and no duplicate cursor items', async () => {
    const orders = Array.from({ length: 5 }, (_, index) => makeOrder(index + 1))
    const { run, state } = makeHarness({ orders })
    const result = await run({ batchSize: 2, maxOrders: 5, concurrency: 1 })
    assert.equal(result.candidates, 5)
    assert.deepEqual(state.limits, [2, 2, 1])
    assert.deepEqual(state.cursors.slice(1).map((cursor) => cursor._id), ['order-2', 'order-4'])
    assert.equal(new Set(state.orders.map((order) => order._id)).size, 5)
  })

  it('honors the maximum orders per run', async () => {
    const orders = Array.from({ length: 8 }, (_, index) => makeOrder(index + 1))
    const { run, state } = makeHarness({ orders })
    const result = await run({ batchSize: 2, maxOrders: 3 })
    assert.equal(result.candidates, 3)
    assert.equal(result.processed, 3)
    assert.equal(state.providerCalls, 3)
  })

  it('calculates a final limit one after 99 of max 100 with batch 20', () => {
    assert.equal(calculateCandidateLimit({
      batchSize: 20,
      maxOrders: 100,
      candidates: 99
    }), 1)
  })

  it('never starts candidate 101 with max 100 and batch 20', async () => {
    const orders = Array.from({ length: 101 }, (_, index) => makeOrder(index + 1, {
      _id: `order-${String(index + 1).padStart(3, '0')}`
    }))
    const { run, state } = makeHarness({ orders })
    const result = await run({ batchSize: 20, maxOrders: 100 })

    assert.equal(result.candidates, 100)
    assert.equal(result.processed, 100)
    assert.equal(state.providerCalls, 100)
    assert.deepEqual(state.limits, [20, 20, 20, 20, 20])
    assert.equal(state.orders.at(-1).reconciliationAttempts, 0)
    assert.equal(state.orders.at(-1).reconciliationNextAt, null)
  })

  it('never exceeds provider concurrency two even if a higher value is requested', async () => {
    const orders = Array.from({ length: 6 }, (_, index) => makeOrder(index + 1))
    const { run, state } = makeHarness({
      orders,
      reconcile: async () => {
        await new Promise((resolve) => setTimeout(resolve, 5))
        return { outcome: 'pending', remoteClassification: REMOTE_ORDER_CLASSIFICATIONS.PAYABLE }
      }
    })
    await run({ concurrency: 10 })
    assert.equal(state.maxActiveProviderCalls, 2)
  })

  it('uses the cancellation and expiration domain services without direct provider writes', async () => {
    const source = await readFile(
      new URL('../../src/services/paymentReconciliationWorker.service.js', import.meta.url),
      'utf8'
    )
    assert.equal(source.includes('this.cancellation.cancelPaymentOrder('), true)
    assert.equal(
      source.includes('this.expiration.expirePendingOrderWithTerminalUnpaidEvidence('),
      true
    )
    assert.equal(source.includes('.cancelOrder('), false)
    assert.equal(source.includes('releaseExpiredReservations'), false)
    assert.equal(source.includes("nextStatus: 'expired'"), false)
    assert.equal(source.includes("status: 'available'"), false)
    assert.equal(source.includes('PaymentEvent'), false)
  })

  it('exposes the expected claim-lost operational outcome', () => {
    assert.equal(WORKER_OUTCOMES.CLAIM_LOST, 'claim_lost')
  })
})
