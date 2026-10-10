/* eslint-env mocha */
import assert from 'node:assert/strict'
import mongoose from 'mongoose'
import OrderModel from '../../src/dao/models/order.model.js'
import {
  OrderManager,
  reconciliationCursorFilter
} from '../../src/dao/managers/order.manager.js'
import {
  OrderReconciliationClaimService,
  RECONCILIATION_LEASE_MS
} from '../../src/services/orderReconciliationClaim.service.js'

const orderId = new mongoose.Types.ObjectId().toString()
const now = new Date('2026-10-09T12:00:00.000Z')

const matchesCursorFilter = (order, filter) => {
  if (!filter) return true

  return filter.$or.some((clause) => {
    const expiry = clause.reservationExpiresAt

    if (expiry === null) {
      return order.reservationExpiresAt == null && order._id > clause._id.$gt
    }
    if (expiry?.$type === 'date') return order.reservationExpiresAt instanceof Date
    if (expiry?.$gt) return order.reservationExpiresAt > expiry.$gt
    return order.reservationExpiresAt?.getTime() === expiry.getTime() && order._id > clause._id.$gt
  })
}

const compareCandidates = (left, right) => {
  const leftExpiry = left.reservationExpiresAt?.getTime() ?? Number.NEGATIVE_INFINITY
  const rightExpiry = right.reservationExpiresAt?.getTime() ?? Number.NEGATIVE_INFINITY
  return leftExpiry - rightExpiry || left._id.localeCompare(right._id)
}

const paginateCandidates = (orders, limit) => {
  const ordered = [...orders].sort(compareCandidates)
  const pages = []
  let cursor = null

  while (true) {
    const filter = reconciliationCursorFilter(cursor)
    const page = ordered.filter((order) => matchesCursorFilter(order, filter)).slice(0, limit)
    if (!page.length) return pages
    pages.push(page)
    cursor = page.at(-1)
  }
}

const makeClaimHarness = (overrides = {}) => {
  const state = {
    order: {
      _id: orderId,
      status: 'pending_payment',
      reservationExpiresAt: new Date('2026-10-09T13:00:00.000Z'),
      reconciliationNextAt: null,
      reconciliationLeaseOwner: null,
      reconciliationLeaseUntil: null,
      reconciliationAttempts: 0,
      reconciliationFailures: 0,
      ...overrides
    }
  }
  const isDue = (inputNow) => (
    (!state.order.reconciliationNextAt || state.order.reconciliationNextAt <= inputNow) &&
    (!state.order.reconciliationLeaseUntil || state.order.reconciliationLeaseUntil <= inputNow)
  )
  const owned = ({ ownerToken, now: inputNow }) => (
    state.order.status === 'pending_payment' &&
    state.order.reconciliationLeaseOwner === ownerToken &&
    state.order.reconciliationLeaseUntil > inputNow
  )
  const manager = {
    async claimForReconciliation(input) {
      if (state.order._id !== input.orderId || state.order.status !== 'pending_payment' || !isDue(input.now)) {
        return null
      }
      state.order.reconciliationLeaseOwner = input.ownerToken
      state.order.reconciliationLeaseUntil = input.leaseUntil
      state.order.reconciliationAttempts += 1
      return { ...state.order }
    },
    async renewReconciliationClaim(input) {
      if (!owned(input)) return null
      state.order.reconciliationLeaseUntil = input.leaseUntil
      return { ...state.order }
    },
    async assertReconciliationOwnership(input) {
      return owned(input) ? { ...state.order } : null
    },
    async releaseReconciliationClaim({ ownerToken }) {
      if (state.order.reconciliationLeaseOwner !== ownerToken) return null
      state.order.reconciliationLeaseOwner = null
      state.order.reconciliationLeaseUntil = null
      return { ...state.order }
    },
    async scheduleNextReconciliation(input) {
      if (!owned(input)) return null
      state.order.reconciliationNextAt = input.nextAt
      return { ...state.order }
    },
    async markReconciliationFailure(input) {
      if (!owned(input)) return null
      state.order.reconciliationNextAt = input.nextAt
      state.order.reconciliationFailures += 1
      return { ...state.order }
    }
  }
  const service = new OrderReconciliationClaimService({ orderManager: manager })
  return { service, state }
}

