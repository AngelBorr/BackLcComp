import mongoose from 'mongoose'
import { createHash } from 'node:crypto'
import OrderManager from '../dao/managers/order.manager.js'
import OrderItemManager from '../dao/managers/orderItem.manager.js'
import PaymentManager from '../dao/managers/payment.manager.js'
import ProductUnitManager from '../dao/managers/productUnit.manager.js'
import OrderAttentionResolutionManager from '../dao/managers/orderAttentionResolution.manager.js'
import { error as logError } from '../utils/logger.js'
import {
  ATTENTION_CATEGORIES,
  classifyAttention
} from './orderAttention.service.js'
import OrderAttentionResolutionService from './orderAttentionResolution.service.js'
import OrderInventoryRepairReadService from './orderInventoryRepairRead.service.js'
import OrderInventoryRepairPlannerService, {
  PLAN_OUTCOMES
} from './orderInventoryRepairPlanner.service.js'
import OrderInventoryRepairSelectorService from './orderInventoryRepairSelector.service.js'
import OrderInventoryRepairWriterService from './orderInventoryRepairWriter.service.js'
import { ServiceError } from './service.products.js'

const TRANSACTION_OPTIONS = Object.freeze({
  readConcern: { level: 'snapshot' },
  writeConcern: { w: 'majority' }
})

const ACTION = 'reassign_inventory'
const COMPLETION_REASON = 'ATTENTION_RESOLUTION_INVENTORY_REPAIR'
const ORDER_NUMBER_PATTERN = /^LC-\d{4}-\d{6,}$/
const IDEMPOTENCY_KEY_PATTERN = /^[A-Za-z0-9._:-]{8,128}$/
const OBJECT_ID_PATTERN = /^[a-f0-9]{24}$/i
const INPUT_FIELDS = new Set([
  'orderNumber',
  'idempotencyKey',
  'actorUserId',
  'actorRole',
  'note'
])

const asText = (value) => String(value ?? '').trim()
const asId = (value) => asText(value?._id ?? value)
const toPlainObject = (value) => typeof value?.toObject === 'function'
  ? value.toObject()
  : value

const validDate = (value) => {
  if (value == null) return null
  const date = value instanceof Date ? new Date(value.getTime()) : new Date(value)
  return Number.isNaN(date.getTime()) ? null : date
}

const decimalString = (value) => value == null
  ? null
  : String(value?.toString?.() ?? value)

const normalizeInput = (rawInput) => {
  if (!rawInput || typeof rawInput !== 'object' || Array.isArray(rawInput)) {
    throw new ServiceError('Solicitud de reparacion invalida', 'INVALID_INVENTORY_REPAIR_INPUT', 400)
  }

  const extraFields = Object.keys(rawInput).filter((field) => !INPUT_FIELDS.has(field))
  if (extraFields.length > 0) {
    throw new ServiceError(
      'La solicitud contiene campos no permitidos',
      'INVALID_INVENTORY_REPAIR_INPUT',
      400
    )
  }

  const orderNumber = asText(rawInput.orderNumber).toUpperCase()
  const idempotencyKey = asText(rawInput.idempotencyKey)
  const actorRole = asText(rawInput.actorRole).toUpperCase()

  if (!ORDER_NUMBER_PATTERN.test(orderNumber)) {
    throw new ServiceError('Numero de orden invalido', 'INVALID_ORDER_NUMBER', 400)
  }
  if (!IDEMPOTENCY_KEY_PATTERN.test(idempotencyKey)) {
    throw new ServiceError(
      'Idempotency-Key invalida',
      'ATTENTION_RESOLUTION_IDEMPOTENCY_KEY_REQUIRED',
      400
    )
  }

  const actorUserId = asText(rawInput.actorUserId)
  if (!OBJECT_ID_PATTERN.test(actorUserId) || !mongoose.Types.ObjectId.isValid(actorUserId)) {
    throw new ServiceError('Administrador no autenticado', 'ADMIN_UNAUTHENTICATED', 401)
  }
  if (!['ADMIN', 'SUPERADMIN'].includes(actorRole)) {
    throw new ServiceError('Acceso administrativo requerido', 'ORDERS_ADMIN_FORBIDDEN', 403)
  }

  if (rawInput.note != null && typeof rawInput.note !== 'string') {
    throw new ServiceError('Nota administrativa invalida', 'INVALID_ATTENTION_NOTE', 400)
  }
  const normalizedNote = rawInput.note == null ? null : rawInput.note.trim() || null
  if (normalizedNote && normalizedNote.length > 2000) {
    throw new ServiceError('Nota administrativa demasiado extensa', 'INVALID_ATTENTION_NOTE', 400)
  }

  return {
    orderNumber,
    idempotencyKey,
    actorUserId,
    actorRole,
    note: normalizedNote
  }
}

