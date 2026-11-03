import mongoose from 'mongoose'
import { randomUUID } from 'node:crypto'
import OrderManager from '../dao/managers/order.manager.js'
import OrderAttentionResolutionManager from '../dao/managers/orderAttentionResolution.manager.js'
import OrderItemManager from '../dao/managers/orderItem.manager.js'
import PaymentManager from '../dao/managers/payment.manager.js'
import ProductUnitManager from '../dao/managers/productUnit.manager.js'
import { toMinorUnits } from '../utils/commerceMoney.js'
import { error as logError } from '../utils/logger.js'
import MercadoPagoTerminalUnpaidEvidenceService, {
  ORDERS_API_TERMINAL_UNPAID,
  OWN_CANCELLATION_TERMINAL_UNPAID
} from './mercadoPagoTerminalUnpaidEvidence.service.js'
import { inspectReservationIntegrity } from './orderAttention.service.js'
import OrderAttentionResolutionService from './orderAttentionResolution.service.js'
import ProductUnitService from './productUnit.service.js'
import { ServiceError } from './service.products.js'

const TRANSACTION_OPTIONS = Object.freeze({
  readConcern: { level: 'snapshot' },
  writeConcern: { w: 'majority' }
})

const ACTION = 'close_terminal_unpaid'
const COMPLETION_REASON = 'ATTENTION_RESOLUTION_TERMINAL_UNPAID'
const ORDER_NUMBER_PATTERN = /^LC-\d{4}-\d{6,}$/
const ALLOWED_INITIAL_PAYMENT_STATUSES = new Set(['pending', 'requires_attention'])
const TERMINAL_UNPAID_PAYMENT_STATUSES = new Set(['rejected', 'cancelled', 'canceled'])

const asText = (value) => String(value ?? '').trim()
const lowerText = (value) => asText(value).toLowerCase()
const sameId = (left, right) => asText(left) !== '' && asText(left) === asText(right)
const decimalString = (value) => value == null ? null : String(value?.toString?.() ?? value)
const toPlainObject = (value) => typeof value?.toObject === 'function' ? value.toObject() : value

const validDate = (value) => {
  if (value == null) return null
  const date = new Date(value)
  return Number.isNaN(date.getTime()) ? null : date
}

const sameInstant = (left, right) => {
  if (left == null || right == null) return left == null && right == null
  const leftDate = validDate(left)
  const rightDate = validDate(right)
  return Boolean(leftDate && rightDate && leftDate.getTime() === rightDate.getTime())
}

const sameMoney = (left, right) => {
  if (left == null || right == null) return false
  try {
    return toMinorUnits(left) === toMinorUnits(right)
  } catch {
    return false
  }
}

const unitSnapshot = (unit) => ({
  productUnitId: unit._id || unit.productUnitId,
  serialNumber: asText(unit.serialNumber),
  status: asText(unit.status),
  productId: unit.productId || null,
  orderId: unit.orderId || null,
  orderItemId: unit.orderItemId || null,
  reservedByOrderId: unit.reservedByOrderId || null,
  reservedAt: validDate(unit.reservedAt),
  reservationExpiresAt: validDate(unit.reservationExpiresAt),
  soldByOrderId: unit.soldByOrderId || null,
  soldAt: validDate(unit.soldAt),
  isDeleted: unit.isDeleted === true
})

const sameUnitSnapshot = (current, previous) => (
  sameId(current._id || current.productUnitId, previous.productUnitId) &&
  asText(current.serialNumber) === asText(previous.serialNumber) &&
  asText(current.status) === asText(previous.status) &&
  sameId(current.productId, previous.productId) &&
  sameId(current.orderId, previous.orderId) &&
  sameId(current.orderItemId, previous.orderItemId) &&
  sameId(current.reservedByOrderId, previous.reservedByOrderId) &&
  sameInstant(current.reservedAt, previous.reservedAt) &&
  sameInstant(current.reservationExpiresAt, previous.reservationExpiresAt) &&
  current.soldByOrderId == null &&
  previous.soldByOrderId == null &&
  current.soldAt == null &&
  previous.soldAt == null &&
  (current.isDeleted === true) === (previous.isDeleted === true)
)

const exactUnitSnapshot = (units, previousUnits) => {
  if (units.length !== previousUnits.length) return false
  const currentById = new Map(units.map((unit) => [asText(unit._id), unit]))
  return previousUnits.every((previous) => {
    const current = currentById.get(asText(previous.productUnitId))
    return current && sameUnitSnapshot(current, previous)
  })
}

