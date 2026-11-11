import {
  ATTENTION_CATEGORIES,
  classifyAttention
} from './orderAttention.service.js'
import { toMinorUnits } from '../utils/commerceMoney.js'

const ORIGINAL_UNIT_CLASSIFICATIONS = Object.freeze({
  VALID_ORIGINAL: 'VALID_ORIGINAL',
  RECLAIMABLE_ORIGINAL: 'RECLAIMABLE_ORIGINAL',
  ALREADY_SATISFIED: 'ALREADY_SATISFIED',
  REPLACEABLE_DEFICIT: 'REPLACEABLE_DEFICIT',
  HARD_CONFLICT: 'HARD_CONFLICT',
  DATA_CORRUPTION: 'DATA_CORRUPTION'
})

const PLAN_OUTCOMES = Object.freeze({
  READY: 'PLAN_READY',
  NOT_ALLOWED: 'NOT_ALLOWED',
  BLOCKED: 'BLOCKED'
})

const OBJECT_ID_PATTERN = /^[a-f0-9]{24}$/i
const ISO_UTC_PATTERN = /^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2})(?:\.(\d{1,3}))?Z$/

const normalizeId = (value) => {
  if (typeof value === 'string') {
    const id = value.trim()
    return OBJECT_ID_PATTERN.test(id) ? id.toLowerCase() : null
  }
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null

  try {
    const candidate = typeof value.toHexString === 'function'
      ? value.toHexString()
      : typeof value.toString === 'function'
        ? value.toString()
        : null
    if (typeof candidate !== 'string') return null
    const id = candidate.trim()
    return OBJECT_ID_PATTERN.test(id) ? id.toLowerCase() : null
  } catch {
    return null
  }
}
const sameId = (left, right) => {
  const leftId = normalizeId(left)
  return leftId !== null && leftId === normalizeId(right)
}
const normalizeSerial = (value) => {
  if (typeof value !== 'string') return null
  const serial = value.trim().toUpperCase()
  return serial || null
}
const isNullish = (value) => value === null || value === undefined

const isValidDate = (value) => {
  if (value instanceof Date) return !Number.isNaN(value.getTime())
  if (typeof value !== 'string') return false

  const match = ISO_UTC_PATTERN.exec(value)
  if (!match) return false
  const milliseconds = (match[2] || '').padEnd(3, '0')
  const canonical = `${match[1]}.${milliseconds}Z`
  const date = new Date(canonical)
  return !Number.isNaN(date.getTime()) && date.toISOString() === canonical
}

const unitId = (unit) => normalizeId(unit?._id ?? unit?.productUnitId)

const descriptor = (ledgerUnit, unit, category, reason) => ({
  productUnitId: normalizeId(ledgerUnit?.productUnitId),
  serial: normalizeSerial(ledgerUnit?.serial),
  currentStatus: unit && typeof unit.status === 'string' ? unit.status : null,
  category,
  reason
})

const operationalReferencesAreClean = (unit) => [
  unit?.orderId,
  unit?.orderItemId,
  unit?.reservedByOrderId,
  unit?.reservedAt,
  unit?.reservationExpiresAt,
  unit?.soldByOrderId,
  unit?.soldAt
].every(isNullish)

const hasSaleResidue = (unit) => !isNullish(unit?.soldByOrderId) || !isNullish(unit?.soldAt)

const externalOrderItemEvidence = (externalOrderItemsById, orderItemId) => {
  const normalizedOrderItemId = normalizeId(orderItemId)
  if (!normalizedOrderItemId) return { found: false, item: null, ambiguous: false }

  const entries = externalOrderItemsById instanceof Map
    ? [...externalOrderItemsById.entries()]
    : externalOrderItemsById &&
        typeof externalOrderItemsById === 'object' &&
        !Array.isArray(externalOrderItemsById)
      ? Object.entries(externalOrderItemsById)
      : []
  const matches = entries.filter(([key]) => normalizeId(key) === normalizedOrderItemId)

  if (matches.length === 0) return { found: false, item: null, ambiguous: false }
  if (matches.length > 1) {
    const fingerprints = new Set(matches.map(([, item]) => [
      normalizeId(item?._id),
      normalizeId(item?.orderId),
      normalizeId(item?.productId)
    ].join(':')))
    if (fingerprints.size > 1) return { found: true, item: null, ambiguous: true }
  }

  return { found: true, item: matches[0][1], ambiguous: false }
}

