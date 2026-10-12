import OrderManager from '../dao/managers/order.manager.js'
import PaymentManager from '../dao/managers/payment.manager.js'
import env from '../config.js'
import logger from '../utils/logger.js'
import MercadoPagoReconciliationService from './mercadoPagoReconciliation.service.js'
import OrderReconciliationClaimService from './orderReconciliationClaim.service.js'
import { REMOTE_ORDER_CLASSIFICATIONS } from './mercadoPagoOrderClassification.service.js'

const MINUTE_MS = 60 * 1000
const HOUR_MS = 60 * MINUTE_MS

const WORKER_OUTCOMES = Object.freeze({
  PAID: 'paid',
  REQUIRES_ATTENTION: 'requires_attention',
  STILL_PENDING: 'still_pending',
  PROVIDER_UNAVAILABLE: 'provider_unavailable',
  UNCERTAIN: 'uncertain',
  TERMINAL_UNPAID: 'terminal_unpaid_observed',
  IGNORED: 'ignored',
  CLAIM_LOST: 'claim_lost',
  CLAIM_RELEASE_FAILED: 'claim_release_failed',
  ERROR: 'error'
})

const asDate = (value, fallback = null) => {
  const date = new Date(value)
  return Number.isNaN(date.getTime()) ? fallback : date
}

const positiveInteger = (value, fallback, field) => {
  const parsed = Number(value ?? fallback)
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new TypeError(`${field} debe ser un entero positivo`)
  }
  return parsed
}

const calculateCandidateLimit = ({ batchSize, maxOrders, candidates }) => (
  Math.min(batchSize, maxOrders - candidates)
)

const calculateNextReconciliationAt = ({ now, createdAt, reservationExpiresAt }) => {
  const checkedAt = asDate(now)
  if (!checkedAt) throw new TypeError('now debe ser una fecha valida')

  const created = asDate(createdAt, checkedAt)
  const expires = asDate(reservationExpiresAt)
  const lastThirtyMinutes = expires && expires.getTime() - checkedAt.getTime() <= 30 * MINUTE_MS
  const firstHour = checkedAt.getTime() - created.getTime() < HOUR_MS
  const delay = lastThirtyMinutes || firstHour ? 5 * MINUTE_MS : 15 * MINUTE_MS

  return new Date(checkedAt.getTime() + delay)
}

const calculateProviderFailureBackoffMs = (failureNumber) => {
  const attempt = Math.max(1, Number(failureNumber) || 1)
  return [5, 10, 20, 30][Math.min(attempt, 4) - 1] * MINUTE_MS
}

const isProviderUnavailable = (error) => {
  const status = Number(error?.status ?? error?.statusCode)
  return status === 429 || status >= 500 || [
    'MERCADOPAGO_UNAVAILABLE',
    'MERCADOPAGO_TIMEOUT',
    'MERCADOPAGO_RATE_LIMITED'
  ].includes(error?.code)
}

const noProviderOrderReason = (payment) => {
  if (!payment || !Object.hasOwn(payment, 'providerAttemptStatus')) {
    return 'LEGACY_PROVIDER_ATTEMPT_STATUS_MISSING'
  }
  if (payment.providerAttemptStatus === null) return 'NO_PROVIDER_ATTEMPT'
  return `PROVIDER_ATTEMPT_${String(payment.providerAttemptStatus).toUpperCase()}`
}

const runPool = async (items, concurrency, handler) => {
  let nextIndex = 0
  const workers = Array.from({ length: Math.min(concurrency, items.length) }, async () => {
    while (nextIndex < items.length) {
      const item = items[nextIndex]
      nextIndex += 1
      await handler(item)
    }
  })
  await Promise.all(workers)
}

