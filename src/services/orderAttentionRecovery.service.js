import mongoose from 'mongoose'
import { randomUUID } from 'node:crypto'
import OrderManager from '../dao/managers/order.manager.js'
import OrderItemManager from '../dao/managers/orderItem.manager.js'
import PaymentManager from '../dao/managers/payment.manager.js'
import ProductUnitManager from '../dao/managers/productUnit.manager.js'
import OrderAttentionResolutionManager from '../dao/managers/orderAttentionResolution.manager.js'
import MercadoPagoProvider from '../providers/mercadoPago.provider.js'
import { toMinorUnits } from '../utils/commerceMoney.js'
import { error as logError } from '../utils/logger.js'
import OrderAttentionService, {
  ATTENTION_CATEGORIES,
  inspectReservationIntegrity
} from './orderAttention.service.js'
import OrderAttentionResolutionService from './orderAttentionResolution.service.js'
import ProductUnitService from './productUnit.service.js'
import {
  REMOTE_ORDER_CLASSIFICATIONS,
  classifyRemoteOrder
} from './mercadoPagoOrderClassification.service.js'
import { ServiceError } from './service.products.js'

const TRANSACTION_OPTIONS = Object.freeze({
  readConcern: { level: 'snapshot' },
  writeConcern: { w: 'majority' }
})

const ACTION = 'complete_existing_reservation_sale'
const COMPLETION_REASON = 'ATTENTION_RESOLUTION_EXISTING_RESERVATION_SALE'
const ORDER_NUMBER_PATTERN = /^LC-\d{4}-\d{6,}$/

const asText = (value) => String(value ?? '').trim()
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

const assertExactUnitSnapshot = (units, previousUnits) => {
  if (units.length !== previousUnits.length) return false
  const currentById = new Map(units.map((unit) => [asText(unit._id), unit]))

  return previousUnits.every((previous) => {
    const current = currentById.get(asText(previous.productUnitId))
    return current && sameUnitSnapshot(current, previous)
  })
}

class OrderAttentionRecoveryService {
  constructor({
    mongooseInstance = mongoose,
    orderManager = OrderManager,
    orderItemManager = OrderItemManager,
    paymentManager = PaymentManager,
    productUnitManager = ProductUnitManager,
    productUnitService = ProductUnitService,
    resolutionManager = OrderAttentionResolutionManager,
    resolutionService = OrderAttentionResolutionService,
    orderAttentionService = OrderAttentionService,
    provider = MercadoPagoProvider,
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
    this.orderAttention = orderAttentionService
    this.provider = provider
    this.clock = clock
  }

  #normalizeInput({ orderNumber, idempotencyKey, actorUserId, actorRole, note }) {
    const normalizedOrderNumber = asText(orderNumber).toUpperCase()
    const normalizedIdempotencyKey = asText(idempotencyKey)
    const normalizedRole = asText(actorRole).toUpperCase()
    const normalizedNote = asText(note)

    if (!ORDER_NUMBER_PATTERN.test(normalizedOrderNumber)) {
      throw new ServiceError('Numero de orden invalido', 'INVALID_ORDER_NUMBER', 400)
    }
    if (!normalizedIdempotencyKey || normalizedIdempotencyKey.length > 128) {
      throw new ServiceError(
        'Idempotency-Key obligatorio e invalido',
        'ATTENTION_RESOLUTION_IDEMPOTENCY_KEY_REQUIRED',
        400
      )
    }
    if (!mongoose.Types.ObjectId.isValid(actorUserId)) {
      throw new ServiceError('Administrador no autenticado', 'ADMIN_UNAUTHENTICATED', 401)
    }
    if (!['ADMIN', 'SUPERADMIN'].includes(normalizedRole)) {
      throw new ServiceError('Acceso administrativo requerido', 'ORDERS_ADMIN_FORBIDDEN', 403)
    }
    if (normalizedNote.length > 2000) {
      throw new ServiceError('Nota administrativa demasiado extensa', 'INVALID_ATTENTION_NOTE', 400)
    }

    return {
      orderNumber: normalizedOrderNumber,
      idempotencyKey: normalizedIdempotencyKey,
      actorUserId,
      actorRole: normalizedRole,
      note: normalizedNote
    }
  }