const requestHashFor = ({ orderNumber, note }) => createHash('sha256')
  .update(JSON.stringify({ orderNumber, action: ACTION, note }))
  .digest('hex')

const resolutionMatchesRequest = (resolution, input, requestHash) => (
  resolution?.status === 'completed' &&
  asText(resolution.orderNumber).toUpperCase() === input.orderNumber &&
  resolution.action === ACTION &&
  resolution.requestHash === requestHash
)

const inventoryRepairError = (message, code, status = 409, details) => (
  new ServiceError(message, code, status, details)
)

const ensureSingleResolution = (resolutions) => {
  if (!Array.isArray(resolutions) || resolutions.length > 1) {
    throw inventoryRepairError(
      'La clave de idempotencia posee evidencia ambigua',
      'ATTENTION_RESOLUTION_STATE_CONFLICT'
    )
  }
  return resolutions[0] || null
}

const versionOf = (order) => {
  const version = order?.attentionResolutionVersion ?? 0
  if (!Number.isSafeInteger(version) || version < 0) {
    throw inventoryRepairError(
      'La version de resolucion de la Order es invalida',
      'ATTENTION_RESOLUTION_STATE_CONFLICT'
    )
  }
  return version
}

const originalProductUnitIds = (orderItems) => {
  if (!Array.isArray(orderItems)) {
    throw inventoryRepairError(
      'Los OrderItems de la reparacion son invalidos',
      'INVENTORY_REPAIR_PLAN_BLOCKED'
    )
  }

  return orderItems.flatMap((item) => Array.isArray(item?.originalReservation?.units)
    ? item.originalReservation.units.map((unit) => unit?.productUnitId)
    : [])
}

const previousState = (order, payment) => ({
  orderStatus: order.status,
  paymentStatus: payment.normalizedStatus,
  fulfillmentStatus: order.fulfillmentStatus,
  attentionReason: asText(order.attentionReason),
  attentionResolutionVersion: versionOf(order),
  paymentApprovedAt: validDate(payment.approvedAt),
  paymentLastProviderCheckAt: validDate(payment.lastProviderCheckAt),
  paymentProviderOrderId: payment.providerOrderId ?? null,
  paymentProviderPaymentId: payment.providerPaymentId ?? null,
  paymentExternalReference: payment.externalReference ?? null,
  paymentAmountArs: decimalString(payment.amountArs),
  paymentCurrency: payment.currency ?? null,
  paymentProviderStatus: payment.providerStatus ?? null,
  paymentProviderStatusDetail: payment.providerStatusDetail ?? null,
  providerCancellationPayableStatus: payment.providerCancellationPayableStatus ?? null,
  providerCancellationPayableObservedAt: validDate(
    payment.providerCancellationPayableObservedAt
  ),
  providerCancellationIdempotencyKey: payment.providerCancellationIdempotencyKey ?? null,
  providerCancellationAttemptedAt: validDate(payment.providerCancellationAttemptedAt),
  providerCancellationStatus: payment.providerCancellationStatus ?? null,
  providerCancellationCompletedAt: validDate(payment.providerCancellationCompletedAt),
  reservationExpiresAt: validDate(order.reservationExpiresAt),
  reconciliationNextAt: validDate(order.reconciliationNextAt),
  reconciliationLeaseOwner: order.reconciliationLeaseOwner ?? null,
  reconciliationLeaseUntil: validDate(order.reconciliationLeaseUntil)
})

