/* eslint-env mocha */
import assert from 'node:assert/strict'
import mongoose from 'mongoose'
import { CheckoutLeaseService } from '../../src/services/checkoutLease.service.js'

const userId = new mongoose.Types.ObjectId().toString()
const start = new Date('2026-10-06T15:00:00.000Z')

const makeAtomicManager = () => {
  const records = new Map()
  const state = { renewCalls: 0 }

  return {
    records,
    state,
    async acquire(requestedUserId, ownerToken, { now, expiresAt }) {
      const key = String(requestedUserId)
      const current = records.get(key)

      if (current && current.expiresAt.getTime() > now.getTime()) {
        const duplicate = new Error('duplicate _id')
        duplicate.code = 11000
        throw duplicate
      }

      const lease = { _id: requestedUserId, ownerToken, expiresAt }
      records.set(key, lease)
      return lease
    },
    async renew(requestedUserId, ownerToken, { now, expiresAt }) {
      state.renewCalls += 1
      const key = String(requestedUserId)
      const current = records.get(key)

      if (
        !current ||
        current.ownerToken !== ownerToken ||
        current.expiresAt.getTime() <= now.getTime()
      ) return null

      const renewed = { ...current, expiresAt }
      records.set(key, renewed)
      return renewed
    },
    async release(requestedUserId, ownerToken) {
      const key = String(requestedUserId)
      const current = records.get(key)
      if (!current || current.ownerToken !== ownerToken) return { deletedCount: 0 }
      records.delete(key)
      return { deletedCount: 1 }
    }
  }
}

describe('CheckoutLeaseService CAS semantics (isolated unit tests)', () => {
  it('allows only one owner for concurrent acquisition attempts', async () => {
    const manager = makeAtomicManager()
    let sequence = 0
    const service = new CheckoutLeaseService({
      checkoutLeaseManager: manager,
      uuidFactory: () => `owner-${++sequence}`
    })

    const results = await Promise.allSettled([
      service.acquire(userId, { now: start }),
      service.acquire(userId, { now: start })
    ])

    assert.equal(results.filter(({ status }) => status === 'fulfilled').length, 1)
    const rejected = results.find(({ status }) => status === 'rejected')
    assert.equal(rejected.reason.code, 'CHECKOUT_IN_PROGRESS')
  })

  it('recovers an expired lease with a new owner', async () => {
    const manager = makeAtomicManager()
    let sequence = 0
    const service = new CheckoutLeaseService({
      checkoutLeaseManager: manager,
      uuidFactory: () => `owner-${++sequence}`,
      leaseDurationMs: 1000
    })
    const first = await service.acquire(userId, { now: start })
    const second = await service.acquire(userId, {
      now: new Date(start.getTime() + 1001)
    })

    assert.notEqual(second.ownerToken, first.ownerToken)
    assert.equal(manager.records.get(userId).ownerToken, second.ownerToken)
  })

  it('does not let an old worker release another owner lease', async () => {
    const manager = makeAtomicManager()
    let sequence = 0
    const service = new CheckoutLeaseService({
      checkoutLeaseManager: manager,
      uuidFactory: () => `owner-${++sequence}`,
      leaseDurationMs: 1000
    })
    const first = await service.acquire(userId, { now: start })
    const second = await service.acquire(userId, {
      now: new Date(start.getTime() + 1001)
    })

    assert.equal(await service.release(first), false)
    assert.equal(manager.records.get(userId).ownerToken, second.ownerToken)
    assert.equal(await service.release(second), true)
    assert.equal(manager.records.has(userId), false)
  })

  it('refuses renewal after the lease was replaced', async () => {
    const manager = makeAtomicManager()
    let sequence = 0
    const service = new CheckoutLeaseService({
      checkoutLeaseManager: manager,
      uuidFactory: () => `owner-${++sequence}`,
      leaseDurationMs: 1000
    })
    const first = await service.acquire(userId, { now: start })
    await service.acquire(userId, { now: new Date(start.getTime() + 1001) })

    await assert.rejects(
      service.renew(first, { now: new Date(start.getTime() + 1002) }),
      (error) => error.code === 'CHECKOUT_IN_PROGRESS'
    )
  })

  it('renews an active lease through the heartbeat without overlapping ownership', async () => {
    const manager = makeAtomicManager()
    const acquiredAt = new Date()
    let scheduledPulse
    let cleared = false
    const timer = { unrefCalled: false, unref() { this.unrefCalled = true } }
    const service = new CheckoutLeaseService({
      checkoutLeaseManager: manager,
      uuidFactory: () => 'heartbeat-owner',
      leaseDurationMs: 60_000,
      heartbeatIntervalMs: 15_000,
      setIntervalFn(callback, intervalMs) {
        scheduledPulse = callback
        assert.equal(intervalMs, 15_000)
        return timer
      },
      clearIntervalFn(receivedTimer) {
        assert.equal(receivedTimer, timer)
        cleared = true
      }
    })
    const lease = await service.acquire(userId, { now: acquiredAt })
    const firstExpiration = lease.expiresAt.getTime()
    const heartbeat = service.startHeartbeat(lease)

    scheduledPulse()
    await heartbeat.assertOwnership()

    assert.equal(timer.unrefCalled, true)
    assert.equal(heartbeat.isLost(), false)
    assert.equal(manager.state.renewCalls, 1)
    assert.ok(lease.expiresAt.getTime() >= firstExpiration)

    await heartbeat.stop()
    assert.equal(cleared, true)
  })

  it('fences a stale owner after another worker takes over an expired lease', async () => {
    const manager = makeAtomicManager()
    let sequence = 0
    let scheduledPulse
    const service = new CheckoutLeaseService({
      checkoutLeaseManager: manager,
      uuidFactory: () => `owner-${++sequence}`,
      leaseDurationMs: 20,
      heartbeatIntervalMs: 5,
      setIntervalFn(callback) {
        scheduledPulse = callback
        return { unref() {} }
      },
      clearIntervalFn() {}
    })
    const acquiredAt = new Date()
    const first = await service.acquire(userId, { now: acquiredAt })
    const second = await service.acquire(userId, {
      now: new Date(acquiredAt.getTime() + 21)
    })
    const heartbeat = service.startHeartbeat(first)

    scheduledPulse()
    await assert.rejects(
      heartbeat.assertOwnership(),
      (error) => error.code === 'CHECKOUT_LOCK_LOST'
    )
    assert.equal(heartbeat.isLost(), true)
    assert.equal(await service.release(first), false)
    assert.equal(manager.records.get(userId).ownerToken, second.ownerToken)

    await heartbeat.stop()
  })
})
