/* eslint-env mocha */
import assert from 'node:assert/strict'
import mongoose from 'mongoose'
import { OrderAttentionController } from '../../src/controllers/orderAttention.controller.js'
import OrderManager from '../../src/dao/managers/order.manager.js'
import PaymentManager from '../../src/dao/managers/payment.manager.js'
import OrderModel from '../../src/dao/models/order.model.js'
import OrderAttentionResolutionModel from '../../src/dao/models/orderAttentionResolution.model.js'
import PaymentModel from '../../src/dao/models/payment.model.js'
import { CheckoutFinancialGuardService } from '../../src/services/checkoutFinancialGuard.service.js'
import { OrderAttentionResolutionService } from '../../src/services/orderAttentionResolution.service.js'
import { OrderAttentionService } from '../../src/services/orderAttention.service.js'
import {
  COMPLETION_REASON,
  OrderAttentionTerminalUnpaidService
} from '../../src/services/orderAttentionTerminalUnpaid.service.js'

const ids = Object.freeze({
  order: '507f1f77bcf86cd799439201',
  payment: '507f1f77bcf86cd799439202',
  item: '507f1f77bcf86cd799439203',
  product: '507f1f77bcf86cd799439204',
  unit: '507f1f77bcf86cd799439205',
  actor: '507f1f77bcf86cd799439206',
  otherOrder: '507f1f77bcf86cd799439207'
})

const fixedNow = new Date('2026-11-02T18:00:00.000Z')
const expiredAt = new Date('2026-11-02T15:00:00.000Z')
const priorCheckAt = new Date('2026-11-02T17:00:00.000Z')
const payableObservedAt = new Date('2026-11-02T14:50:00.000Z')
const attemptedAt = new Date('2026-11-02T14:55:00.000Z')
const completedAt = new Date('2026-11-02T14:56:00.000Z')

const clone = (value) => structuredClone(value)
const sameId = (left, right) => String(left ?? '') === String(right ?? '')
const sameInstant = (left, right) => {
  if (left == null || right == null) return left == null && right == null
  return new Date(left).getTime() === new Date(right).getTime()
}

const typeAEvidence = (overrides = {}) => ({
  provider: 'mercado_pago',
  evidenceSource: 'ORDERS_API_TERMINAL_UNPAID',
  providerOrderId: 'ORD-P1CD-001',
  providerPaymentId: null,
  externalReference: 'LC-2026-000010',
  providerStatus: 'canceled',
  providerStatusDetail: 'canceled',
  amountArs: '20497.40',
  totalAmount: '20497.40',
  totalPaidAmount: '0',
  currency: 'ARS',
  observedAt: fixedNow,
  remoteClassification: 'TERMINAL_UNPAID',
  totalPaidAmountPresent: true,
  transactionsPresent: true,
  paymentsPresent: true,
  paymentsIsArray: true,
  paymentCount: 0,
  payments: [],
  paymentsSearch: {
    completed: true,
    total: 0,
    inspectedCount: 0,
    vetoCount: 0,
    paymentIds: [],
    payments: []
  },
  ...overrides
})

const typeBEvidence = (overrides = {}) => typeAEvidence({
  evidenceSource: 'OWN_CANCELLATION_TERMINAL_UNPAID',
  totalPaidAmount: null,
  remoteClassification: 'CANCELED_PAYMENT_AGGREGATES_OMITTED',
  totalPaidAmountPresent: false,
  transactionsPresent: false,
  paymentsPresent: false,
  paymentsIsArray: false,
  paymentCount: null,
  payments: undefined,
  providerCancellationPayableStatus: 'created',
  providerCancellationPayableObservedAt: payableObservedAt,
  providerCancellationIdempotencyKey: 'cancel-P1CD-001',
  providerCancellationAttemptedAt: attemptedAt,
  providerCancellationStatus: 'succeeded',
  providerCancellationCompletedAt: completedAt,
  ...overrides
})

