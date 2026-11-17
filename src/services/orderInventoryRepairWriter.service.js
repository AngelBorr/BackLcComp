import mongoose from 'mongoose'
import ProductUnitManager from '../dao/managers/productUnit.manager.js'
import ProductUnitService from './productUnit.service.js'
import { normalizeInventoryRepairId } from './orderInventoryRepairRead.service.js'

const READY_PLAN_OUTCOME = 'PLAN_READY'
const EXPLICIT_NULL_FIELDS = Object.freeze([
  'orderId',
  'orderItemId',
  'reservedByOrderId',
  'reservedAt',
  'reservationExpiresAt',
  'soldByOrderId',
  'soldAt'
])

class OrderInventoryRepairWriterError extends Error {
  constructor(message, code, status, details = {}) {
    super(message)
    this.name = 'OrderInventoryRepairWriterError'
    this.code = code
    this.status = status
    this.statusCode = status
    this.details = details
  }
}

const writerError = (message, code, status = 400, details = {}) => (
  new OrderInventoryRepairWriterError(message, code, status, details)
)

const invalidInput = (message, details = {}) => writerError(
  message,
  'INVALID_INVENTORY_REPAIR_WRITE_INPUT',
  400,
  details
)

const casConflict = (details = {}) => writerError(
  'Las ProductUnits cambiaron durante la reparacion de inventario',
  'INVENTORY_REPAIR_CAS_CONFLICT',
  409,
  details
)

const finalStateConflict = (details = {}) => writerError(
  'El inventario vendido no coincide con la reparacion esperada',
  'INVENTORY_REPAIR_FINAL_STATE_CONFLICT',
  409,
  details
)

const assertActiveTransaction = (session) => {
  let isActive = false

  try {
    isActive = Boolean(
      session &&
      !session.hasEnded &&
      typeof session.inTransaction === 'function' &&
      session.inTransaction()
    )
  } catch {
    isActive = false
  }

  if (!isActive) {
    throw writerError(
      'La reparacion de inventario requiere una transaccion activa',
      'INVENTORY_REPAIR_TRANSACTION_REQUIRED',
      500
    )
  }
}

const normalizeRequiredId = (value, label) => {
  const id = normalizeInventoryRepairId(value)
  if (!id) throw invalidInput(`${label} es invalido`)
  return id
}

const normalizeUniqueIds = (values, label) => {
  if (!Array.isArray(values)) throw invalidInput(`${label} debe ser un array`)
  const normalized = []
  const seen = new Set()

  for (const value of values) {
    const id = normalizeRequiredId(value, label)
    if (seen.has(id)) throw invalidInput(`${label} contiene IDs duplicados`, { productUnitId: id })
    seen.add(id)
    normalized.push(id)
  }

  return normalized
}

const descriptorIds = (entries, label) => {
  if (!Array.isArray(entries)) throw invalidInput(`${label} debe ser un array`)
  return normalizeUniqueIds(entries.map((entry) => entry?.productUnitId), label)
}

const strictDate = (value, label) => {
  if (!(value instanceof Date) || Number.isNaN(value.getTime())) {
    throw invalidInput(`${label} debe ser una Date valida`)
  }
  return new Date(value.getTime())
}

const sameDate = (left, right) => (
  left instanceof Date &&
  right instanceof Date &&
  !Number.isNaN(left.getTime()) &&
  !Number.isNaN(right.getTime()) &&
  left.getTime() === right.getTime()
)

const nullish = (value) => value === null || value === undefined

const sameNullableDate = (left, right) => (
  nullish(left) && nullish(right)
) || sameDate(left, right)

const sameNullableId = (left, right) => {
  if (nullish(left) && nullish(right)) return true
  const leftId = normalizeInventoryRepairId(left)
  return leftId !== null && leftId === normalizeInventoryRepairId(right)
}

const hasExplicitNull = (value, field) => (
  Object.hasOwn(value, field) && value[field] === null
)

const isExplicitlyCleanAvailable = (unit) => (
  unit?.status === 'available' &&
  unit?.isDeleted === false &&
  EXPLICIT_NULL_FIELDS.every((field) => hasExplicitNull(unit, field))
)