const inspectExternalOrderItemOwnership = ({
  externalOrderItemsById,
  orderItemId,
  ownerOrderId,
  productId
}) => {
  const evidence = externalOrderItemEvidence(externalOrderItemsById, orderItemId)
  if (!evidence.found) {
    return { verified: false, reason: 'EXTERNAL_ORDER_ITEM_OWNERSHIP_UNVERIFIED' }
  }
  if (evidence.ambiguous) {
    return { verified: false, reason: 'EXTERNAL_ORDER_ITEM_OWNERSHIP_AMBIGUOUS' }
  }
  if (
    !evidence.item ||
    !sameId(evidence.item._id, orderItemId) ||
    !sameId(evidence.item.orderId, ownerOrderId)
  ) {
    return { verified: false, reason: 'EXTERNAL_ORDER_ITEM_OWNERSHIP_MISMATCH' }
  }
  if (!sameId(evidence.item.productId, productId)) {
    return { verified: false, reason: 'EXTERNAL_ORDER_ITEM_PRODUCT_MISMATCH' }
  }
  return { verified: true, reason: null }
}

const isCoherentOtherReservationState = (unit, targetOrderId, targetOrderItemId) => {
  const ownerOrderId = normalizeId(unit?.orderId)
  return ownerOrderId !== null &&
    !sameId(ownerOrderId, targetOrderId) &&
    sameId(unit?.reservedByOrderId, ownerOrderId) &&
    normalizeId(unit?.orderItemId) !== null &&
    !sameId(unit?.orderItemId, targetOrderItemId) &&
    isValidDate(unit?.reservedAt) &&
    isValidDate(unit?.reservationExpiresAt) &&
    isNullish(unit?.soldByOrderId) &&
    isNullish(unit?.soldAt)
}

const soldReservationMetadataIsCoherent = (unit, ownerOrderId) => {
  if (isNullish(unit?.reservedByOrderId)) {
    return isNullish(unit?.reservedAt) && isNullish(unit?.reservationExpiresAt)
  }
  return sameId(unit.reservedByOrderId, ownerOrderId) &&
    isValidDate(unit.reservedAt) &&
    isValidDate(unit.reservationExpiresAt)
}

const isCoherentOtherSaleState = (unit, targetOrderId, targetOrderItemId) => {
  const ownerOrderId = normalizeId(unit?.orderId)
  return ownerOrderId !== null &&
    !sameId(ownerOrderId, targetOrderId) &&
    sameId(unit?.soldByOrderId, ownerOrderId) &&
    normalizeId(unit?.orderItemId) !== null &&
    !sameId(unit?.orderItemId, targetOrderItemId) &&
    isValidDate(unit?.soldAt) &&
    soldReservationMetadataIsCoherent(unit, ownerOrderId)
}

