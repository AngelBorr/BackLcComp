import assert from 'node:assert/strict'
import mongoose from 'mongoose'
import { OrderAttentionController } from '../../src/controllers/orderAttention.controller.js'
import OrderManager from '../../src/dao/managers/order.manager.js'
import PaymentManager from '../../src/dao/managers/payment.manager.js'
import ProductUnitManager from '../../src/dao/managers/productUnit.manager.js'
import OrderModel from '../../src/dao/models/order.model.js'
import PaymentModel from '../../src/dao/models/payment.model.js'
import ProductUnitModel from '../../src/dao/models/productUnit.model.js'
import { OrderAttentionResolutionService } from '../../src/services/orderAttentionResolution.service.js'
import { OrderAttentionRecoveryService } from '../../src/services/orderAttentionRecovery.service.js'
import { CheckoutFinancialGuardService } from '../../src/services/checkoutFinancialGuard.service.js'

const ids = Object.freeze({
  order: '507f1f77bcf86cd799439101',
  payment: '507f1f77bcf86cd799439102',
  item: '507f1f77bcf86cd799439103',
  product: '507f1f77bcf86cd799439104',
  unit: '507f1f77bcf86cd799439105',
  actor: '507f1f77bcf86cd799439106',
  otherOrder: '507f1f77bcf86cd799439107'
})

const fixedNow = new Date('2026-11-02T18:00:00.000Z')
const approvedAt = new Date('2026-11-02T16:00:00.000Z')
const priorCheckAt = new Date('2026-11-02T17:00:00.000Z')
const expiredAt = new Date('2026-11-02T15:00:00.000Z')

const clone = (value) => structuredClone(value)
const sameId = (left, right) => String(left ?? '') === String(right ?? '')
const sameInstant = (left, right) => {
  if (left == null || right == null) return left == null && right == null
  return new Date(left).getTime() === new Date(right).getTime()
}

const baseProviderOrder = (overrides = {}) => ({
  providerOrderId: 'ORD-ATTENTION-001',
  status: 'processed',
  statusDetail: 'accredited',
  externalReference: 'LC-2026-000003',
  totalAmount: '20497.40',
  totalPaidAmount: '20497.40',
  currency: 'ARS',
  payments: [{
    providerPaymentId: 'PAY-ATTENTION-001',
    status: 'processed',
    statusDetail: 'accredited',
    amount: '20497.40',
    paidAmount: '20497.40'
  }],
  ...overrides
})