const exactIdSet = (left, right) => (
  left.length === right.length &&
  [...left].sort().every((id, index) => id === [...right].sort()[index])
)

const indexById = (documents, label) => {
  if (!Array.isArray(documents)) throw invalidInput(`${label} debe ser un array`)
  const byId = new Map()

  for (const document of documents) {
    const id = normalizeRequiredId(document?._id, label)
    if (byId.has(id)) throw invalidInput(`${label} contiene IDs duplicados`, { id })
    byId.set(id, document)
  }

  return byId
}

const assertExactCounts = (result, expected, details) => {
  if (result?.matchedCount !== expected || result?.modifiedCount !== expected) {
    throw casConflict({
      ...details,
      expected,
      matchedCount: result?.matchedCount,
      modifiedCount: result?.modifiedCount
    })
  }
}

const toObjectId = (id) => new mongoose.Types.ObjectId(id)

const materializeRepair = ({ order, authoritativeInputs, plan, selection, repairAt } = {}) => {
  if (!order || typeof order !== 'object' || Array.isArray(order)) {
    throw invalidInput('La Order es invalida')
  }
  if (!authoritativeInputs || typeof authoritativeInputs !== 'object') {
    throw invalidInput('Las lecturas autoritativas son invalidas')
  }
  if (!plan || typeof plan !== 'object' || plan.outcome !== READY_PLAN_OUTCOME || plan.repairable !== true) {
    throw invalidInput('El writer requiere un plan PLAN_READY reparable')
  }
  if (!Array.isArray(plan.blocked) || plan.blocked.length !== 0) {
    throw invalidInput('El plan contiene bloqueos')
  }
  if (!selection || typeof selection !== 'object' || Array.isArray(selection)) {
    throw invalidInput('La seleccion de reparacion es invalida')
  }

  const orderId = normalizeRequiredId(order._id, 'La Order')
  if (
    normalizeRequiredId(plan.orderId, 'La Order del plan') !== orderId ||
    normalizeRequiredId(selection.orderId, 'La Order de la seleccion') !== orderId
  ) {
    throw invalidInput('La Order no coincide entre las entradas')
  }

  const normalizedRepairAt = strictDate(repairAt, 'repairAt')
  const reservationExpiresAt = strictDate(
    order.reservationExpiresAt,
    'order.reservationExpiresAt'
  )

  if (!Array.isArray(plan.items) || plan.items.length === 0) {
    throw invalidInput('El plan no contiene items')
  }
  if (!Array.isArray(selection.byOrderItem)) {
    throw invalidInput('La seleccion no contiene items')
  }

  const authoritativeItemById = indexById(
    authoritativeInputs.orderItems,
    'Los OrderItems autoritativos'
  )
  const authoritativeUnitById = indexById(
    authoritativeInputs.originalProductUnits,
    'Las ProductUnits autoritativas'
  )
  const selectionByItemId = new Map()

  for (const itemSelection of selection.byOrderItem) {
    const orderItemId = normalizeRequiredId(
      itemSelection?.orderItemId,
      'El OrderItem de la seleccion'
    )
    if (selectionByItemId.has(orderItemId)) {
      throw invalidInput('La seleccion contiene OrderItems duplicados', { orderItemId })
    }
    selectionByItemId.set(orderItemId, itemSelection)
  }

  const planItemIds = new Set()
  const globallyExpectedIds = new Set()
  const items = []
  const selectedIdsInPlanOrder = []
  let totalReplacementCount = 0

  for (const itemPlan of plan.items) {
    const orderItemId = normalizeRequiredId(itemPlan?.orderItemId, 'El OrderItem del plan')
    const productId = normalizeRequiredId(itemPlan?.productId, 'El Product del plan')
    if (planItemIds.has(orderItemId)) {
      throw invalidInput('El plan contiene OrderItems duplicados', { orderItemId })
    }
    planItemIds.add(orderItemId)

    const authoritativeItem = authoritativeItemById.get(orderItemId)
    const itemSelection = selectionByItemId.get(orderItemId)
    if (!authoritativeItem || !itemSelection) {
      throw invalidInput('Falta evidencia autoritativa o seleccion para un OrderItem', { orderItemId })
    }

    const quantity = authoritativeItem.quantity
    if (
      normalizeRequiredId(authoritativeItem.orderId, 'La Order del OrderItem') !== orderId ||
      normalizeRequiredId(authoritativeItem.productId, 'El Product del OrderItem') !== productId ||
      !Number.isSafeInteger(quantity) ||
      quantity <= 0 ||
      itemPlan.quantity !== quantity ||
      normalizeRequiredId(itemSelection.productId, 'El Product de la seleccion') !== productId
    ) {
      throw invalidInput('El OrderItem no coincide entre las entradas', { orderItemId })
    }
    if (!Array.isArray(itemPlan.blocked) || itemPlan.blocked.length !== 0) {
      throw invalidInput('El item del plan contiene bloqueos', { orderItemId })
    }
    if (!Number.isSafeInteger(itemPlan.replacementCount) || itemPlan.replacementCount < 0) {
      throw invalidInput('El replacementCount del item es invalido', { orderItemId })
    }
    if (itemSelection.replacementCount !== itemPlan.replacementCount) {
      throw invalidInput('El replacementCount no coincide con la seleccion', { orderItemId })
    }

    const preserveIds = descriptorIds(itemPlan.preserveReserved, 'preserveReserved')
    const alreadySoldIds = descriptorIds(itemPlan.alreadySold, 'alreadySold')
    const reclaimIds = descriptorIds(
      itemPlan.reclaimAvailableOriginals,
      'reclaimAvailableOriginals'
    )
    const selectedReclaimIds = normalizeUniqueIds(
      itemSelection.reclaimUnitIds,
      'Los reclaim IDs seleccionados'
    )
    if (!exactIdSet(reclaimIds, selectedReclaimIds)) {
      throw invalidInput('Los reclaim IDs no coinciden entre plan y seleccion', { orderItemId })
    }

    const replacementIds = normalizeUniqueIds(
      itemSelection.newReplacementCandidateIds,
      'Los replacement IDs seleccionados'
    )
    if (
      replacementIds.length !== itemPlan.replacementCount ||
      !Array.isArray(itemSelection.newReplacementCandidates) ||
      itemSelection.newReplacementCandidates.length !== replacementIds.length
    ) {
      throw invalidInput('Los replacements no coinciden con el plan', { orderItemId })
    }

    for (let index = 0; index < replacementIds.length; index += 1) {
      const candidate = itemSelection.newReplacementCandidates[index]
      if (
        normalizeRequiredId(candidate?._id, 'El replacement candidate') !== replacementIds[index] ||
        normalizeRequiredId(candidate?.productId, 'El Product del replacement') !== productId ||
        !isExplicitlyCleanAvailable(candidate)
      ) {
        throw invalidInput('Un replacement candidate no coincide con la seleccion', {
          orderItemId,
          productUnitId: replacementIds[index]
        })
      }
    }

    const expectedIds = [
      ...alreadySoldIds,
      ...preserveIds,
      ...reclaimIds,
      ...replacementIds
    ]
    if (new Set(expectedIds).size !== expectedIds.length || expectedIds.length !== quantity) {
      throw invalidInput('El conjunto esperado del OrderItem es invalido', { orderItemId })
    }

    for (const productUnitId of expectedIds) {
      if (globallyExpectedIds.has(productUnitId)) {
        throw invalidInput('Una ProductUnit aparece en mas de un OrderItem', { productUnitId })
      }
      globallyExpectedIds.add(productUnitId)
    }

    const evidenceById = new Map()
    const preserveUnits = preserveIds.map((productUnitId) => {
      const unit = authoritativeUnitById.get(productUnitId)
      if (
        !unit ||
        normalizeRequiredId(unit.productId, 'El Product de preserveReserved') !== productId ||
        unit.status !== 'reserved' ||
        unit.isDeleted !== false ||
        normalizeRequiredId(unit.orderId, 'La Order de preserveReserved') !== orderId ||
        normalizeRequiredId(unit.orderItemId, 'El OrderItem de preserveReserved') !== orderItemId ||
        normalizeRequiredId(unit.reservedByOrderId, 'La reserva de preserveReserved') !== orderId ||
        !hasExplicitNull(unit, 'soldByOrderId') ||
        !hasExplicitNull(unit, 'soldAt')
      ) {
        throw invalidInput('La evidencia preserveReserved es inconsistente', {
          orderItemId,
          productUnitId
        })
      }

      const evidence = {
        kind: 'preserve',
        snapshot: unit,
        reservedAt: strictDate(unit.reservedAt, 'preserveReserved.reservedAt'),
        reservationExpiresAt: strictDate(
          unit.reservationExpiresAt,
          'preserveReserved.reservationExpiresAt'
        )
      }
      evidenceById.set(productUnitId, evidence)
      return {
        productUnitId: toObjectId(productUnitId),
        reservedAt: evidence.reservedAt,
        reservationExpiresAt: evidence.reservationExpiresAt
      }
    })

    for (const productUnitId of reclaimIds) {
      const unit = authoritativeUnitById.get(productUnitId)
      if (
        !unit ||
        normalizeRequiredId(unit.productId, 'El Product del reclaim') !== productId ||
        !isExplicitlyCleanAvailable(unit)
      ) {
        throw invalidInput('La evidencia reclaim es inconsistente', {
          orderItemId,
          productUnitId
        })
      }
      evidenceById.set(productUnitId, { kind: 'available', snapshot: unit })
    }

    for (const productUnitId of replacementIds) {
      const index = replacementIds.indexOf(productUnitId)
      evidenceById.set(productUnitId, {
        kind: 'available',
        snapshot: itemSelection.newReplacementCandidates[index]
      })
    }

    for (const productUnitId of alreadySoldIds) {
      const unit = authoritativeUnitById.get(productUnitId)
      const reservedByTarget = normalizeInventoryRepairId(unit?.reservedByOrderId) === orderId
      const cleanReservationHistory = nullish(unit?.reservedByOrderId)
        ? nullish(unit?.reservedAt) && nullish(unit?.reservationExpiresAt)
        : reservedByTarget &&
          unit.reservedAt instanceof Date &&
          !Number.isNaN(unit.reservedAt.getTime()) &&
          unit.reservationExpiresAt instanceof Date &&
          !Number.isNaN(unit.reservationExpiresAt.getTime())

      if (
        !unit ||
        normalizeRequiredId(unit.productId, 'El Product de alreadySold') !== productId ||
        unit.status !== 'sold' ||
        unit.isDeleted !== false ||
        normalizeRequiredId(unit.orderId, 'La Order de alreadySold') !== orderId ||
        normalizeRequiredId(unit.orderItemId, 'El OrderItem de alreadySold') !== orderItemId ||
        normalizeRequiredId(unit.soldByOrderId, 'La venta de alreadySold') !== orderId ||
        !(unit.soldAt instanceof Date) ||
        Number.isNaN(unit.soldAt.getTime()) ||
        !cleanReservationHistory
      ) {
        throw invalidInput('La evidencia alreadySold es inconsistente', {
          orderItemId,
          productUnitId
        })
      }
      evidenceById.set(productUnitId, { kind: 'already', snapshot: unit })
    }

    const availableIds = [...reclaimIds, ...replacementIds]
    selectedIdsInPlanOrder.push(...replacementIds)
    totalReplacementCount += itemPlan.replacementCount
    if (!Number.isSafeInteger(totalReplacementCount)) {
      throw invalidInput('El total de replacements excede el rango seguro')
    }

    items.push({
      orderItemId,
      productId,
      quantity,
      preserveIds,
      alreadySoldIds,
      reclaimIds,
      replacementIds,
      preserveUnits,
      availableIds,
      expectedIds,
      evidenceById
    })
  }

  if (
    planItemIds.size !== authoritativeItemById.size ||
    planItemIds.size !== selectionByItemId.size
  ) {
    throw invalidInput('Los OrderItems no coinciden entre las entradas')
  }
  if (!Number.isSafeInteger(plan.replacementCount) || plan.replacementCount !== totalReplacementCount) {
    throw invalidInput('El total de replacements del plan es invalido')
  }

  const selectedGlobalIds = normalizeUniqueIds(
    selection.selectedNewProductUnitIds,
    'Los replacements globales seleccionados'
  )
  if (
    selectedGlobalIds.length !== selectedIdsInPlanOrder.length ||
    selectedGlobalIds.some((id, index) => id !== selectedIdsInPlanOrder[index])
  ) {
    throw invalidInput('Los replacements globales no coinciden con los items')
  }

  const affectedProductIds = [...new Set(
    items
      .filter((item) => item.preserveIds.length > 0 || item.availableIds.length > 0)
      .map((item) => item.productId)
  )].sort()
  const mutationItems = [...items].sort((left, right) => (
    left.productId.localeCompare(right.productId) ||
    left.orderItemId.localeCompare(right.orderItemId)
  ))

  return {
    orderId,
    repairAt: normalizedRepairAt,
    reservationExpiresAt,
    items,
    mutationItems,
    affectedProductIds,
    selectedNewProductUnitIds: selectedGlobalIds
  }
}

