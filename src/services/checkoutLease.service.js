import { randomUUID } from 'node:crypto'
import mongoose from 'mongoose'
import CheckoutLeaseManager from '../dao/managers/checkoutLease.manager.js'
import { ServiceError } from './service.products.js'

const CHECKOUT_LEASE_DURATION_MS = 60 * 1000
const CHECKOUT_LEASE_HEARTBEAT_MS = 15 * 1000

class CheckoutLeaseService {
  constructor({
    checkoutLeaseManager = CheckoutLeaseManager,
    uuidFactory = randomUUID,
    leaseDurationMs = CHECKOUT_LEASE_DURATION_MS,
    heartbeatIntervalMs = CHECKOUT_LEASE_HEARTBEAT_MS,
    setIntervalFn = setInterval,
    clearIntervalFn = clearInterval
  } = {}) {
    this.leases = checkoutLeaseManager
    this.uuidFactory = uuidFactory
    this.leaseDurationMs = leaseDurationMs
    this.heartbeatIntervalMs = heartbeatIntervalMs
    this.setIntervalFn = setIntervalFn
    this.clearIntervalFn = clearIntervalFn
  }

  #normalizeNow(value) {
    const now = new Date(value)

    if (Number.isNaN(now.getTime())) {
      throw new ServiceError('Fecha de checkout inválida', 'CHECKOUT_INVALID_DATE', 400)
    }

    return now
  }

  #assertUserId(userId) {
    if (!mongoose.Types.ObjectId.isValid(userId)) {
      throw new ServiceError('ID de usuario inválido', 'INVALID_USER_ID', 400)
    }
  }

  #isDuplicateKeyError(error) {
    return error?.code === 11000 || error?.errorResponse?.code === 11000
  }

  async acquire(userId, { now = new Date() } = {}) {
    this.#assertUserId(userId)
    const acquiredAt = this.#normalizeNow(now)
    const ownerToken = this.uuidFactory()
    const expiresAt = new Date(acquiredAt.getTime() + this.leaseDurationMs)

    try {
      const lease = await this.leases.acquire(userId, ownerToken, {
        now: acquiredAt,
        expiresAt
      })

      if (!lease || lease.ownerToken !== ownerToken) {
        throw new ServiceError(
          'Ya hay un checkout en curso para esta cuenta',
          'CHECKOUT_IN_PROGRESS',
          409
        )
      }

      return { userId: String(userId), ownerToken, expiresAt }
    } catch (error) {
      if (error instanceof ServiceError) throw error

      if (this.#isDuplicateKeyError(error)) {
        throw new ServiceError(
          'Ya hay un checkout en curso para esta cuenta',
          'CHECKOUT_IN_PROGRESS',
          409
        )
      }

      throw new ServiceError(
        'No se pudo proteger el inicio del checkout',
        'CHECKOUT_LOCK_UNAVAILABLE',
        503
      )
    }
  }

  async renew(lease, { now = new Date(), session } = {}) {
    if (!lease?.userId || !lease?.ownerToken) {
      throw new ServiceError(
        'No existe una protección válida para el checkout',
        'CHECKOUT_IN_PROGRESS',
        409
      )
    }

    const renewedAt = this.#normalizeNow(now)
    const expiresAt = new Date(renewedAt.getTime() + this.leaseDurationMs)
    const renewed = await this.leases.renew(lease.userId, lease.ownerToken, {
      now: renewedAt,
      expiresAt,
      session
    })

    if (!renewed) {
      throw new ServiceError(
        'El checkout perdió su turno de procesamiento',
        'CHECKOUT_IN_PROGRESS',
        409
      )
    }

    lease.expiresAt = expiresAt
    return lease
  }

  #toLockLostError(cause) {
    return new ServiceError(
      'El checkout perdió su protección de concurrencia',
      'CHECKOUT_LOCK_LOST',
      409,
      { cause: cause?.code || 'LEASE_OWNERSHIP_LOST' }
    )
  }

  async assertOwnership(lease, { now = new Date() } = {}) {
    try {
      return await this.renew(lease, { now })
    } catch (error) {
      if (error?.code === 'CHECKOUT_LOCK_LOST') throw error
      throw this.#toLockLostError(error)
    }
  }

  startHeartbeat(lease) {
    let stopped = false
    let lostError = null
    let inFlight = null

    const pulse = async () => {
      if (lostError) return false
      if (inFlight) return inFlight
      if (stopped) return false

      inFlight = this.assertOwnership(lease)
        .then(() => true)
        .catch((error) => {
          lostError = error?.code === 'CHECKOUT_LOCK_LOST'
            ? error
            : this.#toLockLostError(error)
          return false
        })
        .finally(() => {
          inFlight = null
        })

      return inFlight
    }

    const timer = this.setIntervalFn(() => {
      pulse().catch(() => {})
    }, this.heartbeatIntervalMs)
    timer?.unref?.()

    return {
      assertOwnership: async () => {
        if (lostError) throw lostError
        const owned = await pulse()
        if (!owned) throw lostError || this.#toLockLostError()
        return lease
      },
      isLost: () => Boolean(lostError),
      stop: async () => {
        stopped = true
        this.clearIntervalFn(timer)
        if (inFlight) await inFlight
      }
    }
  }

  async release(lease) {
    if (!lease?.userId || !lease?.ownerToken) return false
    const result = await this.leases.release(lease.userId, lease.ownerToken)
    return result?.deletedCount === 1
  }
}

export {
  CheckoutLeaseService,
  CHECKOUT_LEASE_DURATION_MS,
  CHECKOUT_LEASE_HEARTBEAT_MS
}
export default new CheckoutLeaseService()