const classifyOriginalUnit = ({
  order,
  orderItem,
  ledgerUnit,
  productUnit,
  externalOrderItemsById = {}
}) => {
  const categories = ORIGINAL_UNIT_CLASSIFICATIONS

  if (!productUnit) {
    return descriptor(
      ledgerUnit,
      null,
      categories.DATA_CORRUPTION,
      'ORIGINAL_PRODUCT_UNIT_MISSING'
    )
  }

  if (!sameId(productUnit.productId, orderItem.productId)) {
    return descriptor(
      ledgerUnit,
      productUnit,
      categories.DATA_CORRUPTION,
      'ORIGINAL_PRODUCT_MISMATCH'
    )
  }

  const historicalSerial = normalizeSerial(ledgerUnit?.serial)
  const currentSerial = normalizeSerial(productUnit.serialNumber)
  if (!historicalSerial || !currentSerial) {
    return descriptor(
      ledgerUnit,
      productUnit,
      categories.DATA_CORRUPTION,
      'ORIGINAL_SERIAL_INVALID'
    )
  }

  if (currentSerial !== historicalSerial) {
    return descriptor(
      ledgerUnit,
      productUnit,
      categories.DATA_CORRUPTION,
      'ORIGINAL_SERIAL_MISMATCH'
    )
  }

  if (productUnit.isDeleted !== false && productUnit.isDeleted !== true) {
    return descriptor(
      ledgerUnit,
      productUnit,
      categories.DATA_CORRUPTION,
      'ORIGINAL_DELETION_STATE_INVALID'
    )
  }

  if (productUnit.isDeleted === true) {
    return operationalReferencesAreClean(productUnit)
      ? descriptor(
        ledgerUnit,
        productUnit,
        categories.REPLACEABLE_DEFICIT,
        'SOFT_DELETED_ORIGINAL_UNASSIGNED'
      )
      : descriptor(
        ledgerUnit,
        productUnit,
        categories.DATA_CORRUPTION,
        'SOFT_DELETED_ORIGINAL_HAS_OPERATIONAL_STATE'
      )
  }

  const status = productUnit.status

  if (status === 'available') {
    if (operationalReferencesAreClean(productUnit)) {
      return descriptor(
        ledgerUnit,
        productUnit,
        categories.RECLAIMABLE_ORIGINAL,
        'AVAILABLE_ORIGINAL_CLEAN'
      )
    }

    return descriptor(
      ledgerUnit,
      productUnit,
      hasSaleResidue(productUnit) ? categories.DATA_CORRUPTION : categories.HARD_CONFLICT,
      hasSaleResidue(productUnit)
        ? 'AVAILABLE_ORIGINAL_HAS_SALE_RESIDUE'
        : 'AVAILABLE_ORIGINAL_HAS_RESERVATION_RESIDUE'
    )
  }

  if (status === 'reserved') {
    const ownedByTarget = sameId(productUnit.orderId, order._id) &&
      sameId(productUnit.orderItemId, orderItem._id) &&
      sameId(productUnit.reservedByOrderId, order._id)

    if (ownedByTarget) {
      if (!isNullish(productUnit.soldByOrderId) || !isNullish(productUnit.soldAt)) {
        return descriptor(
          ledgerUnit,
          productUnit,
          categories.HARD_CONFLICT,
          'RESERVED_ORIGINAL_HAS_SALE_STATE'
        )
      }
      if (!isValidDate(productUnit.reservedAt) || !isValidDate(productUnit.reservationExpiresAt)) {
        return descriptor(
          ledgerUnit,
          productUnit,
          categories.DATA_CORRUPTION,
          'RESERVED_ORIGINAL_INVALID_TIMESTAMPS'
        )
      }
      return descriptor(
        ledgerUnit,
        productUnit,
        categories.VALID_ORIGINAL,
        'RESERVED_ORIGINAL_OWNERSHIP_VALID'
      )
    }

    if (!isCoherentOtherReservationState(productUnit, order._id, orderItem._id)) {
      return descriptor(
        ledgerUnit,
        productUnit,
        categories.HARD_CONFLICT,
        'RESERVED_ORIGINAL_OWNERSHIP_CONFLICT'
      )
    }

    const externalOwnership = inspectExternalOrderItemOwnership({
      externalOrderItemsById,
      orderItemId: productUnit.orderItemId,
      ownerOrderId: productUnit.orderId,
      productId: productUnit.productId
    })
    return externalOwnership.verified
      ? descriptor(
        ledgerUnit,
        productUnit,
        categories.REPLACEABLE_DEFICIT,
        'ORIGINAL_RESERVED_BY_ANOTHER_ORDER'
      )
      : descriptor(
        ledgerUnit,
        productUnit,
        categories.HARD_CONFLICT,
        externalOwnership.reason
      )
  }

  if (status === 'sold') {
    const soldByTarget = sameId(productUnit.orderId, order._id) &&
      sameId(productUnit.orderItemId, orderItem._id) &&
      sameId(productUnit.soldByOrderId, order._id)

    if (soldByTarget) {
      if (!isValidDate(productUnit.soldAt)) {
        return descriptor(
          ledgerUnit,
          productUnit,
          categories.DATA_CORRUPTION,
          'SOLD_ORIGINAL_INVALID_TIMESTAMP'
        )
      }
      if (
        !isNullish(productUnit.reservedByOrderId) &&
        !sameId(productUnit.reservedByOrderId, order._id)
      ) {
        return descriptor(
          ledgerUnit,
          productUnit,
          categories.HARD_CONFLICT,
          'SOLD_ORIGINAL_RESERVATION_OWNER_CONFLICT'
        )
      }
      if (!soldReservationMetadataIsCoherent(productUnit, order._id)) {
        return descriptor(
          ledgerUnit,
          productUnit,
          categories.DATA_CORRUPTION,
          'SOLD_ORIGINAL_RESERVATION_METADATA_INVALID'
        )
      }
      return descriptor(
        ledgerUnit,
        productUnit,
        categories.ALREADY_SATISFIED,
        'ORIGINAL_ALREADY_SOLD_BY_TARGET_ORDER'
      )
    }

    if (!isCoherentOtherSaleState(productUnit, order._id, orderItem._id)) {
      return descriptor(
        ledgerUnit,
        productUnit,
        categories.HARD_CONFLICT,
        'SOLD_ORIGINAL_OWNERSHIP_CONFLICT'
      )
    }

    const externalOwnership = inspectExternalOrderItemOwnership({
      externalOrderItemsById,
      orderItemId: productUnit.orderItemId,
      ownerOrderId: productUnit.orderId,
      productId: productUnit.productId
    })
    return externalOwnership.verified
      ? descriptor(
        ledgerUnit,
        productUnit,
        categories.REPLACEABLE_DEFICIT,
        'ORIGINAL_SOLD_BY_ANOTHER_ORDER'
      )
      : descriptor(
        ledgerUnit,
        productUnit,
        categories.HARD_CONFLICT,
        externalOwnership.reason
      )
  }

  if (['inactive', 'warranty', 'returned'].includes(status)) {
    return operationalReferencesAreClean(productUnit)
      ? descriptor(
        ledgerUnit,
        productUnit,
        categories.REPLACEABLE_DEFICIT,
        'ORIGINAL_NOT_ALLOCATABLE_AND_UNASSIGNED'
      )
      : descriptor(
        ledgerUnit,
        productUnit,
        hasSaleResidue(productUnit) ? categories.DATA_CORRUPTION : categories.HARD_CONFLICT,
        'ORIGINAL_NOT_ALLOCATABLE_HAS_OPERATIONAL_STATE'
      )
  }

  return descriptor(
    ledgerUnit,
    productUnit,
    categories.DATA_CORRUPTION,
    'ORIGINAL_STATUS_INVALID'
  )
}

