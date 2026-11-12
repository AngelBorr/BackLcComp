import mongoose from 'mongoose'
import ProductUnitManager from '../dao/managers/productUnit.manager.js'
import {
  PLAN_OUTCOMES,
  normalizeSerial
} from './orderInventoryRepairPlanner.service.js'
import { normalizeInventoryRepairId } from './orderInventoryRepairRead.service.js'

const EXPLICIT_NULL_FIELDS = Object.freeze([
  'orderId',
  'orderItemId',
  'reservedByOrderId',
  'reservedAt',
  'reservationExpiresAt',
  'soldByOrderId',
  'soldAt'
])

class OrderInventoryRepairSelectorError extends Error {
  constructor(message, code, status, details = {}) {
    super(message)
    this.name = 'OrderInventoryRepairSelectorError'
    this.code = code
    this.status = status
    this.statusCode = status
    this.details = details
  }
}

const selectorError = (message, code, status = 400, details = {}) => (
  new OrderInventoryRepairSelectorError(message, code, status, details)
)

const invalidInput = (message, details = {}) => selectorError(
  message,
  'INVALID_INVENTORY_REPAIR_SELECTOR_INPUT',
  400,
  details
)

const ambiguousSelection = (message, details = {}) => selectorError(
  message,
  'AMBIGUOUS_REPAIR_CANDIDATE_SELECTION',
  409,
  details
)

const normalizeUniqueIds = (values, label) => {
  if (!Array.isArray(values)) throw invalidInput(`${label} debe ser un array`)

  const normalized = []
  const seen = new Set()

  for (const value of values) {
    const id = normalizeInventoryRepairId(value)
    if (!id) throw invalidInput(`${label} contiene un ID invalido`)
    if (seen.has(id)) throw invalidInput(`${label} contiene IDs duplicados`)
    seen.add(id)
    normalized.push(id)
  }

  return normalized
}

const toObjectIds = (normalizedIds) => normalizedIds.map(
  (id) => new mongoose.Types.ObjectId(id)
)

const hasExplicitNull = (value, field) => (
  Object.hasOwn(value, field) && value[field] === null
)

const isValidCandidateDate = (value) => (
  value instanceof Date && !Number.isNaN(value.getTime())
)

const isCanonicalProductUnitSerial = (value) => {
  const normalized = normalizeSerial(value)
  return normalized !== null && value === normalized
}

const compareCandidateOrder = (left, right) => {
  const dateDifference = left.createdAt.getTime() - right.createdAt.getTime()
  if (dateDifference !== 0) return dateDifference
  return left.id.localeCompare(right.id)
}

const validateCandidateSequence = ({
  candidates,
  productId,
  required,
  excludedIds,
  orderItemId
}) => {
  if (!Array.isArray(candidates) || candidates.length > required) {
    throw ambiguousSelection('La lectura de candidatos devolvio un resultado invalido', {
      orderItemId,
      productId,
      required
    })
  }

  const seen = new Set()
  const validated = []

  for (const candidate of candidates) {
    const candidateId = normalizeInventoryRepairId(candidate?._id)
    const candidateProductId = normalizeInventoryRepairId(candidate?.productId)
    const referencesAreClean = candidate && EXPLICIT_NULL_FIELDS.every(
      (field) => hasExplicitNull(candidate, field)
    )

    if (
      !candidateId ||
      candidateProductId !== productId ||
      candidate?.status !== 'available' ||
      candidate?.isDeleted !== false ||
      !isValidCandidateDate(candidate?.createdAt) ||
      !isCanonicalProductUnitSerial(candidate?.serialNumber) ||
      !referencesAreClean ||
      seen.has(candidateId) ||
      excludedIds.has(candidateId)
    ) {
      throw ambiguousSelection('La lectura devolvio un candidato ambiguo', {
        orderItemId,
        productId,
        productUnitId: candidateId
      })
    }

    const entry = { candidate, id: candidateId, createdAt: candidate.createdAt }
    const previous = validated.at(-1)
    if (previous && compareCandidateOrder(previous, entry) > 0) {
      throw ambiguousSelection('Los candidatos no respetan el orden FIFO', {
        orderItemId,
        productId,
        productUnitId: candidateId
      })
    }

    seen.add(candidateId)
    validated.push(entry)
  }

  return validated
}

