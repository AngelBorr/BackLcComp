const ATTENTION_CATEGORIES = Object.freeze({
  APPROVED_INVENTORY: 'APPROVED_INVENTORY_ATTENTION',
  FINANCIAL_INCONSISTENCY: 'FINANCIAL_INCONSISTENCY',
  TERMINAL_UNPAID: 'TERMINAL_UNPAID_ATTENTION',
  REFUND: 'REFUND_ATTENTION',
  UNKNOWN: 'UNKNOWN_ATTENTION'
})

const APPROVED_INVENTORY_REASONS = new Set([
  'RESERVATION_EXPIRED',
  'ORDER_NOT_PENDING_PAYMENT',
  'ORDER_ITEMS_MISSING',
  'RESERVATION_REFERENCE_MISMATCH',
  'RESERVATION_QUANTITY_MISMATCH',
  'RESERVATION_CHANGED_DURING_APPROVAL',
  'RESERVATION_INTEGRITY_CONFLICT',
  'RESERVATION_SALE_CONFLICT'
])

const FINANCIAL_INCONSISTENCY_REASONS = new Set([
  'LOCAL_PAYMENT_OR_ORDER_MISSING',
  'PAYMENT_PROVIDER_MISMATCH',
  'PAYMENT_ORDER_MISMATCH',
  'EXTERNAL_REFERENCE_MISMATCH',
  'CURRENCY_MISMATCH',
  'TOTAL_AMOUNT_MISMATCH',
  'PROVIDER_ORDER_ID_MISMATCH',
  'EARLY_WEBHOOK_PAYMENT_STATE_MISMATCH',
  'PROVIDER_ORDER_INCONSISTENT',
  'PROVIDER_PAYMENT_AMBIGUOUS',
  'PROVIDER_PAYMENT_ID_CONFLICT',
  'LOCAL_PAYMENT_STATE_REQUIRES_ATTENTION'
])

const TERMINAL_UNPAID_REASONS = new Set([
  'RESERVATION_INTEGRITY_CONFLICT'
])

const asText = (value) => String(value ?? '').trim()
const sameId = (left, right) => asText(left) !== '' && asText(left) === asText(right)

const hasValidDate = (value) => {
  if (value === null || value === undefined) return false
  const date = new Date(value)
  return !Number.isNaN(date.getTime())
}

const approvedPaymentEvidenceIsComplete = (payment) => (
  payment?.normalizedStatus === 'approved' &&
  asText(payment.providerPaymentId) !== '' &&
  hasValidDate(payment.approvedAt)
)

const terminalUnpaidLocalEvidenceIsComplete = (payment, attentionReason) => (
  TERMINAL_UNPAID_REASONS.has(attentionReason) &&
  ['requires_attention', 'rejected', 'cancelled'].includes(payment?.normalizedStatus) &&
  asText(payment?.providerPaymentId) === '' &&
  !hasValidDate(payment?.approvedAt)
)

