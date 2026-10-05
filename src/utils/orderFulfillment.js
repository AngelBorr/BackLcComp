import { ORDER_FULFILLMENT_STATUSES } from '../dao/models/order.model.js'

const historicalFulfillmentByOrderStatus = Object.freeze({
  pending_payment: 'pending',
  paid: 'preparing',
  cancelled: 'cancelled',
  expired: 'cancelled'
})

const getEffectiveFulfillmentStatus = (order) => {
  const persisted = String(order?.fulfillmentStatus || '').trim()

  if (ORDER_FULFILLMENT_STATUSES.includes(persisted)) return persisted

  return historicalFulfillmentByOrderStatus[order?.status] || 'pending'
}

export { getEffectiveFulfillmentStatus, historicalFulfillmentByOrderStatus }