describe('Order reconciliation distributed claim foundation (isolated)', () => {
  const restorations = []

  afterEach(() => {
    while (restorations.length) restorations.pop()()
  })

  const stub = (target, property, replacement) => {
    const original = target[property]
    restorations.push(() => { target[property] = original })
    target[property] = replacement
  }

  it('claims an available pending Order for exactly 60 seconds and increments once', async () => {
    const { service, state } = makeClaimHarness()
    const result = await service.claim(orderId, { now, ownerToken: 'owner-a' })

    assert.equal(result.ownerToken, 'owner-a')
    assert.equal(state.order.reconciliationAttempts, 1)
    assert.equal(
      state.order.reconciliationLeaseUntil.toISOString(),
      new Date(now.getTime() + RECONCILIATION_LEASE_MS).toISOString()
    )
  })

  it('does not claim a non-pending Order or an Order with a live lease', async () => {
    const nonPending = makeClaimHarness({ status: 'paid' })
    const leased = makeClaimHarness({
      reconciliationLeaseOwner: 'owner-a',
      reconciliationLeaseUntil: new Date(now.getTime() + 1000)
    })

    assert.equal(await nonPending.service.claim(orderId, { now, ownerToken: 'owner-b' }), null)
    assert.equal(await leased.service.claim(orderId, { now, ownerToken: 'owner-b' }), null)
  })

  it('does not claim an Order scheduled for the future', async () => {
    const { service, state } = makeClaimHarness({
      reconciliationNextAt: new Date(now.getTime() + 1000)
    })

    assert.equal(await service.claim(orderId, { now, ownerToken: 'owner-a' }), null)
    assert.equal(state.order.reconciliationAttempts, 0)
  })

  it('takes over an expired lease and allows only one of two owners', async () => {
    const { service, state } = makeClaimHarness({
      reconciliationLeaseOwner: 'stale-owner',
      reconciliationLeaseUntil: new Date(now.getTime() - 1)
    })

    const first = await service.claim(orderId, { now, ownerToken: 'owner-a' })
    const second = await service.claim(orderId, { now, ownerToken: 'owner-b' })

    assert.equal(first.ownerToken, 'owner-a')
    assert.equal(second, null)
    assert.equal(state.order.reconciliationLeaseOwner, 'owner-a')
    assert.equal(state.order.reconciliationAttempts, 1)
  })

  it('fences every stale-owner operation after an expired lease is taken over', async () => {
    const { service, state } = makeClaimHarness()
    await service.claim(orderId, { now, ownerToken: 'worker-a' })
    const takeoverAt = new Date(now.getTime() + RECONCILIATION_LEASE_MS + 1)
    const nextAt = new Date(takeoverAt.getTime() + 5 * 60 * 1000)
    const takeover = await service.claim(orderId, {
      now: takeoverAt,
      ownerToken: 'worker-b'
    })

    assert.equal(takeover.ownerToken, 'worker-b')
    assert.equal(await service.renew(orderId, 'worker-a', { now: takeoverAt }), null)
    assert.equal(
      await service.scheduleNext(orderId, 'worker-a', nextAt, { now: takeoverAt }),
      null
    )
    assert.equal(
      await service.markFailure(orderId, 'worker-a', nextAt, { now: takeoverAt }),
      null
    )
    await assert.rejects(
      service.assertOwnership(orderId, 'worker-a', { now: takeoverAt }),
      (error) => error.code === 'RECONCILIATION_CLAIM_LOST'
    )
    assert.equal(await service.release(orderId, 'worker-a'), null)
    assert.equal(state.order.reconciliationLeaseOwner, 'worker-b')
    assert.equal(state.order.reconciliationNextAt, null)
    assert.equal(state.order.reconciliationFailures, 0)
    assert.equal(state.order.reconciliationAttempts, 2)
  })

  it('prevents stale release and lets the current owner release', async () => {
    const { service, state } = makeClaimHarness()
    await service.claim(orderId, { now, ownerToken: 'owner-a' })

    assert.equal(await service.release(orderId, 'owner-b'), null)
    assert.equal(state.order.reconciliationLeaseOwner, 'owner-a')
    assert.ok(await service.release(orderId, 'owner-a'))
    assert.equal(state.order.reconciliationLeaseOwner, null)
  })

  it('renews only the current live owner and fences an incorrect owner', async () => {
    const { service, state } = makeClaimHarness()
    await service.claim(orderId, { now, ownerToken: 'owner-a' })
    const renewAt = new Date(now.getTime() + 5000)

    assert.equal(await service.renew(orderId, 'owner-b', { now: renewAt }), null)
    const renewed = await service.renew(orderId, 'owner-a', { now: renewAt })
    assert.equal(
      renewed.reconciliationLeaseUntil.toISOString(),
      new Date(renewAt.getTime() + RECONCILIATION_LEASE_MS).toISOString()
    )

    await assert.rejects(
      service.assertOwnership(orderId, 'owner-b', { now: renewAt }),
      (error) => error.code === 'RECONCILIATION_CLAIM_LOST'
    )
    assert.equal(state.order.reconciliationLeaseOwner, 'owner-a')
  })

  it('schedules the next attempt and records a failure only for the live owner', async () => {
    const { service, state } = makeClaimHarness()
    await service.claim(orderId, { now, ownerToken: 'owner-a' })
    const nextAt = new Date(now.getTime() + 5 * 60 * 1000)

    assert.equal(await service.scheduleNext(orderId, 'owner-b', nextAt, { now }), null)
    await service.scheduleNext(orderId, 'owner-a', nextAt, { now })
    await service.markFailure(orderId, 'owner-a', nextAt, { now })

    assert.equal(state.order.reconciliationNextAt.toISOString(), nextAt.toISOString())
    assert.equal(state.order.reconciliationFailures, 1)
  })

  it('requires a candidate limit and emits cursor ordering without skip', async () => {
    const manager = new OrderManager()
    let captured
    const query = {
      sort(value) { captured.sort = value; return this },
      limit(value) { captured.limit = value; return this },
      lean: async () => []
    }

    stub(OrderModel, 'find', (filter) => {
      captured = { filter }
      return query
    })

    await assert.rejects(
      manager.findReconciliationCandidates({ now }),
      /limit es obligatorio/
    )

    await manager.findReconciliationCandidates({ now, limit: 25 })
    assert.deepEqual(captured.sort, { reservationExpiresAt: 1, _id: 1 })
    assert.equal(captured.limit, 25)
    assert.equal(JSON.stringify(captured.filter).includes('pending_payment'), true)
    assert.equal(JSON.stringify(captured.filter).includes('reconciliationNextAt'), true)
    assert.equal(JSON.stringify(captured.filter).includes('$exists'), true)
    assert.equal(Object.hasOwn(query, 'skip'), false)
  })

  it('uses _id as the keyset tiebreaker for equal reservation expiration', () => {
    const expiry = new Date('2026-10-09T13:00:00.000Z')
    const filter = reconciliationCursorFilter({
      _id: '000000000000000000000010',
      reservationExpiresAt: expiry
    })

    assert.deepEqual(filter, {
      $or: [
        { reservationExpiresAt: { $gt: expiry } },
        {
          reservationExpiresAt: expiry,
          _id: { $gt: '000000000000000000000010' }
        }
      ]
    })
  })

  it('paginates null, missing and equal-date candidates once without gaps', () => {
    const firstDate = new Date('2026-10-09T13:00:00.000Z')
    const secondDate = new Date('2026-10-09T14:00:00.000Z')
    const orders = [
      { _id: '000000000000000000000001', reservationExpiresAt: null },
      { _id: '000000000000000000000002' },
      { _id: '000000000000000000000003', reservationExpiresAt: null },
      { _id: '000000000000000000000004', reservationExpiresAt: firstDate },
      { _id: '000000000000000000000005', reservationExpiresAt: firstDate },
      { _id: '000000000000000000000006', reservationExpiresAt: secondDate }
    ]
    const pages = paginateCandidates(orders, 2)
    const ids = pages.flat().map(({ _id }) => _id)

    assert.deepEqual(pages.map((page) => page.length), [2, 2, 2])
    assert.deepEqual(ids, orders.map(({ _id }) => _id))
    assert.equal(new Set(ids).size, orders.length)
    assert.equal(pages[1][1].reservationExpiresAt, firstDate)
  })

  it('builds acquire/renew/release as owner-fenced CAS writes', async () => {
    const manager = new OrderManager()
    const captures = []
    stub(OrderModel, 'findOneAndUpdate', (filter, update, options) => {
      captures.push({ filter, update, options })
      return { lean: async () => ({ _id: orderId }) }
    })

    const leaseUntil = new Date(now.getTime() + RECONCILIATION_LEASE_MS)
    await manager.claimForReconciliation({ orderId, ownerToken: 'owner-a', now, leaseUntil })
    await manager.renewReconciliationClaim({ orderId, ownerToken: 'owner-a', now, leaseUntil })
    await manager.releaseReconciliationClaim({ orderId, ownerToken: 'owner-a' })

    assert.equal(captures[0].update.$inc.reconciliationAttempts, 1)
    assert.equal(JSON.stringify(captures[0].filter).includes('reconciliationLeaseUntil'), true)
    assert.equal(captures[1].filter.reconciliationLeaseOwner, 'owner-a')
    assert.deepEqual(captures[1].filter.reconciliationLeaseUntil, { $gt: now })
    assert.deepEqual(captures[2].filter, {
      _id: orderId,
      reconciliationLeaseOwner: 'owner-a'
    })
    assert.equal(captures[2].update.$set.reconciliationLeaseOwner, null)
    assert.equal(captures.every(({ options }) => options.runValidators === true), true)
  })
})