const verifyAlreadySoldMetadata = (actual, snapshot) => (
  actual.serialNumber === snapshot.serialNumber &&
  sameDate(actual.soldAt, snapshot.soldAt) &&
  sameNullableId(actual.reservedByOrderId, snapshot.reservedByOrderId) &&
  sameNullableDate(actual.reservedAt, snapshot.reservedAt) &&
  sameNullableDate(actual.reservationExpiresAt, snapshot.reservationExpiresAt)
)

const verifyItemFinalState = ({ actualUnits, item, context }) => {
  if (!Array.isArray(actualUnits)) {
    throw finalStateConflict({ orderItemId: item.orderItemId, reason: 'INVALID_READ_RESULT' })
  }

  const actualIds = []
  const seen = new Set()

  for (const unit of actualUnits) {
    const productUnitId = normalizeInventoryRepairId(unit?._id)
    if (!productUnitId || seen.has(productUnitId)) {
      throw finalStateConflict({
        orderItemId: item.orderItemId,
        productUnitId,
        reason: 'AMBIGUOUS_PRODUCT_UNIT_ID'
      })
    }
    seen.add(productUnitId)
    actualIds.push(productUnitId)

    const evidence = item.evidenceById.get(productUnitId)
    const commonValid = evidence &&
      unit.status === 'sold' &&
      unit.isDeleted === false &&
      normalizeInventoryRepairId(unit.orderId) === context.orderId &&
      normalizeInventoryRepairId(unit.orderItemId) === item.orderItemId &&
      normalizeInventoryRepairId(unit.productId) === item.productId &&
      normalizeInventoryRepairId(unit.soldByOrderId) === context.orderId &&
      unit.soldAt instanceof Date &&
      !Number.isNaN(unit.soldAt.getTime())

    if (!commonValid) {
      throw finalStateConflict({
        orderItemId: item.orderItemId,
        productUnitId,
        reason: 'INVALID_SOLD_METADATA'
      })
    }

    if (evidence.kind === 'preserve') {
      if (
        normalizeInventoryRepairId(unit.reservedByOrderId) !== context.orderId ||
        !sameDate(unit.reservedAt, evidence.reservedAt) ||
        !sameDate(unit.reservationExpiresAt, evidence.reservationExpiresAt) ||
        !sameDate(unit.soldAt, context.repairAt)
      ) {
        throw finalStateConflict({
          orderItemId: item.orderItemId,
          productUnitId,
          reason: 'PRESERVE_METADATA_MISMATCH'
        })
      }
    } else if (evidence.kind === 'available') {
      if (
        normalizeInventoryRepairId(unit.reservedByOrderId) !== context.orderId ||
        !sameDate(unit.reservedAt, context.repairAt) ||
        !sameDate(unit.reservationExpiresAt, context.reservationExpiresAt) ||
        !sameDate(unit.soldAt, context.repairAt)
      ) {
        throw finalStateConflict({
          orderItemId: item.orderItemId,
          productUnitId,
          reason: 'AVAILABLE_METADATA_MISMATCH'
        })
      }
    } else if (!verifyAlreadySoldMetadata(unit, evidence.snapshot)) {
      throw finalStateConflict({
        orderItemId: item.orderItemId,
        productUnitId,
        reason: 'ALREADY_SOLD_METADATA_MISMATCH'
      })
    }
  }

  if (!exactIdSet(actualIds, item.expectedIds)) {
    throw finalStateConflict({
      orderItemId: item.orderItemId,
      expectedIds: [...item.expectedIds].sort(),
      actualIds: [...actualIds].sort(),
      reason: 'SOLD_ID_SET_MISMATCH'
    })
  }

  return actualIds
}