const inspectReservationIntegrity = ({ order, orderItems = [], productUnits = [] }) => {
  const orderId = asText(order?._id)
  const expectedByItem = new Map()
  let reason = null

  if (!orderItems.length) reason = 'ORDER_ITEMS_MISSING'

  for (const item of orderItems) {
    const quantity = Number(item.quantity)
    const itemId = asText(item._id)

    if (!itemId || !Number.isInteger(quantity) || quantity <= 0 || !asText(item.productId)) {
      reason = reason || 'RESERVATION_QUANTITY_MISMATCH'
      continue
    }

    expectedByItem.set(itemId, {
      quantity,
      productId: asText(item.productId)
    })
  }

  const actualByItem = new Map()
  let reservedCount = 0

  for (const unit of productUnits) {
    const itemId = asText(unit.orderItemId)
    const expected = expectedByItem.get(itemId)
    const soldByAnotherOrder = asText(unit.soldByOrderId) !== '' &&
      !sameId(unit.soldByOrderId, orderId)

    if (soldByAnotherOrder) {
      reason = reason || 'UNIT_SOLD_BY_ANOTHER_ORDER'
      continue
    }

    if (
      !expected ||
      !sameId(unit.orderId, orderId) ||
      !sameId(unit.reservedByOrderId, orderId) ||
      asText(unit.productId) !== expected.productId
    ) {
      reason = reason || 'RESERVATION_REFERENCE_MISMATCH'
      continue
    }

    if (
      unit.status !== 'reserved' ||
      unit.isDeleted === true ||
      unit.soldByOrderId != null ||
      unit.soldAt != null
    ) {
      reason = reason || 'RESERVATION_INTEGRITY_CONFLICT'
      continue
    }

    reservedCount += 1
    actualByItem.set(itemId, (actualByItem.get(itemId) || 0) + 1)
  }

  if (!reason) {
    for (const [itemId, expected] of expectedByItem.entries()) {
      if (actualByItem.get(itemId) !== expected.quantity) {
        reason = 'RESERVATION_QUANTITY_MISMATCH'
        break
      }
    }
  }

  const expectedCount = orderItems.reduce((total, item) => {
    const quantity = Number(item.quantity)
    return total + (Number.isInteger(quantity) && quantity > 0 ? quantity : 0)
  }, 0)

  if (!reason && productUnits.length !== expectedCount) {
    reason = 'RESERVATION_QUANTITY_MISMATCH'
  }

  return {
    valid: reason === null,
    reason,
    expectedCount,
    relatedCount: productUnits.length,
    reservedCount
  }
}

const classifyAttention = ({ order, payment }) => {
  if (order?.status !== 'requires_attention') {
    return { attentionCategory: null, financialRisk: 'none' }
  }

  const attentionReason = asText(order.attentionReason).toUpperCase()

  if (attentionReason === 'PROVIDER_REFUND_REQUIRES_ATTENTION') {
    return {
      attentionCategory: ATTENTION_CATEGORIES.REFUND,
      financialRisk: 'refund_requires_review'
    }
  }

  if (
    APPROVED_INVENTORY_REASONS.has(attentionReason) &&
    approvedPaymentEvidenceIsComplete(payment)
  ) {
    return {
      attentionCategory: ATTENTION_CATEGORIES.APPROVED_INVENTORY,
      financialRisk: 'approved_money_inventory_unresolved'
    }
  }

  if (FINANCIAL_INCONSISTENCY_REASONS.has(attentionReason)) {
    return {
      attentionCategory: ATTENTION_CATEGORIES.FINANCIAL_INCONSISTENCY,
      financialRisk: 'financial_state_inconsistent'
    }
  }

  if (terminalUnpaidLocalEvidenceIsComplete(payment, attentionReason)) {
    return {
      attentionCategory: ATTENTION_CATEGORIES.TERMINAL_UNPAID,
      financialRisk: 'unpaid_not_provider_verified'
    }
  }

  return {
    attentionCategory: ATTENTION_CATEGORIES.UNKNOWN,
    financialRisk: 'unknown_fail_closed'
  }
}

const buildAllowedActions = ({ reservationIntegrity }) => {
  const commonBlockers = ['P1C_ACTION_NOT_IMPLEMENTED']
  const inventoryBlockers = reservationIntegrity.valid
    ? commonBlockers
    : [...commonBlockers, 'RESERVATION_INTEGRITY_INVALID']

  return {
    canCompleteExistingReservationSale: false,
    canCloseTerminalUnpaid: false,
    canReassignInventory: false,
    canRefund: false,
    blockers: {
      completeExistingReservationSale: inventoryBlockers,
      closeTerminalUnpaid: commonBlockers,
      reassignInventory: inventoryBlockers,
      refund: commonBlockers
    }
  }
}

class OrderAttentionService {
  buildReadModel({ order, payment, orderItems = [], productUnits = [] }) {
    const reservationIntegrity = inspectReservationIntegrity({
      order,
      orderItems,
      productUnits
    })
    const classification = classifyAttention({ order, payment })

    return {
      ...classification,
      originalAttentionReason: asText(order?.attentionReason),
      reservationIntegrity,
      allowedActions: buildAllowedActions({ reservationIntegrity })
    }
  }
}

export {
  ATTENTION_CATEGORIES,
  OrderAttentionService,
  classifyAttention,
  inspectReservationIntegrity,
  buildAllowedActions
}
export default new OrderAttentionService()
