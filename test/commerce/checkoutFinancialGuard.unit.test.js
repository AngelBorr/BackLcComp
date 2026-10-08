/* eslint-env mocha */
import assert from 'node:assert/strict'
import mongoose from 'mongoose'
import { CheckoutFinancialGuardService } from '../../src/services/checkoutFinancialGuard.service.js'

const userId = new mongoose.Types.ObjectId().toString()
const otherUserId = new mongoose.Types.ObjectId().toString()
const now = new Date('2026-10-06T15:00:00.000Z')

const makeOrder = (overrides = {}) => ({
  _id: new mongoose.Types.ObjectId(),
  userId,
  orderNumber: 'LC-2026-000003',
  status: 'requires_attention',
  attentionReason: 'RESERVATION_EXPIRED',
  reservationExpiresAt: new Date('2026-10-06T14:00:00.000Z'),
  createdAt: new Date('2026-10-06T10:00:00.000Z'),
  ...overrides
})

const makePayment = (order, overrides = {}) => ({
  _id: new mongoose.Types.ObjectId(),
  orderId: order._id,
  normalizedStatus: 'approved',
  providerOrderId: 'ORD-APPROVED',
  providerCheckoutUrl: 'https://www.mercadopago.com.ar/checkout/v1/redirect',
  providerRequestSnapshot: { type: 'online' },
  providerIdempotencyKey: 'provider-key',
  providerAttemptStatus: 'succeeded',
  ...overrides
})

const makeHarness = ({ operations = [], reconcile } = {}) => {
  const state = { reconciliationCalls: [] }
  const orderManager = {
    async getFinanciallyUnresolvedByUserId(requestedUserId) {
      return operations
        .filter(({ order }) => (
          String(order.userId) === String(requestedUserId) && order.status !== 'paid'
        ))
        .map(({ order }) => order)
    },
    async getByUserAndCheckoutIdempotencyKey(requestedUserId, idempotencyKey) {
      return operations.find(({ order }) => (
        String(order.userId) === String(requestedUserId) &&
        order.checkoutIdempotencyKey === idempotencyKey
      ))?.order || null
    },
    async getById(orderId) {
      return operations.find(({ order }) => String(order._id) === String(orderId))?.order || null
    }
  }
  const paymentManager = {
    async getLatestByOrderId(orderId) {
      return operations.find(({ order }) => String(order._id) === String(orderId))?.payment || null
    },
    async getById(paymentId) {
      return operations.find(({ payment }) => String(payment?._id) === String(paymentId))?.payment || null
    }
  }
  const mercadoPagoReconciliationService = {
    async reconcileProviderOrder(providerOrderId, options) {
      state.reconciliationCalls.push({ providerOrderId, options })
      if (reconcile) return reconcile(providerOrderId, options)
      return { outcome: 'pending' }
    }
  }

  return {
    state,
    service: new CheckoutFinancialGuardService({
      orderManager,
      paymentManager,
      mercadoPagoReconciliationService
    })
  }
}