const unitSnapshot = (unit) => ({
  productUnitId: unit._id ?? unit.productUnitId,
  serialNumber: asText(unit.serialNumber),
  status: asText(unit.status),
  productId: unit.productId ?? null,
  orderId: unit.orderId ?? null,
  orderItemId: unit.orderItemId ?? null,
  reservedByOrderId: unit.reservedByOrderId ?? null,
  reservedAt: validDate(unit.reservedAt),
  reservationExpiresAt: validDate(unit.reservationExpiresAt),
  soldByOrderId: unit.soldByOrderId ?? null,
  soldAt: validDate(unit.soldAt),
  isDeleted: unit.isDeleted === true
})

const idsFromDescriptors = (entries) => entries.map((entry) => entry.productUnitId)

const buildInventoryRepairSummary = (plan, selection) => {
  const selectionByItem = new Map(
    selection.byOrderItem.map((item) => [asId(item.orderItemId), item])
  )
  const items = plan.items.map((item) => {
    const selected = selectionByItem.get(asId(item.orderItemId))
    if (!selected) {
      throw inventoryRepairError(
        'La seleccion no coincide con el plan de reparacion',
        'INVENTORY_REPAIR_CAS_CONFLICT'
      )
    }
    return {
      orderItemId: item.orderItemId,
      productId: item.productId,
      alreadySoldProductUnitIds: idsFromDescriptors(item.alreadySold),
      preservedReservedProductUnitIds: idsFromDescriptors(item.preserveReserved),
      reclaimedOriginalProductUnitIds: idsFromDescriptors(item.reclaimAvailableOriginals),
      replacementProductUnitIds: [...selected.newReplacementCandidateIds]
    }
  })

  const count = (field) => items.reduce((total, item) => total + item[field].length, 0)
  const alreadySoldCount = count('alreadySoldProductUnitIds')
  const preservedReservedCount = count('preservedReservedProductUnitIds')
  const reclaimedOriginalCount = count('reclaimedOriginalProductUnitIds')
  const replacementCount = count('replacementProductUnitIds')

  return {
    items,
    alreadySoldCount,
    preservedReservedCount,
    reclaimedOriginalCount,
    replacementCount,
    soldCount: alreadySoldCount + preservedReservedCount +
      reclaimedOriginalCount + replacementCount
  }
}

const publicSummary = (summary) => ({
  alreadySoldCount: summary?.alreadySoldCount ?? 0,
  preservedReservedCount: summary?.preservedReservedCount ?? 0,
  reclaimedOriginalCount: summary?.reclaimedOriginalCount ?? 0,
  replacementCount: summary?.replacementCount ?? 0,
  soldCount: summary?.soldCount ?? 0
})

const resultFromResolution = (resolution, idempotent) => ({
  orderNumber: asText(resolution.orderNumber).toUpperCase(),
  resolutionId: asId(resolution),
  resolutionStatus: resolution.status,
  action: resolution.action,
  outcome: resolution.finalResult?.outcome ?? resolution.status,
  orderStatus: resolution.finalResult?.orderStatus ?? null,
  paymentStatus: resolution.finalResult?.paymentStatus ?? null,
  fulfillmentStatus: resolution.finalResult?.fulfillmentStatus ?? null,
  repairAt: validDate(resolution.repairAt)?.toISOString() ?? null,
  resolvedAt: validDate(resolution.completedAt)?.toISOString() ?? null,
  attentionResolutionVersion:
    resolution.finalResult?.attentionResolutionVersion ?? null,
  summary: publicSummary(resolution.inventoryRepairSummary),
  idempotent
})

const duplicateFields = (error) => new Set([
  ...Object.keys(error?.keyPattern || {}),
  ...Object.keys(error?.keyValue || {})
])

const isDuplicateKey = (error) => error?.code === 11000

const isDomainError = (error) => (
  error instanceof ServiceError ||
  (typeof error?.code === 'string' &&
    Number.isInteger(error?.status ?? error?.statusCode))
)