const baseState = (overrides = {}) => ({
  order: {
    _id: ids.order,
    orderNumber: 'LC-2026-000010',
    userId: '507f1f77bcf86cd799439209',
    status: 'requires_attention',
    fulfillmentStatus: 'pending',
    attentionReason: 'PROVIDER_ORDER_INCONSISTENT',
    attentionResolutionVersion: 3,
    paymentCurrency: 'ARS',
    totals: { totalArs: '20497.40' },
    reservationExpiresAt: expiredAt,
    reconciliationNextAt: null,
    reconciliationLeaseOwner: null,
    reconciliationLeaseUntil: null,
    statusHistory: [],
    fulfillmentHistory: []
  },
  payment: {
    _id: ids.payment,
    orderId: ids.order,
    provider: 'mercado_pago',
    providerOrderId: 'ORD-P1CD-001',
    providerPaymentId: null,
    externalReference: 'LC-2026-000010',
    providerStatus: 'canceled',
    providerStatusDetail: 'canceled',
    normalizedStatus: 'requires_attention',
    amountArs: '20497.40',
    currency: 'ARS',
    approvedAt: null,
    lastProviderCheckAt: priorCheckAt,
    providerCancellationPayableStatus: null,
    providerCancellationPayableObservedAt: null,
    providerCancellationIdempotencyKey: null,
    providerCancellationAttemptedAt: null,
    providerCancellationStatus: null,
    providerCancellationCompletedAt: null
  },
  items: [{
    _id: ids.item,
    orderId: ids.order,
    productId: ids.product,
    quantity: 1
  }],
  units: [{
    _id: ids.unit,
    serialNumber: 'P1CD-SERIAL-001',
    productId: ids.product,
    orderId: ids.order,
    orderItemId: ids.item,
    reservedByOrderId: ids.order,
    reservedAt: new Date('2026-11-02T14:00:00.000Z'),
    reservationExpiresAt: expiredAt,
    status: 'reserved',
    soldByOrderId: null,
    soldAt: null,
    isDeleted: false
  }],
  resolutions: [],
  stockByProduct: { [ids.product]: 0 },
  counters: {
    evidence: 0,
    releases: 0,
    releaseExpiredReservations: 0,
    stockRecalculations: 0,
    paymentCas: 0,
    orderCas: 0
  },
  ...overrides
})

const restoreState = (state, snapshot) => {
  for (const key of Object.keys(state)) delete state[key]
  Object.assign(state, snapshot)
}

