/* eslint-env mocha */
import assert from 'node:assert/strict'
import express from 'express'
import mongoose from 'mongoose'
import request from 'supertest'
import {
  BuyerPaymentReconciliationService,
  BUYER_RECONCILIATION_COOLDOWN_MS
} from '../../src/services/buyerPaymentReconciliation.service.js'
import {
  BuyerPaymentReconciliationController
} from '../../src/controllers/buyerPaymentReconciliation.controller.js'
import { ServiceError } from '../../src/services/service.products.js'
import { mapServiceErrorToHttp } from '../../src/middlewares/serviceErrorMapper.js'
import PaymentModel from '../../src/dao/models/payment.model.js'
import { PaymentManager } from '../../src/dao/managers/payment.manager.js'

const userId = new mongoose.Types.ObjectId().toString()
const otherUserId = new mongoose.Types.ObjectId().toString()
const orderId = new mongoose.Types.ObjectId().toString()
const paymentId = new mongoose.Types.ObjectId().toString()
const orderNumber = 'LC-2026-000101'
const providerOrderId = 'ORD-BUYER-RECOVERY-101'
const now = new Date('2026-10-09T12:00:00.000Z')

const clone = (value) => structuredClone(value)

const createHarness = (overrides = {}) => {
  const state = {
    order: {
      _id: orderId,
      orderNumber,
      userId,
      status: 'pending_payment',
      fulfillmentStatus: 'pending',
      reservationExpiresAt: new Date('2026-10-09T13:00:00.000Z'),
      paidAt: null,
      attentionReason: '',
      checkoutIdempotencyKey: 'must-not-leak'
    },
    payment: {
      _id: paymentId,
      orderId,
      provider: 'mercado_pago',
      providerOrderId,
      providerPaymentId: null,
      providerIdempotencyKey: 'must-not-leak',
      providerRequestSnapshot: { payer: 'must-not-leak' },
      providerAttemptStatus: 'succeeded',
      normalizedStatus: 'pending',
      approvedAt: null,
      lastProviderCheckAt: null
    },
    providerCalls: 0,
    providerCheckDates: [],
    claims: 0,
    paymentEvents: 0,
    financialTransitions: 0,
    productUnits: [{ status: 'reserved', soldAt: null }]
  }

  Object.assign(state.order, clone(overrides.order || {}))
  Object.assign(state.payment, clone(overrides.payment || {}))

  const orderManager = {
    async getByOrderNumberAndUserId(receivedOrderNumber, receivedUserId) {
      if (overrides.missingOrder) return null
      if (receivedOrderNumber !== orderNumber || String(receivedUserId) !== String(state.order.userId)) {
        return null
      }
      return clone(state.order)
    }
  }

  const paymentManager = {
    async getLatestByOrderId(receivedOrderId) {
      if (overrides.missingPayment || String(receivedOrderId) !== orderId) return null
      return clone(state.payment)
    },
    async claimBuyerProviderCheck(
      receivedPaymentId,
      { checkedAt, cooldownThreshold }
    ) {
      state.claims += 1
      if (
        String(receivedPaymentId) !== paymentId ||
        state.payment.normalizedStatus !== 'pending' ||
        !state.payment.providerOrderId
      ) return null

      const lastCheck = state.payment.lastProviderCheckAt
        ? new Date(state.payment.lastProviderCheckAt)
        : null
      if (lastCheck && lastCheck.getTime() > cooldownThreshold.getTime()) return null

      state.payment.lastProviderCheckAt = checkedAt
      return clone(state.payment)
    }
  }

  const reconciliationService = {
    async reconcileProviderOrder(receivedProviderOrderId, options) {
      state.providerCalls += 1
      state.providerCheckDates.push(options.now)
      assert.equal(receivedProviderOrderId, providerOrderId)
      if (overrides.gate) await overrides.gate()
      if (overrides.reconciliationError) throw overrides.reconciliationError
      if (overrides.reconcile) return overrides.reconcile(state)

      state.payment.normalizedStatus = 'approved'
      state.payment.approvedAt = options.now
      state.order.status = 'paid'
      state.order.fulfillmentStatus = 'preparing'
      state.order.paidAt = options.now
      state.productUnits[0].status = 'sold'
      state.productUnits[0].soldAt = options.now
      state.financialTransitions += 1
      return { outcome: 'paid', orderId, paymentId }
    }
  }

  return {
    state,
    service: new BuyerPaymentReconciliationService({
      orderManager,
      paymentManager,
      reconciliationService
    })
  }
}

