/* eslint-env mocha */
import assert from 'node:assert/strict'
import mongoose from 'mongoose'
import { OrderExpirationService } from '../../src/services/orderExpiration.service.js'
import { REMOTE_ORDER_CLASSIFICATIONS } from '../../src/services/mercadoPagoOrderClassification.service.js'
import ProductUnitService from '../../src/services/productUnit.service.js'
import ProductUnitManager from '../../src/dao/managers/productUnit.manager.js'
import PaymentManager from '../../src/dao/managers/payment.manager.js'
import OrderManager from '../../src/dao/managers/order.manager.js'
import OrderItemManager from '../../src/dao/managers/orderItem.manager.js'
import ProductModel from '../../src/dao/models/produtc.model.js'
import ProductUnitModel from '../../src/dao/models/productUnit.model.js'
import PaymentModel from '../../src/dao/models/payment.model.js'
import OrderModel from '../../src/dao/models/order.model.js'
import { ServiceError } from '../../src/services/service.products.js'

const now = new Date('2026-10-12T12:00:00.000Z')
const observedAt = new Date('2026-10-12T11:59:00.000Z')
const ids = {
  order: new mongoose.Types.ObjectId().toString(),
  payment: new mongoose.Types.ObjectId().toString(),
  item: new mongoose.Types.ObjectId().toString(),
  item2: new mongoose.Types.ObjectId().toString(),
  product: new mongoose.Types.ObjectId().toString(),
  product2: new mongoose.Types.ObjectId().toString(),
  unit: new mongoose.Types.ObjectId().toString(),
  unit2: new mongoose.Types.ObjectId().toString(),
  owner: 'worker-owner'
}

const clone = (value) => structuredClone(value)

const baseState = () => ({
  order: {
    _id: ids.order,
    orderNumber: 'LC-2026-000100',
    status: 'pending_payment',
    fulfillmentStatus: 'pending',
    reservationExpiresAt: new Date(now.getTime() - 1),
    reconciliationLeaseOwner: ids.owner,
    reconciliationLeaseUntil: new Date(now.getTime() + 60_000),
    reconciliationNextAt: now,
    statusHistory: [{ status: 'pending_payment', changedAt: new Date(now.getTime() - 60_000) }],
    fulfillmentHistory: [{ status: 'pending', changedAt: new Date(now.getTime() - 60_000) }]
  },
  payment: {
    _id: ids.payment,
    orderId: ids.order,
    provider: 'mercado_pago',
    normalizedStatus: 'pending',
    providerOrderId: 'ORD-TERMINAL-1',
    providerPaymentId: null,
    providerStatus: 'canceled',
    approvedAt: null,
    lastProviderCheckAt: observedAt
  },
  items: [{ _id: ids.item, orderId: ids.order, productId: ids.product, quantity: 1 }],
  units: [{
    _id: ids.unit,
    productId: ids.product,
    orderId: ids.order,
    orderItemId: ids.item,
    reservedByOrderId: ids.order,
    soldByOrderId: null,
    status: 'reserved',
    isDeleted: false,
    reservedAt: new Date(now.getTime() - 120_000),
    reservationExpiresAt: new Date(now.getTime() - 1),
    soldAt: null
  }],
  products: {
    [ids.product]: { _id: ids.product, inventoryMode: 'serialized', prodStock: 99 }
  }
})

const evidence = (overrides = {}) => ({
  providerOrderId: 'ORD-TERMINAL-1',
  classification: REMOTE_ORDER_CLASSIFICATIONS.TERMINAL_UNPAID,
  remoteStatus: 'canceled',
  observedAt,
  orderId: ids.order,
  paymentId: ids.payment,
  ...overrides
})

const input = (overrides = {}) => ({
  orderId: ids.order,
  paymentId: ids.payment,
  ownerToken: ids.owner,
  terminalEvidence: evidence(),
  now,
  ...overrides
})

