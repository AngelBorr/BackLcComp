import { randomUUID } from 'node:crypto'
import mongoose from 'mongoose'
import OrderManager from '../dao/managers/order.manager.js'
import { ServiceError } from './service.products.js'

const RECONCILIATION_LEASE_MS = 60 * 1000

class OrderReconciliationClaimService {
  constructor({
    orderManager = OrderManager,
    uuidFactory = randomUUID,
    leaseMs = RECONCILIATION_LEASE_MS
  } = {}) {
    this.orders = orderManager
    this.uuidFactory = uuidFactory
    this.leaseMs = leaseMs
  }

  #date(value, field) {
    const date = new Date(value)
    if (Number.isNaN(date.getTime())) {
      throw new ServiceError(`${field} invalida`, 'INVALID_RECONCILIATION_DATE', 400)
    }
    return date
  }

  #orderId(orderId) {
    if (!mongoose.Types.ObjectId.isValid(orderId)) {
      throw new ServiceError('ID de order invalido', 'INVALID_ORDER_ID', 400)
    }
    return orderId
  }

  #owner(ownerToken) {
    const normalized = String(ownerToken || '').trim()
    if (!normalized || normalized.length > 128) {
      throw new ServiceError(
        'Owner de reconciliacion invalido',
        'INVALID_RECONCILIATION_OWNER',
        400
      )
    }
    return normalized
  }

  #leaseUntil(now) {
    if (!Number.isInteger(this.leaseMs) || this.leaseMs <= 0) {
      throw new ServiceError(
        'Duracion de lease invalida',
        'INVALID_RECONCILIATION_LEASE',
        500
      )
    }
    return new Date(now.getTime() + this.leaseMs)
  }

  findCandidates({ now = new Date(), limit, afterCursor = null }) {
    return this.orders.findReconciliationCandidates({
      now: this.#date(now, 'now'),
      limit,
      afterCursor
    })
  }

  async claim(orderId, { now = new Date(), ownerToken = this.uuidFactory() } = {}) {
    const claimedAt = this.#date(now, 'now')
    const owner = this.#owner(ownerToken)
    const order = await this.orders.claimForReconciliation({
      orderId: this.#orderId(orderId),
      ownerToken: owner,
      now: claimedAt,
      leaseUntil: this.#leaseUntil(claimedAt)
    })

    return order ? { order, ownerToken: owner } : null
  }

  renew(orderId, ownerToken, { now = new Date() } = {}) {
    const renewedAt = this.#date(now, 'now')
    return this.orders.renewReconciliationClaim({
      orderId: this.#orderId(orderId),
      ownerToken: this.#owner(ownerToken),
      now: renewedAt,
      leaseUntil: this.#leaseUntil(renewedAt)
    })
  }

  async assertOwnership(orderId, ownerToken, { now = new Date(), session } = {}) {
    const order = await this.orders.assertReconciliationOwnership(
      {
        orderId: this.#orderId(orderId),
        ownerToken: this.#owner(ownerToken),
        now: this.#date(now, 'now')
      },
      { session }
    )

    if (!order) {
      throw new ServiceError(
        'El claim de reconciliacion ya no pertenece al worker',
        'RECONCILIATION_CLAIM_LOST',
        409
      )
    }

    return order
  }

  release(orderId, ownerToken) {
    return this.orders.releaseReconciliationClaim({
      orderId: this.#orderId(orderId),
      ownerToken: this.#owner(ownerToken)
    })
  }

  scheduleNext(orderId, ownerToken, nextAt, { now = new Date() } = {}) {
    return this.orders.scheduleNextReconciliation({
      orderId: this.#orderId(orderId),
      ownerToken: this.#owner(ownerToken),
      now: this.#date(now, 'now'),
      nextAt: this.#date(nextAt, 'nextAt')
    })
  }

  markFailure(orderId, ownerToken, nextAt, { now = new Date() } = {}) {
    return this.orders.markReconciliationFailure({
      orderId: this.#orderId(orderId),
      ownerToken: this.#owner(ownerToken),
      now: this.#date(now, 'now'),
      nextAt: this.#date(nextAt, 'nextAt')
    })
  }
}

export { OrderReconciliationClaimService, RECONCILIATION_LEASE_MS }
export default new OrderReconciliationClaimService()