class OrderInventoryRepairCommandService {
  constructor({
    mongooseInstance = mongoose,
    orderManager = OrderManager,
    orderItemManager = OrderItemManager,
    paymentManager = PaymentManager,
    productUnitManager = ProductUnitManager,
    resolutionManager = OrderAttentionResolutionManager,
    resolutionService = OrderAttentionResolutionService,
    readService = OrderInventoryRepairReadService,
    plannerService = OrderInventoryRepairPlannerService,
    selectorService = OrderInventoryRepairSelectorService,
    writerService = OrderInventoryRepairWriterService,
    attentionClassifier = classifyAttention,
    clock = () => new Date()
  } = {}) {
    this.mongoose = mongooseInstance
    this.orders = orderManager
    this.orderItems = orderItemManager
    this.payments = paymentManager
    this.productUnits = productUnitManager
    this.resolutions = resolutionManager
    this.resolutionService = resolutionService
    this.readService = readService
    this.planner = plannerService
    this.selector = selectorService
    this.writer = writerService
    this.classifyAttention = attentionClassifier
    this.clock = clock
  }

  async #resolutionByKey(idempotencyKey, { session } = {}) {
    return ensureSingleResolution(
      await this.resolutions.findByIdempotencyKey(idempotencyKey, { session })
    )
  }

  #resolveExisting(resolution, input, requestHash) {
    if (!resolution) return null
    if (resolutionMatchesRequest(resolution, input, requestHash)) {
      return resultFromResolution(resolution, true)
    }
    if (
      asText(resolution.orderNumber).toUpperCase() !== input.orderNumber ||
      resolution.action !== ACTION ||
      resolution.requestHash !== requestHash
    ) {
      throw inventoryRepairError(
        'La Idempotency-Key ya fue usada para otra solicitud',
        'IDEMPOTENCY_KEY_REUSED'
      )
    }
    throw inventoryRepairError(
      'La resolucion idempotente no esta completada',
      'ATTENTION_RESOLUTION_STATE_CONFLICT'
    )
  }

  #clockNow() {
    const now = validDate(this.clock())
    if (!now) {
      throw new ServiceError('Fecha interna invalida', 'INVALID_ATTENTION_RESOLUTION_DATE', 500)
    }
    return now
  }

  async #preflightRepairAt(orderNumber) {
    const order = await this.orders.getByOrderNumber(orderNumber)
    if (!order) throw new ServiceError('Orden no encontrada', 'ORDER_NOT_FOUND', 404)
    const payment = await this.payments.getLatestByOrderId(order._id)
    if (!payment) throw new ServiceError('Pago no encontrado', 'PAYMENT_NOT_FOUND', 404)
    const updatedAt = validDate(payment.updatedAt)
    if (!updatedAt) {
      throw inventoryRepairError(
        'El timestamp de Payment es invalido',
        'INVALID_INVENTORY_REPAIR_PAYMENT_EVIDENCE'
      )
    }

    const now = this.#clockNow()
    const nextPaymentMillisecond = updatedAt.getTime() + 1
    const repairAt = new Date(Math.max(now.getTime(), nextPaymentMillisecond))
    if (
      Number.isNaN(repairAt.getTime()) ||
      repairAt.getTime() <= updatedAt.getTime()
    ) {
      throw inventoryRepairError(
        'No fue posible generar un timestamp seguro de reparacion',
        'INVENTORY_REPAIR_PAYMENT_FENCE_TIMESTAMP_CONFLICT'
      )
    }
    return repairAt
  }

  async #runAttempt(input, requestHash, repairAt, session) {
    const existingByKey = await this.#resolutionByKey(input.idempotencyKey, { session })
    const replay = this.#resolveExisting(existingByKey, input, requestHash)
    if (replay) return replay

    const order = await this.orders.getByOrderNumber(input.orderNumber, { session })
    if (!order) throw new ServiceError('Orden no encontrada', 'ORDER_NOT_FOUND', 404)

    const completed = await this.resolutions.findCompletedByOrderAndAction(
      order._id,
      ACTION,
      { session }
    )
    if (completed) {
      throw inventoryRepairError(
        'La reparacion de inventario ya fue completada',
        'ATTENTION_INVENTORY_REPAIR_ALREADY_COMPLETED'
      )
    }

    const payment = await this.payments.getLatestByOrderId(order._id, { session })
    if (!payment) throw new ServiceError('Pago no encontrado', 'PAYMENT_NOT_FOUND', 404)

    const paymentUpdatedAt = validDate(payment.updatedAt)
    if (!paymentUpdatedAt || paymentUpdatedAt.getTime() >= repairAt.getTime()) {
      throw inventoryRepairError(
        'La evidencia de Payment cambio despues del preflight',
        'INVENTORY_REPAIR_PAYMENT_FENCE_TIMESTAMP_CONFLICT'
      )
    }

    const ledgerItems = await this.orderItems.getByOrderId(order._id, { session })
    const authoritativeInputs = await this.readService.loadAuthoritativeInputs(
      {
        orderId: order._id,
        originalProductUnitIds: originalProductUnitIds(ledgerItems)
      },
      { session }
    )

    const classification = this.classifyAttention({ order, payment })
    if (classification.attentionCategory !== ATTENTION_CATEGORIES.APPROVED_INVENTORY) {
      throw inventoryRepairError(
        'La incidencia no corresponde a inventario con pago aprobado',
        'ATTENTION_INVENTORY_REPAIR_NOT_ALLOWED',
        409,
        { attentionCategory: classification.attentionCategory }
      )
    }

    const plan = this.planner.buildInventoryRepairPlan({
      order,
      payment,
      orderItems: authoritativeInputs.orderItems,
      originalProductUnits: authoritativeInputs.originalProductUnits,
      currentProductUnits: authoritativeInputs.relatedProductUnits,
      externalOrderItemsById: authoritativeInputs.externalOrderItemsById
    })
    if (plan.outcome !== PLAN_OUTCOMES.READY || plan.repairable !== true) {
      throw inventoryRepairError(
        'El plan de reparacion esta bloqueado',
        'INVENTORY_REPAIR_PLAN_BLOCKED',
        409,
        {
          blockers: Array.isArray(plan.blocked)
            ? plan.blocked.map((entry) => ({
              reason: asText(entry?.reason),
              category: asText(entry?.category)
            }))
            : []
        }
      )
    }

    const prepared = await this.resolutionService.createPreparedInventoryRepairResolution(
      {
        orderId: order._id,
        orderNumber: input.orderNumber,
        paymentId: payment._id,
        action: ACTION,
        originalAttentionReason: asText(order.attentionReason),
        actorUserId: input.actorUserId,
        actorRole: input.actorRole,
        idempotencyKey: input.idempotencyKey,
        requestHash,
        note: input.note,
        requestedAt: repairAt,
        repairAt,
        previousState: previousState(order, payment)
      },
      { session }
    )

    const selection = await this.selector.selectCandidates(plan, { session })

    await this.payments.fenceApprovedInventoryRepairEvidence(
      {
        paymentId: payment._id,
        orderId: order._id,
        provider: payment.provider,
        normalizedStatus: payment.normalizedStatus,
        providerOrderId: payment.providerOrderId,
        providerPaymentId: payment.providerPaymentId,
        approvedAt: validDate(payment.approvedAt),
        externalReference: payment.externalReference,
        amountArs: payment.amountArs,
        currency: payment.currency,
        expectedUpdatedAt: paymentUpdatedAt,
        repairAt
      },
      { session }
    )

    const writeResult = await this.writer.writeRepair(
      { order, authoritativeInputs, plan, selection, repairAt },
      { session }
    )
    const finalUnits = await this.productUnits.getByIds(
      writeResult.verifiedSoldProductUnitIds,
      { session }
    )
    if (
      !Array.isArray(finalUnits) ||
      finalUnits.length !== writeResult.verifiedSoldProductUnitIds.length
    ) {
      throw inventoryRepairError(
        'La evidencia final de ProductUnits es incompleta',
        'INVENTORY_REPAIR_FINAL_STATE_CONFLICT'
      )
    }

    const expectedVersion = versionOf(order)
    await this.orders.completeInventoryRepairAttention(
      order._id,
      {
        expectedAttentionReason: asText(order.attentionReason),
        expectedAttentionResolutionVersion: expectedVersion,
        expectedReservationExpiresAt: validDate(order.reservationExpiresAt),
        expectedActiveRefundId: order.activeRefundId ?? null,
        expectedReconciliationNextAt: validDate(order.reconciliationNextAt),
        expectedReconciliationLeaseOwner: order.reconciliationLeaseOwner ?? null,
        expectedReconciliationLeaseUntil: validDate(order.reconciliationLeaseUntil),
        paymentApprovedAt: validDate(payment.approvedAt),
        actorUserId: input.actorUserId,
        repairAt
      },
      { session }
    )

    const inventoryRepairSummary = buildInventoryRepairSummary(plan, selection)
    const finalResult = {
      outcome: 'completed',
      reason: COMPLETION_REASON,
      orderStatus: 'paid',
      paymentStatus: 'approved',
      fulfillmentStatus: 'preparing',
      attentionResolutionVersion: expectedVersion + 1,
      soldCount: writeResult.verifiedSoldProductUnitIds.length,
      releasedCount: 0,
      productIds: [...writeResult.affectedProductIds]
    }
    const completedResolution = await this.resolutionService.completeInventoryRepairResolution(
      {
        resolutionId: prepared._id,
        orderId: order._id,
        idempotencyKey: input.idempotencyKey,
        requestHash,
        completedAt: repairAt,
        finalProductUnits: finalUnits.map(unitSnapshot),
        inventoryRepairSummary,
        finalResult
      },
      { session }
    )

    return resultFromResolution(toPlainObject(completedResolution), false)
  }

  async #resolveDuplicate(error, input, requestHash) {
    const fields = duplicateFields(error)
    if (fields.has('idempotencyKey')) {
      const resolution = await this.#resolutionByKey(input.idempotencyKey)
      const replay = this.#resolveExisting(resolution, input, requestHash)
      if (replay) return replay
    }

    if (fields.has('orderId') && fields.has('action')) {
      const order = await this.orders.getByOrderNumber(input.orderNumber)
      const completed = order
        ? await this.resolutions.findCompletedByOrderAndAction(order._id, ACTION)
        : null
      if (completed) {
        throw inventoryRepairError(
          'La reparacion de inventario ya fue completada',
          'ATTENTION_INVENTORY_REPAIR_ALREADY_COMPLETED'
        )
      }
    }

    throw new ServiceError(
      'No fue posible completar la reparacion de inventario',
      'INVENTORY_REPAIR_FAILED',
      500
    )
  }

  async repairApprovedOrderInventory(rawInput) {
    let input = null

    try {
      input = normalizeInput(rawInput)
      const requestHash = requestHashFor(input)

      const fastExisting = await this.#resolutionByKey(input.idempotencyKey)
      const fastReplay = this.#resolveExisting(fastExisting, input, requestHash)
      if (fastReplay) return fastReplay

      const repairAt = await this.#preflightRepairAt(input.orderNumber)
      const session = await this.mongoose.startSession()
      let result
      let transactionError = null

      try {
        await session.withTransaction(async () => {
          result = await this.#runAttempt(input, requestHash, repairAt, session)
          return result
        }, TRANSACTION_OPTIONS)
      } catch (error) {
        transactionError = error
      } finally {
        await session.endSession()
      }

      if (!transactionError) return result
      if (isDuplicateKey(transactionError)) {
        return await this.#resolveDuplicate(transactionError, input, requestHash)
      }
      throw transactionError
    } catch (error) {
      if (isDomainError(error)) throw error

      logError('Order inventory repair command failed', {
        orderNumber: input?.orderNumber || null,
        code: asText(error?.code || error?.name || 'UNKNOWN')
      })
      throw new ServiceError(
        'No fue posible completar la reparacion de inventario',
        'INVENTORY_REPAIR_FAILED',
        500
      )
    }
  }
}

export {
  ACTION as INVENTORY_REPAIR_ACTION,
  OrderInventoryRepairCommandService,
  buildInventoryRepairSummary,
  normalizeInput as normalizeInventoryRepairCommandInput,
  requestHashFor as inventoryRepairRequestHash,
  resultFromResolution as inventoryRepairResultFromResolution
}

export default new OrderInventoryRepairCommandService()