const createHarness = ({ state: suppliedState, hooks = {} } = {}) => {
  const state = suppliedState || baseState()
  let transactionActive = false

  const restore = (snapshot) => {
    for (const key of Object.keys(state)) delete state[key]
    Object.assign(state, clone(snapshot))
  }

  const session = {
    hasEnded: false,
    inTransaction: () => transactionActive,
    async withTransaction(operation, options) {
      assert.deepEqual(options, {
        readConcern: { level: 'snapshot' },
        writeConcern: { w: 'majority' }
      })
      const snapshot = clone(state)
      transactionActive = true
      try {
        return await operation()
      } catch (error) {
        restore(snapshot)
        throw error
      } finally {
        transactionActive = false
      }
    },
    async endSession() {
      this.hasEnded = true
    }
  }

  const orderManager = {
    async getById(orderId) {
      return String(state.order?._id) === String(orderId) ? clone(state.order) : null
    },
    async assertReconciliationOwnership({ orderId, ownerToken, now: checkedAt }) {
      const order = state.order
      return order &&
        String(order._id) === String(orderId) &&
        order.status === 'pending_payment' &&
        order.reconciliationLeaseOwner === ownerToken &&
        new Date(order.reconciliationLeaseUntil) > checkedAt
        ? clone(order)
        : null
    },
    async expirePendingPaymentOrder(orderId, ownerToken, { changedAt, reason }) {
      hooks.beforeOrderExpirationTransition?.(state)
      const order = state.order
      if (
        !order ||
        String(order._id) !== String(orderId) ||
        order.status !== 'pending_payment' ||
        order.fulfillmentStatus !== 'pending' ||
        order.reconciliationLeaseOwner !== ownerToken ||
        new Date(order.reconciliationLeaseUntil) <= changedAt ||
        new Date(order.reservationExpiresAt) > changedAt
      ) return null

      order.status = 'expired'
      order.fulfillmentStatus = 'cancelled'
      order.expiredAt = changedAt
      order.reconciliationNextAt = null
      order.reconciliationLeaseOwner = null
      order.reconciliationLeaseUntil = null
      order.statusHistory.push({ status: 'expired', changedAt, reason })
      order.fulfillmentHistory.push({
        status: 'cancelled', changedAt, changedBy: null, reason
      })
      return clone(order)
    },
    async markExpirationIntegrityAttention(orderId, ownerToken, { changedAt, reason }) {
      hooks.beforeAttentionOrderTransition?.(state)
      const order = state.order
      if (
        !order ||
        String(order._id) !== String(orderId) ||
        order.status !== 'pending_payment' ||
        order.reconciliationLeaseOwner !== ownerToken ||
        new Date(order.reconciliationLeaseUntil) <= changedAt
      ) return null
      order.status = 'requires_attention'
      order.attentionReason = reason
      order.reconciliationNextAt = null
      order.reconciliationLeaseOwner = null
      order.reconciliationLeaseUntil = null
      order.statusHistory.push({ status: 'requires_attention', changedAt, reason })
      return clone(order)
    }
  }

  const paymentManager = {
    async getLatestByOrderId(orderId) {
      return state.payment && String(state.payment.orderId) === String(orderId)
        ? clone(state.payment)
        : null
    },
    async transitionPendingWithTerminalUnpaidObservation(
      paymentId,
      { orderId, providerOrderId, observedAt: expectedObservation, nextStatus }
    ) {
      hooks.beforePaymentTransition?.(state)
      const payment = state.payment
      if (
        !payment ||
        String(payment._id) !== String(paymentId) ||
        String(payment.orderId) !== String(orderId) ||
        payment.provider !== 'mercado_pago' ||
        payment.normalizedStatus !== 'pending' ||
        payment.providerOrderId !== providerOrderId ||
        payment.providerStatus !== 'canceled' ||
        payment.providerPaymentId != null ||
        payment.approvedAt != null ||
        new Date(payment.lastProviderCheckAt).getTime() !== expectedObservation.getTime()
      ) return null
      payment.normalizedStatus = nextStatus
      return clone(payment)
    }
  }

  const productUnitManager = {
    async findUnitsByOrderReferences(orderId) {
      return clone(state.units.filter((unit) => (
        String(unit.orderId || '') === String(orderId) ||
        String(unit.reservedByOrderId || '') === String(orderId)
      )))
    }
  }

  const productUnitService = {
    async releaseOrderReservationsForExpiration({ orderId, expirationLimit }) {
      const expectedByItem = new Map(state.items.map((item) => [String(item._id), item]))
      const units = state.units.filter((unit) => (
        String(unit.orderId || '') === String(orderId) ||
        String(unit.reservedByOrderId || '') === String(orderId)
      ))
      const expectedCount = state.items.reduce((total, item) => total + item.quantity, 0)
      const actualByItem = new Map()
      let valid = state.items.length > 0

      for (const unit of units) {
        const item = expectedByItem.get(String(unit.orderItemId || ''))
        if (
          !item ||
          unit.status !== 'reserved' ||
          unit.isDeleted === true ||
          String(unit.orderId) !== String(orderId) ||
          String(unit.reservedByOrderId) !== String(orderId) ||
          String(unit.productId) !== String(item.productId) ||
          unit.soldByOrderId != null ||
          unit.soldAt != null ||
          new Date(unit.reservationExpiresAt) > expirationLimit
        ) valid = false
        actualByItem.set(String(unit.orderItemId), (actualByItem.get(String(unit.orderItemId)) || 0) + 1)
      }
      for (const item of state.items) {
        if (actualByItem.get(String(item._id)) !== item.quantity) valid = false
      }
      if (units.length !== expectedCount) valid = false
      if (!valid) {
        return {
          valid: false,
          reason: 'RESERVATION_INTEGRITY_CONFLICT',
          expectedCount,
          units: []
        }
      }

      hooks.beforeUnitRelease?.(state)
      if (units.some((unit) => unit.status !== 'reserved')) {
        throw new ServiceError('reservation changed', 'RESERVATION_RELEASE_CONFLICT', 409)
      }

      for (const unit of units) {
        unit.status = 'available'
        unit.orderId = null
        unit.orderItemId = null
        unit.reservedByOrderId = null
        unit.reservedAt = null
        unit.reservationExpiresAt = null
      }
      hooks.afterUnitRelease?.(state)

      const productIds = [...new Set(units.map((unit) => String(unit.productId)))].sort()
      for (const productId of productIds) {
        hooks.beforeStockRecalculation?.(state, productId)
        state.products[productId].prodStock = state.units.filter((unit) => (
          String(unit.productId) === productId &&
          unit.status === 'available' &&
          unit.isDeleted !== true
        )).length
      }

      return {
        valid: true,
        releasedCount: units.length,
        productIds
      }
    }
  }

  const service = new OrderExpirationService({
    mongooseInstance: { async startSession() { return session } },
    orderManager,
    paymentManager,
    productUnitManager,
    productUnitService
  })

  return { service, state, session }
}