const validatePlan = (plan) => {
  if (!plan || typeof plan !== 'object' || Array.isArray(plan)) {
    throw invalidInput('El plan de reparacion es invalido')
  }
  if (plan.outcome !== PLAN_OUTCOMES.READY || plan.repairable !== true) {
    throw invalidInput('El selector requiere un plan PLAN_READY reparable')
  }
  if (!Array.isArray(plan.blocked) || plan.blocked.length !== 0) {
    throw invalidInput('El plan contiene bloqueos')
  }

  const orderId = normalizeInventoryRepairId(plan.orderId)
  if (!orderId) throw invalidInput('El plan contiene una Order invalida')
  if (!Array.isArray(plan.items) || plan.items.length === 0) {
    throw invalidInput('El plan no contiene items validos')
  }
  if (!Number.isSafeInteger(plan.replacementCount) || plan.replacementCount < 0) {
    throw invalidInput('El total de replacements es invalido')
  }

  const globalExcludedIds = normalizeUniqueIds(
    plan.globalExcludedProductUnitIds,
    'Las exclusiones globales'
  )
  const globalExcludedSet = new Set(globalExcludedIds)
  const seenOrderItemIds = new Set()
  const seenReclaimIds = new Set()
  const items = []
  let replacementCount = 0

  for (const itemPlan of plan.items) {
    if (!itemPlan || typeof itemPlan !== 'object' || Array.isArray(itemPlan)) {
      throw invalidInput('El plan contiene un item invalido')
    }

    const orderItemId = normalizeInventoryRepairId(itemPlan.orderItemId)
    const productId = normalizeInventoryRepairId(itemPlan.productId)
    if (!orderItemId || !productId) {
      throw invalidInput('El plan contiene referencias de item invalidas')
    }
    if (seenOrderItemIds.has(orderItemId)) {
      throw invalidInput('El plan contiene OrderItems duplicados')
    }
    if (!Array.isArray(itemPlan.blocked) || itemPlan.blocked.length !== 0) {
      throw invalidInput('El item contiene bloqueos')
    }
    if (!Number.isSafeInteger(itemPlan.replacementCount) || itemPlan.replacementCount < 0) {
      throw invalidInput('El replacementCount del item es invalido', { orderItemId })
    }

    const reclaimEntries = itemPlan.reclaimAvailableOriginals
    if (!Array.isArray(reclaimEntries)) {
      throw invalidInput('Los reclaim del item deben ser un array', { orderItemId })
    }

    const reclaimUnitIds = []
    for (const entry of reclaimEntries) {
      const reclaimId = normalizeInventoryRepairId(entry?.productUnitId)
      if (!reclaimId) throw invalidInput('El plan contiene un reclaim invalido', { orderItemId })
      if (seenReclaimIds.has(reclaimId)) {
        throw invalidInput('El plan contiene reclaim IDs duplicados', { productUnitId: reclaimId })
      }
      if (!globalExcludedSet.has(reclaimId)) {
        throw invalidInput('Un reclaim no esta incluido en las exclusiones globales', {
          orderItemId,
          productUnitId: reclaimId
        })
      }
      seenReclaimIds.add(reclaimId)
      reclaimUnitIds.push(reclaimId)
    }

    seenOrderItemIds.add(orderItemId)
    replacementCount += itemPlan.replacementCount
    if (!Number.isSafeInteger(replacementCount)) {
      throw invalidInput('La suma de replacements excede el rango seguro')
    }
    items.push({
      orderItemId,
      productId,
      reclaimUnitIds,
      replacementCount: itemPlan.replacementCount
    })
  }

  if (replacementCount !== plan.replacementCount) {
    throw invalidInput('El total de replacements no coincide con los items')
  }

  return { orderId, globalExcludedIds, items }
}

class OrderInventoryRepairSelectorService {
  constructor({ productUnitManager = ProductUnitManager } = {}) {
    this.productUnits = productUnitManager
  }

  async selectCandidates(plan, { session } = {}) {
    const validatedPlan = validatePlan(plan)
    const executionExcludedIds = new Set(validatedPlan.globalExcludedIds)
    const byOrderItem = []
    const selectedNewProductUnitIds = []

    for (const itemPlan of validatedPlan.items) {
      let newReplacementCandidates = []
      let newReplacementCandidateIds = []

      if (itemPlan.replacementCount > 0) {
        const normalizedExclusions = [...executionExcludedIds].sort()
        const candidates = await this.productUnits.findAvailableRepairCandidates(
          {
            productId: new mongoose.Types.ObjectId(itemPlan.productId),
            excludeIds: toObjectIds(normalizedExclusions),
            limit: itemPlan.replacementCount
          },
          { session }
        )
        const validatedCandidates = validateCandidateSequence({
          candidates,
          productId: itemPlan.productId,
          required: itemPlan.replacementCount,
          excludedIds: executionExcludedIds,
          orderItemId: itemPlan.orderItemId
        })

        if (validatedCandidates.length < itemPlan.replacementCount) {
          throw selectorError(
            'No hay suficientes ProductUnits elegibles para reparar la Order',
            'INSUFFICIENT_REPAIR_INVENTORY',
            409,
            {
              orderItemId: itemPlan.orderItemId,
              productId: itemPlan.productId,
              required: itemPlan.replacementCount,
              available: validatedCandidates.length
            }
          )
        }

        newReplacementCandidates = validatedCandidates.map((entry) => entry.candidate)
        newReplacementCandidateIds = validatedCandidates.map((entry) => entry.id)

        for (const candidateId of newReplacementCandidateIds) {
          executionExcludedIds.add(candidateId)
          selectedNewProductUnitIds.push(candidateId)
        }
      }

      byOrderItem.push({
        orderItemId: itemPlan.orderItemId,
        productId: itemPlan.productId,
        reclaimUnitIds: [...itemPlan.reclaimUnitIds],
        newReplacementCandidates,
        newReplacementCandidateIds,
        replacementCount: itemPlan.replacementCount
      })
    }

    return {
      orderId: validatedPlan.orderId,
      byOrderItem,
      selectedNewProductUnitIds,
      finalExcludedProductUnitIds: [...executionExcludedIds].sort()
    }
  }
}

export {
  OrderInventoryRepairSelectorError,
  OrderInventoryRepairSelectorService,
  validateCandidateSequence,
  validatePlan
}

export default new OrderInventoryRepairSelectorService()