describe('CheckoutFinancialGuardService P0 (isolated unit tests)', () => {
  it('blocks approved plus requires_attention independently of a new key or fingerprint', async () => {
    const order = makeOrder()
    const payment = makePayment(order)
    const { service, state } = makeHarness({ operations: [{ order, payment }] })

    await assert.rejects(
      service.assertCanCreateCheckout(userId, { now, reconcile: true }),
      (error) => (
        error.code === 'CHECKOUT_BLOCKED_BY_APPROVED_PAYMENT' &&
        error.details.checkoutBlocker.orderNumber === 'LC-2026-000003' &&
        error.details.checkoutBlocker.attentionReason === 'RESERVATION_EXPIRED'
      )
    )

    assert.equal(state.reconciliationCalls.length, 0)
  })

  it('does not let another user operation block this buyer', async () => {
    const order = makeOrder({ userId: otherUserId })
    const payment = makePayment(order)
    const { service } = makeHarness({ operations: [{ order, payment }] })

    assert.deepEqual(await service.getEligibility(userId, { now }), {
      allowed: true,
      blocker: null
    })
  })

  it('allows a new checkout when the only prior Order was already paid before this request', async () => {
    const paidOrder = makeOrder({ status: 'paid' })
    const payment = makePayment(paidOrder)
    const { service, state } = makeHarness({ operations: [{ order: paidOrder, payment }] })

    assert.deepEqual(
      await service.assertCanCreateCheckout(userId, { now, reconcile: true }),
      { allowed: true, blocker: null }
    )
    assert.equal(state.reconciliationCalls.length, 0)
  })

  it('allows historical paid Orders and terminal unpaid Payments', async () => {
    const paidOrder = makeOrder({ status: 'paid' })
    const rejectedOrder = makeOrder({
      _id: new mongoose.Types.ObjectId(),
      orderNumber: 'LC-2026-000004',
      status: 'cancelled'
    })
    const operations = [
      { order: paidOrder, payment: makePayment(paidOrder) },
      {
        order: rejectedOrder,
        payment: makePayment(rejectedOrder, {
          normalizedStatus: 'rejected',
          providerOrderId: null,
          providerCheckoutUrl: null,
          providerAttemptStatus: 'rejected'
        })
      }
    ]
    const { service } = makeHarness({ operations })

    assert.equal((await service.getEligibility(userId, { now })).allowed, true)
  })

  it('reconciles a provider Order and blocks when it becomes approved', async () => {
    const order = makeOrder({ status: 'pending_payment' })
    const payment = makePayment(order, { normalizedStatus: 'pending' })
    const operations = [{ order, payment }]
    const { service, state } = makeHarness({
      operations,
      reconcile: async () => {
        payment.normalizedStatus = 'approved'
        order.status = 'requires_attention'
        return { outcome: 'requires_attention' }
      }
    })

    await assert.rejects(
      service.assertCanCreateCheckout(userId, { now, reconcile: true }),
      (error) => error.code === 'CHECKOUT_BLOCKED_BY_APPROVED_PAYMENT'
    )
    assert.equal(state.reconciliationCalls.length, 1)
  })

  it('stops the same POST when reconciliation confirms the prior payment as paid', async () => {
    const order = makeOrder({ status: 'pending_payment' })
    const payment = makePayment(order, { normalizedStatus: 'pending' })
    const operations = [{ order, payment }]
    const { service, state } = makeHarness({
      operations,
      reconcile: async () => {
        payment.normalizedStatus = 'approved'
        order.status = 'paid'
        return {
          outcome: 'paid',
          orderId: order._id,
          paymentId: payment._id
        }
      }
    })

    await assert.rejects(
      service.assertCanCreateCheckout(userId, { now, reconcile: true }),
      (error) => (
        error.code === 'CHECKOUT_PRIOR_PAYMENT_CONFIRMED' &&
        error.status === 409 &&
        error.details.checkoutBlocker.orderStatus === 'paid' &&
        error.details.checkoutBlocker.paymentStatus === 'approved'
      )
    )
    assert.equal(state.reconciliationCalls.length, 1)
    assert.equal(order.status, 'paid')
    assert.equal(payment.normalizedStatus, 'approved')
  })

  it('fails closed when authoritative reconciliation remains pending', async () => {
    const order = makeOrder({ status: 'pending_payment' })
    const payment = makePayment(order, { normalizedStatus: 'pending' })
    const { service } = makeHarness({ operations: [{ order, payment }] })

    await assert.rejects(
      service.assertCanCreateCheckout(userId, { now, reconcile: true }),
      (error) => error.code === 'CHECKOUT_PRIOR_PAYMENT_UNCERTAIN'
    )
  })

  it('fails closed without exposing provider identifiers when reconciliation is unavailable', async () => {
    const order = makeOrder({ status: 'pending_payment' })
    const payment = makePayment(order, { normalizedStatus: 'pending' })
    const { service } = makeHarness({
      operations: [{ order, payment }],
      reconcile: async () => { throw new Error('provider unavailable ORDTST-secret') }
    })

    await assert.rejects(
      service.assertCanCreateCheckout(userId, { now, reconcile: true }),
      (error) => (
        error.code === 'CHECKOUT_RECONCILIATION_UNAVAILABLE' &&
        error.status === 503 &&
        !error.message.includes('ORDTST-secret')
      )
    )
  })

  for (const providerAttemptStatus of ['prepared', 'uncertain', 'conflict', 'succeeded']) {
    it(`fails closed for providerAttemptStatus=${providerAttemptStatus} without providerOrderId`, async () => {
      const order = makeOrder({ status: 'pending_payment' })
      const payment = makePayment(order, {
        normalizedStatus: 'pending',
        providerOrderId: null,
        providerCheckoutUrl: null,
        providerAttemptStatus
      })
      const { service } = makeHarness({ operations: [{ order, payment }] })

      assert.equal((await service.getEligibility(userId, { now })).allowed, false)
    })
  }

  it('allows an expired local checkout with explicit null attempt state and no remote evidence', async () => {
    const order = makeOrder({ status: 'pending_payment' })
    const payment = makePayment(order, {
      normalizedStatus: 'pending',
      providerOrderId: null,
      providerCheckoutUrl: null,
      providerRequestSnapshot: null,
      providerAttemptStatus: null
    })
    const { service } = makeHarness({ operations: [{ order, payment }] })

    assert.equal((await service.getEligibility(userId, { now })).allowed, true)
  })

  it('keeps a retryable rejected attempt on its original checkout while the Order is active', async () => {
    const order = makeOrder({
      status: 'pending_payment',
      reservationExpiresAt: new Date(now.getTime() + 60 * 60 * 1000)
    })
    const payment = makePayment(order, {
      normalizedStatus: 'pending',
      providerOrderId: null,
      providerCheckoutUrl: null,
      providerAttemptStatus: 'rejected'
    })
    const { service } = makeHarness({ operations: [{ order, payment }] })

    const result = await service.getEligibility(userId, { now })
    assert.equal(result.allowed, false)
    assert.equal(result.blocker.code, 'CHECKOUT_BLOCKED_BY_ACTIVE_ORDER')
  })

  it('fails closed for a legacy Payment without providerAttemptStatus', async () => {
    const order = makeOrder({ status: 'pending_payment' })
    const payment = makePayment(order, {
      normalizedStatus: 'pending',
      providerOrderId: null,
      providerCheckoutUrl: null,
      providerRequestSnapshot: null
    })
    delete payment.providerAttemptStatus
    const { service } = makeHarness({ operations: [{ order, payment }] })

    const result = await service.getEligibility(userId, { now })
    assert.equal(result.allowed, false)
    assert.equal(result.blocker.code, 'CHECKOUT_PRIOR_PAYMENT_UNCERTAIN')
  })

  it('allows only the same pending checkout to retry an uncertain provider attempt', async () => {
    const order = makeOrder({
      status: 'pending_payment',
      checkoutIdempotencyKey: 'same-logical-checkout'
    })
    const payment = makePayment(order, {
      normalizedStatus: 'pending',
      providerOrderId: null,
      providerCheckoutUrl: null,
      providerAttemptStatus: 'uncertain'
    })
    const { service } = makeHarness({ operations: [{ order, payment }] })

    const sameKey = await service.getEligibility(userId, {
      now,
      idempotencyKey: 'same-logical-checkout'
    })
    const newKey = await service.getEligibility(userId, {
      now,
      idempotencyKey: 'different-key'
    })

    assert.equal(sameKey.allowed, true)
    assert.equal(newKey.allowed, false)
    assert.equal(newKey.blocker.code, 'CHECKOUT_PRIOR_PAYMENT_UNCERTAIN')
  })

  it('does not let a same-key retry continue after a provider idempotency conflict', async () => {
    const order = makeOrder({
      status: 'pending_payment',
      checkoutIdempotencyKey: 'same-logical-checkout'
    })
    const payment = makePayment(order, {
      normalizedStatus: 'pending',
      providerOrderId: null,
      providerCheckoutUrl: null,
      providerAttemptStatus: 'conflict'
    })
    const { service } = makeHarness({ operations: [{ order, payment }] })

    const result = await service.getEligibility(userId, {
      now,
      idempotencyKey: 'same-logical-checkout'
    })

    assert.equal(result.allowed, false)
    assert.equal(result.blocker.code, 'CHECKOUT_PRIOR_PAYMENT_UNCERTAIN')
  })

  it('allows a same-key retry to return an already attached provider Order', async () => {
    const order = makeOrder({
      status: 'pending_payment',
      checkoutIdempotencyKey: 'same-logical-checkout'
    })
    const payment = makePayment(order, {
      normalizedStatus: 'pending',
      providerAttemptStatus: 'succeeded'
    })
    const { service } = makeHarness({ operations: [{ order, payment }] })

    const result = await service.getEligibility(userId, {
      now,
      idempotencyKey: 'same-logical-checkout'
    })

    assert.equal(result.allowed, true)
    assert.equal(result.blocker, null)
  })

  it('does not let a same-key retry bypass another approved unresolved Order', async () => {
    const retryOrder = makeOrder({
      status: 'pending_payment',
      checkoutIdempotencyKey: 'same-logical-checkout'
    })
    const approvedOrder = makeOrder({
      _id: new mongoose.Types.ObjectId(),
      orderNumber: 'LC-2026-000005'
    })
    const operations = [
      {
        order: retryOrder,
        payment: makePayment(retryOrder, {
          normalizedStatus: 'pending',
          providerOrderId: null,
          providerCheckoutUrl: null,
          providerAttemptStatus: 'uncertain'
        })
      },
      { order: approvedOrder, payment: makePayment(approvedOrder) }
    ]
    const { service } = makeHarness({ operations })

    const result = await service.getEligibility(userId, {
      now,
      idempotencyKey: 'same-logical-checkout'
    })
    assert.equal(result.allowed, false)
    assert.equal(result.blocker.code, 'CHECKOUT_BLOCKED_BY_APPROVED_PAYMENT')
    assert.equal(result.blocker.orderNumber, 'LC-2026-000005')
  })

  it('blocks a same-key approved checkout before another provider call can be attempted', () => {
    const { service } = makeHarness()

    assert.throws(
      () => service.assertCheckoutCanContinue({
        order: {
          orderNumber: 'LC-2026-000003',
          status: 'requires_attention',
          attentionReason: 'RESERVATION_EXPIRED'
        },
        payment: { status: 'approved' }
      }),
      (error) => error.code === 'CHECKOUT_BLOCKED_BY_APPROVED_PAYMENT'
    )
  })
})
