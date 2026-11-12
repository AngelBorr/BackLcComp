import OrderItemManager from '../dao/managers/orderItem.manager.js'
import ProductUnitManager from '../dao/managers/productUnit.manager.js'

const OBJECT_ID_PATTERN = /^[a-f0-9]{24}$/i

class OrderInventoryRepairReadError extends Error {
  constructor(message, code) {
    super(message)
    this.name = 'OrderInventoryRepairReadError'
    this.code = code
    this.status = 400
    this.statusCode = 400
  }
}

const normalizeInventoryRepairId = (value) => {
  if (typeof value === 'string') {
    const id = value.trim()
    return OBJECT_ID_PATTERN.test(id) ? id.toLowerCase() : null
  }

  if (!value || typeof value !== 'object' || Array.isArray(value)) return null

  try {
    if (typeof value.toHexString !== 'function') return null
    const id = value.toHexString().trim()
    return OBJECT_ID_PATTERN.test(id) ? id.toLowerCase() : null
  } catch {
    return null
  }
}

const normalizeRequestedIds = (values, { invalidCode, duplicateCode, label }) => {
  if (!Array.isArray(values)) {
    throw new OrderInventoryRepairReadError(`${label} debe ser un array`, invalidCode)
  }

  const normalized = []
  const seen = new Set()

  for (const value of values) {
    const id = normalizeInventoryRepairId(value)
    if (!id) {
      throw new OrderInventoryRepairReadError(`${label} contiene un ID invalido`, invalidCode)
    }
    if (seen.has(id)) {
      throw new OrderInventoryRepairReadError(`${label} contiene IDs duplicados`, duplicateCode)
    }
    seen.add(id)
    normalized.push(id)
  }

  return normalized
}

const indexExactResults = (requestedIds, documents, { invalidCode, label }) => {
  if (!Array.isArray(documents)) {
    throw new OrderInventoryRepairReadError(`${label} devolvio un resultado invalido`, invalidCode)
  }

  const requested = new Set(requestedIds)
  const byId = new Map()

  for (const document of documents) {
    const id = normalizeInventoryRepairId(document?._id)
    if (!id || !requested.has(id) || byId.has(id)) {
      throw new OrderInventoryRepairReadError(`${label} devolvio evidencia ambigua`, invalidCode)
    }
    byId.set(id, document)
  }

  return {
    byId,
    unitsInRequestedOrder: requestedIds.flatMap((id) => {
      const document = byId.get(id)
      return document ? [document] : []
    }),
    missingIds: requestedIds.filter((id) => !byId.has(id))
  }
}

const extractExternalOrderItemIds = ({ targetOrderId, originalProductUnits } = {}) => {
  const normalizedTargetOrderId = normalizeInventoryRepairId(targetOrderId)
  if (!normalizedTargetOrderId) {
    throw new OrderInventoryRepairReadError(
      'La Order objetivo es invalida',
      'INVALID_TARGET_ORDER_ID'
    )
  }
  if (!Array.isArray(originalProductUnits)) {
    throw new OrderInventoryRepairReadError(
      'Las ProductUnits originales deben ser un array',
      'INVALID_ORIGINAL_PRODUCT_UNITS'
    )
  }

  const externalOrderItemIds = new Set()

  for (const unit of originalProductUnits) {
    const orderItemId = normalizeInventoryRepairId(unit?.orderItemId)
    if (!orderItemId) continue

    const referencesAnotherOrder = [
      unit?.orderId,
      unit?.reservedByOrderId,
      unit?.soldByOrderId
    ].some((ownerId) => {
      const normalizedOwnerId = normalizeInventoryRepairId(ownerId)
      return normalizedOwnerId !== null && normalizedOwnerId !== normalizedTargetOrderId
    })

    if (referencesAnotherOrder) externalOrderItemIds.add(orderItemId)
  }

  return [...externalOrderItemIds].sort()
}

class OrderInventoryRepairReadService {
  constructor({
    productUnitManager = ProductUnitManager,
    orderItemManager = OrderItemManager
  } = {}) {
    this.productUnits = productUnitManager
    this.orderItems = orderItemManager
  }

  async loadOriginalProductUnits(unitIds, { session } = {}) {
    const requestedIds = normalizeRequestedIds(unitIds, {
      invalidCode: 'INVALID_ORIGINAL_PRODUCT_UNIT_IDS',
      duplicateCode: 'DUPLICATE_ORIGINAL_PRODUCT_UNIT_ID',
      label: 'Los IDs de ProductUnit originales'
    })
    const documents = requestedIds.length
      ? await this.productUnits.getByIdsIncludingDeleted(requestedIds, { session })
      : []

    return indexExactResults(requestedIds, documents, {
      invalidCode: 'ORIGINAL_PRODUCT_UNIT_READ_CONFLICT',
      label: 'La lectura de ProductUnits originales'
    })
  }

  async loadExternalOrderItems(orderItemIds, { session } = {}) {
    const requestedIds = normalizeRequestedIds(orderItemIds, {
      invalidCode: 'INVALID_EXTERNAL_ORDER_ITEM_IDS',
      duplicateCode: 'DUPLICATE_EXTERNAL_ORDER_ITEM_ID',
      label: 'Los IDs de OrderItem externos'
    })
    const documents = requestedIds.length
      ? await this.orderItems.getByIds(requestedIds, { session })
      : []
    const indexed = indexExactResults(requestedIds, documents, {
      invalidCode: 'EXTERNAL_ORDER_ITEM_READ_CONFLICT',
      label: 'La lectura de OrderItems externos'
    })

    return {
      byId: indexed.byId,
      itemsInRequestedOrder: indexed.unitsInRequestedOrder,
      missingIds: indexed.missingIds
    }
  }

  async loadAuthoritativeInputs(
    { orderId, originalProductUnitIds } = {},
    { session } = {}
  ) {
    const normalizedOrderId = normalizeInventoryRepairId(orderId)
    if (!normalizedOrderId) {
      throw new OrderInventoryRepairReadError(
        'La Order objetivo es invalida',
        'INVALID_TARGET_ORDER_ID'
      )
    }

    const orderItems = await this.orderItems.getByOrderId(normalizedOrderId, { session })
    const originals = await this.loadOriginalProductUnits(originalProductUnitIds, { session })
    const relatedProductUnits = await this.productUnits.getRelatedByOrderId(
      normalizedOrderId,
      { session }
    )
    const externalOrderItemIds = extractExternalOrderItemIds({
      targetOrderId: normalizedOrderId,
      originalProductUnits: originals.unitsInRequestedOrder
    })
    const externalOrderItems = await this.loadExternalOrderItems(externalOrderItemIds, { session })

    return {
      orderItems,
      originalProductUnits: originals.unitsInRequestedOrder,
      originalProductUnitsById: originals.byId,
      missingOriginalProductUnitIds: originals.missingIds,
      relatedProductUnits,
      externalOrderItemIds,
      externalOrderItems: externalOrderItems.itemsInRequestedOrder,
      externalOrderItemsById: externalOrderItems.byId,
      missingExternalOrderItemIds: externalOrderItems.missingIds
    }
  }
}

export {
  OrderInventoryRepairReadError,
  OrderInventoryRepairReadService,
  extractExternalOrderItemIds,
  normalizeInventoryRepairId
}

export default new OrderInventoryRepairReadService()
