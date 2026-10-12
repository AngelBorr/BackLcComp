/* eslint-env mocha */
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import {
  PaymentReconciliationWorkerService,
  WORKER_OUTCOMES,
  calculateCandidateLimit,
  calculateNextReconciliationAt,
  calculateProviderFailureBackoffMs
} from '../../src/services/paymentReconciliationWorker.service.js'
import { REMOTE_ORDER_CLASSIFICATIONS } from '../../src/services/mercadoPagoOrderClassification.service.js'
import MercadoPagoOrderCancellationService from '../../src/services/mercadoPagoOrderCancellation.service.js'
import ProductUnitService from '../../src/services/productUnit.service.js'

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
  providerOrderId: `provider-${order._id}`,
  providerAttemptStatus: 'succeeded',
  ...overrides
})

const compareOrders = (left, right) => {
  const leftExpiry = left.reservationExpiresAt?.getTime() ?? Number.NEGATIVE_INFINITY
  const rightExpiry = right.reservationExpiresAt?.getTime() ?? Number.NEGATIVE_INFINITY
  return leftExpiry - rightExpiry || left._id.localeCompare(right._id)
}

const makeHarness = ({
  orders = [makeOrder(1)],
  payments,
  reconcile,
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
      return payment ? { ...payment } : null
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
        if (reconcile) return await reconcile({ providerOrderId, options, state, findOrder })
        return {
          outcome: 'pending',
          remoteClassification: REMOTE_ORDER_CLASSIFICATIONS.PAYABLE
        }
      } finally {
        state.activeProviderCalls -= 1
      }
    }
  }
  const worker = new PaymentReconciliationWorkerService({
    orderManager,
    paymentManager,
    claimService,
    reconciliationService,
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

  it('never calls automatic cancellation or inventory release', async () => {
    const originalCancel = MercadoPagoOrderCancellationService.cancelPaymentOrder
    const originalRelease = ProductUnitService.releaseExpiredReservations
    let cancelCalls = 0
    let releaseCalls = 0
    MercadoPagoOrderCancellationService.cancelPaymentOrder = async () => { cancelCalls += 1 }
    ProductUnitService.releaseExpiredReservations = async () => { releaseCalls += 1 }
    const { run, state } = makeHarness({
      reconcile: async () => ({
        outcome: 'pending',
        remoteClassification: REMOTE_ORDER_CLASSIFICATIONS.TERMINAL_UNPAID
      })
    })
    try {
      await run()
      assert.equal(cancelCalls, 0)
      assert.equal(releaseCalls, 0)
      assert.equal(state.cancelCalls, 0)
      assert.equal(state.releaseInventoryCalls, 0)
      assert.equal(state.units[0].status, 'reserved')
      const source = await readFile(new URL('../../src/services/paymentReconciliationWorker.service.js', import.meta.url), 'utf8')
      assert.equal(source.includes('.cancelPaymentOrder('), false)
      assert.equal(source.includes('.cancelOrder('), false)
      assert.equal(source.includes('releaseExpiredReservations'), false)
      assert.equal(source.includes("nextStatus: 'expired'"), false)
      assert.equal(source.includes("status: 'available'"), false)
      assert.equal(source.includes('PaymentEvent'), false)
    } finally {
      MercadoPagoOrderCancellationService.cancelPaymentOrder = originalCancel
      ProductUnitService.releaseExpiredReservations = originalRelease
    }
  })

  it('exposes the expected claim-lost operational outcome', () => {
    assert.equal(WORKER_OUTCOMES.CLAIM_LOST, 'claim_lost')
  })
})