const baseState = (overrides = {}) => ({
  order: {
    _id: ids.order,
    orderNumber: 'LC-2026-000003',
    userId: '507f1f77bcf86cd799439109',
    status: 'requires_attention',
    fulfillmentStatus: 'pending',
    attentionReason: 'RESERVATION_EXPIRED',
    attentionResolutionVersion: 0,
    paymentCurrency: 'ARS',
    totals: { totalArs: '20497.40' },
    paidAt: null,
    statusHistory: [],
    fulfillmentHistory: []
  },
  payment: {
    _id: ids.payment,
    orderId: ids.order,
    provider: 'mercado_pago',
    providerOrderId: 'ORD-ATTENTION-001',
    providerPaymentId: 'PAY-ATTENTION-001',
    externalReference: 'LC-2026-000003',
    providerStatus: 'processed',
    providerStatusDetail: 'accredited',
    normalizedStatus: 'approved',
    amountArs: '20497.40',
    currency: 'ARS',
    approvedAt,
    lastProviderCheckAt: priorCheckAt
  },
  items: [{
    _id: ids.item,
    orderId: ids.order,
    productId: ids.product,
    quantity: 1
  }],
  units: [{
    _id: ids.unit,
    serialNumber: 'LC000003-SERIAL',
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
  stockByProduct: { [ids.product]: 4 },
  counters: {
    providerGets: 0,
    saleCalls: 0,
    stockRecalculations: 0
  },
  ...overrides
})

const restoreState = (state, snapshot) => {
  for (const key of Object.keys(state)) delete state[key]
  Object.assign(state, snapshot)
}

const makeHarness = ({
  state: initialState = baseState(),
  providerOrder = baseProviderOrder(),
  mutateTransactionOrder,
  mutateTransactionUnits,
  mutateBeforePaymentCas,
  partialUnitSale = false
} = {}) => {
  const state = initialState
  let transactionTail = Promise.resolve()
  let transactionOrderReads = 0
  let transactionUnitReads = 0

  const mongooseInstance = {
    async startSession() {
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
      transactionOrderReads += 1
      if (transactionOrderReads === 1 && mutateTransactionOrder) {
        mutateTransactionOrder(state)
      }
      return sameId(state.order._id, orderId) ? clone(state.order) : null
    },
    async completeExistingReservationSaleAttention(orderId, input) {
      const order = state.order
      if (
        !sameId(order._id, orderId) ||
        order.status !== 'requires_attention' ||
        order.fulfillmentStatus !== 'pending' ||
        order.attentionReason !== input.expectedAttentionReason ||
        (order.attentionResolutionVersion ?? 0) !== input.expectedAttentionResolutionVersion
      ) return null

      order.status = 'paid'
      order.paidAt = new Date(input.paidAt)
      order.fulfillmentStatus = 'preparing'
      order.attentionResolutionVersion = (order.attentionResolutionVersion ?? 0) + 1
      order.statusHistory.push({
        status: 'paid',
        changedAt: new Date(input.changedAt),
        reason: input.reason
      })
      order.fulfillmentHistory.push({
        status: 'preparing',
        changedAt: new Date(input.changedAt),
        changedBy: input.changedBy,
        reason: input.reason
      })
      return clone(order)
    },
    async getFinanciallyUnresolvedByUserId() {
      return state.order.status === 'paid' ? [] : [clone(state.order)]
    }
  }

  const orderItemManager = {
    async getByOrderId() { return clone(state.items) }
  }

  const paymentManager = {
    async getLatestByOrderId() { return clone(state.payment) },
    async getById(paymentId) {
      return sameId(state.payment._id, paymentId) ? clone(state.payment) : null
    },
    async confirmApprovedAttentionEvidence(paymentId, input) {
      if (mutateBeforePaymentCas) mutateBeforePaymentCas(state)
      const payment = state.payment
      if (
        !sameId(payment._id, paymentId) ||
        !sameId(payment.orderId, input.orderId) ||
        payment.provider !== 'mercado_pago' ||
        payment.normalizedStatus !== 'approved' ||
        !sameId(payment.providerOrderId, input.providerOrderId) ||
        !sameId(payment.providerPaymentId, input.providerPaymentId) ||
        !sameInstant(payment.approvedAt, input.approvedAt) ||
        String(payment.amountArs) !== String(input.amountArs) ||
        payment.currency !== input.currency ||
        !sameInstant(payment.lastProviderCheckAt, input.expectedLastProviderCheckAt)
      ) return null

      payment.providerStatus = input.providerStatus
      payment.providerStatusDetail = input.providerStatusDetail
      payment.lastProviderCheckAt = new Date(input.observedAt)
      return clone(payment)
    }
  }

  const productUnitManager = {
    async getRelatedByOrderId() {
      transactionUnitReads += 1
      if (transactionUnitReads === 2 && mutateTransactionUnits) {
        mutateTransactionUnits(state)
      }
      return clone(state.units)
    },
    async markExactReservedUnitsSold(expectedUnits, orderId, soldAt) {
      state.counters.saleCalls += 1
      let matchedCount = 0
      let modifiedCount = 0

      for (const expected of expectedUnits) {
        const unit = state.units.find((candidate) => sameId(candidate._id, expected.productUnitId))
        if (!unit) continue
        if (
          unit.status !== 'reserved' ||
          unit.isDeleted === true ||
          !sameId(unit.orderId, orderId) ||
          !sameId(unit.reservedByOrderId, orderId) ||
          !sameId(unit.orderItemId, expected.orderItemId) ||
          !sameId(unit.productId, expected.productId) ||
          unit.soldByOrderId != null ||
          unit.soldAt != null
        ) continue

        matchedCount += 1
        unit.status = 'sold'
        unit.soldByOrderId = orderId
        unit.soldAt = new Date(soldAt)
        modifiedCount += 1
        if (partialUnitSale) break
      }

      return { matchedCount, modifiedCount }
    },
    async getByIds(unitIds) {
      return clone(state.units.filter((unit) => unitIds.some((id) => sameId(id, unit._id))))
    }
  }

  const productUnitService = {
    async recalculateProductStock(productId) {
      state.counters.stockRecalculations += 1
      state.stockByProduct[String(productId)] = state.units.filter((unit) => (
        sameId(unit.productId, productId) &&
        unit.status === 'available' &&
        unit.isDeleted !== true
      )).length
      return { available: state.stockByProduct[String(productId)] }
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
        (update.expectedAttemptToken && row.activeAttemptToken !== update.expectedAttemptToken)
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
  const provider = {
    async getOrder() {
      state.counters.providerGets += 1
      return clone(providerOrder)
    }
  }
  const service = new OrderAttentionRecoveryService({
    mongooseInstance,
    orderManager,
    orderItemManager,
    paymentManager,
    productUnitManager,
    productUnitService,
    resolutionManager,
    resolutionService,
    provider,
    clock: () => fixedNow
  })

  return {
    state,
    service,
    managers: { orderManager, paymentManager },
    input: {
      orderNumber: 'LC-2026-000003',
      idempotencyKey: 'attention-recovery-001',
      actorUserId: ids.actor,
      actorRole: 'ADMIN',
      note: 'Evidencia revisada'
    }
  }
}

const rejectsCode = async (operation, code) => {
  await assert.rejects(operation, (error) => error?.code === code)
}

describe('P1C-A approved sale recovery (isolated)', () => {
  it('completes the same expired reservation atomically and preserves its audit trail', async () => {
    const { service, state, input } = makeHarness()
    const result = await service.completeExistingReservationSale(input)

    assert.equal(result.orderStatus, 'paid')
    assert.equal(result.paymentStatus, 'approved')
    assert.equal(result.fulfillmentStatus, 'preparing')
    assert.equal(result.soldCount, 1)
    assert.equal(state.order.attentionReason, 'RESERVATION_EXPIRED')
    assert.equal(state.order.attentionResolutionVersion, 1)
    assert.equal(state.order.paidAt.toISOString(), approvedAt.toISOString())
    assert.equal(state.payment.normalizedStatus, 'approved')
    assert.equal(state.payment.providerPaymentId, 'PAY-ATTENTION-001')
    assert.equal(state.units[0].status, 'sold')
    assert.equal(state.units[0].reservedByOrderId, ids.order)
    assert.equal(state.units[0].reservationExpiresAt.toISOString(), expiredAt.toISOString())
    assert.equal(state.units[0].soldByOrderId, ids.order)
    assert.equal(state.stockByProduct[ids.product], 0)
    assert.equal(state.counters.stockRecalculations, 1)
    assert.deepEqual(state.order.statusHistory.map(({ status, reason }) => ({ status, reason })), [{
      status: 'paid',
      reason: 'ATTENTION_RESOLUTION_EXISTING_RESERVATION_SALE'
    }])
    assert.deepEqual(
      state.order.fulfillmentHistory.map(({ status, reason }) => ({ status, reason })),
      [{ status: 'preparing', reason: 'ATTENTION_RESOLUTION_EXISTING_RESERVATION_SALE' }]
    )
    assert.equal(state.resolutions.length, 1)
    assert.equal(state.resolutions[0].status, 'completed')
    assert.equal(state.resolutions[0].actorUserId, ids.actor)
    assert.equal(state.resolutions[0].providerEvidence.remoteClassification, 'APPROVED')
    assert.equal(state.resolutions[0].providerEvidence.totalPaidAmount, '20497.40')
    assert.equal(state.resolutions[0].finalProductUnits[0].status, 'sold')
  })

  for (const [name, providerOverrides] of [
    ['remote payment is not approved', { status: 'processing', statusDetail: 'pending' }],
    ['provider payment id differs', {
      payments: [{
        providerPaymentId: 'PAY-OTHER',
        status: 'processed',
        statusDetail: 'accredited',
        amount: '20497.40',
        paidAmount: '20497.40'
      }]
    }],
    ['amount differs', { totalAmount: '20497.41' }],
    ['paid amount differs', { totalPaidAmount: '20497.39' }],
    ['currency differs', { currency: 'USD' }],
    ['external reference differs', { externalReference: 'LC-2026-999999' }]
  ]) {
    it(`fails closed when ${name}`, async () => {
      const harness = makeHarness({ providerOrder: baseProviderOrder(providerOverrides) })
      await rejectsCode(
        harness.service.completeExistingReservationSale(harness.input),
        'ATTENTION_PROVIDER_EVIDENCE_MISMATCH'
      )
      assert.equal(harness.state.order.status, 'requires_attention')
      assert.equal(harness.state.units[0].status, 'reserved')
      assert.equal(harness.state.resolutions.length, 0)
    })
  }

  for (const [name, mutate] of [
    ['unit belongs to another Order', (state) => { state.units[0].orderId = ids.otherOrder }],
    ['unit was sold by another Order', (state) => {
      state.units[0].status = 'sold'
      state.units[0].soldByOrderId = ids.otherOrder
      state.units[0].soldAt = fixedNow
    }],
    ['unit is deleted', (state) => { state.units[0].isDeleted = true }],
    ['unit is inactive', (state) => { state.units[0].status = 'inactive' }],
    ['reserved quantity is incomplete', (state) => { state.items[0].quantity = 2 }]
  ]) {
    it(`rejects preflight when ${name}`, async () => {
      const state = baseState()
      mutate(state)
      const harness = makeHarness({ state })
      await rejectsCode(
        harness.service.completeExistingReservationSale(harness.input),
        'ATTENTION_EXISTING_RESERVATION_SALE_NOT_ALLOWED'
      )
      assert.equal(state.counters.providerGets, 0)
      assert.equal(state.counters.saleCalls, 0)
      assert.equal(state.order.status, 'requires_attention')
    })
  }

  it('rejects a stale attentionResolutionVersion with 409 and rolls back', async () => {
    const harness = makeHarness({
      mutateTransactionOrder(state) { state.order.attentionResolutionVersion = 1 }
    })
    await rejectsCode(
      harness.service.completeExistingReservationSale(harness.input),
      'ATTENTION_RESOLUTION_STATE_CONFLICT'
    )
    assert.equal(harness.state.order.status, 'requires_attention')
    assert.equal(harness.state.units[0].status, 'reserved')
    assert.equal(harness.state.resolutions[0].status, 'failed')
  })

  it('deduplicates two concurrent ADMIN commands with the same key', async () => {
    const harness = makeHarness()
    const results = await Promise.all([
      harness.service.completeExistingReservationSale(harness.input),
      harness.service.completeExistingReservationSale(harness.input)
    ])

    assert.equal(new Set(results.map((result) => result.resolutionId)).size, 1)
    assert.equal(harness.state.order.attentionResolutionVersion, 1)
    assert.equal(harness.state.counters.saleCalls, 1)
    assert.equal(harness.state.order.statusHistory.length, 1)
  })

  it('returns the same completed result for retry and rejects a second key', async () => {
    const harness = makeHarness()
    const first = await harness.service.completeExistingReservationSale(harness.input)
    const retry = await harness.service.completeExistingReservationSale(harness.input)

    assert.equal(retry.resolutionId, first.resolutionId)
    assert.equal(retry.idempotent, true)
    assert.equal(harness.state.counters.saleCalls, 1)
    assert.equal(harness.state.counters.providerGets, 1)

    await rejectsCode(
      harness.service.completeExistingReservationSale({
        ...harness.input,
        idempotencyKey: 'attention-recovery-002'
      }),
      'ATTENTION_EXISTING_RESERVATION_SALE_NOT_ALLOWED'
    )
    assert.equal(harness.state.resolutions.length, 1)
  })

  it('resumes a prepared resolution after a crash using only its persisted evidence', async () => {
    const firstHarness = makeHarness()
    await firstHarness.service.completeExistingReservationSale(firstHarness.input)
    const prepared = clone(firstHarness.state.resolutions[0])
    const state = baseState({ resolutions: [prepared] })
    state.resolutions[0].status = 'prepared'
    state.resolutions[0].completedAt = null
    state.resolutions[0].finalProductUnits = []
    state.resolutions[0].finalResult = null
    const harness = makeHarness({ state })

    const result = await harness.service.completeExistingReservationSale(harness.input)

    assert.equal(result.orderStatus, 'paid')
    assert.equal(state.resolutions[0].status, 'completed')
    assert.equal(state.counters.providerGets, 0)
    assert.equal(state.counters.saleCalls, 1)
  })

  it('allows only one of two different concurrent keys to win the Order CAS', async () => {
    const harness = makeHarness()
    const results = await Promise.allSettled([
      harness.service.completeExistingReservationSale(harness.input),
      harness.service.completeExistingReservationSale({
        ...harness.input,
        idempotencyKey: 'attention-recovery-other'
      })
    ])

    assert.equal(results.filter(({ status }) => status === 'fulfilled').length, 1)
    assert.equal(results.filter(({ status }) => status === 'rejected').length, 1)
    assert.equal(harness.state.order.attentionResolutionVersion, 1)
    assert.equal(harness.state.counters.saleCalls, 1)
    assert.equal(harness.state.resolutions.filter(({ status }) => status === 'completed').length, 1)
  })

  it('aborts as stale if a webhook changes lastProviderCheckAt after preflight', async () => {
    const harness = makeHarness({
      mutateBeforePaymentCas(state) {
        state.payment.lastProviderCheckAt = new Date('2026-11-02T17:30:00.001Z')
      }
    })
    await rejectsCode(
      harness.service.completeExistingReservationSale(harness.input),
      'ATTENTION_PAYMENT_EVIDENCE_STALE'
    )
    assert.equal(harness.state.order.status, 'requires_attention')
    assert.equal(harness.state.units[0].status, 'reserved')
    assert.equal(harness.state.counters.saleCalls, 0)
  })

  it('aborts if a ProductUnit changes between preflight and transaction', async () => {
    const harness = makeHarness({
      mutateTransactionUnits(state) { state.units[0].reservedByOrderId = ids.otherOrder }
    })
    await rejectsCode(
      harness.service.completeExistingReservationSale(harness.input),
      'ATTENTION_RESERVATION_STATE_CONFLICT'
    )
    assert.equal(harness.state.order.status, 'requires_attention')
    assert.equal(harness.state.counters.saleCalls, 0)
  })

  it('rolls back Order, Payment, units and stock when an all-or-none unit CAS fails', async () => {
    const secondUnitId = '507f1f77bcf86cd799439108'
    const state = baseState()
    state.items[0].quantity = 2
    state.units.push({ ...clone(state.units[0]), _id: secondUnitId, serialNumber: 'SECOND' })
    const harness = makeHarness({ state, partialUnitSale: true })

    await rejectsCode(
      harness.service.completeExistingReservationSale(harness.input),
      'ATTENTION_RESERVATION_SALE_CONFLICT'
    )
    assert.equal(state.order.status, 'requires_attention')
    assert.equal(state.payment.lastProviderCheckAt.toISOString(), priorCheckAt.toISOString())
    assert.deepEqual(state.units.map((unit) => unit.status), ['reserved', 'reserved'])
    assert.equal(state.stockByProduct[ids.product], 4)
    assert.equal(state.resolutions[0].status, 'failed')
    assert.equal(state.resolutions[0].finalResult.soldCount, 0)
  })

  it('Financial Guard blocks before recovery and allows after paid completion', async () => {
    const harness = makeHarness()
    const guard = new CheckoutFinancialGuardService({
      orderManager: harness.managers.orderManager,
      paymentManager: harness.managers.paymentManager,
      mercadoPagoReconciliationService: { async reconcileProviderOrder() {} }
    })
    const buyerId = harness.state.order.userId

    const before = await guard.evaluate(buyerId)
    assert.equal(before.allowed, false)
    assert.equal(before.blocker.code, 'CHECKOUT_BLOCKED_BY_APPROVED_PAYMENT')

    await harness.service.completeExistingReservationSale(harness.input)
    const after = await guard.evaluate(buyerId)
    assert.deepEqual(after, { allowed: true, blocker: null })
  })
})

describe('P1C-A HTTP authorization contract (isolated)', () => {
  for (const role of ['USER', 'PREMIUM']) {
    it(`rejects ${role} before invoking the recovery service`, async () => {
      let called = false
      const controller = new OrderAttentionController({
        orderAttentionRecoveryService: {
          async completeExistingReservationSale() { called = true }
        }
      })
      let forwarded
      await controller.completeExistingReservationSale(
        {
          user: { id: ids.actor, role },
          params: { orderNumber: 'LC-2026-000003' },
          headers: { 'idempotency-key': 'key' },
          body: {}
        },
        {},
        (error) => { forwarded = error }
      )

      assert.equal(called, false)
      assert.equal(forwarded.code, 'ORDERS_ADMIN_FORBIDDEN')
      assert.equal(forwarded.status, 403)
    })
  }

  it('forwards only server-authenticated actor, key and optional note', async () => {
    let received
    const controller = new OrderAttentionController({
      orderAttentionRecoveryService: {
        async completeExistingReservationSale(input) {
          received = input
          return { orderStatus: 'paid' }
        }
      }
    })
    let response
    await controller.completeExistingReservationSale(
      {
        user: { id: ids.actor, role: 'ADMIN' },
        params: { orderNumber: 'LC-2026-000003' },
        get: () => 'http-command-key',
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
      orderNumber: 'LC-2026-000003',
      idempotencyKey: 'http-command-key',
      actorUserId: ids.actor,
      actorRole: 'ADMIN',
      note: 'reviewed'
    })
    assert.deepEqual(response, { orderStatus: 'paid' })
  })
})

describe('P1C-A persistence compare-and-set contracts (isolated)', () => {
  it('updates Order only from the exact attention reason/version/fulfillment state', async () => {
    const original = OrderModel.findOneAndUpdate
    let captured
    OrderModel.findOneAndUpdate = (filter, update, options) => {
      captured = { filter, update, options }
      return { lean: async () => ({ status: 'paid' }) }
    }

    try {
      await OrderManager.completeExistingReservationSaleAttention(ids.order, {
        expectedAttentionReason: 'RESERVATION_EXPIRED',
        expectedAttentionResolutionVersion: 0,
        paidAt: approvedAt,
        changedAt: fixedNow,
        changedBy: ids.actor,
        reason: 'ATTENTION_RESOLUTION_EXISTING_RESERVATION_SALE'
      })
    } finally {
      OrderModel.findOneAndUpdate = original
    }

    assert.deepEqual(captured.filter.$and[0], {
      _id: ids.order,
      status: 'requires_attention',
      attentionReason: 'RESERVATION_EXPIRED',
      fulfillmentStatus: 'pending'
    })
    assert.ok(captured.filter.$and[1].$or.some((entry) => (
      entry.attentionResolutionVersion === 0
    )))
    assert.equal(captured.update.$inc.attentionResolutionVersion, 1)
    assert.equal(captured.update.$set.status, 'paid')
    assert.equal(captured.update.$set.fulfillmentStatus, 'preparing')
    assert.equal(captured.update.$push.statusHistory.status, 'paid')
    assert.equal(captured.update.$push.fulfillmentHistory.status, 'preparing')
  })

  it('keeps Payment approved while fencing every financial identifier and observation', async () => {
    const original = PaymentModel.findOneAndUpdate
    let captured
    PaymentModel.findOneAndUpdate = (filter, update, options) => {
      captured = { filter, update, options }
      return { lean: async () => ({ normalizedStatus: 'approved' }) }
    }

    try {
      await PaymentManager.confirmApprovedAttentionEvidence(ids.payment, {
        orderId: ids.order,
        providerOrderId: 'ORD-ATTENTION-001',
        providerPaymentId: 'PAY-ATTENTION-001',
        approvedAt,
        amountArs: '20497.40',
        currency: 'ARS',
        expectedLastProviderCheckAt: priorCheckAt,
        observedAt: fixedNow,
        providerStatus: 'processed',
        providerStatusDetail: 'accredited'
      })
    } finally {
      PaymentModel.findOneAndUpdate = original
    }

    assert.deepEqual(captured.filter.$and[0], {
      _id: ids.payment,
      orderId: ids.order,
      provider: 'mercado_pago',
      normalizedStatus: 'approved',
      providerOrderId: 'ORD-ATTENTION-001',
      providerPaymentId: 'PAY-ATTENTION-001',
      approvedAt,
      amountArs: '20497.40',
      currency: 'ARS'
    })
    assert.deepEqual(captured.filter.$and[1], { lastProviderCheckAt: priorCheckAt })
    assert.deepEqual(captured.update.$set, {
      providerStatus: 'processed',
      providerStatusDetail: 'accredited',
      lastProviderCheckAt: fixedNow
    })
    assert.equal(Object.hasOwn(captured.update.$set, 'normalizedStatus'), false)
    assert.equal(Object.hasOwn(captured.update.$set, 'providerPaymentId'), false)
    assert.equal(Object.hasOwn(captured.update.$set, 'approvedAt'), false)
  })

  it('sells every ProductUnit with exact original reservation references', async () => {
    const original = ProductUnitModel.bulkWrite
    let captured
    ProductUnitModel.bulkWrite = async (operations, options) => {
      captured = { operations, options }
      return { matchedCount: 1, modifiedCount: 1 }
    }

    try {
      await ProductUnitManager.markExactReservedUnitsSold([{
        productUnitId: ids.unit,
        orderItemId: ids.item,
        productId: ids.product
      }], ids.order, fixedNow)
    } finally {
      ProductUnitModel.bulkWrite = original
    }

    const operation = captured.operations[0].updateOne
    assert.deepEqual(operation.filter, {
      _id: ids.unit,
      status: 'reserved',
      isDeleted: { $ne: true },
      orderId: ids.order,
      reservedByOrderId: ids.order,
      orderItemId: ids.item,
      productId: ids.product,
      soldByOrderId: null,
      soldAt: null
    })
    assert.deepEqual(operation.update.$set, {
      status: 'sold',
      soldByOrderId: ids.order,
      soldAt: fixedNow
    })
    assert.equal(captured.options.ordered, true)
  })
})