const makeHarness = ({
  state: initialState = baseState(),
  evidence = typeAEvidence(),
  evidenceError = null,
  mutateBeforePaymentCas,
  mutateBeforeRelease,
  mutateBeforeOrderCas,
  failAfterFirstRelease = false,
  crashAfterPrepare = false
} = {}) => {
  const state = initialState
  let transactionTail = Promise.resolve()
  let crashPending = crashAfterPrepare

  const mongooseInstance = {
    async startSession() {
      if (crashPending) throw new Error('simulated process crash')
      return {
        async withTransaction(operation, options) {
          const run = transactionTail.then(async () => {
            assert.deepEqual(options, {
              readConcern: { level: 'snapshot' },
              writeConcern: { w: 'majority' }
            })
            const snapshot = clone(state)
            try {
              return await operation()
            } catch (error) {
              restoreState(state, snapshot)
              throw error
            }
          })
          transactionTail = run.catch(() => {})
          return run
        },
        async endSession() {}
      }
    }
  }

  const orderManager = {
    async getByOrderNumber(orderNumber) {
      return state.order.orderNumber === orderNumber ? clone(state.order) : null
    },
    async getById(orderId) {
      return sameId(orderId, state.order._id) ? clone(state.order) : null
    },
    async closeTerminalUnpaidAttention(orderId, input) {
      state.counters.orderCas += 1
      if (mutateBeforeOrderCas) mutateBeforeOrderCas(state)
      const order = state.order
      if (
        !sameId(order._id, orderId) ||
        order.status !== 'requires_attention' ||
        order.fulfillmentStatus !== 'pending' ||
        order.attentionReason !== input.expectedAttentionReason ||
        (order.attentionResolutionVersion ?? 0) !== input.expectedAttentionResolutionVersion ||
        !sameInstant(order.reservationExpiresAt, input.expectedReservationExpiresAt) ||
        !sameInstant(order.reconciliationNextAt, input.expectedReconciliationNextAt) ||
        String(order.reconciliationLeaseOwner ?? '') !==
          String(input.expectedReconciliationLeaseOwner ?? '') ||
        !sameInstant(order.reconciliationLeaseUntil, input.expectedReconciliationLeaseUntil)
      ) return null

      order.status = 'expired'
      order.expiredAt = new Date(input.changedAt)
      order.fulfillmentStatus = 'cancelled'
      order.reconciliationNextAt = null
      order.reconciliationLeaseOwner = null
      order.reconciliationLeaseUntil = null
      order.attentionResolutionVersion += 1
      order.statusHistory.push({
        status: 'expired',
        changedAt: new Date(input.changedAt),
        reason: input.reason
      })
      order.fulfillmentHistory.push({
        status: 'cancelled',
        changedAt: new Date(input.changedAt),
        changedBy: input.changedBy,
        reason: input.reason
      })
      return clone(order)
    }
  }

  const paymentManager = {
    async getLatestByOrderId() { return clone(state.payment) },
    async cancelAttentionWithTerminalUnpaidEvidence(paymentId, input) {
      state.counters.paymentCas += 1
      if (mutateBeforePaymentCas) mutateBeforePaymentCas(state)
      const payment = state.payment
      const context = input.cancellationContext
      if (
        !sameId(payment._id, paymentId) ||
        !sameId(payment.orderId, input.orderId) ||
        payment.provider !== 'mercado_pago' ||
        payment.normalizedStatus !== input.expectedNormalizedStatus ||
        payment.providerOrderId !== input.providerOrderId ||
        payment.externalReference !== input.externalReference ||
        String(payment.amountArs) !== String(input.amountArs) ||
        payment.currency !== input.currency ||
        String(payment.providerStatus ?? '') !== String(input.expectedProviderStatus ?? '') ||
        String(payment.providerStatusDetail ?? '') !==
          String(input.expectedProviderStatusDetail ?? '') ||
        !sameInstant(payment.lastProviderCheckAt, input.expectedLastProviderCheckAt) ||
        payment.providerPaymentId != null ||
        payment.approvedAt != null ||
        String(payment.providerCancellationPayableStatus ?? '') !==
          String(context.providerCancellationPayableStatus ?? '') ||
        !sameInstant(
          payment.providerCancellationPayableObservedAt,
          context.providerCancellationPayableObservedAt
        ) ||
        String(payment.providerCancellationIdempotencyKey ?? '') !==
          String(context.providerCancellationIdempotencyKey ?? '') ||
        !sameInstant(
          payment.providerCancellationAttemptedAt,
          context.providerCancellationAttemptedAt
        ) ||
        String(payment.providerCancellationStatus ?? '') !==
          String(context.providerCancellationStatus ?? '') ||
        !sameInstant(
          payment.providerCancellationCompletedAt,
          context.providerCancellationCompletedAt
        )
      ) return null

      payment.normalizedStatus = 'cancelled'
      payment.providerStatus = input.providerStatus
      payment.providerStatusDetail = input.providerStatusDetail
      payment.lastProviderCheckAt = new Date(input.observedAt)
      return clone(payment)
    }
  }

  const orderItemManager = {
    async getByOrderId() { return clone(state.items) }
  }

  const productUnitManager = {
    async getRelatedByOrderId() { return clone(state.units) },
    async getByIds(unitIds) {
      return clone(state.units.filter((unit) => unitIds.some((id) => sameId(id, unit._id))))
    }
  }

  const productUnitService = {
    async releaseOrderReservationsForExpiration({ orderId, expirationLimit }) {
      state.counters.releases += 1
      if (mutateBeforeRelease) mutateBeforeRelease(state)
      const expectedCount = state.items.reduce((sum, item) => sum + Number(item.quantity), 0)
      if (state.units.length !== expectedCount) {
        return { valid: false, reason: 'RESERVATION_QUANTITY_MISMATCH', expectedCount, units: [] }
      }
      const productIds = []
      let releasedCount = 0
      for (const unit of state.units) {
        const item = state.items.find((candidate) => sameId(candidate._id, unit.orderItemId))
        if (
          !item ||
          unit.status !== 'reserved' ||
          unit.isDeleted !== false ||
          !sameId(unit.productId, item.productId) ||
          !sameId(unit.orderId, orderId) ||
          !sameId(unit.reservedByOrderId, orderId) ||
          unit.soldByOrderId != null ||
          unit.soldAt != null ||
          new Date(unit.reservationExpiresAt).getTime() > new Date(expirationLimit).getTime()
        ) {
          return { valid: false, reason: 'RESERVATION_INTEGRITY_CONFLICT', expectedCount, units: [] }
        }
        unit.status = 'available'
        unit.orderId = null
        unit.orderItemId = null
        unit.reservedByOrderId = null
        unit.reservedAt = null
        unit.reservationExpiresAt = null
        releasedCount += 1
        if (!productIds.includes(String(unit.productId))) productIds.push(String(unit.productId))
        if (failAfterFirstRelease) throw new Error('simulated partial release')
      }
      for (const productId of productIds) {
        state.counters.stockRecalculations += 1
        state.stockByProduct[productId] = state.units.filter((unit) => (
          sameId(unit.productId, productId) &&
          unit.status === 'available' &&
          unit.isDeleted === false
        )).length
      }
      return {
        valid: true,
        reason: null,
        expectedCount,
        releasedCount,
        unitIds: state.units.map((unit) => String(unit._id)),
        productIds
      }
    },
    async releaseExpiredReservations() {
      state.counters.releaseExpiredReservations += 1
    }
  }

  const resolutionManager = {
    async createPreparedResolution(data) {
      await Promise.resolve()
      if (state.resolutions.some((row) => (
        sameId(row.orderId, data.orderId) && row.idempotencyKey === data.idempotencyKey
      ))) {
        const error = new Error('duplicate key')
        error.code = 11000
        throw error
      }
      const row = {
        _id: new mongoose.Types.ObjectId().toString(),
        ...clone(data),
        status: 'prepared',
        activeAttemptToken: null,
        completedAt: null,
        finalProductUnits: [],
        finalResult: null,
        sanitizedError: null
      }
      state.resolutions.push(row)
      return clone(row)
    },
    async getById(resolutionId) {
      if (crashPending) {
        crashPending = false
        throw new Error('simulated process crash')
      }
      const row = state.resolutions.find((candidate) => sameId(candidate._id, resolutionId))
      return row ? clone(row) : null
    },
    async getByOrderAndIdempotencyKey(orderId, idempotencyKey) {
      const row = state.resolutions.find((candidate) => (
        sameId(candidate.orderId, orderId) && candidate.idempotencyKey === idempotencyKey
      ))
      return row ? clone(row) : null
    },
    async getOrderResolutionHistory(orderId) {
      return clone(state.resolutions.filter((row) => sameId(row.orderId, orderId)))
    },
    async claimPreparedResolutionAttempt(resolutionId, attemptToken) {
      const row = state.resolutions.find((candidate) => sameId(candidate._id, resolutionId))
      if (!row || row.status !== 'prepared' || row.activeAttemptToken != null) return null
      row.activeAttemptToken = attemptToken
      return clone(row)
    },
    async completePreparedResolution(resolutionId, update) {
      const row = state.resolutions.find((candidate) => sameId(candidate._id, resolutionId))
      if (
        !row ||
        row.status !== 'prepared' ||
        row.activeAttemptToken !== update.expectedAttemptToken
      ) return null
      Object.assign(row, clone(update), {
        status: 'completed',
        activeAttemptToken: null,
        sanitizedError: null
      })
      return clone(row)
    },
    async failPreparedResolution(resolutionId, update) {
      const row = state.resolutions.find((candidate) => sameId(candidate._id, resolutionId))
      if (!row || row.status !== 'prepared' || row.activeAttemptToken != null) return null
      Object.assign(row, clone(update), { status: 'failed' })
      return clone(row)
    }
  }

  const resolutionService = new OrderAttentionResolutionService({ resolutionManager })
  const evidenceService = {
    async getEvidence() {
      state.counters.evidence += 1
      if (evidenceError) throw evidenceError
      return clone(evidence)
    }
  }
  const service = new OrderAttentionTerminalUnpaidService({
    mongooseInstance,
    orderManager,
    orderItemManager,
    paymentManager,
    productUnitManager,
    productUnitService,
    resolutionManager,
    resolutionService,
    evidenceService,
    clock: () => fixedNow
  })

  return {
    service,
    state,
    managers: { orderManager, paymentManager, productUnitManager },
    input: {
      orderNumber: state.order.orderNumber,
      idempotencyKey: 'p1cd-key-001',
      actorUserId: ids.actor,
      actorRole: 'ADMIN',
      note: 'Cierre revisado'
    }
  }
}