class PaymentReconciliationWorkerService {
  constructor({
    orderManager = OrderManager,
    paymentManager = PaymentManager,
    claimService = OrderReconciliationClaimService,
    reconciliationService = MercadoPagoReconciliationService,
    clock = () => new Date(),
    workerConfig = env.paymentReconciliation,
    log = (message, metadata) => logger.info(`${message} ${JSON.stringify(metadata)}`)
  } = {}) {
    this.orders = orderManager
    this.payments = paymentManager
    this.claims = claimService
    this.reconciliation = reconciliationService
    this.clock = clock
    this.config = workerConfig
    this.log = log
  }

  #now() {
    const now = asDate(this.clock())
    if (!now) throw new TypeError('El clock del worker devolvio una fecha invalida')
    return now
  }

  #logOrder(runId, order, outcome, startedAt, extra = {}) {
    this.log('payment_reconciliation_order', {
      runId,
      orderNumber: order?.orderNumber || null,
      outcome,
      durationMs: Math.max(0, this.#now().getTime() - startedAt.getTime()),
      attemptNumber: order?.reconciliationAttempts ?? null,
      reservationExpiresAt: asDate(order?.reservationExpiresAt)?.toISOString() || null,
      ...extra
    })
  }

  async #schedule(order, ownerToken, { providerSucceeded }) {
    const now = this.#now()
    const nextAt = calculateNextReconciliationAt({
      now,
      createdAt: order.createdAt,
      reservationExpiresAt: order.reservationExpiresAt
    })
    const scheduled = providerSucceeded
      ? await this.claims.scheduleSuccess(order._id, ownerToken, nextAt, { now })
      : await this.claims.scheduleNext(order._id, ownerToken, nextAt, { now })

    return scheduled ? nextAt : null
  }

  async #markProviderFailure(order, ownerToken) {
    const now = this.#now()
    const failureNumber = Number(order.reconciliationFailures || 0) + 1
    const nextAt = new Date(now.getTime() + calculateProviderFailureBackoffMs(failureNumber))
    const marked = await this.claims.markFailure(order._id, ownerToken, nextAt, { now })
    return marked ? { failureNumber, nextAt } : null
  }

  async #processClaimedOrder(order, ownerToken) {
    const current = await this.orders.getById(order._id)
    if (!current || ['paid', 'requires_attention'].includes(current.status)) {
      return { outcome: WORKER_OUTCOMES.IGNORED, order: current || order }
    }

    await this.claims.assertOwnership(order._id, ownerToken, { now: this.#now() })
    const payment = await this.payments.getLatestByOrderId(order._id)

    if (!payment) {
      const nextAt = await this.#schedule(current, ownerToken, { providerSucceeded: false })
      if (!nextAt) return { outcome: WORKER_OUTCOMES.CLAIM_LOST, order: current }
      return {
        outcome: WORKER_OUTCOMES.UNCERTAIN,
        reason: 'PAYMENT_MISSING',
        order: current,
        nextAt
      }
    }

    if (payment.normalizedStatus === 'approved') {
      const latest = await this.orders.getById(order._id)
      if (latest && ['paid', 'requires_attention'].includes(latest.status)) {
        return { outcome: WORKER_OUTCOMES.IGNORED, order: latest }
      }
      const nextAt = await this.#schedule(current, ownerToken, { providerSucceeded: false })
      if (!nextAt) return { outcome: WORKER_OUTCOMES.CLAIM_LOST, order: current }
      return {
        outcome: WORKER_OUTCOMES.UNCERTAIN,
        reason: 'LOCAL_PAYMENT_APPROVED_ORDER_PENDING',
        order: current,
        nextAt
      }
    }

    const providerOrderId = String(payment.providerOrderId || '').trim()
    if (payment.normalizedStatus !== 'pending' || !providerOrderId) {
      const nextAt = await this.#schedule(current, ownerToken, { providerSucceeded: false })
      if (!nextAt) return { outcome: WORKER_OUTCOMES.CLAIM_LOST, order: current }
      return {
        outcome: WORKER_OUTCOMES.UNCERTAIN,
        reason: providerOrderId
          ? `LOCAL_PAYMENT_${String(payment.normalizedStatus).toUpperCase()}`
          : noProviderOrderReason(payment),
        order: current,
        nextAt
      }
    }

    const renewed = await this.claims.renew(order._id, ownerToken, { now: this.#now() })
    if (!renewed) return { outcome: WORKER_OUTCOMES.CLAIM_LOST, order: current }

    let result
    try {
      result = await this.reconciliation.reconcileProviderOrder(providerOrderId, {
        now: this.#now()
      })
    } catch (error) {
      try {
        await this.claims.assertOwnership(order._id, ownerToken, { now: this.#now() })
      } catch (claimError) {
        if (claimError?.code === 'RECONCILIATION_CLAIM_LOST') {
          return { outcome: WORKER_OUTCOMES.CLAIM_LOST, order: current }
        }
        throw claimError
      }

      const failure = await this.#markProviderFailure(current, ownerToken)
      if (!failure) return { outcome: WORKER_OUTCOMES.CLAIM_LOST, order: current }
      return {
        outcome: isProviderUnavailable(error)
          ? WORKER_OUTCOMES.PROVIDER_UNAVAILABLE
          : WORKER_OUTCOMES.ERROR,
        code: error?.code || 'PAYMENT_RECONCILIATION_FAILED',
        order: current,
        ...failure
      }
    }

    if (result.outcome === 'paid') {
      return { outcome: WORKER_OUTCOMES.PAID, order: current }
    }
    if (result.outcome === 'requires_attention') {
      return { outcome: WORKER_OUTCOMES.REQUIRES_ATTENTION, order: current }
    }

    try {
      await this.claims.assertOwnership(order._id, ownerToken, { now: this.#now() })
    } catch (error) {
      if (error?.code === 'RECONCILIATION_CLAIM_LOST') {
        return { outcome: WORKER_OUTCOMES.CLAIM_LOST, order: current }
      }
      throw error
    }

    const nextAt = await this.#schedule(current, ownerToken, { providerSucceeded: true })
    if (!nextAt) return { outcome: WORKER_OUTCOMES.CLAIM_LOST, order: current }

    if (result.outcome === 'ignored') {
      return { outcome: WORKER_OUTCOMES.IGNORED, order: current, nextAt }
    }
    if (result.remoteClassification === REMOTE_ORDER_CLASSIFICATIONS.TERMINAL_UNPAID) {
      return { outcome: WORKER_OUTCOMES.TERMINAL_UNPAID, order: current, nextAt }
    }
    return { outcome: WORKER_OUTCOMES.STILL_PENDING, order: current, nextAt }
  }

  async #processCandidate(candidate, runId) {
    const startedAt = this.#now()
    let claim = null
    let lostClaim = false
    let result = null
    let primaryErrorCode = null
    let releaseFailed = false
    try {
      claim = await this.claims.claim(candidate._id, { now: startedAt })
      if (!claim) return { claimed: false, outcome: WORKER_OUTCOMES.IGNORED }

      result = await this.#processClaimedOrder(claim.order, claim.ownerToken)
      lostClaim = result.outcome === WORKER_OUTCOMES.CLAIM_LOST
      this.#logOrder(runId, result.order || claim.order, result.outcome, startedAt, {
        reason: result.reason || null,
        nextAt: result.nextAt?.toISOString() || null,
        failureNumber: result.failureNumber || null,
        code: result.code || null
      })
      result = { claimed: true, ...result }
    } catch (error) {
      lostClaim = error?.code === 'RECONCILIATION_CLAIM_LOST'
      const outcome = lostClaim ? WORKER_OUTCOMES.CLAIM_LOST : WORKER_OUTCOMES.ERROR
      primaryErrorCode = error?.code || 'PAYMENT_RECONCILIATION_FAILED'
      this.#logOrder(runId, claim?.order || candidate, outcome, startedAt, {
        code: primaryErrorCode
      })
      result = {
        claimed: Boolean(claim),
        outcome,
        order: claim?.order || candidate,
        code: primaryErrorCode
      }
    } finally {
      if (claim && !lostClaim) {
        try {
          await this.claims.release(candidate._id, claim.ownerToken)
        } catch (error) {
          releaseFailed = true
          this.#logOrder(
            runId,
            result?.order || claim.order,
            WORKER_OUTCOMES.CLAIM_RELEASE_FAILED,
            startedAt,
            {
              code: error?.code || 'RECONCILIATION_CLAIM_RELEASE_FAILED',
              primaryCode: primaryErrorCode
            }
          )
        }
      }
    }

    return { ...result, releaseFailed }
  }

  async run({
    now = this.#now(),
    runId,
    maxOrders = this.config.maxOrdersPerRun,
    batchSize = this.config.batchSize,
    concurrency = this.config.concurrency
  } = {}) {
    const startedAt = asDate(now)
    if (!startedAt) throw new TypeError('now debe ser una fecha valida')
    const normalizedRunId = String(runId || '').trim()
    if (!normalizedRunId) throw new TypeError('runId es obligatorio')

    const max = positiveInteger(maxOrders, 100, 'maxOrders')
    const batch = positiveInteger(batchSize, 20, 'batchSize')
    const parallelism = Math.min(2, positiveInteger(concurrency, 2, 'concurrency'))
    const summary = {
      runId: normalizedRunId,
      startedAt: startedAt.toISOString(),
      durationMs: 0,
      candidates: 0,
      claimed: 0,
      processed: 0,
      paid: 0,
      requiresAttention: 0,
      stillPending: 0,
      providerUnavailable: 0,
      uncertain: 0,
      terminalUnpaid: 0,
      ignored: 0,
      claimLost: 0,
      claimReleaseFailures: 0,
      errors: 0
    }
    const summaryField = {
      [WORKER_OUTCOMES.PAID]: 'paid',
      [WORKER_OUTCOMES.REQUIRES_ATTENTION]: 'requiresAttention',
      [WORKER_OUTCOMES.STILL_PENDING]: 'stillPending',
      [WORKER_OUTCOMES.PROVIDER_UNAVAILABLE]: 'providerUnavailable',
      [WORKER_OUTCOMES.UNCERTAIN]: 'uncertain',
      [WORKER_OUTCOMES.TERMINAL_UNPAID]: 'terminalUnpaid',
      [WORKER_OUTCOMES.IGNORED]: 'ignored',
      [WORKER_OUTCOMES.CLAIM_LOST]: 'claimLost',
      [WORKER_OUTCOMES.ERROR]: 'errors'
    }
    let cursor = null

    while (summary.candidates < max) {
      const queryLimit = calculateCandidateLimit({
        batchSize: batch,
        maxOrders: max,
        candidates: summary.candidates
      })
      const candidates = await this.claims.findCandidates({
        now: startedAt,
        limit: queryLimit,
        afterCursor: cursor
      })
      if (!candidates.length) break

      const stableCandidates = candidates.map((candidate) => ({ ...candidate }))
      const last = stableCandidates.at(-1)
      cursor = {
        _id: last._id,
        reservationExpiresAt: last.reservationExpiresAt ?? null
      }
      summary.candidates += stableCandidates.length

      await runPool(stableCandidates, parallelism, async (candidate) => {
        const result = await this.#processCandidate(candidate, normalizedRunId)
        if (result.claimed) {
          summary.claimed += 1
          summary.processed += 1
        }
        if (result.releaseFailed) summary.claimReleaseFailures += 1
        summary[summaryField[result.outcome]] += 1
      })

      if (stableCandidates.length < queryLimit) break
    }

    summary.durationMs = Math.max(0, this.#now().getTime() - startedAt.getTime())
    this.log('payment_reconciliation_run', summary)
    return summary
  }
}

export {
  PaymentReconciliationWorkerService,
  WORKER_OUTCOMES,
  calculateCandidateLimit,
  calculateNextReconciliationAt,
  calculateProviderFailureBackoffMs,
  isProviderUnavailable
}
export default new PaymentReconciliationWorkerService()