const nonEmptyString = (value) => typeof value === 'string' && value.trim() !== ''

const moneyMatches = (left, right) => {
  if (isNullish(left) || isNullish(right)) return false
  try {
    return toMinorUnits(left) === toMinorUnits(right)
  } catch {
    return false
  }
}

const approvedPaymentEvidenceBlockers = ({ order, payment }) => {
  const blockers = []
  const orderNumber = typeof order?.orderNumber === 'string'
    ? order.orderNumber.trim().toUpperCase()
    : ''
  const paymentCurrency = typeof payment?.currency === 'string'
    ? payment.currency.trim().toUpperCase()
    : ''
  const orderCurrency = typeof order?.paymentCurrency === 'string'
    ? order.paymentCurrency.trim().toUpperCase()
    : ''
  const externalReference = typeof payment?.externalReference === 'string'
    ? payment.externalReference.trim().toUpperCase()
    : ''

  if (payment?.provider !== 'mercado_pago') blockers.push('PAYMENT_PROVIDER_MISMATCH')
  if (!nonEmptyString(payment?.providerPaymentId)) {
    blockers.push('PROVIDER_PAYMENT_ID_REQUIRED')
  }
  if (!nonEmptyString(payment?.providerOrderId)) blockers.push('PROVIDER_ORDER_ID_REQUIRED')
  if (!isValidDate(payment?.approvedAt)) blockers.push('PAYMENT_APPROVED_AT_INVALID')
  if (!moneyMatches(order?.totals?.totalArs, payment?.amountArs)) {
    blockers.push('PAYMENT_AMOUNT_MISMATCH')
  }
  if (!orderCurrency || paymentCurrency !== orderCurrency) {
    blockers.push('PAYMENT_CURRENCY_MISMATCH')
  }
  if (!orderNumber || externalReference !== orderNumber) {
    blockers.push('PAYMENT_EXTERNAL_REFERENCE_MISMATCH')
  }

  return blockers
}