const createHttpApp = ({ service, user = { id: userId, role: 'USER' } }) => {
  const app = express()
  const controller = new BuyerPaymentReconciliationController({
    buyerPaymentReconciliationService: service
  })
  app.use(express.json())
  app.use((req, _res, next) => {
    if (user) req.user = user
    next()
  })
  app.post('/api/orders/:orderNumber/reconcile-payment', controller.reconcile)
  app.use((error, _req, res, _next) => {
    const mapped = mapServiceErrorToHttp(error)
    res.status(mapped.status).json({ status: 'error', message: mapped.message })
  })
  return app
}

describe('Buyer payment reconciliation P1A (isolated)', () => {
  it('claims the provider cooldown with one atomic Payment compare-and-set', async () => {
    const original = PaymentModel.findOneAndUpdate
    let captured
    PaymentModel.findOneAndUpdate = (filter, update, options) => ({
      async lean() {
        captured = { filter, update, options }
        return { _id: paymentId }
      }
    })

    try {
      const cooldownThreshold = new Date(now.getTime() - BUYER_RECONCILIATION_COOLDOWN_MS)
      await new PaymentManager().claimBuyerProviderCheck(
        paymentId,
        { checkedAt: now, cooldownThreshold }
      )

      assert.equal(captured.filter._id, paymentId)
      assert.equal(captured.filter.provider, 'mercado_pago')
      assert.equal(captured.filter.normalizedStatus, 'pending')
      assert.deepEqual(captured.filter.providerOrderId, { $type: 'string', $ne: '' })
      assert.deepEqual(captured.filter.$or, [
        { lastProviderCheckAt: null },
        { lastProviderCheckAt: { $exists: false } },
        { lastProviderCheckAt: { $lte: cooldownThreshold } }
      ])
      assert.deepEqual(captured.update, { $set: { lastProviderCheckAt: now } })
      assert.equal(captured.options.new, true)
      assert.equal(captured.options.runValidators, true)
    } finally {
      PaymentModel.findOneAndUpdate = original
    }
  })

  it('reuses authoritative reconciliation for an approved payment with active reservation', async () => {
    const { service, state } = createHarness()
    const result = await service.reconcileForBuyer({ orderNumber, userId, now })

    assert.equal(result.outcome, 'paid')
    assert.equal(result.orderStatus, 'paid')
    assert.equal(result.paymentStatus, 'approved')
    assert.equal(result.fulfillmentStatus, 'preparing')
    assert.equal(state.providerCalls, 1)
    assert.equal(state.financialTransitions, 1)
  })

  it('keeps sold closed when authoritative approval finds an expired reservation', async () => {
    const { service } = createHarness({
      order: { reservationExpiresAt: new Date('2026-10-09T11:59:59.000Z') },
      reconcile(current) {
        current.payment.normalizedStatus = 'approved'
        current.payment.approvedAt = now
        current.order.status = 'requires_attention'
        current.order.attentionReason = 'RESERVATION_EXPIRED'
        current.financialTransitions += 1
        return { outcome: 'requires_attention', orderId, paymentId }
      }
    })
    const result = await service.reconcileForBuyer({ orderNumber, userId, now })

    assert.equal(result.outcome, 'requires_attention')
    assert.equal(result.paymentStatus, 'approved')
    assert.equal(result.fulfillmentStatus, 'pending')
    assert.equal(result.attentionReason, 'RESERVATION_EXPIRED')
  })

  it('keeps local state pending when the provider remains pending', async () => {
    const { service, state } = createHarness({
      reconcile() { return { outcome: 'pending', orderId, paymentId } }
    })
    const result = await service.reconcileForBuyer({ orderNumber, userId, now })

    assert.equal(result.outcome, 'pending')
    assert.equal(result.orderStatus, 'pending_payment')
    assert.equal(result.paymentStatus, 'pending')
    assert.equal(state.providerCalls, 1)
  })

  it('fails closed with 503 when the provider is unavailable', async () => {
    const providerError = new ServiceError('provider internals', 'MERCADOPAGO_TIMEOUT', 503)
    const { service, state } = createHarness({ reconciliationError: providerError })

    await assert.rejects(
      service.reconcileForBuyer({ orderNumber, userId, now }),
      (error) => error.code === 'BUYER_PAYMENT_RECONCILIATION_UNAVAILABLE' &&
        error.status === 503 &&
        !error.message.includes('provider internals')
    )
    assert.equal(state.order.status, 'pending_payment')
    assert.equal(state.payment.normalizedStatus, 'pending')
  })

  for (const [label, overrides, receivedUserId] of [
    ['foreign', {}, otherUserId],
    ['missing', { missingOrder: true }, userId]
  ]) {
    it(`returns the same 404 for a ${label} Order`, async () => {
      const { service, state } = createHarness(overrides)
      await assert.rejects(
        service.reconcileForBuyer({ orderNumber, userId: receivedUserId, now }),
        (error) => error.code === 'ORDER_NOT_FOUND' && error.status === 404
      )
      assert.equal(state.providerCalls, 0)
    })
  }

  it('returns paid + approved idempotently without a provider call', async () => {
    const { service, state } = createHarness({
      order: { status: 'paid', fulfillmentStatus: 'preparing', paidAt: now },
      payment: { normalizedStatus: 'approved', approvedAt: now }
    })
    const result = await service.reconcileForBuyer({ orderNumber, userId, now })

    assert.equal(result.outcome, 'paid')
    assert.equal(state.providerCalls, 0)
    assert.equal(state.claims, 0)
  })

  it('returns requires_attention + approved without late resolution or provider call', async () => {
    const { service, state } = createHarness({
      order: { status: 'requires_attention', attentionReason: 'RESERVATION_EXPIRED' },
      payment: { normalizedStatus: 'approved', approvedAt: now }
    })
    const result = await service.reconcileForBuyer({ orderNumber, userId, now })

    assert.equal(result.outcome, 'requires_attention')
    assert.equal(result.attentionReason, 'RESERVATION_EXPIRED')
    assert.equal(state.providerCalls, 0)
    assert.equal(state.financialTransitions, 0)
  })

  it('reconciles pending to paid on a sequential recovery after cooldown', async () => {
    const secondCheckAt = new Date(now.getTime() + BUYER_RECONCILIATION_COOLDOWN_MS + 1)
    const { service, state } = createHarness({
      reconcile(current) {
        if (current.providerCalls === 1) return { outcome: 'pending', orderId, paymentId }

        current.payment.normalizedStatus = 'approved'
        current.payment.approvedAt = secondCheckAt
        current.order.status = 'paid'
        current.order.fulfillmentStatus = 'preparing'
        current.order.paidAt = secondCheckAt
        current.productUnits[0].status = 'sold'
        current.productUnits[0].soldAt = secondCheckAt
        current.financialTransitions += 1
        return { outcome: 'paid', orderId, paymentId }
      }
    })

    const first = await service.reconcileForBuyer({ orderNumber, userId, now })
    const second = await service.reconcileForBuyer({
      orderNumber,
      userId,
      now: secondCheckAt
    })

    assert.equal(first.outcome, 'pending')
    assert.equal(second.outcome, 'paid')
    assert.equal(second.paymentStatus, 'approved')
    assert.equal(second.orderStatus, 'paid')
    assert.equal(second.fulfillmentStatus, 'preparing')
    assert.equal(state.providerCalls, 2)
    assert.equal(state.financialTransitions, 1)
    assert.equal(state.productUnits[0].status, 'sold')
    assert.deepEqual(state.productUnits[0].soldAt, secondCheckAt)
  })

  it('reconciles pending to attention after cooldown when the reservation expired', async () => {
    const secondCheckAt = new Date(now.getTime() + BUYER_RECONCILIATION_COOLDOWN_MS + 1)
    const { service, state } = createHarness({
      reconcile(current) {
        if (current.providerCalls === 1) return { outcome: 'pending', orderId, paymentId }

        current.payment.normalizedStatus = 'approved'
        current.payment.approvedAt = secondCheckAt
        current.order.status = 'requires_attention'
        current.order.attentionReason = 'RESERVATION_EXPIRED'
        current.financialTransitions += 1
        return { outcome: 'requires_attention', orderId, paymentId }
      }
    })

    const first = await service.reconcileForBuyer({ orderNumber, userId, now })
    const second = await service.reconcileForBuyer({
      orderNumber,
      userId,
      now: secondCheckAt
    })

    assert.equal(first.outcome, 'pending')
    assert.equal(second.outcome, 'requires_attention')
    assert.equal(second.paymentStatus, 'approved')
    assert.equal(second.fulfillmentStatus, 'pending')
    assert.equal(second.attentionReason, 'RESERVATION_EXPIRED')
    assert.equal(state.providerCalls, 2)
    assert.equal(state.productUnits[0].status, 'reserved')
    assert.equal(state.productUnits[0].soldAt, null)
  })

  it('keeps provider failure under cooldown and permits a later sequential retry', async () => {
    const beforeCooldown = new Date(now.getTime() + 5_000)
    const afterCooldown = new Date(now.getTime() + BUYER_RECONCILIATION_COOLDOWN_MS + 1)
    const { service, state } = createHarness({
      reconcile(current) {
        if (current.providerCalls === 1) {
          const error = new Error('provider unavailable')
          error.status = 503
          throw error
        }
        return { outcome: 'pending', orderId, paymentId }
      }
    })

    await assert.rejects(
      service.reconcileForBuyer({ orderNumber, userId, now }),
      (error) => error.code === 'BUYER_PAYMENT_RECONCILIATION_UNAVAILABLE' && error.status === 503
    )

    const protectedByCooldown = await service.reconcileForBuyer({
      orderNumber,
      userId,
      now: beforeCooldown
    })
    assert.equal(protectedByCooldown.outcome, 'pending')
    assert.equal(state.providerCalls, 1)

    const retried = await service.reconcileForBuyer({
      orderNumber,
      userId,
      now: afterCooldown
    })
    assert.equal(retried.outcome, 'pending')
    assert.equal(state.providerCalls, 2)
    assert.deepEqual(state.providerCheckDates, [now, afterCooldown])
  })

  it('returns uncertain without creating provider data when providerOrderId is absent', async () => {
    const { service, state } = createHarness({ payment: { providerOrderId: null } })
    const result = await service.reconcileForBuyer({ orderNumber, userId, now })

    assert.equal(result.outcome, 'uncertain')
    assert.equal(state.providerCalls, 0)
    assert.equal(state.claims, 0)
    assert.equal(state.payment.providerOrderId, null)
  })

  it('does not reopen a terminal unpaid Order', async () => {
    const { service, state } = createHarness({
      order: { status: 'expired', fulfillmentStatus: 'cancelled' },
      payment: { normalizedStatus: 'cancelled' }
    })
    const result = await service.reconcileForBuyer({ orderNumber, userId, now })

    assert.equal(result.outcome, 'terminal_unpaid')
    assert.equal(state.providerCalls, 0)
    assert.equal(state.claims, 0)
  })

  it('still reconciles a financially unresolved expired Order', async () => {
    const { service, state } = createHarness({
      order: { status: 'expired', fulfillmentStatus: 'cancelled' },
      reconcile(current) {
        current.payment.normalizedStatus = 'approved'
        current.payment.approvedAt = now
        current.order.status = 'requires_attention'
        current.order.attentionReason = 'RESERVATION_EXPIRED'
        return { outcome: 'requires_attention', orderId, paymentId }
      }
    })
    const result = await service.reconcileForBuyer({ orderNumber, userId, now })

    assert.equal(result.outcome, 'requires_attention')
    assert.equal(result.paymentStatus, 'approved')
    assert.equal(state.providerCalls, 1)
  })

  it('enforces active cooldown without another provider GET', async () => {
    const { service, state } = createHarness({
      payment: { lastProviderCheckAt: new Date(now.getTime() - 5_000) }
    })
    const result = await service.reconcileForBuyer({ orderNumber, userId, now })

    assert.equal(result.outcome, 'pending')
    assert.equal(state.providerCalls, 0)
  })

  it('allows a provider GET after cooldown expires', async () => {
    const { service, state } = createHarness({
      payment: {
        lastProviderCheckAt: new Date(
          now.getTime() - BUYER_RECONCILIATION_COOLDOWN_MS - 1
        )
      }
    })
    await service.reconcileForBuyer({ orderNumber, userId, now })
    assert.equal(state.providerCalls, 1)
  })

  it('atomically admits only one of two concurrent buyer recoveries', async () => {
    let release
    const gate = new Promise((resolve) => { release = resolve })
    const { service, state } = createHarness({ gate: () => gate })

    const first = service.reconcileForBuyer({ orderNumber, userId, now })
    await Promise.resolve()
    const second = service.reconcileForBuyer({ orderNumber, userId, now })
    await Promise.resolve()
    release()
    const [firstResult, secondResult] = await Promise.all([first, second])

    assert.equal(state.providerCalls, 1)
    assert.equal(state.financialTransitions, 1)
    assert.equal(
      [firstResult.outcome, secondResult.outcome]
        .every((outcome) => ['paid', 'pending'].includes(outcome)),
      true
    )
    assert.equal(
      [firstResult.outcome, secondResult.outcome].includes('paid'),
      true
    )
  })

  for (const source of ['webhook', 'P0 financial guard']) {
    it(`converges when ${source} wins the financial CAS`, async () => {
      const conflict = new ServiceError('race', 'PAYMENT_STATUS_CONFLICT', 409)
      const { service, state } = createHarness({
        reconcile(current) {
          current.payment.normalizedStatus = 'approved'
          current.payment.approvedAt = now
          current.order.status = 'paid'
          current.order.fulfillmentStatus = 'preparing'
          current.order.paidAt = now
          throw conflict
        }
      })
      const result = await service.reconcileForBuyer({ orderNumber, userId, now })

      assert.equal(result.outcome, 'paid')
      assert.equal(result.paymentStatus, 'approved')
      assert.equal(result.orderStatus, 'paid')
      assert.equal(state.providerCalls, 1)
    })
  }

  it('rejects body/query financial claims and uses identity only from req.user', async () => {
    const { service, state } = createHarness()
    const app = createHttpApp({ service })
    const bodyResponse = await request(app)
      .post(`/api/orders/${orderNumber}/reconcile-payment`)
      .send({ status: 'approved', providerOrderId: 'attacker-value', userId: otherUserId })
    const queryResponse = await request(app)
      .post(`/api/orders/${orderNumber}/reconcile-payment?status=approved`)

    assert.equal(bodyResponse.status, 400)
    assert.equal(queryResponse.status, 400)
    assert.equal(state.providerCalls, 0)
  })

  it('returns a strict owner-safe DTO without provider or persistence internals', async () => {
    const { service } = createHarness()
    const result = await service.reconcileForBuyer({ orderNumber, userId, now })

    assert.deepEqual(Object.keys(result).sort(), [
      'attentionReason',
      'fulfillmentStatus',
      'orderNumber',
      'orderStatus',
      'outcome',
      'paidAt',
      'paymentApprovedAt',
      'paymentStatus'
    ])
    const serialized = JSON.stringify(result)
    for (const forbidden of [
      providerOrderId,
      paymentId,
      orderId,
      'must-not-leak',
      'providerPaymentId',
      'providerRequestSnapshot'
    ]) assert.equal(serialized.includes(forbidden), false)
  })

  it('does not create a fake PaymentEvent', async () => {
    const { service, state } = createHarness()
    await service.reconcileForBuyer({ orderNumber, userId, now })
    assert.equal(state.paymentEvents, 0)
  })
})