const rejectsCode = async (operation, code) => {
  await assert.rejects(operation, (error) => error?.code === code)
}

describe('P1C-D administrative terminal-unpaid closure (isolated)', () => {
  it('closes valid Type A all-or-none and preserves the original attention reason', async () => {
    const { service, state, input } = makeHarness()
    const result = await service.closeTerminalUnpaid(input)

    assert.equal(result.orderStatus, 'expired')
    assert.equal(result.paymentStatus, 'cancelled')
    assert.equal(result.fulfillmentStatus, 'cancelled')
    assert.equal(result.releasedCount, 1)
    assert.equal(result.idempotent, false)
    assert.equal(state.order.attentionReason, 'PROVIDER_ORDER_INCONSISTENT')
    assert.equal(state.order.attentionResolutionVersion, 4)
    assert.equal(state.payment.normalizedStatus, 'cancelled')
    assert.equal(state.payment.providerPaymentId, null)
    assert.equal(state.units[0].status, 'available')
    assert.equal(state.units[0].orderId, null)
    assert.equal(state.stockByProduct[ids.product], 1)
    assert.equal(state.counters.stockRecalculations, 1)
    assert.equal(state.counters.releaseExpiredReservations, 0)
    assert.deepEqual(state.order.statusHistory, [{
      status: 'expired',
      changedAt: fixedNow,
      reason: COMPLETION_REASON
    }])
    assert.deepEqual(state.order.fulfillmentHistory, [{
      status: 'cancelled',
      changedAt: fixedNow,
      changedBy: ids.actor,
      reason: COMPLETION_REASON
    }])
    assert.equal(state.resolutions[0].status, 'completed')
    assert.equal(state.resolutions[0].finalProductUnits[0].status, 'available')
  })

  it('closes valid Type B only with the exact persisted cancellation chain', async () => {
    const state = baseState()
    Object.assign(state.payment, {
      normalizedStatus: 'pending',
      providerCancellationPayableStatus: 'created',
      providerCancellationPayableObservedAt: payableObservedAt,
      providerCancellationIdempotencyKey: 'cancel-P1CD-001',
      providerCancellationAttemptedAt: attemptedAt,
      providerCancellationStatus: 'succeeded',
      providerCancellationCompletedAt: completedAt
    })
    const { service, input } = makeHarness({ state, evidence: typeBEvidence() })
    const result = await service.closeTerminalUnpaid(input)
    assert.equal(result.orderStatus, 'expired')
    assert.equal(result.paymentStatus, 'cancelled')
  })

  it('rejects LC000007 omitted aggregates without persisted PAYABLE evidence', async () => {
    const state = baseState()
    state.order.orderNumber = 'LC-2026-000007'
    state.payment.externalReference = 'LC-2026-000007'
    const { service, input } = makeHarness({
      state,
      evidence: typeBEvidence({
        externalReference: 'LC-2026-000007',
        providerCancellationPayableStatus: null,
        providerCancellationPayableObservedAt: null
      })
    })
    await rejectsCode(service.closeTerminalUnpaid(input), 'ATTENTION_RESOLUTION_STALE')
    assert.equal(state.order.status, 'requires_attention')
    assert.equal(state.payment.normalizedStatus, 'requires_attention')
    assert.equal(state.units[0].status, 'reserved')
  })

  it('rejects LC000008 before provider evidence because Order is not requires_attention', async () => {
    const state = baseState()
    state.order.orderNumber = 'LC-2026-000008'
    state.payment.externalReference = 'LC-2026-000008'
    state.order.status = 'pending_payment'
    const { service, input } = makeHarness({ state })
    await rejectsCode(service.closeTerminalUnpaid(input), 'ATTENTION_TERMINAL_UNPAID_NOT_ALLOWED')
    assert.equal(state.counters.evidence, 0)
    assert.equal(state.counters.releases, 0)
  })

  it('keeps canCloseTerminalUnpaid false for both LC000007 and LC000008 read models', () => {
    const attention = new OrderAttentionService()
    const lc7 = baseState()
    lc7.order.orderNumber = 'LC-2026-000007'
    const lc8 = baseState()
    lc8.order.orderNumber = 'LC-2026-000008'
    lc8.order.status = 'pending_payment'

    for (const fixture of [lc7, lc8]) {
      const readModel = attention.buildReadModel({
        order: fixture.order,
        payment: fixture.payment,
        orderItems: fixture.items,
        productUnits: fixture.units,
        resolutions: fixture.resolutions
      })
      assert.equal(readModel.allowedActions.canCloseTerminalUnpaid, false)
    }
  })

  for (const [name, mutate, code = 'ATTENTION_PAYMENT_STATE_CONFLICT'] of [
    ['approved Payment', (state) => { state.payment.normalizedStatus = 'approved' }],
    ['refunded Payment', (state) => { state.payment.normalizedStatus = 'refunded' }],
    ['local approvedAt', (state) => { state.payment.approvedAt = fixedNow }],
    ['local providerPaymentId', (state) => { state.payment.providerPaymentId = 'PAY-1' }],
    ['amount mismatch', (state) => { state.payment.amountArs = '1.00' }],
    ['currency mismatch', (state) => { state.payment.currency = 'USD' }]
  ]) {
    it(`rejects preflight with ${name}`, async () => {
      const state = baseState()
      mutate(state)
      const { service, input } = makeHarness({ state })
      await rejectsCode(service.closeTerminalUnpaid(input), code)
      assert.equal(state.counters.evidence, 0)
      assert.equal(state.counters.releases, 0)
    })
  }

  for (const [name, mutate] of [
    ['sold ProductUnit', (state) => { state.units[0].status = 'sold' }],
    ['available ProductUnit', (state) => { state.units[0].status = 'available' }],
    ['deleted ProductUnit', (state) => { state.units[0].isDeleted = true }],
    ['orderId mismatch', (state) => { state.units[0].orderId = ids.otherOrder }],
    ['orderItemId mismatch', (state) => { state.units[0].orderItemId = '507f1f77bcf86cd799439299' }],
    ['missing ProductUnit', (state) => { state.units = [] }],
    ['extra ProductUnit', (state) => { state.units.push({ ...clone(state.units[0]), _id: '507f1f77bcf86cd799439298' }) }]
  ]) {
    it(`rejects reservation integrity with ${name}`, async () => {
      const state = baseState()
      mutate(state)
      const { service, input } = makeHarness({ state })
      await rejectsCode(service.closeTerminalUnpaid(input), 'ATTENTION_RESERVATION_INTEGRITY_CONFLICT')
      assert.equal(state.counters.evidence, 0)
      assert.equal(state.counters.releases, 0)
    })
  }

  it('releases multiple units and recalculates each product once', async () => {
    const state = baseState()
    const item2 = '507f1f77bcf86cd799439210'
    const product2 = '507f1f77bcf86cd799439211'
    state.items.push({ _id: item2, orderId: ids.order, productId: product2, quantity: 1 })
    state.units.push({
      ...clone(state.units[0]),
      _id: '507f1f77bcf86cd799439212',
      serialNumber: 'P1CD-SERIAL-002',
      productId: product2,
      orderItemId: item2
    })
    state.stockByProduct[product2] = 0
    const { service, input } = makeHarness({ state })
    const result = await service.closeTerminalUnpaid(input)
    assert.equal(result.releasedCount, 2)
    assert.equal(state.counters.stockRecalculations, 2)
    assert.equal(state.stockByProduct[ids.product], 1)
    assert.equal(state.stockByProduct[product2], 1)
  })

  it('rolls back Payment, units, stock and histories after a partial release failure', async () => {
    const state = baseState()
    const { service, input } = makeHarness({ state, failAfterFirstRelease: true })
    await assert.rejects(service.closeTerminalUnpaid(input), /simulated partial release/)
    assert.equal(state.order.status, 'requires_attention')
    assert.equal(state.payment.normalizedStatus, 'requires_attention')
    assert.equal(state.units[0].status, 'reserved')
    assert.deepEqual(state.order.statusHistory, [])
    assert.deepEqual(state.order.fulfillmentHistory, [])
  })

  for (const [name, option, mutate] of [
    ['webhook approval', 'mutateBeforePaymentCas', (state) => {
      state.payment.normalizedStatus = 'approved'
      state.payment.providerPaymentId = 'PAY-RACE'
      state.payment.approvedAt = fixedNow
    }],
    ['lastProviderCheckAt race', 'mutateBeforePaymentCas', (state) => {
      state.payment.lastProviderCheckAt = new Date(fixedNow.getTime() + 1)
    }],
    ['ProductUnit race', 'mutateBeforeRelease', (state) => { state.units[0].status = 'sold' }],
    ['version race', 'mutateBeforeOrderCas', (state) => { state.order.attentionResolutionVersion += 1 }]
  ]) {
    it(`rolls back completely on ${name}`, async () => {
      const state = baseState()
      const { service, input } = makeHarness({ state, [option]: mutate })
      await rejectsCode(
        service.closeTerminalUnpaid(input),
        name === 'ProductUnit race'
          ? 'ATTENTION_RESERVATION_INTEGRITY_CONFLICT'
          : 'ATTENTION_RESOLUTION_STALE'
      )
      assert.equal(state.order.status, 'requires_attention')
      assert.equal(state.payment.normalizedStatus, 'requires_attention')
      assert.equal(state.units[0].status, 'reserved')
    })
  }

  it('returns the same completed result for same-key retry without provider calls', async () => {
    const { service, state, input } = makeHarness()
    await service.closeTerminalUnpaid(input)
    const result = await service.closeTerminalUnpaid(input)
    assert.equal(result.idempotent, true)
    assert.equal(state.counters.evidence, 1)
    assert.equal(state.counters.releases, 1)
    assert.equal(state.order.statusHistory.length, 1)
    assert.equal(state.order.fulfillmentHistory.length, 1)
    assert.equal(state.order.attentionResolutionVersion, 4)
  })

  it('resumes a prepared resolution after a process crash without repeating provider evidence', async () => {
    const { service, state, input } = makeHarness({ crashAfterPrepare: true })
    await assert.rejects(service.closeTerminalUnpaid(input), /simulated process crash/)
    assert.equal(state.resolutions.length, 1)
    assert.equal(state.resolutions[0].status, 'prepared')
    assert.equal(state.counters.evidence, 1)

    const result = await service.closeTerminalUnpaid(input)
    assert.equal(result.orderStatus, 'expired')
    assert.equal(state.counters.evidence, 1)
    assert.equal(state.resolutions[0].status, 'completed')
  })

  it('allows only one different idempotency key to win the exact Order CAS', async () => {
    const { service, state, input } = makeHarness()
    const results = await Promise.allSettled([
      service.closeTerminalUnpaid({ ...input, idempotencyKey: 'p1cd-concurrent-A' }),
      service.closeTerminalUnpaid({ ...input, idempotencyKey: 'p1cd-concurrent-B' })
    ])
    assert.equal(results.filter((result) => result.status === 'fulfilled').length, 1)
    assert.equal(state.order.status, 'expired')
    assert.equal(state.counters.releases, 1)
    assert.equal(state.order.attentionResolutionVersion, 4)
  })

  it('rejects a different key after expiration without a second release', async () => {
    const { service, state, input } = makeHarness()
    await service.closeTerminalUnpaid(input)
    await rejectsCode(
      service.closeTerminalUnpaid({ ...input, idempotencyKey: 'p1cd-second-key' }),
      'ATTENTION_TERMINAL_UNPAID_NOT_ALLOWED'
    )
    assert.equal(state.counters.releases, 1)
  })

  it('keeps Financial Guard blocked before and allows after terminal closure', async () => {
    const { service, state, input, managers } = makeHarness()
    const guard = new CheckoutFinancialGuardService({
      orderManager: {
        async getFinanciallyUnresolvedByUserId() {
          return state.order.status === 'expired' ? [] : [clone(state.order)]
        }
      },
      paymentManager: managers.paymentManager
    })
    await assert.rejects(
      guard.assertCanCreateCheckout(state.order.userId),
      (error) => error?.code === 'CHECKOUT_PRIOR_PAYMENT_UNCERTAIN'
    )
    await service.closeTerminalUnpaid(input)
    await guard.assertCanCreateCheckout(state.order.userId)
  })
})