describe('P1B.3a safe Order expiration domain command', () => {
  it('expires, cancels fulfillment/payment and releases one unit atomically', async () => {
    const { service, state } = createHarness()
    const result = await service.expirePendingOrderWithTerminalUnpaidEvidence(input())

    assert.equal(result.outcome, 'expired')
    assert.equal(result.releasedCount, 1)
    assert.equal(state.order.status, 'expired')
    assert.equal(state.order.fulfillmentStatus, 'cancelled')
    assert.equal(state.payment.normalizedStatus, 'cancelled')
    assert.equal(state.units[0].status, 'available')
    assert.equal(state.products[ids.product].prodStock, 1)
    assert.equal(state.order.statusHistory.at(-1).reason, 'PAYMENT_WINDOW_EXPIRED_UNPAID')
  })

  for (const [name, invalidEvidence] of [
    ['classification', { classification: REMOTE_ORDER_CLASSIFICATIONS.PAYABLE }],
    ['remote status', { remoteStatus: 'processed' }],
    ['provider Order', { providerOrderId: '' }],
    ['observation date', { observedAt: 'not-a-date' }],
    ['local Order identity', { orderId: new mongoose.Types.ObjectId().toString() }],
    ['local Payment identity', { paymentId: new mongoose.Types.ObjectId().toString() }]
  ]) {
    it(`rejects terminal evidence with invalid ${name}`, async () => {
      const { service, state } = createHarness()
      await assert.rejects(
        service.expirePendingOrderWithTerminalUnpaidEvidence(input({
          terminalEvidence: evidence(invalidEvidence)
        })),
        (error) => error.code === 'INVALID_TERMINAL_UNPAID_EVIDENCE'
      )
      assert.equal(state.units[0].status, 'reserved')
      assert.equal(state.order.status, 'pending_payment')
    })
  }

  it('does not treat an active local reservation as release authority', async () => {
    const state = baseState()
    state.order.reservationExpiresAt = new Date(now.getTime() + 1)
    const { service } = createHarness({ state })
    await assert.rejects(
      service.expirePendingOrderWithTerminalUnpaidEvidence(input()),
      (error) => error.code === 'ORDER_RESERVATION_NOT_EXPIRED'
    )
    assert.equal(state.units[0].status, 'reserved')
  })

  for (const [name, reservationExpiresAt] of [
    ['null', null],
    ['undefined', undefined]
  ]) {
    it(`rejects an Order with reservationExpiresAt ${name} without side effects`, async () => {
      const state = baseState()
      state.order.reservationExpiresAt = reservationExpiresAt
      const before = clone(state)
      const { service } = createHarness({ state })

      await assert.rejects(
        service.expirePendingOrderWithTerminalUnpaidEvidence(input()),
        (error) => error.code === 'ORDER_RESERVATION_NOT_EXPIRED'
      )

      assert.deepEqual(state, before)
      assert.equal(state.units[0].status, 'reserved')
      assert.equal(state.payment.normalizedStatus, 'pending')
      assert.equal(state.order.status, 'pending_payment')
      assert.equal(state.products[ids.product].prodStock, 99)
    })
  }

  for (const source of ['webhook', 'buyer recovery', 'provider observation race']) {
    it(`does not release when ${source} already approved the Payment`, async () => {
      const state = baseState()
      state.payment.normalizedStatus = 'approved'
      state.payment.providerPaymentId = 'PAY-APPROVED'
      state.payment.approvedAt = now
      const { service } = createHarness({ state })

      await assert.rejects(
        service.expirePendingOrderWithTerminalUnpaidEvidence(input()),
        (error) => error.code === 'PAYMENT_EXPIRATION_CONFLICT'
      )
      assert.equal(state.units[0].status, 'reserved')
      assert.equal(state.order.status, 'pending_payment')
    })
  }

  for (const paymentStatus of [
    'rejected',
    'cancelled',
    'refunded',
    'requires_attention'
  ]) {
    it(`does not expire or release inventory when Payment is ${paymentStatus}`, async () => {
      const state = baseState()
      state.payment.normalizedStatus = paymentStatus
      const before = clone(state)
      const { service } = createHarness({ state })

      await assert.rejects(
        service.expirePendingOrderWithTerminalUnpaidEvidence(input()),
        (error) => error.code === 'PAYMENT_EXPIRATION_CONFLICT'
      )

      assert.deepEqual(state, before)
      assert.equal(state.units[0].status, 'reserved')
      assert.equal(state.products[ids.product].prodStock, 99)
      assert.equal(state.order.status, 'pending_payment')
    })
  }

  it('rolls back released inventory if Payment becomes approved before its CAS', async () => {
    const { service, state } = createHarness({
      hooks: {
        beforePaymentTransition(current) {
          current.payment.normalizedStatus = 'approved'
          current.payment.providerPaymentId = 'PAY-RACE'
          current.payment.approvedAt = now
        }
      }
    })

    await assert.rejects(
      service.expirePendingOrderWithTerminalUnpaidEvidence(input()),
      (error) => error.code === 'PAYMENT_EXPIRATION_CONFLICT'
    )
    assert.equal(state.units[0].status, 'reserved')
    assert.equal(state.products[ids.product].prodStock, 99)
    assert.equal(state.payment.normalizedStatus, 'pending')
  })

  it('does not release when providerPaymentId appears concurrently', async () => {
    const { service, state } = createHarness({
      hooks: {
        beforePaymentTransition(current) {
          current.payment.providerPaymentId = 'PAY-RACE'
        }
      }
    })
    await assert.rejects(
      service.expirePendingOrderWithTerminalUnpaidEvidence(input()),
      (error) => error.code === 'PAYMENT_EXPIRATION_CONFLICT'
    )
    assert.equal(state.units[0].status, 'reserved')
  })

  it('fences a lost claim without releasing inventory', async () => {
    const state = baseState()
    state.order.reconciliationLeaseUntil = new Date(now.getTime() - 1)
    const { service } = createHarness({ state })
    await assert.rejects(
      service.expirePendingOrderWithTerminalUnpaidEvidence(input()),
      (error) => error.code === 'RECONCILIATION_CLAIM_LOST'
    )
    assert.equal(state.units[0].status, 'reserved')
  })

  it('does not let worker A release or clear worker B claim', async () => {
    const state = baseState()
    state.order.reconciliationLeaseOwner = 'worker-b'
    const { service } = createHarness({ state })
    await assert.rejects(
      service.expirePendingOrderWithTerminalUnpaidEvidence(input()),
      (error) => error.code === 'RECONCILIATION_CLAIM_LOST'
    )
    assert.equal(state.order.reconciliationLeaseOwner, 'worker-b')
    assert.equal(state.units[0].status, 'reserved')
  })

  it('rolls back when a ProductUnit changes from reserved to sold', async () => {
    const { service, state } = createHarness({
      hooks: {
        beforeUnitRelease(current) {
          current.units[0].status = 'sold'
          current.units[0].soldByOrderId = ids.order
        }
      }
    })
    await assert.rejects(
      service.expirePendingOrderWithTerminalUnpaidEvidence(input()),
      (error) => error.code === 'RESERVATION_RELEASE_CONFLICT'
    )
    assert.equal(state.units[0].status, 'reserved')
    assert.equal(state.order.status, 'pending_payment')
  })

  for (const [name, mutate] of [
    ['a unit is missing', (state) => { state.units = [] }],
    ['an extra unit references the Order', (state) => {
      state.units.push({ ...clone(state.units[0]), _id: ids.unit2 })
    }],
    ['a unit belongs to another Order', (state) => {
      const otherOrder = new mongoose.Types.ObjectId().toString()
      state.units[0].orderId = otherOrder
      state.units[0].reservedByOrderId = otherOrder
    }],
    ['a unit has the wrong orderItemId', (state) => {
      state.units[0].orderItemId = ids.item2
    }],
    ['a unit has the wrong productId', (state) => {
      state.units[0].productId = ids.product2
    }],
    ['orderId matches but reservedByOrderId does not', (state) => {
      state.units[0].reservedByOrderId = new mongoose.Types.ObjectId().toString()
    }],
    ['reservedByOrderId matches but orderId does not', (state) => {
      state.units[0].orderId = new mongoose.Types.ObjectId().toString()
    }],
    ['a unit is already available', (state) => { state.units[0].status = 'available' }],
    ['a unit is deleted', (state) => { state.units[0].isDeleted = true }]
  ]) {
    it(`fails closed with attention when ${name}`, async () => {
      const state = baseState()
      mutate(state)
      const unitsBefore = clone(state.units)
      const statusHistoryLength = state.order.statusHistory.length
      const fulfillmentHistoryLength = state.order.fulfillmentHistory.length
      const { service } = createHarness({ state })
      const result = await service.expirePendingOrderWithTerminalUnpaidEvidence(input())

      assert.equal(result.outcome, 'requires_attention')
      assert.equal(result.releasedCount, 0)
      assert.equal(result.reason, 'RESERVATION_INTEGRITY_CONFLICT')
      assert.equal(state.order.status, 'requires_attention')
      assert.equal(state.payment.normalizedStatus, 'requires_attention')
      assert.deepEqual(state.units, unitsBefore)
      assert.equal(state.products[ids.product].prodStock, 99)
      assert.equal(state.order.reconciliationLeaseOwner, null)
      assert.equal(state.order.reconciliationLeaseUntil, null)
      assert.equal(state.order.reconciliationNextAt, null)
      assert.equal(state.order.statusHistory.length, statusHistoryLength + 1)
      assert.equal(state.order.statusHistory.at(-1).reason, 'RESERVATION_INTEGRITY_CONFLICT')
      assert.equal(state.order.fulfillmentHistory.length, fulfillmentHistoryLength)
    })
  }

  it('does not duplicate integrity history after the Order enters attention', async () => {
    const state = baseState()
    state.units = []
    const { service } = createHarness({ state })
    await service.expirePendingOrderWithTerminalUnpaidEvidence(input())
    const historyLength = state.order.statusHistory.length

    await assert.rejects(
      service.expirePendingOrderWithTerminalUnpaidEvidence(input()),
      (error) => error.code === 'RECONCILIATION_CLAIM_LOST'
    )

    assert.equal(state.order.statusHistory.length, historyLength)
    assert.equal(state.order.fulfillmentHistory.length, 1)
  })

  it('rolls back Payment attention if the final Order attention CAS fails', async () => {
    const state = baseState()
    state.units = []
    const before = clone(state)
    const { service } = createHarness({
      state,
      hooks: {
        beforeAttentionOrderTransition(current) {
          current.order.reconciliationLeaseOwner = 'worker-b'
        }
      }
    })

    await assert.rejects(
      service.expirePendingOrderWithTerminalUnpaidEvidence(input()),
      (error) => error.code === 'ORDER_EXPIRATION_CONFLICT'
    )

    assert.deepEqual(state, before)
    assert.equal(state.payment.normalizedStatus, 'pending')
    assert.equal(state.order.statusHistory.length, 1)
    assert.equal(state.order.fulfillmentHistory.length, 1)
    assert.equal(state.products[ids.product].prodStock, 99)
  })

  it('rolls back unit, stock, Payment and histories when the final Order CAS fails', async () => {
    const state = baseState()
    const before = clone(state)
    const { service } = createHarness({
      state,
      hooks: {
        beforeOrderExpirationTransition(current) {
          current.order.reconciliationLeaseOwner = 'worker-b'
        }
      }
    })

    await assert.rejects(
      service.expirePendingOrderWithTerminalUnpaidEvidence(input()),
      (error) => error.code === 'ORDER_EXPIRATION_CONFLICT'
    )

    assert.deepEqual(state, before)
    assert.equal(state.units[0].status, 'reserved')
    assert.equal(state.payment.normalizedStatus, 'pending')
    assert.equal(state.order.statusHistory.length, 1)
    assert.equal(state.order.fulfillmentHistory.length, 1)
    assert.equal(state.products[ids.product].prodStock, 99)
  })

  it('is idempotent on a complete second execution', async () => {
    const { service, state } = createHarness()
    await service.expirePendingOrderWithTerminalUnpaidEvidence(input())
    const historyLength = state.order.statusHistory.length
    const result = await service.expirePendingOrderWithTerminalUnpaidEvidence(input())

    assert.equal(result.outcome, 'already_expired')
    assert.equal(result.releasedCount, 0)
    assert.equal(state.order.statusHistory.length, historyLength)
    assert.equal(state.products[ids.product].prodStock, 1)
  })

  it('releases quantity greater than one without partial effects', async () => {
    const state = baseState()
    state.items[0].quantity = 2
    state.units.push({ ...clone(state.units[0]), _id: ids.unit2 })
    const { service } = createHarness({ state })
    const result = await service.expirePendingOrderWithTerminalUnpaidEvidence(input())

    assert.equal(result.releasedCount, 2)
    assert.deepEqual(state.units.map((unit) => unit.status), ['available', 'available'])
    assert.equal(state.products[ids.product].prodStock, 2)
  })

  it('recalculates each product authoritatively in a multi-product Order', async () => {
    const state = baseState()
    state.items.push({
      _id: ids.item2, orderId: ids.order, productId: ids.product2, quantity: 1
    })
    state.units.push({
      ...clone(state.units[0]),
      _id: ids.unit2,
      productId: ids.product2,
      orderItemId: ids.item2
    })
    state.products[ids.product2] = {
      _id: ids.product2, inventoryMode: 'serialized', prodStock: 42
    }
    const { service } = createHarness({ state })
    const result = await service.expirePendingOrderWithTerminalUnpaidEvidence(input())

    assert.deepEqual(result.productIds, [ids.product, ids.product2].sort())
    assert.equal(state.products[ids.product].prodStock, 1)
    assert.equal(state.products[ids.product2].prodStock, 1)
  })

  it('repairs pre-existing prodStock drift from the available-unit count', async () => {
    const state = baseState()
    state.units.push({
      ...clone(state.units[0]),
      _id: ids.unit2,
      status: 'available',
      orderId: null,
      orderItemId: null,
      reservedByOrderId: null,
      reservedAt: null,
      reservationExpiresAt: null
    })
    state.products[ids.product].prodStock = 500
    const { service } = createHarness({ state })
    await service.expirePendingOrderWithTerminalUnpaidEvidence(input())
    assert.equal(state.products[ids.product].prodStock, 2)
  })

  it('rolls back a failure after units were modified', async () => {
    const { service, state } = createHarness({
      hooks: { afterUnitRelease() { throw new Error('simulated failure') } }
    })
    await assert.rejects(
      service.expirePendingOrderWithTerminalUnpaidEvidence(input()),
      (error) => error.code === 'ORDER_EXPIRATION_FAILED'
    )
    assert.equal(state.units[0].status, 'reserved')
    assert.equal(state.order.status, 'pending_payment')
    assert.equal(state.payment.normalizedStatus, 'pending')
  })

  it('rolls back a stock recalculation failure', async () => {
    const { service, state } = createHarness({
      hooks: { beforeStockRecalculation() { throw new Error('stock failed') } }
    })
    await assert.rejects(
      service.expirePendingOrderWithTerminalUnpaidEvidence(input()),
      (error) => error.code === 'ORDER_EXPIRATION_FAILED'
    )
    assert.equal(state.units[0].status, 'reserved')
    assert.equal(state.products[ids.product].prodStock, 99)
  })

  it('treats reservationExpiresAt equal to now as expired', async () => {
    const state = baseState()
    state.order.reservationExpiresAt = now
    state.units[0].reservationExpiresAt = now
    const { service } = createHarness({ state })
    assert.equal(
      (await service.expirePendingOrderWithTerminalUnpaidEvidence(input())).outcome,
      'expired'
    )
  })

  it('rejects invented evidence for a legacy Payment without providerOrderId', async () => {
    const state = baseState()
    state.payment.providerOrderId = null
    state.payment.providerStatus = null
    state.payment.lastProviderCheckAt = null
    const { service } = createHarness({ state })
    await assert.rejects(
      service.expirePendingOrderWithTerminalUnpaidEvidence(input()),
      (error) => error.code === 'PAYMENT_EXPIRATION_CONFLICT'
    )
    assert.equal(state.units[0].status, 'reserved')
  })

  it('rejects stale terminal evidence after the persisted observation changed', async () => {
    const state = baseState()
    state.payment.lastProviderCheckAt = new Date(observedAt.getTime() + 1)
    const { service } = createHarness({ state })
    await assert.rejects(
      service.expirePendingOrderWithTerminalUnpaidEvidence(input()),
      (error) => error.code === 'PAYMENT_EXPIRATION_CONFLICT'
    )
  })

  it('rejects incomplete terminal state instead of pretending idempotence', async () => {
    const state = baseState()
    state.order.status = 'expired'
    state.order.fulfillmentStatus = 'cancelled'
    state.payment.normalizedStatus = 'cancelled'
    const { service } = createHarness({ state })
    await assert.rejects(
      service.expirePendingOrderWithTerminalUnpaidEvidence(input()),
      (error) => error.code === 'ORDER_EXPIRATION_TERMINAL_STATE_CONFLICT'
    )
  })
})