  #now() {
    const now = new Date(this.clock())
    if (Number.isNaN(now.getTime())) {
      throw new ServiceError('Fecha interna invalida', 'INVALID_ATTENTION_RESOLUTION_DATE', 500)
    }
    return now
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
      orderStatus: resolution.finalResult?.orderStatus || 'paid',
      paymentStatus: resolution.finalResult?.paymentStatus || 'approved',
      fulfillmentStatus: resolution.finalResult?.fulfillmentStatus || 'preparing',
      attentionResolutionVersion:
        resolution.finalResult?.attentionResolutionVersion ?? null,
      soldCount: resolution.finalResult?.soldCount ?? resolution.finalProductUnits?.length ?? 0,
      idempotent
    }
  }

  #assertLocalPreflight({ order, payment, items, units, resolutions }) {
    if (!payment || !sameId(payment.orderId, order._id)) {
      throw new ServiceError(
        'El pago local no corresponde a la orden',
        'ATTENTION_PAYMENT_STATE_CONFLICT',
        409
      )
    }

    const readModel = this.orderAttention.buildReadModel({
      order,
      payment,
      orderItems: items,
      productUnits: units,
      resolutions
    })

    if (
      readModel.attentionCategory !== ATTENTION_CATEGORIES.APPROVED_INVENTORY ||
      !readModel.allowedActions.canCompleteExistingReservationSale
    ) {
      throw new ServiceError(
        'La orden no admite completar la venta con su reserva existente',
        'ATTENTION_EXISTING_RESERVATION_SALE_NOT_ALLOWED',
        409,
        { blockers: readModel.allowedActions.blockers.completeExistingReservationSale }
      )
    }

    const providerOrderId = asText(payment.providerOrderId)
    const providerPaymentId = asText(payment.providerPaymentId)
    const approvedAt = validDate(payment.approvedAt)
    const totalArs = decimalString(order.totals?.totalArs)
    const paymentAmount = decimalString(payment.amountArs)
    const currency = asText(payment.currency).toUpperCase()

    if (
      payment.provider !== 'mercado_pago' ||
      !providerOrderId ||
      !providerPaymentId ||
      !approvedAt ||
      !totalArs ||
      !paymentAmount ||
      !sameMoney(totalArs, paymentAmount) ||
      currency !== asText(order.paymentCurrency).toUpperCase() ||
      asText(payment.externalReference).toUpperCase() !== asText(order.orderNumber).toUpperCase()
    ) {
      throw new ServiceError(
        'La evidencia local del pago es inconsistente',
        'ATTENTION_PAYMENT_STATE_CONFLICT',
        409
      )
    }

    return {
      providerOrderId,
      providerPaymentId,
      approvedAt,
      totalArs,
      currency,
      version: this.#version(order),
      readModel
    }
  }

  #providerEvidence(providerOrder, expected, observedAt) {
    const classification = classifyRemoteOrder(providerOrder, {
      expectedProviderOrderId: expected.providerOrderId,
      expectedExternalReference: expected.orderNumber,
      expectedTotalAmount: expected.totalArs,
      expectedCurrency: expected.currency
    })
    const accreditedPayments = Array.isArray(providerOrder?.payments)
      ? providerOrder.payments.filter((payment) => (
        asText(payment?.status).toLowerCase() === 'processed' &&
        asText(payment?.statusDetail).toLowerCase() === 'accredited'
      ))
      : []
    const accreditedPayment = accreditedPayments[0]

    if (
      classification !== REMOTE_ORDER_CLASSIFICATIONS.APPROVED ||
      asText(providerOrder.status).toLowerCase() !== 'processed' ||
      asText(providerOrder.statusDetail).toLowerCase() !== 'accredited' ||
      accreditedPayments.length !== 1 ||
      !sameId(accreditedPayment?.providerPaymentId, expected.providerPaymentId) ||
      !sameMoney(providerOrder.totalAmount, expected.totalArs) ||
      !sameMoney(providerOrder.totalPaidAmount, expected.totalArs) ||
      !sameMoney(accreditedPayment?.amount, expected.totalArs) ||
      !sameMoney(accreditedPayment?.paidAmount, expected.totalArs) ||
      asText(providerOrder.externalReference).toUpperCase() !== expected.orderNumber ||
      asText(providerOrder.currency).toUpperCase() !== expected.currency
    ) {
      throw new ServiceError(
        'Mercado Pago no confirma exactamente la venta aprobada',
        'ATTENTION_PROVIDER_EVIDENCE_MISMATCH',
        409
      )
    }

    return {
      provider: 'mercado_pago',
      providerOrderId: expected.providerOrderId,
      providerPaymentId: expected.providerPaymentId,
      externalReference: expected.orderNumber,
      providerStatus: 'processed',
      providerStatusDetail: 'accredited',
      amountArs: expected.totalArs,
      totalAmount: decimalString(providerOrder.totalAmount),
      totalPaidAmount: decimalString(providerOrder.totalPaidAmount),
      currency: expected.currency,
      observedAt,
      remoteClassification: REMOTE_ORDER_CLASSIFICATIONS.APPROVED,
      accreditedPayment: {
        providerPaymentId: expected.providerPaymentId,
        status: 'processed',
        statusDetail: 'accredited',
        amount: decimalString(accreditedPayment.amount),
        paidAmount: decimalString(accreditedPayment.paidAmount)
      }
    }
  }

  #assertPersistedEvidence(resolution, order, payment) {
    const evidence = resolution.providerEvidence
    const previous = resolution.previousState
    const observedAt = validDate(evidence?.observedAt)
    const paymentApprovedAt = validDate(previous?.paymentApprovedAt)
    const accreditedPayment = evidence?.accreditedPayment

    if (
      evidence?.provider !== 'mercado_pago' ||
      evidence?.remoteClassification !== REMOTE_ORDER_CLASSIFICATIONS.APPROVED ||
      asText(evidence.providerStatus).toLowerCase() !== 'processed' ||
      asText(evidence.providerStatusDetail).toLowerCase() !== 'accredited' ||
      !observedAt ||
      !paymentApprovedAt ||
      !sameId(evidence.providerOrderId, payment.providerOrderId) ||
      !sameId(evidence.providerPaymentId, payment.providerPaymentId) ||
      !sameId(accreditedPayment?.providerPaymentId, payment.providerPaymentId) ||
      asText(evidence.externalReference).toUpperCase() !== asText(order.orderNumber).toUpperCase() ||
      asText(evidence.currency).toUpperCase() !== asText(payment.currency).toUpperCase() ||
      !sameMoney(evidence.totalAmount, order.totals?.totalArs) ||
      !sameMoney(evidence.totalPaidAmount, order.totals?.totalArs) ||
      !sameMoney(accreditedPayment?.amount, order.totals?.totalArs) ||
      !sameMoney(accreditedPayment?.paidAmount, order.totals?.totalArs) ||
      !sameInstant(payment.approvedAt, paymentApprovedAt)
    ) {
      throw new ServiceError(
        'La evidencia persistida ya no corresponde al estado local',
        'ATTENTION_RESOLUTION_STALE',
        409
      )
    }

    return { evidence, observedAt, paymentApprovedAt }
  }

  async #prepareResolution(input, order) {
    const [items, payment, units, resolutions] = await Promise.all([
      this.orderItems.getByOrderId(order._id),
      this.payments.getLatestByOrderId(order._id),
      this.productUnitManager.getRelatedByOrderId(order._id),
      this.resolutions.getOrderResolutionHistory(order._id)
    ])
    const local = this.#assertLocalPreflight({ order, payment, items, units, resolutions })
    const providerOrder = await this.provider.getOrder(local.providerOrderId)
    const observedAt = this.#now()
    const providerEvidence = this.#providerEvidence(providerOrder, {
      ...local,
      orderNumber: input.orderNumber
    }, observedAt)
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
      previousState: {
        orderStatus: order.status,
        paymentStatus: payment.normalizedStatus,
        fulfillmentStatus: order.fulfillmentStatus,
        attentionReason: asText(order.attentionReason),
        attentionResolutionVersion: local.version,
        paymentApprovedAt: local.approvedAt,
        paymentLastProviderCheckAt: validDate(payment.lastProviderCheckAt)
      },
      previousProductUnits: units.map(unitSnapshot)
    })

    this.#assertResolutionContract(prepared.resolution, input, order)
    return prepared.resolution
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
      if (resolution.status === 'completed') {
        return { resolution, idempotent: true }
      }
      if (resolution.status !== 'prepared') {
        throw new ServiceError(
          'La resolucion no puede reintentarse con la misma key',
          'ATTENTION_RESOLUTION_STATE_CONFLICT',
          409
        )
      }

      const attemptToken = randomUUID()
      const claimedResolution = await this.resolutions.claimPreparedResolutionAttempt(
        resolution._id,
        attemptToken,
        { session }
      )

      if (!claimedResolution) {
        const current = await this.resolutions.getById(resolution._id, { session })
        if (current?.status === 'completed') return { resolution: current, idempotent: true }
        throw new ServiceError(
          'La resolucion esta siendo procesada por otra solicitud',
          'ATTENTION_RESOLUTION_STATE_CONFLICT',
          409
        )
      }

      resolution = claimedResolution

      const order = await this.orders.getById(resolution.orderId, { session })
      if (!order) throw new ServiceError('Orden no encontrada', 'ORDER_NOT_FOUND', 404)
      this.#assertResolutionContract(resolution, input, order)

      const [payment, latestPayment, items, units] = await Promise.all([
        this.payments.getById(resolution.paymentId, { session }),
        this.payments.getLatestByOrderId(order._id, { session }),
        this.orderItems.getByOrderId(order._id, { session }),
        this.productUnitManager.getRelatedByOrderId(order._id, { session })
      ])

      const expectedVersion = resolution.previousState?.attentionResolutionVersion
      if (
        !payment ||
        !latestPayment ||
        !sameId(payment._id, latestPayment._id) ||
        order.status !== 'requires_attention' ||
        order.fulfillmentStatus !== 'pending' ||
        asText(order.attentionReason) !== asText(resolution.originalAttentionReason) ||
        this.#version(order) !== expectedVersion ||
        payment.normalizedStatus !== 'approved' ||
        !sameId(payment.orderId, order._id)
      ) {
        throw new ServiceError(
          'La orden o el pago cambiaron durante la resolucion',
          'ATTENTION_RESOLUTION_STATE_CONFLICT',
          409
        )
      }

      const { evidence, observedAt, paymentApprovedAt } = this.#assertPersistedEvidence(
        resolution,
        order,
        payment
      )
      const integrity = inspectReservationIntegrity({
        order,
        orderItems: items,
        productUnits: units
      })

      if (
        !integrity.valid ||
        !assertExactUnitSnapshot(units, resolution.previousProductUnits || [])
      ) {
        throw new ServiceError(
          'La reserva original cambio durante la resolucion',
          'ATTENTION_RESERVATION_STATE_CONFLICT',
          409
        )
      }

      const updatedPayment = await this.payments.confirmApprovedAttentionEvidence(
        payment._id,
        {
          orderId: order._id,
          providerOrderId: evidence.providerOrderId,
          providerPaymentId: evidence.providerPaymentId,
          approvedAt: paymentApprovedAt,
          amountArs: evidence.amountArs,
          currency: evidence.currency,
          expectedLastProviderCheckAt: resolution.previousState.paymentLastProviderCheckAt,
          observedAt,
          providerStatus: evidence.providerStatus,
          providerStatusDetail: evidence.providerStatusDetail
        },
        { session }
      )

      if (!updatedPayment) {
        throw new ServiceError(
          'La evidencia del pago cambio durante la resolucion',
          'ATTENTION_PAYMENT_EVIDENCE_STALE',
          409
        )
      }

      const changedAt = this.#now()
      const previousUnits = resolution.previousProductUnits || []
      const saleResult = await this.productUnitManager.markExactReservedUnitsSold(
        previousUnits,
        order._id,
        changedAt,
        { session }
      )

      if (
        saleResult.matchedCount !== previousUnits.length ||
        saleResult.modifiedCount !== previousUnits.length
      ) {
        throw new ServiceError(
          'No fue posible vender toda la reserva original',
          'ATTENTION_RESERVATION_SALE_CONFLICT',
          409
        )
      }

      const productIds = [...new Set(previousUnits.map((unit) => asText(unit.productId)))]
      for (const productId of productIds) {
        await this.productUnits.recalculateProductStock(productId, { session })
      }

      const updatedOrder = await this.orders.completeExistingReservationSaleAttention(
        order._id,
        {
          expectedAttentionReason: resolution.originalAttentionReason,
          expectedAttentionResolutionVersion: expectedVersion,
          paidAt: paymentApprovedAt,
          changedAt,
          changedBy: input.actorUserId,
          reason: COMPLETION_REASON
        },
        { session }
      )

      if (!updatedOrder) {
        throw new ServiceError(
          'La orden cambio durante la resolucion',
          'ATTENTION_RESOLUTION_STATE_CONFLICT',
          409
        )
      }

      const soldUnits = await this.productUnitManager.getByIds(
        previousUnits.map((unit) => unit.productUnitId),
        { session }
      )
      const completedResolution = await this.resolutionService.completePreparedResolution(
        {
          resolutionId: resolution._id,
          completedAt: changedAt,
          providerEvidence: evidence,
          finalProductUnits: soldUnits.map(unitSnapshot),
          finalResult: {
            outcome: 'completed',
            reason: COMPLETION_REASON,
            orderStatus: updatedOrder.status,
            paymentStatus: updatedPayment.normalizedStatus,
            fulfillmentStatus: updatedOrder.fulfillmentStatus,
            attentionResolutionVersion: updatedOrder.attentionResolutionVersion,
            soldCount: soldUnits.length
          },
          expectedAttemptToken: attemptToken
        },
        { session }
      )

      return { resolution: toPlainObject(completedResolution), idempotent: false }
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
          soldCount: 0
        },
        sanitizedError: {
          code: asText(error?.code || 'ATTENTION_RESOLUTION_FAILED'),
          message: 'La resolucion no pudo completarse y no produjo cambios parciales'
        }
      })
    } catch (failureError) {
      logError('Order attention resolution failure audit could not be persisted', {
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

  async completeExistingReservationSale(rawInput) {
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

      const afterFailureAudit = await this.#markPreparedFailed(resolution, error)
      if (afterFailureAudit?.status === 'completed') {
        return this.#completedResult(input.orderNumber, afterFailureAudit, true)
      }
      throw error
    }
  }
}

export {
  ACTION as COMPLETE_EXISTING_RESERVATION_SALE_ACTION,
  COMPLETION_REASON,
  OrderAttentionRecoveryService
}
export default new OrderAttentionRecoveryService()