class OrderAttentionTerminalUnpaidService {
  constructor({
    mongooseInstance = mongoose,
    orderManager = OrderManager,
    orderItemManager = OrderItemManager,
    paymentManager = PaymentManager,
    productUnitManager = ProductUnitManager,
    productUnitService = ProductUnitService,
    resolutionManager = OrderAttentionResolutionManager,
    resolutionService = OrderAttentionResolutionService,
    evidenceService = MercadoPagoTerminalUnpaidEvidenceService,
    clock = () => new Date()
  } = {}) {
    this.mongoose = mongooseInstance
    this.orders = orderManager
    this.orderItems = orderItemManager
    this.payments = paymentManager
    this.productUnitManager = productUnitManager
    this.productUnits = productUnitService
    this.resolutions = resolutionManager
    this.resolutionService = resolutionService
    this.evidenceService = evidenceService
    this.clock = clock
  }

  #now() {
    const now = new Date(this.clock())
    if (Number.isNaN(now.getTime())) {
      throw new ServiceError('Fecha interna invalida', 'INVALID_ATTENTION_RESOLUTION_DATE', 500)
    }
    return now
  }

  #normalizeInput({ orderNumber, idempotencyKey, actorUserId, actorRole, note }) {
    const input = {
      orderNumber: asText(orderNumber).toUpperCase(),
      idempotencyKey: asText(idempotencyKey),
      actorUserId,
      actorRole: asText(actorRole).toUpperCase(),
      note: asText(note)
    }
    if (!ORDER_NUMBER_PATTERN.test(input.orderNumber)) {
      throw new ServiceError('Numero de orden invalido', 'INVALID_ORDER_NUMBER', 400)
    }
    if (!input.idempotencyKey || input.idempotencyKey.length > 128) {
      throw new ServiceError(
        'Idempotency-Key obligatorio e invalido',
        'ATTENTION_RESOLUTION_IDEMPOTENCY_KEY_REQUIRED',
        400
      )
    }
    if (!mongoose.Types.ObjectId.isValid(input.actorUserId)) {
      throw new ServiceError('Administrador no autenticado', 'ADMIN_UNAUTHENTICATED', 401)
    }
    if (!['ADMIN', 'SUPERADMIN'].includes(input.actorRole)) {
      throw new ServiceError('Acceso administrativo requerido', 'ORDERS_ADMIN_FORBIDDEN', 403)
    }
    if (input.note.length > 2000) {
      throw new ServiceError('Nota administrativa demasiado extensa', 'INVALID_ATTENTION_NOTE', 400)
    }
    return input
  }

  #version(order) {
    const version = order?.attentionResolutionVersion ?? 0
    if (!Number.isInteger(version) || version < 0) {
      throw new ServiceError(
        'Version de resolucion invalida',
        'ATTENTION_RESOLUTION_STATE_CONFLICT',
        409
      )
    }
    return version
  }

  #assertResolutionContract(resolution, input, order) {
    if (
      resolution.action !== ACTION ||
      !sameId(resolution.orderId, order._id) ||
      !sameId(resolution.actorUserId, input.actorUserId) ||
      asText(resolution.actorRole).toUpperCase() !== input.actorRole
    ) {
      throw new ServiceError(
        'La Idempotency-Key corresponde a otra resolucion',
        'ATTENTION_RESOLUTION_IDEMPOTENCY_CONFLICT',
        409
      )
    }
  }

  #completedResult(orderNumber, resolution, idempotent = true) {
    return {
      orderNumber,
      resolutionId: asText(resolution._id),
      resolutionStatus: resolution.status,
      action: resolution.action,
      outcome: resolution.finalResult?.outcome || 'completed',
      orderStatus: resolution.finalResult?.orderStatus || 'expired',
      paymentStatus: resolution.finalResult?.paymentStatus || 'cancelled',
      fulfillmentStatus: resolution.finalResult?.fulfillmentStatus || 'cancelled',
      attentionResolutionVersion:
        resolution.finalResult?.attentionResolutionVersion ?? null,
      releasedCount:
        resolution.finalResult?.releasedCount ?? resolution.finalProductUnits?.length ?? 0,
      idempotent
    }
  }

  #assertLocalPreflight({ order, payment, items, units, resolutions, now }) {
    const reservationExpiresAt = validDate(order.reservationExpiresAt)
    const totalArs = decimalString(order.totals?.totalArs)
    const amountArs = decimalString(payment?.amountArs)
    const currency = asText(payment?.currency).toUpperCase()
    const version = this.#version(order)
    const integrity = inspectReservationIntegrity({ order, orderItems: items, productUnits: units })

    if (order.status !== 'requires_attention') {
      throw new ServiceError(
        'La orden no esta en requires_attention',
        'ATTENTION_TERMINAL_UNPAID_NOT_ALLOWED',
        409
      )
    }
    if (asText(order.fulfillmentStatus) !== 'pending') {
      throw new ServiceError(
        'El fulfillment ya no puede cancelarse',
        'ATTENTION_TERMINAL_UNPAID_NOT_ALLOWED',
        409
      )
    }
    if (!payment || !sameId(payment.orderId, order._id)) {
      throw new ServiceError('El pago local no corresponde a la orden', 'ATTENTION_PAYMENT_STATE_CONFLICT', 409)
    }
    if (
      payment.provider !== 'mercado_pago' ||
      !ALLOWED_INITIAL_PAYMENT_STATUSES.has(payment.normalizedStatus) ||
      !asText(payment.providerOrderId) ||
      asText(payment.providerPaymentId) ||
      validDate(payment.approvedAt) ||
      !totalArs ||
      !amountArs ||
      !sameMoney(totalArs, amountArs) ||
      currency !== asText(order.paymentCurrency).toUpperCase() ||
      asText(payment.externalReference).toUpperCase() !== asText(order.orderNumber).toUpperCase()
    ) {
      throw new ServiceError(
        'La evidencia financiera local no permite cerrar la orden',
        'ATTENTION_PAYMENT_STATE_CONFLICT',
        409
      )
    }
    if (!reservationExpiresAt || reservationExpiresAt.getTime() > now.getTime()) {
      throw new ServiceError(
        'La reserva todavia no vencio o no tiene una expiracion valida',
        'ATTENTION_RESERVATION_NOT_EXPIRED',
        409
      )
    }
    if (!integrity.valid) {
      throw new ServiceError(
        'La reserva no es integra',
        'ATTENTION_RESERVATION_INTEGRITY_CONFLICT',
        409,
        { reason: integrity.reason }
      )
    }
    if (resolutions.some((resolution) => resolution?.status === 'completed')) {
      throw new ServiceError(
        'La orden ya posee una resolucion completada',
        'ATTENTION_ALREADY_RESOLVED',
        409
      )
    }

    return {
      providerOrderId: asText(payment.providerOrderId),
      totalArs,
      currency,
      version,
      reservationExpiresAt,
      integrity
    }
  }

  #previousState(order, payment, local) {
    return {
      orderStatus: order.status,
      paymentStatus: payment.normalizedStatus,
      fulfillmentStatus: order.fulfillmentStatus,
      attentionReason: asText(order.attentionReason),
      attentionResolutionVersion: local.version,
      paymentApprovedAt: validDate(payment.approvedAt),
      paymentLastProviderCheckAt: validDate(payment.lastProviderCheckAt),
      paymentProviderOrderId: asText(payment.providerOrderId),
      paymentProviderPaymentId: asText(payment.providerPaymentId) || null,
      paymentExternalReference: asText(payment.externalReference),
      paymentAmountArs: decimalString(payment.amountArs),
      paymentCurrency: asText(payment.currency),
      paymentProviderStatus: payment.providerStatus ?? null,
      paymentProviderStatusDetail: payment.providerStatusDetail ?? null,
      providerCancellationPayableStatus: payment.providerCancellationPayableStatus ?? null,
      providerCancellationPayableObservedAt:
        validDate(payment.providerCancellationPayableObservedAt),
      providerCancellationIdempotencyKey:
        payment.providerCancellationIdempotencyKey ?? null,
      providerCancellationAttemptedAt: validDate(payment.providerCancellationAttemptedAt),
      providerCancellationStatus: payment.providerCancellationStatus ?? null,
      providerCancellationCompletedAt: validDate(payment.providerCancellationCompletedAt),
      reservationExpiresAt: local.reservationExpiresAt,
      reconciliationNextAt: validDate(order.reconciliationNextAt),
      reconciliationLeaseOwner: order.reconciliationLeaseOwner ?? null,
      reconciliationLeaseUntil: validDate(order.reconciliationLeaseUntil)
    }
  }

  async #prepareResolution(input, order) {
    const [items, payment, units, resolutions] = await Promise.all([
      this.orderItems.getByOrderId(order._id),
      this.payments.getLatestByOrderId(order._id),
      this.productUnitManager.getRelatedByOrderId(order._id),
      this.resolutions.getOrderResolutionHistory(order._id)
    ])
    const local = this.#assertLocalPreflight({
      order,
      payment,
      items,
      units,
      resolutions,
      now: this.#now()
    })
    const providerEvidence = await this.evidenceService.getEvidence({
      orderNumber: input.orderNumber,
      providerOrderId: local.providerOrderId,
      totalArs: local.totalArs,
      currency: local.currency,
      payment
    })
    const requestedAt = this.#now()
    const prepared = await this.resolutionService.createPreparedResolution({
      orderId: order._id,
      paymentId: payment._id,
      idempotencyKey: input.idempotencyKey,
      action: ACTION,
      originalAttentionReason: asText(order.attentionReason),
      actorUserId: input.actorUserId,
      actorRole: input.actorRole,
      note: input.note,
      requestedAt,
      providerEvidence,
      previousState: this.#previousState(order, payment, local),
      previousProductUnits: units.map(unitSnapshot)
    })

    this.#assertResolutionContract(prepared.resolution, input, order)
    return prepared.resolution
  }

  #assertPreviousState(resolution, order, payment) {
    const previous = resolution.previousState
    if (
      order.status !== 'requires_attention' ||
      order.fulfillmentStatus !== 'pending' ||
      asText(order.attentionReason) !== asText(resolution.originalAttentionReason) ||
      this.#version(order) !== previous.attentionResolutionVersion ||
      !sameInstant(order.reservationExpiresAt, previous.reservationExpiresAt) ||
      !sameInstant(order.reconciliationNextAt, previous.reconciliationNextAt) ||
      asText(order.reconciliationLeaseOwner) !== asText(previous.reconciliationLeaseOwner) ||
      !sameInstant(order.reconciliationLeaseUntil, previous.reconciliationLeaseUntil) ||
      !sameId(payment._id, resolution.paymentId) ||
      !sameId(payment.orderId, order._id) ||
      payment.provider !== 'mercado_pago' ||
      payment.normalizedStatus !== previous.paymentStatus ||
      !ALLOWED_INITIAL_PAYMENT_STATUSES.has(payment.normalizedStatus) ||
      asText(payment.providerOrderId) !== asText(previous.paymentProviderOrderId) ||
      asText(payment.providerPaymentId) !== asText(previous.paymentProviderPaymentId) ||
      asText(payment.externalReference) !== asText(previous.paymentExternalReference) ||
      !sameMoney(payment.amountArs, previous.paymentAmountArs) ||
      asText(payment.currency) !== asText(previous.paymentCurrency) ||
      asText(payment.providerStatus) !== asText(previous.paymentProviderStatus) ||
      asText(payment.providerStatusDetail) !== asText(previous.paymentProviderStatusDetail) ||
      !sameInstant(payment.approvedAt, previous.paymentApprovedAt) ||
      !sameInstant(payment.lastProviderCheckAt, previous.paymentLastProviderCheckAt) ||
      asText(payment.providerCancellationPayableStatus) !==
        asText(previous.providerCancellationPayableStatus) ||
      !sameInstant(
        payment.providerCancellationPayableObservedAt,
        previous.providerCancellationPayableObservedAt
      ) ||
      asText(payment.providerCancellationIdempotencyKey) !==
        asText(previous.providerCancellationIdempotencyKey) ||
      !sameInstant(
        payment.providerCancellationAttemptedAt,
        previous.providerCancellationAttemptedAt
      ) ||
      asText(payment.providerCancellationStatus) !==
        asText(previous.providerCancellationStatus) ||
      !sameInstant(
        payment.providerCancellationCompletedAt,
        previous.providerCancellationCompletedAt
      )
    ) {
      throw new ServiceError(
        'El estado local cambio despues del preflight',
        'ATTENTION_RESOLUTION_STALE',
        409
      )
    }
    if (asText(payment.providerPaymentId) || validDate(payment.approvedAt)) {
      throw new ServiceError(
        'Aparecio evidencia local de cobro',
        'ATTENTION_RESOLUTION_STALE',
        409
      )
    }
    return previous
  }

  #assertPersistedEvidence(resolution, order, payment) {
    const evidence = resolution.providerEvidence
    const previous = resolution.previousState
    const observedAt = validDate(evidence?.observedAt)
    const search = evidence?.paymentsSearch
    const searchPaymentIds = Array.isArray(search?.paymentIds) ? search.paymentIds : []
    const searchPayments = Array.isArray(search?.payments) ? search.payments : []
    const uniqueSearchIds = new Set(searchPaymentIds)
    const searchPaymentsValid = searchPayments.every((entry, index) => (
      /^[1-9]\d*$/.test(asText(entry.paymentsApiPaymentId)) &&
      asText(entry.paymentsApiPaymentId) === asText(searchPaymentIds[index]) &&
      TERMINAL_UNPAID_PAYMENT_STATUSES.has(lowerText(entry.status)) &&
      asText(entry.statusDetail) !== '' &&
      !lowerText(entry.statusDetail).includes('accredit') &&
      !lowerText(entry.statusDetail).includes('refund') &&
      sameMoney(entry.amount, order.totals?.totalArs) &&
      sameMoney(entry.paidAmount, '0') &&
      sameMoney(entry.refundedAmount, '0') &&
      entry.refundCount === 0 &&
      asText(entry.orderMpReferenceId) === asText(payment.providerOrderId)
    ))
    const commonValid = (
      evidence?.provider === 'mercado_pago' &&
      observedAt &&
      asText(evidence.providerOrderId) === asText(payment.providerOrderId) &&
      asText(evidence.externalReference).toUpperCase() === asText(order.orderNumber).toUpperCase() &&
      sameMoney(evidence.amountArs, payment.amountArs) &&
      sameMoney(evidence.totalAmount, order.totals?.totalArs) &&
      asText(evidence.currency).toUpperCase() === asText(payment.currency).toUpperCase() &&
      lowerText(evidence.providerStatus) === 'canceled' &&
      lowerText(evidence.providerStatusDetail) === 'canceled' &&
      evidence.providerPaymentId == null &&
      search?.completed === true &&
      Number.isInteger(search.total) &&
      search.total >= 0 &&
      search.inspectedCount === search.total &&
      search.vetoCount === 0 &&
      searchPaymentIds.length === search.total &&
      uniqueSearchIds.size === search.total &&
      searchPayments.length === search.total &&
      searchPaymentsValid
    )
    if (!commonValid) {
      throw new ServiceError(
        'La evidencia persistida es incompleta',
        'ATTENTION_RESOLUTION_STALE',
        409
      )
    }

    if (evidence.evidenceSource === ORDERS_API_TERMINAL_UNPAID) {
      const payments = evidence.payments
      const zeroPaid = evidence.totalPaidAmount != null &&
        sameMoney(evidence.totalPaidAmount, '0')
      const explicitNullEmpty = evidence.totalPaidAmount == null &&
        Array.isArray(payments) && payments.length === 0
      if (
        evidence.remoteClassification !== 'TERMINAL_UNPAID' ||
        evidence.totalPaidAmountPresent !== true ||
        evidence.transactionsPresent !== true ||
        evidence.paymentsPresent !== true ||
        evidence.paymentsIsArray !== true ||
        !Array.isArray(payments) ||
        evidence.paymentCount !== payments.length ||
        (!zeroPaid && !explicitNullEmpty) ||
        payments.some((entry) => (
          !TERMINAL_UNPAID_PAYMENT_STATUSES.has(lowerText(entry.status)) ||
          asText(entry.statusDetail) === '' ||
          lowerText(entry.statusDetail).includes('accredit') ||
          lowerText(entry.statusDetail).includes('refund') ||
          !sameMoney(entry.amount, order.totals?.totalArs) ||
          entry.paidAmount == null ||
          !sameMoney(entry.paidAmount, '0')
        ))
      ) {
        throw new ServiceError(
          'La evidencia Tipo A ya no es verificable',
          'ATTENTION_RESOLUTION_STALE',
          409
        )
      }
      return { evidence, previous, observedAt, cancellationContext: null }
    }

    if (evidence.evidenceSource === OWN_CANCELLATION_TERMINAL_UNPAID) {
      const payableObservedAt = validDate(evidence.providerCancellationPayableObservedAt)
      const attemptedAt = validDate(evidence.providerCancellationAttemptedAt)
      const completedAt = validDate(evidence.providerCancellationCompletedAt)
      const cancellationStatus = lowerText(evidence.providerCancellationStatus)
      const cancellationCoherent = cancellationStatus === 'uncertain'
        ? evidence.providerCancellationCompletedAt == null
        : cancellationStatus === 'succeeded' && completedAt && attemptedAt &&
          completedAt.getTime() >= attemptedAt.getTime() &&
          completedAt.getTime() <= observedAt.getTime()
      if (
        evidence.remoteClassification !== 'CANCELED_PAYMENT_AGGREGATES_OMITTED' ||
        evidence.totalPaidAmountPresent !== false ||
        evidence.transactionsPresent !== false ||
        evidence.paymentsPresent !== false ||
        evidence.paymentsIsArray !== false ||
        evidence.totalPaidAmount != null ||
        evidence.payments != null ||
        !['created', 'action_required'].includes(
          lowerText(evidence.providerCancellationPayableStatus)
        ) ||
        !payableObservedAt ||
        !attemptedAt ||
        payableObservedAt.getTime() > attemptedAt.getTime() ||
        observedAt.getTime() <= attemptedAt.getTime() ||
        !asText(evidence.providerCancellationIdempotencyKey) ||
        !cancellationCoherent ||
        asText(evidence.providerCancellationPayableStatus) !==
          asText(previous.providerCancellationPayableStatus) ||
        !sameInstant(
          evidence.providerCancellationPayableObservedAt,
          previous.providerCancellationPayableObservedAt
        ) ||
        asText(evidence.providerCancellationIdempotencyKey) !==
          asText(previous.providerCancellationIdempotencyKey) ||
        !sameInstant(
          evidence.providerCancellationAttemptedAt,
          previous.providerCancellationAttemptedAt
        ) ||
        asText(evidence.providerCancellationStatus) !==
          asText(previous.providerCancellationStatus) ||
        !sameInstant(
          evidence.providerCancellationCompletedAt,
          previous.providerCancellationCompletedAt
        )
      ) {
        throw new ServiceError(
          'La evidencia Tipo B ya no es verificable',
          'ATTENTION_RESOLUTION_STALE',
          409
        )
      }
      return {
        evidence,
        previous,
        observedAt,
        cancellationContext: {
          providerCancellationPayableStatus: previous.providerCancellationPayableStatus,
          providerCancellationPayableObservedAt:
            previous.providerCancellationPayableObservedAt,
          providerCancellationIdempotencyKey: previous.providerCancellationIdempotencyKey,
          providerCancellationAttemptedAt: previous.providerCancellationAttemptedAt,
          providerCancellationStatus: previous.providerCancellationStatus,
          providerCancellationCompletedAt: previous.providerCancellationCompletedAt
        }
      }
    }

    throw new ServiceError(
      'Tipo de evidencia terminal impaga desconocido',
      'ATTENTION_RESOLUTION_STALE',
      409
    )
  }

  async #runTransaction(operation) {
    const session = await this.mongoose.startSession()
    let result
    try {
      await session.withTransaction(async () => {
        result = await operation(session)
      }, TRANSACTION_OPTIONS)
      return result
    } finally {
      await session.endSession()
    }
  }

  async #completePrepared(input, preparedResolution) {
    return this.#runTransaction(async (session) => {
      let resolution = await this.resolutions.getById(preparedResolution._id, { session })
      if (!resolution) {
        throw new ServiceError('Resolucion no encontrada', 'ATTENTION_RESOLUTION_NOT_FOUND', 404)
      }
      if (resolution.status === 'completed') return { resolution, idempotent: true }
      if (resolution.status !== 'prepared') {
        throw new ServiceError(
          'La resolucion no puede reintentarse con la misma key',
          'ATTENTION_RESOLUTION_STATE_CONFLICT',
          409
        )
      }

      const attemptToken = randomUUID()
      const claimed = await this.resolutions.claimPreparedResolutionAttempt(
        resolution._id,
        attemptToken,
        { session }
      )
      if (!claimed) {
        const current = await this.resolutions.getById(resolution._id, { session })
        if (current?.status === 'completed') return { resolution: current, idempotent: true }
        throw new ServiceError(
          'La resolucion esta siendo procesada por otra solicitud',
          'ATTENTION_RESOLUTION_STATE_CONFLICT',
          409
        )
      }
      resolution = claimed

      const order = await this.orders.getById(resolution.orderId, { session })
      if (!order) throw new ServiceError('Orden no encontrada', 'ORDER_NOT_FOUND', 404)
      this.#assertResolutionContract(resolution, input, order)

      const [payment, items, units] = await Promise.all([
        this.payments.getLatestByOrderId(order._id, { session }),
        this.orderItems.getByOrderId(order._id, { session }),
        this.productUnitManager.getRelatedByOrderId(order._id, { session })
      ])
      const previous = this.#assertPreviousState(resolution, order, payment)
      const integrity = inspectReservationIntegrity({ order, orderItems: items, productUnits: units })
      if (!integrity.valid || !exactUnitSnapshot(units, resolution.previousProductUnits || [])) {
        throw new ServiceError(
          'La reserva cambio despues del preflight',
          'ATTENTION_RESOLUTION_STALE',
          409
        )
      }
      const evidenceState = this.#assertPersistedEvidence(resolution, order, payment)
      const changedAt = evidenceState.observedAt
      const reservationExpiresAt = validDate(order.reservationExpiresAt)
      if (!reservationExpiresAt || reservationExpiresAt.getTime() > changedAt.getTime()) {
        throw new ServiceError(
          'La reserva no estaba vencida al observar la evidencia',
          'ATTENTION_RESOLUTION_STALE',
          409
        )
      }

      const cancellationContext = {
        providerCancellationPayableStatus: previous.providerCancellationPayableStatus,
        providerCancellationPayableObservedAt: previous.providerCancellationPayableObservedAt,
        providerCancellationIdempotencyKey: previous.providerCancellationIdempotencyKey,
        providerCancellationAttemptedAt: previous.providerCancellationAttemptedAt,
        providerCancellationStatus: previous.providerCancellationStatus,
        providerCancellationCompletedAt: previous.providerCancellationCompletedAt
      }
      const updatedPayment = await this.payments.cancelAttentionWithTerminalUnpaidEvidence(
        payment._id,
        {
          orderId: order._id,
          expectedNormalizedStatus: previous.paymentStatus,
          providerOrderId: previous.paymentProviderOrderId,
          externalReference: previous.paymentExternalReference,
          amountArs: payment.amountArs,
          currency: previous.paymentCurrency,
          expectedProviderStatus: previous.paymentProviderStatus,
          expectedProviderStatusDetail: previous.paymentProviderStatusDetail,
          expectedLastProviderCheckAt: previous.paymentLastProviderCheckAt,
          observedAt: changedAt,
          providerStatus: evidenceState.evidence.providerStatus,
          providerStatusDetail: evidenceState.evidence.providerStatusDetail,
          cancellationContext
        },
        { session }
      )
      if (!updatedPayment) {
        throw new ServiceError(
          'El pago cambio durante la resolucion',
          'ATTENTION_RESOLUTION_STALE',
          409
        )
      }

      const inventory = await this.productUnits.releaseOrderReservationsForExpiration(
        { orderId: order._id, expirationLimit: changedAt },
        { session }
      )
      if (!inventory.valid) {
        throw new ServiceError(
          'La reserva no pudo liberarse de forma integra',
          'ATTENTION_RESERVATION_INTEGRITY_CONFLICT',
          409,
          { reason: inventory.reason }
        )
      }

      const updatedOrder = await this.orders.closeTerminalUnpaidAttention(
        order._id,
        {
          expectedAttentionReason: resolution.originalAttentionReason,
          expectedAttentionResolutionVersion: previous.attentionResolutionVersion,
          expectedReservationExpiresAt: previous.reservationExpiresAt,
          expectedReconciliationNextAt: previous.reconciliationNextAt,
          expectedReconciliationLeaseOwner: previous.reconciliationLeaseOwner,
          expectedReconciliationLeaseUntil: previous.reconciliationLeaseUntil,
          changedAt,
          changedBy: input.actorUserId,
          reason: COMPLETION_REASON
        },
        { session }
      )
      if (!updatedOrder) {
        throw new ServiceError(
          'La orden cambio durante la resolucion',
          'ATTENTION_RESOLUTION_STALE',
          409
        )
      }

      const finalUnits = await this.productUnitManager.getByIds(
        (resolution.previousProductUnits || []).map((unit) => unit.productUnitId),
        { session }
      )
      if (
        finalUnits.length !== inventory.releasedCount ||
        finalUnits.some((unit) => (
          unit.status !== 'available' ||
          unit.orderId != null ||
          unit.orderItemId != null ||
          unit.reservedByOrderId != null ||
          unit.reservedAt != null ||
          unit.reservationExpiresAt != null
        ))
      ) {
        throw new ServiceError(
          'El inventario final no coincide con la liberacion',
          'ATTENTION_RESOLUTION_STALE',
          409
        )
      }

      const completed = await this.resolutionService.completePreparedResolution(
        {
          resolutionId: resolution._id,
          completedAt: changedAt,
          providerEvidence: evidenceState.evidence,
          finalProductUnits: finalUnits.map(unitSnapshot),
          finalResult: {
            outcome: 'completed',
            reason: COMPLETION_REASON,
            orderStatus: updatedOrder.status,
            paymentStatus: updatedPayment.normalizedStatus,
            fulfillmentStatus: updatedOrder.fulfillmentStatus,
            attentionResolutionVersion: updatedOrder.attentionResolutionVersion,
            soldCount: 0,
            releasedCount: inventory.releasedCount,
            productIds: inventory.productIds
          },
          expectedAttemptToken: attemptToken
        },
        { session }
      )
      return { resolution: toPlainObject(completed), idempotent: false }
    })
  }

  async #markPreparedFailed(resolution, error) {
    try {
      const current = await this.resolutions.getById(resolution._id)
      if (!current || current.status !== 'prepared') return current
      return this.resolutionService.failPreparedResolution({
        resolutionId: current._id,
        completedAt: this.#now(),
        providerEvidence: current.providerEvidence,
        finalProductUnits: [],
        finalResult: {
          outcome: 'failed',
          reason: 'ATTENTION_RESOLUTION_ROLLED_BACK',
          orderStatus: current.previousState?.orderStatus || null,
          paymentStatus: current.previousState?.paymentStatus || null,
          fulfillmentStatus: current.previousState?.fulfillmentStatus || null,
          attentionResolutionVersion:
            current.previousState?.attentionResolutionVersion ?? null,
          soldCount: 0,
          releasedCount: 0,
          productIds: []
        },
        sanitizedError: {
          code: asText(error?.code || 'ATTENTION_RESOLUTION_FAILED'),
          message: 'La resolucion no pudo completarse y no produjo cambios parciales'
        }
      })
    } catch (failureError) {
      logError('Order terminal unpaid resolution failure audit could not be persisted', {
        resolutionId: asText(resolution?._id),
        code: asText(failureError?.code || failureError?.name)
      })
      try {
        return await this.resolutions.getById(resolution._id)
      } catch {
        return null
      }
    }
  }

  async closeTerminalUnpaid(rawInput) {
    const input = this.#normalizeInput(rawInput)
    const order = await this.orders.getByOrderNumber(input.orderNumber)
    if (!order) throw new ServiceError('Orden no encontrada', 'ORDER_NOT_FOUND', 404)

    let resolution = await this.resolutions.getByOrderAndIdempotencyKey(
      order._id,
      input.idempotencyKey
    )
    if (resolution) {
      this.#assertResolutionContract(resolution, input, order)
      if (resolution.status === 'completed') {
        return this.#completedResult(input.orderNumber, resolution, true)
      }
      if (resolution.status === 'failed') {
        throw new ServiceError(
          'La resolucion previa fallo; use una nueva Idempotency-Key tras revisar el estado',
          'ATTENTION_RESOLUTION_FAILED_IDEMPOTENCY_KEY',
          409
        )
      }
    } else {
      resolution = await this.#prepareResolution(input, order)
    }

    try {
      const completed = await this.#completePrepared(input, resolution)
      return this.#completedResult(
        input.orderNumber,
        completed.resolution,
        completed.idempotent
      )
    } catch (error) {
      const current = await this.resolutions.getById(resolution._id)
      if (current?.status === 'completed') {
        return this.#completedResult(input.orderNumber, current, true)
      }
      const afterFailure = await this.#markPreparedFailed(resolution, error)
      if (afterFailure?.status === 'completed') {
        return this.#completedResult(input.orderNumber, afterFailure, true)
      }
      throw error
    }
  }
}

export {
  ACTION as CLOSE_TERMINAL_UNPAID_ACTION,
  COMPLETION_REASON,
  OrderAttentionTerminalUnpaidService
}
export default new OrderAttentionTerminalUnpaidService()