describe('P1C-D HTTP authorization contract (isolated)', () => {
  for (const role of ['USER', 'PREMIUM']) {
    it(`rejects ${role} before invoking P1C-D`, async () => {
      let called = false
      const controller = new OrderAttentionController({
        orderAttentionTerminalUnpaidService: {
          async closeTerminalUnpaid() { called = true }
        }
      })
      let forwarded
      await controller.closeTerminalUnpaid(
        {
          user: { id: ids.actor, role },
          params: { orderNumber: 'LC-2026-000010' },
          headers: { 'idempotency-key': 'key' },
          body: {}
        },
        {},
        (error) => { forwarded = error }
      )
      assert.equal(called, false)
      assert.equal(forwarded.code, 'ORDERS_ADMIN_FORBIDDEN')
    })
  }

  it('forwards only authenticated ADMIN identity, key and optional note', async () => {
    let received
    const controller = new OrderAttentionController({
      orderAttentionTerminalUnpaidService: {
        async closeTerminalUnpaid(value) {
          received = value
          return { orderStatus: 'expired' }
        }
      }
    })
    let response
    await controller.closeTerminalUnpaid(
      {
        user: { id: ids.actor, role: 'ADMIN' },
        params: { orderNumber: 'LC-2026-000010' },
        get: () => 'p1cd-http-key',
        body: { note: 'reviewed' }
      },
      {
        status(status) {
          assert.equal(status, 200)
          return { json(value) { response = value } }
        }
      },
      (error) => { throw error }
    )
    assert.deepEqual(received, {
      orderNumber: 'LC-2026-000010',
      idempotencyKey: 'p1cd-http-key',
      actorUserId: ids.actor,
      actorRole: 'ADMIN',
      note: 'reviewed'
    })
    assert.deepEqual(response, { orderStatus: 'expired' })
  })

  it('rejects client-supplied financial fields', async () => {
    const controller = new OrderAttentionController({
      orderAttentionTerminalUnpaidService: { async closeTerminalUnpaid() {} }
    })
    let forwarded
    await controller.closeTerminalUnpaid(
      {
        user: { id: ids.actor, role: 'ADMIN' },
        params: { orderNumber: 'LC-2026-000010' },
        headers: { 'idempotency-key': 'key' },
        body: { providerStatus: 'canceled' }
      },
      {},
      (error) => { forwarded = error }
    )
    assert.equal(forwarded.code, 'INVALID_ATTENTION_RESOLUTION_BODY')
  })
})