describe('P1B.3a ProductUnit release primitive', () => {
  const restorations = []
  const session = { hasEnded: false, inTransaction: () => true }

  const stub = (target, property, replacement) => {
    const original = target[property]
    restorations.push(() => { target[property] = original })
    target[property] = replacement
  }

  afterEach(() => {
    while (restorations.length) restorations.pop()()
  })

  it('uses exact reservation ownership, deterministic product guards and one recalc per product', async () => {
    const orderItems = [
      { _id: ids.item, productId: ids.product, quantity: 1 },
      { _id: ids.item2, productId: ids.product2, quantity: 1 }
    ]
    const units = [
      { ...baseState().units[0] },
      {
        ...baseState().units[0],
        _id: ids.unit2,
        productId: ids.product2,
        orderItemId: ids.item2
      }
    ]
    const guards = []
    const recalculations = []
    let releaseInput

    stub(OrderItemManager, 'getByOrderId', async () => orderItems)
    stub(ProductUnitManager, 'findUnitsByOrderReferences', async () => units)
    stub(ProductUnitManager, 'releaseReservedUnitsForOrder', async (value) => {
      releaseInput = value
      return { modifiedCount: 2 }
    })
    stub(ProductModel, 'findOneAndUpdate', (filter) => ({
      lean: async () => {
        guards.push(String(filter._id))
        return { _id: filter._id, inventoryMode: 'serialized' }
      }
    }))
    stub(ProductUnitService, 'recalculateProductStock', async (productId, options) => {
      recalculations.push({ productId: String(productId), session: options.session })
    })

    const result = await ProductUnitService.releaseOrderReservationsForExpiration(
      { orderId: ids.order, expirationLimit: now },
      { session }
    )

    assert.equal(result.valid, true)
    assert.equal(result.releasedCount, 2)
    assert.deepEqual(guards, [ids.product, ids.product2].sort())
    assert.deepEqual(recalculations.map(({ productId }) => productId), guards)
    assert.equal(releaseInput.orderId, ids.order)
    assert.deepEqual(releaseInput.unitIds, [ids.unit, ids.unit2])
    assert.equal(releaseInput.expirationLimit.getTime(), now.getTime())
  })

  it('returns an integrity failure before writing when a unit is missing', async () => {
    let releaseCalls = 0
    stub(OrderItemManager, 'getByOrderId', async () => ([
      { _id: ids.item, productId: ids.product, quantity: 2 }
    ]))
    stub(ProductUnitManager, 'findUnitsByOrderReferences', async () => ([baseState().units[0]]))
    stub(ProductUnitManager, 'releaseReservedUnitsForOrder', async () => {
      releaseCalls += 1
      return { modifiedCount: 1 }
    })

    const result = await ProductUnitService.releaseOrderReservationsForExpiration(
      { orderId: ids.order, expirationLimit: now },
      { session }
    )
    assert.equal(result.valid, false)
    assert.equal(releaseCalls, 0)
  })

  it('rejects a partial CAS so its enclosing transaction can roll back', async () => {
    stub(OrderItemManager, 'getByOrderId', async () => ([
      { _id: ids.item, productId: ids.product, quantity: 1 }
    ]))
    stub(ProductUnitManager, 'findUnitsByOrderReferences', async () => ([baseState().units[0]]))
    stub(ProductUnitManager, 'releaseReservedUnitsForOrder', async () => ({ modifiedCount: 0 }))
    stub(ProductModel, 'findOneAndUpdate', () => ({
      lean: async () => ({ _id: ids.product, inventoryMode: 'serialized' })
    }))

    await assert.rejects(
      ProductUnitService.releaseOrderReservationsForExpiration(
        { orderId: ids.order, expirationLimit: now },
        { session }
      ),
      (error) => error.code === 'RESERVATION_RELEASE_CONFLICT'
    )
  })
})