class OrderInventoryRepairWriterService {
  constructor({
    productUnitManager = ProductUnitManager,
    productUnitService = ProductUnitService
  } = {}) {
    this.productUnits = productUnitManager
    this.productUnitService = productUnitService
  }

  async writeRepair(input, { session } = {}) {
    assertActiveTransaction(session)
    const context = materializeRepair(input)

    if (context.affectedProductIds.length > 0) {
      await this.productUnitService.acquireInventoryRepairGuards(
        context.affectedProductIds,
        { session }
      )
    }

    for (const item of context.mutationItems) {
      if (item.preserveUnits.length > 0) {
        const result = await this.productUnits.markExactReservedUnitsSoldForRepair(
          {
            units: item.preserveUnits,
            orderId: toObjectId(context.orderId),
            orderItemId: toObjectId(item.orderItemId),
            productId: toObjectId(item.productId),
            repairAt: context.repairAt
          },
          { session }
        )
        assertExactCounts(result, item.preserveUnits.length, {
          orderItemId: item.orderItemId,
          operation: 'reserved_to_sold'
        })
      }

      if (item.availableIds.length > 0) {
        const result = await this.productUnits.markExactAvailableUnitsSoldForRepair(
          {
            unitIds: item.availableIds.map(toObjectId),
            orderId: toObjectId(context.orderId),
            orderItemId: toObjectId(item.orderItemId),
            productId: toObjectId(item.productId),
            repairAt: context.repairAt,
            reservationExpiresAt: context.reservationExpiresAt
          },
          { session }
        )
        assertExactCounts(result, item.availableIds.length, {
          orderItemId: item.orderItemId,
          operation: 'available_to_sold'
        })
      }
    }

    for (const productId of context.affectedProductIds) {
      await this.productUnitService.recalculateProductStock(productId, { session })
    }

    const verifiedSoldProductUnitIds = []
    for (const item of context.mutationItems) {
      const actualUnits = await this.productUnits.getSoldUnitsForOrderItem(
        {
          orderId: toObjectId(context.orderId),
          orderItemId: toObjectId(item.orderItemId),
          productId: toObjectId(item.productId)
        },
        { session }
      )
      verifiedSoldProductUnitIds.push(...verifyItemFinalState({ actualUnits, item, context }))
    }

    const itemById = new Map(context.items.map((item) => [item.orderItemId, item]))

    return {
      orderId: context.orderId,
      repairAt: context.repairAt,
      affectedProductIds: [...context.affectedProductIds],
      selectedNewProductUnitIds: [...context.selectedNewProductUnitIds],
      byOrderItem: context.items.map((sourceItem) => {
        const item = itemById.get(sourceItem.orderItemId)
        return {
          orderItemId: item.orderItemId,
          productId: item.productId,
          expectedSoldProductUnitIds: [...item.expectedIds],
          preserveSoldCount: item.preserveIds.length,
          reclaimedSoldCount: item.reclaimIds.length,
          replacementSoldCount: item.replacementIds.length,
          alreadySoldCount: item.alreadySoldIds.length
        }
      }),
      verifiedSoldProductUnitIds: [...verifiedSoldProductUnitIds].sort()
    }
  }
}

export {
  OrderInventoryRepairWriterError,
  OrderInventoryRepairWriterService,
  assertActiveTransaction,
  materializeRepair,
  verifyItemFinalState
}

export default new OrderInventoryRepairWriterService()