const evaluateInventoryRepairEligibility = ({ order, payment } = {}) => {
  const blockers = []

  if (!order || typeof order !== 'object' || Array.isArray(order)) {
    blockers.push('ORDER_REQUIRED')
  }
  if (!payment || typeof payment !== 'object' || Array.isArray(payment)) {
    blockers.push('PAYMENT_REQUIRED')
  }

  if (blockers.length) {
    return { allowed: false, outcome: PLAN_OUTCOMES.NOT_ALLOWED, blockers }
  }

  if (order.status !== 'requires_attention') blockers.push('ORDER_NOT_REQUIRES_ATTENTION')
  if (payment.normalizedStatus !== 'approved') blockers.push('PAYMENT_NOT_APPROVED')
  if (!sameId(payment.orderId, order._id)) blockers.push('PAYMENT_ORDER_MISMATCH')
  if (order.fulfillmentStatus !== 'pending') blockers.push('FULFILLMENT_NOT_PENDING')
  if (!isNullish(order.activeRefundId)) blockers.push('ACTIVE_REFUND_PRESENT')

  blockers.push(...approvedPaymentEvidenceBlockers({ order, payment }))

  const attention = classifyAttention({ order, payment })
  if (attention.attentionCategory !== ATTENTION_CATEGORIES.APPROVED_INVENTORY) {
    blockers.push('ATTENTION_CATEGORY_NOT_APPROVED_INVENTORY')
  }

  return {
    allowed: blockers.length === 0,
    outcome: blockers.length === 0 ? 'ELIGIBLE' : PLAN_OUTCOMES.NOT_ALLOWED,
    attentionCategory: attention.attentionCategory,
    blockers
  }
}

const structuralBlocker = (reason, details = {}) => ({
  category: ORIGINAL_UNIT_CLASSIFICATIONS.DATA_CORRUPTION,
  reason,
  ...details
})