describe('P1C-D persistence compare-and-set contracts (isolated)', () => {
  it('persists Type B provenance without inventing omitted payment aggregates', () => {
    const document = new OrderAttentionResolutionModel({
      orderId: ids.order,
      paymentId: ids.payment,
      idempotencyKey: 'p1cd-schema-key',
      action: 'close_terminal_unpaid',
      originalAttentionReason: 'PROVIDER_ORDER_INCONSISTENT',
      actorUserId: ids.actor,
      actorRole: 'ADMIN',
      requestedAt: fixedNow,
      providerEvidence: typeBEvidence()
    })
    assert.equal(document.validateSync(), undefined)
    const evidence = document.toObject().providerEvidence
    assert.equal(evidence.totalPaidAmountPresent, false)
    assert.equal(evidence.transactionsPresent, false)
    assert.equal(Object.hasOwn(evidence, 'payments'), false)
  })

  it('fences every Order field and preserves attentionReason', async () => {
    const original = OrderModel.findOneAndUpdate
    let captured
    OrderModel.findOneAndUpdate = (filter, update, options) => {
      captured = { filter, update, options }
      return { lean: async () => ({ status: 'expired' }) }
    }
    try {
      await OrderManager.closeTerminalUnpaidAttention(ids.order, {
        expectedAttentionReason: 'PROVIDER_ORDER_INCONSISTENT',
        expectedAttentionResolutionVersion: 3,
        expectedReservationExpiresAt: expiredAt,
        expectedReconciliationNextAt: null,
        expectedReconciliationLeaseOwner: null,
        expectedReconciliationLeaseUntil: null,
        changedAt: fixedNow,
        changedBy: ids.actor,
        reason: COMPLETION_REASON
      })
    } finally {
      OrderModel.findOneAndUpdate = original
    }
    assert.equal(captured.filter.$and[0].status, 'requires_attention')
    assert.equal(captured.filter.$and[0].attentionReason, 'PROVIDER_ORDER_INCONSISTENT')
    assert.equal(captured.filter.$and[0].reservationExpiresAt, expiredAt)
    assert.deepEqual(captured.filter.$and[1], {
      reservationExpiresAt: { $lte: fixedNow }
    })
    assert.equal(captured.filter.$and[2].attentionResolutionVersion, 3)
    assert.equal(captured.update.$set.status, 'expired')
    assert.equal(Object.hasOwn(captured.update.$set, 'attentionReason'), false)
    assert.equal(captured.update.$inc.attentionResolutionVersion, 1)
  })

  it('fences Payment identity, prior observation, null approval and cancellation chain', async () => {
    const original = PaymentModel.findOneAndUpdate
    let captured
    PaymentModel.findOneAndUpdate = (filter, update, options) => {
      captured = { filter, update, options }
      return { lean: async () => ({ normalizedStatus: 'cancelled' }) }
    }
    try {
      await PaymentManager.cancelAttentionWithTerminalUnpaidEvidence(ids.payment, {
        orderId: ids.order,
        expectedNormalizedStatus: 'requires_attention',
        providerOrderId: 'ORD-P1CD-001',
        externalReference: 'LC-2026-000010',
        amountArs: '20497.40',
        currency: 'ARS',
        expectedProviderStatus: 'canceled',
        expectedProviderStatusDetail: 'canceled',
        expectedLastProviderCheckAt: priorCheckAt,
        observedAt: fixedNow,
        providerStatus: 'canceled',
        providerStatusDetail: 'canceled',
        cancellationContext: {
          providerCancellationPayableStatus: 'created',
          providerCancellationPayableObservedAt: payableObservedAt,
          providerCancellationIdempotencyKey: 'cancel-P1CD-001',
          providerCancellationAttemptedAt: attemptedAt,
          providerCancellationStatus: 'succeeded',
          providerCancellationCompletedAt: completedAt
        }
      })
    } finally {
      PaymentModel.findOneAndUpdate = original
    }
    assert.equal(captured.filter.normalizedStatus, 'requires_attention')
    assert.equal(captured.filter.providerOrderId, 'ORD-P1CD-001')
    assert.equal(captured.filter.lastProviderCheckAt, priorCheckAt)
    assert.equal(captured.filter.providerCancellationIdempotencyKey, 'cancel-P1CD-001')
    assert.equal(captured.update.$set.normalizedStatus, 'cancelled')
    assert.ok(captured.filter.$and[0].$or.some((entry) => entry.providerPaymentId === null))
    assert.ok(captured.filter.$and[1].$or.some((entry) => entry.approvedAt === null))
  })
})