describe('P1B.3a expiration persistence fences', () => {
  const restorations = []
  const stub = (target, property, replacement) => {
    const original = target[property]
    restorations.push(() => { target[property] = original })
    target[property] = replacement
  }

  afterEach(() => {
    while (restorations.length) restorations.pop()()
  })

  it('releases only exact expired reservations owned by the same Order', async () => {
    let captured
    stub(ProductUnitModel, 'updateMany', (filter, update, options) => {
      captured = { filter, update, options }
      return { modifiedCount: 1 }
    })
    await ProductUnitManager.releaseReservedUnitsForOrder({
      unitIds: [ids.unit],
      orderId: ids.order,
      expirationLimit: now
    }, { session: 'session' })

    assert.deepEqual(captured.filter, {
      _id: { $in: [ids.unit] },
      status: 'reserved',
      isDeleted: { $ne: true },
      orderId: ids.order,
      reservedByOrderId: ids.order,
      reservationExpiresAt: { $lte: now }
    })
    assert.equal(captured.update.$set.status, 'available')
    assert.equal(captured.update.$set.orderId, null)
    assert.equal(captured.update.$set.reservedByOrderId, null)
    assert.equal(captured.options.session, 'session')
  })

  it('cancels Payment only for the exact terminal observation and no provider payment', async () => {
    let captured
    stub(PaymentModel, 'findOneAndUpdate', (filter, update, options) => {
      captured = { filter, update, options }
      return { lean: async () => ({ _id: ids.payment }) }
    })
    await PaymentManager.transitionPendingWithTerminalUnpaidObservation(
      ids.payment,
      {
        orderId: ids.order,
        providerOrderId: 'ORD-TERMINAL-1',
        observedAt,
        nextStatus: 'cancelled'
      },
      { session: 'session' }
    )

    assert.equal(captured.filter.normalizedStatus, 'pending')
    assert.equal(captured.filter.providerStatus, 'canceled')
    assert.equal(captured.filter.lastProviderCheckAt, observedAt)
    assert.equal(captured.filter.providerOrderId, 'ORD-TERMINAL-1')
    assert.equal(JSON.stringify(captured.filter.$and).includes('providerPaymentId'), true)
    assert.equal(JSON.stringify(captured.filter.$and).includes('approvedAt'), true)
    assert.deepEqual(captured.update, { $set: { normalizedStatus: 'cancelled' } })
  })

  it('expires Order and clears only the current owner claim in the same CAS', async () => {
    let captured
    stub(OrderModel, 'findOneAndUpdate', (filter, update, options) => {
      captured = { filter, update, options }
      return { lean: async () => ({ _id: ids.order }) }
    })
    await OrderManager.expirePendingPaymentOrder(
      ids.order,
      ids.owner,
      { changedAt: now, reason: 'PAYMENT_WINDOW_EXPIRED_UNPAID' },
      { session: 'session' }
    )

    const serializedFilter = JSON.stringify(captured.filter)
    assert.equal(serializedFilter.includes('reconciliationLeaseOwner'), true)
    assert.equal(serializedFilter.includes('reconciliationLeaseUntil'), true)
    assert.equal(serializedFilter.includes('reservationExpiresAt'), true)
    assert.equal(serializedFilter.includes('pending_payment'), true)
    assert.equal(captured.update.$set.status, 'expired')
    assert.equal(captured.update.$set.fulfillmentStatus, 'cancelled')
    assert.equal(captured.update.$set.reconciliationLeaseOwner, null)
    assert.equal(captured.update.$push.statusHistory.reason, 'PAYMENT_WINDOW_EXPIRED_UNPAID')
  })
})