const buildInventoryRepairPlan = ({
  order,
  payment,
  orderItems = [],
  originalProductUnits = [],
  currentProductUnits = [],
  externalOrderItemsById = {}
} = {}) => {
  const eligibility = evaluateInventoryRepairEligibility({ order, payment })
  const itemInputs = Array.isArray(orderItems) ? orderItems : []
  const originalUnitsInput = Array.isArray(originalProductUnits) ? originalProductUnits : []
  const currentUnitsInput = Array.isArray(currentProductUnits) ? currentProductUnits : []
  const itemPlans = []
  const itemPlanById = new Map()
  const ledgerOwnerByUnitId = new Map()
  const originalUnitById = new Map()
  const globalBlocked = []
  const seenOrderItemIds = new Set()

  if (!Array.isArray(orderItems) || itemInputs.length === 0) {
    globalBlocked.push(structuralBlocker('ORDER_ITEMS_MISSING'))
  }

  for (const unit of originalUnitsInput) {
    const id = unitId(unit)
    if (!id) {
      globalBlocked.push(structuralBlocker('ORIGINAL_PRODUCT_UNIT_WITHOUT_ID'))
      continue
    }
    if (originalUnitById.has(id)) {
      globalBlocked.push(structuralBlocker('DUPLICATE_ORIGINAL_PRODUCT_UNIT_INPUT', {
        productUnitId: id
      }))
      continue
    }
    originalUnitById.set(id, unit)
  }

  for (const item of itemInputs) {
    const orderItemId = normalizeId(item?._id)
    const productId = normalizeId(item?.productId)
    const quantity = item?.quantity
    const quantityIsValid = typeof quantity === 'number' &&
      Number.isSafeInteger(quantity) &&
      quantity > 0
    const plan = {
      orderItemId: orderItemId || null,
      productId: productId || null,
      quantity: quantityIsValid ? quantity : null,
      preserveReserved: [],
      alreadySold: [],
      reclaimAvailableOriginals: [],
      replaceableDeficitOriginals: [],
      replacementCount: 0,
      blocked: []
    }
    itemPlans.push(plan)
    if (orderItemId) {
      if (seenOrderItemIds.has(orderItemId)) {
        plan.blocked.push(structuralBlocker('DUPLICATE_ORDER_ITEM_ID'))
        itemPlanById.get(orderItemId)?.blocked.push(structuralBlocker('DUPLICATE_ORDER_ITEM_ID'))
      } else {
        seenOrderItemIds.add(orderItemId)
        itemPlanById.set(orderItemId, plan)
      }
    }

    if (!orderItemId || !productId || !quantityIsValid) {
      plan.blocked.push(structuralBlocker('ORDER_ITEM_STRUCTURE_INVALID'))
      continue
    }
    if (!sameId(item.orderId, order?._id)) {
      plan.blocked.push(structuralBlocker('ORDER_ITEM_ORDER_MISMATCH'))
      continue
    }

    const ledger = item.originalReservation
    if (ledger === undefined) {
      plan.blocked.push(structuralBlocker('ORIGINAL_RESERVATION_ABSENT'))
      continue
    }
    if (ledger === null) {
      plan.blocked.push(structuralBlocker('ORIGINAL_RESERVATION_NULL'))
      continue
    }
    if (!isValidDate(ledger.capturedAt)) {
      plan.blocked.push(structuralBlocker('ORIGINAL_RESERVATION_CAPTURED_AT_INVALID'))
    }
    if (!Array.isArray(ledger.units) || ledger.units.length !== quantity) {
      plan.blocked.push(structuralBlocker('ORIGINAL_RESERVATION_QUANTITY_MISMATCH'))
      continue
    }

    const itemUnitIds = new Set()
    for (const ledgerUnit of ledger.units) {
      const id = normalizeId(ledgerUnit?.productUnitId)
      const serial = normalizeSerial(ledgerUnit?.serial)
      if (!id || !serial) {
        plan.blocked.push(structuralBlocker('ORIGINAL_RESERVATION_UNIT_INVALID', {
          productUnitId: id || null
        }))
        continue
      }
      if (itemUnitIds.has(id)) {
        plan.blocked.push(structuralBlocker('ORIGINAL_RESERVATION_DUPLICATE_ID', {
          productUnitId: id
        }))
        continue
      }
      itemUnitIds.add(id)

      const previousOwner = ledgerOwnerByUnitId.get(id)
      if (previousOwner && previousOwner !== orderItemId) {
        plan.blocked.push(structuralBlocker('ORIGINAL_PRODUCT_UNIT_SHARED_BETWEEN_ITEMS', {
          productUnitId: id,
          otherOrderItemId: previousOwner
        }))
        const previousPlan = itemPlanById.get(previousOwner)
        previousPlan?.blocked.push(structuralBlocker(
          'ORIGINAL_PRODUCT_UNIT_SHARED_BETWEEN_ITEMS',
          { productUnitId: id, otherOrderItemId: orderItemId }
        ))
      } else {
        ledgerOwnerByUnitId.set(id, orderItemId)
      }
    }
  }

  const targetOrderId = normalizeId(order?._id)
  // Phase 2 must return a completed reassign_inventory resolution before invoking
  // this planner again. A target assignment absent from the immutable ledger is
  // intentionally indistinguishable from corruption during a first execution.
  for (const unit of currentUnitsInput) {
    const id = unitId(unit)
    if (!id || ledgerOwnerByUnitId.has(id)) continue
    const referencesTargetOrder = [unit?.orderId, unit?.reservedByOrderId, unit?.soldByOrderId]
      .some((value) => sameId(value, targetOrderId))
    if (referencesTargetOrder) {
      globalBlocked.push({
        category: ORIGINAL_UNIT_CLASSIFICATIONS.HARD_CONFLICT,
        reason: 'UNTRACKED_PRODUCT_UNIT_ASSIGNED_TO_ORDER',
        productUnitId: id
      })
    }
  }

  for (const item of itemInputs) {
    const plan = itemPlanById.get(normalizeId(item?._id))
    if (!plan || plan.blocked.length) continue

    for (const ledgerUnit of item.originalReservation.units) {
      const classification = classifyOriginalUnit({
        order,
        orderItem: item,
        ledgerUnit,
        productUnit: originalUnitById.get(normalizeId(ledgerUnit.productUnitId)),
        externalOrderItemsById
      })

      switch (classification.category) {
        case ORIGINAL_UNIT_CLASSIFICATIONS.VALID_ORIGINAL:
          plan.preserveReserved.push(classification)
          break
        case ORIGINAL_UNIT_CLASSIFICATIONS.RECLAIMABLE_ORIGINAL:
          plan.reclaimAvailableOriginals.push(classification)
          break
        case ORIGINAL_UNIT_CLASSIFICATIONS.ALREADY_SATISFIED:
          plan.alreadySold.push(classification)
          break
        case ORIGINAL_UNIT_CLASSIFICATIONS.REPLACEABLE_DEFICIT:
          plan.replaceableDeficitOriginals.push(classification)
          break
        default:
          plan.blocked.push(classification)
      }
    }

    plan.replacementCount = Math.max(
      0,
      plan.quantity -
        plan.preserveReserved.length -
        plan.alreadySold.length -
        plan.reclaimAvailableOriginals.length
    )
  }

  const blocked = [
    ...globalBlocked,
    ...itemPlans.flatMap((plan) => plan.blocked.map((entry) => ({
      orderItemId: plan.orderItemId,
      ...entry
    })))
  ]
  const repairable = eligibility.allowed && blocked.length === 0
  const excludedIds = new Set(ledgerOwnerByUnitId.keys())
  for (const unit of currentUnitsInput) {
    const id = unitId(unit)
    if (id) excludedIds.add(id)
  }

  return {
    outcome: !eligibility.allowed
      ? PLAN_OUTCOMES.NOT_ALLOWED
      : blocked.length
        ? PLAN_OUTCOMES.BLOCKED
        : PLAN_OUTCOMES.READY,
    repairable,
    eligibility,
    orderId: targetOrderId || null,
    items: itemPlans,
    replacementCount: itemPlans.reduce((total, item) => total + item.replacementCount, 0),
    globalExcludedProductUnitIds: [...excludedIds].sort(),
    blocked
  }
}

export {
  ORIGINAL_UNIT_CLASSIFICATIONS,
  PLAN_OUTCOMES,
  buildInventoryRepairPlan,
  classifyOriginalUnit,
  evaluateInventoryRepairEligibility,
  normalizeSerial
}

export default {
  buildInventoryRepairPlan,
  evaluateInventoryRepairEligibility
}
