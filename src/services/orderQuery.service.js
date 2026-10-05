import mongoose from 'mongoose'
import OrderManager from '../dao/managers/order.manager.js'
import OrderItemManager from '../dao/managers/orderItem.manager.js'
import PaymentManager from '../dao/managers/payment.manager.js'
import ProductUnitManager from '../dao/managers/productUnit.manager.js'
import { ORDER_STATUSES, ORDER_FULFILLMENT_STATUSES } from '../dao/models/order.model.js'
import { PAYMENT_STATUSES } from '../dao/models/payment.model.js'
import { ServiceError } from './service.products.js'
import { getEffectiveFulfillmentStatus } from '../utils/orderFulfillment.js'

const ORDER_NUMBER_PATTERN = /^LC-\d{4}-\d{6,}$/
const DEFAULT_PAGE_SIZE = 20
const MAX_PAGE_SIZE = 100

const toIsoString = (value) => {
  if (!value) return null
  const date = new Date(value)
  return Number.isNaN(date.getTime()) ? null : date.toISOString()
}

const decimalToString = (value) => {
  if (value === null || value === undefined) return null
  return typeof value?.toString === 'function' ? value.toString() : String(value)
}

const idToString = (value) => value === null || value === undefined ? null : String(value)

const parsePositiveInteger = (value, fallback, maximum, field) => {
  if (value === undefined || value === null || value === '') return fallback
  const parsed = Number(value)

  if (!Number.isInteger(parsed) || parsed < 1 || parsed > maximum) {
    throw new ServiceError(`${field} invÃ¡lido`, `INVALID_${field.toUpperCase()}`, 400)
  }

  return parsed
}

const parseEnum = (value, allowed, field) => {
  if (value === undefined || value === null || value === '') return undefined
  const normalized = String(value).trim().toLowerCase()

  if (!allowed.includes(normalized)) {
    throw new ServiceError(`${field} invÃ¡lido`, `INVALID_${field.toUpperCase()}`, 400)
  }

  return normalized
}

const parseDateBoundary = (value, field, endOfDay = false) => {
  if (value === undefined || value === null || value === '') return undefined
  const raw = String(value).trim()
  const date = /^\d{4}-\d{2}-\d{2}$/.test(raw)
    ? new Date(`${raw}T${endOfDay ? '23:59:59.999' : '00:00:00.000'}Z`)
    : new Date(raw)

  if (Number.isNaN(date.getTime())) {
    throw new ServiceError(`${field} invÃ¡lida`, `INVALID_${field.toUpperCase()}`, 400)
  }

  return date
}

const paginationDto = ({ page, limit, total }) => ({
  page,
  limit,
  total,
  totalPages: total ? Math.ceil(total / limit) : 0
})

const exchangeRateDto = (snapshot) => snapshot
  ? {
      source: snapshot.source,
      rate: decimalToString(snapshot.rate),
      sourceDate: snapshot.sourceDate
    }
  : null

const safeExchangeRateSnapshotDto = (snapshot) => snapshot
  ? {
      source: snapshot.source,
      quoteType: snapshot.quoteType,
      baseCurrency: snapshot.baseCurrency,
      quoteCurrency: snapshot.quoteCurrency,
      rate: decimalToString(snapshot.rate),
      sourceDate: snapshot.sourceDate,
      sourceUpdatedTime: snapshot.sourceUpdatedTime,
      sourceEffectiveAt: toIsoString(snapshot.sourceEffectiveAt),
      fetchedAt: toIsoString(snapshot.fetchedAt)
    }
  : null

const paymentCustomerDto = (payment) => payment
  ? {
      provider: payment.provider,
      status: payment.normalizedStatus,
      approvedAt: toIsoString(payment.approvedAt)
    }
  : null

const customerItemDto = (item, serialNumbers) => ({
  productId: idToString(item.productId),
  productNameSnapshot: item.productSnapshot?.name || '',
  quantity: item.quantity,
  unitPriceUsd: decimalToString(item.unitPriceUsd),
  lineTotalUsd: decimalToString(item.totalUsd),
  ...(serialNumbers ? { serialNumbers } : {})
})

const customerOrderDto = (order, items, payment, serialsByOrderItem = null) => ({
  orderNumber: order.orderNumber,
  createdAt: toIsoString(order.createdAt),
  status: order.status,
  fulfillmentStatus: getEffectiveFulfillmentStatus(order),
  totals: {
    totalUsd: decimalToString(order.totals?.totalUsd),
    totalArs: decimalToString(order.totals?.totalArs)
  },
  exchangeRate: exchangeRateDto(order.exchangeRateSnapshot),
  payment: paymentCustomerDto(payment),
  items: items.map((item) => customerItemDto(
    item,
    serialsByOrderItem ? (serialsByOrderItem.get(String(item._id)) || []) : undefined
  ))
})

const statusHistoryDto = (entries = []) => entries.map((entry) => ({
  status: entry.status,
  changedAt: toIsoString(entry.changedAt),
  reason: entry.reason || ''
}))

const fulfillmentHistoryDto = (entries = []) => entries.map((entry) => ({
  status: entry.status,
  changedAt: toIsoString(entry.changedAt),
  changedBy: idToString(entry.changedBy),
  reason: entry.reason || ''
}))

const buildTimeline = ({ order, payment, units }) => {
  const events = []
  const push = (type, at, label) => {
    const normalizedAt = toIsoString(at)
    if (normalizedAt) events.push({ type, at: normalizedAt, label })
  }

  push('order_created', order.createdAt, 'Pedido creado')

  for (const entry of order.statusHistory || []) {
    if (entry.status === 'pending_payment' && toIsoString(entry.changedAt) === toIsoString(order.createdAt)) {
      continue
    }
    push('order_status_changed', entry.changedAt, `Estado de pedido: ${entry.status}`)
  }

  for (const entry of order.fulfillmentHistory || []) {
    const types = {
      pending: 'fulfillment_pending',
      preparing: 'fulfillment_preparing',
      ready_for_pickup: 'fulfillment_ready',
      picked_up: 'fulfillment_picked_up',
      cancelled: 'fulfillment_cancelled'
    }
    const labels = {
      pending: 'PreparaciÃ³n pendiente',
      preparing: 'Pedido en preparaciÃ³n',
      ready_for_pickup: 'Pedido listo para retirar',
      picked_up: 'Pedido retirado',
      cancelled: 'PreparaciÃ³n cancelada'
    }
    push(types[entry.status] || 'fulfillment_changed', entry.changedAt, labels[entry.status] || entry.status)
  }

  push('payment_approved', payment?.approvedAt, 'Pago acreditado')

  for (const unit of units) {
    push('unit_reserved', unit.reservedAt, `Serial ${unit.serialNumber} reservado`)
    push('unit_sold', unit.soldAt, `Serial ${unit.serialNumber} vendido`)
  }

  return events.sort((left, right) => left.at.localeCompare(right.at))
}

class OrderQueryService {
  constructor({
    orderManager = OrderManager,
    orderItemManager = OrderItemManager,
    paymentManager = PaymentManager,
    productUnitManager = ProductUnitManager
  } = {}) {
    this.orders = orderManager
    this.orderItems = orderItemManager
    this.payments = paymentManager
    this.productUnits = productUnitManager
  }

  #parsePagination(filters = {}) {
    return {
      page: parsePositiveInteger(filters.page, 1, Number.MAX_SAFE_INTEGER, 'page'),
      limit: parsePositiveInteger(filters.limit, DEFAULT_PAGE_SIZE, MAX_PAGE_SIZE, 'limit')
    }
  }

  #assertUserId(userId) {
    if (!mongoose.Types.ObjectId.isValid(userId)) {
      throw new ServiceError('Usuario no autenticado', 'ORDERS_UNAUTHENTICATED', 401)
    }
  }

  #normalizeOrderNumber(orderNumber) {
    const normalized = String(orderNumber || '').trim().toUpperCase()
    if (!ORDER_NUMBER_PATTERN.test(normalized)) {
      throw new ServiceError('NÃºmero de orden invÃ¡lido', 'INVALID_ORDER_NUMBER', 400)
    }
    return normalized
  }

  async #loadCustomerRelations(order, { includeSerials = false } = {}) {
    const [items, payment, units] = await Promise.all([
      this.orderItems.getByOrderId(order._id),
      this.payments.getLatestByOrderId(order._id),
      includeSerials
        ? this.productUnits.getAssignedByOrderId(order._id, { statuses: ['sold'] })
        : Promise.resolve([])
    ])
    const serialsByOrderItem = new Map()

    for (const unit of units) {
      if (!unit.orderItemId) continue
      const key = String(unit.orderItemId)
      const serials = serialsByOrderItem.get(key) || []
      serials.push(unit.serialNumber)
      serialsByOrderItem.set(key, serials)
    }

    return { items, payment, serialsByOrderItem }
  }

  async listCustomerOrders({ userId, filters = {} }) {
    this.#assertUserId(userId)
    const { page, limit } = this.#parsePagination(filters)
    const status = parseEnum(filters.status, ORDER_STATUSES, 'order_status')
    const fulfillmentStatus = parseEnum(
      filters.fulfillmentStatus,
      ORDER_FULFILLMENT_STATUSES,
      'fulfillment_status'
    )
    const { orders, total } = await this.orders.listCustomerPage({
      userId,
      status,
      fulfillmentStatus,
      page,
      limit
    })
    const rows = await Promise.all(orders.map(async (order) => {
      const { items, payment } = await this.#loadCustomerRelations(order)
      return customerOrderDto(order, items, payment)
    }))

    return { orders: rows, pagination: paginationDto({ page, limit, total }) }
  }

  async getCustomerOrder({ orderNumber, userId }) {
    this.#assertUserId(userId)
    const normalizedOrderNumber = this.#normalizeOrderNumber(orderNumber)
    const order = await this.orders.getByOrderNumberAndUserId(normalizedOrderNumber, userId)

    if (!order) throw new ServiceError('Orden no encontrada', 'ORDER_NOT_FOUND', 404)

    const { items, payment, serialsByOrderItem } = await this.#loadCustomerRelations(
      order,
      { includeSerials: true }
    )

    return customerOrderDto(order, items, payment, serialsByOrderItem)
  }

  async listAdminOrders({ filters = {} } = {}) {
    const { page, limit } = this.#parsePagination(filters)
    const search = String(filters.search || '').trim()

    if (search.length > 100) {
      throw new ServiceError('BÃºsqueda demasiado extensa', 'INVALID_ORDER_SEARCH', 400)
    }

    const status = parseEnum(filters.status, ORDER_STATUSES, 'order_status')
    const paymentStatus = parseEnum(filters.paymentStatus, PAYMENT_STATUSES, 'payment_status')
    const fulfillmentStatus = parseEnum(
      filters.fulfillmentStatus,
      ORDER_FULFILLMENT_STATUSES,
      'fulfillment_status'
    )
    const createdFrom = parseDateBoundary(filters.dateFrom, 'date_from')
    const createdTo = parseDateBoundary(filters.dateTo, 'date_to', true)

    if (createdFrom && createdTo && createdFrom > createdTo) {
      throw new ServiceError('Rango de fechas invÃ¡lido', 'INVALID_DATE_RANGE', 400)
    }

    const { orders, total } = await this.orders.listAdminPage({
      page,
      limit,
      search: search || undefined,
      status,
      paymentStatus,
      fulfillmentStatus,
      createdFrom,
      createdTo
    })

    return {
      orders: orders.map((order) => ({
        orderNumber: order.orderNumber,
        buyer: {
          firstName: order.buyerSnapshot?.firstName || '',
          lastName: order.buyerSnapshot?.lastName || '',
          email: order.buyerSnapshot?.email || '',
          role: order.buyerSnapshot?.role || ''
        },
        createdAt: toIsoString(order.createdAt),
        itemsCount: Number(order._itemsCount || 0),
        totalUsd: decimalToString(order.totals?.totalUsd),
        totalArs: decimalToString(order.totals?.totalArs),
        orderStatus: order.status,
        paymentStatus: order._payment?.normalizedStatus || null,
        fulfillmentStatus: getEffectiveFulfillmentStatus(order),
        paidAt: toIsoString(order.paidAt)
      })),
      pagination: paginationDto({ page, limit, total })
    }
  }

  async getAdminOrder({ orderNumber }) {
    const normalizedOrderNumber = this.#normalizeOrderNumber(orderNumber)
    const order = await this.orders.getByOrderNumber(normalizedOrderNumber)
    if (!order) throw new ServiceError('Orden no encontrada', 'ORDER_NOT_FOUND', 404)

    const [items, payment, units] = await Promise.all([
      this.orderItems.getByOrderId(order._id),
      this.payments.getLatestByOrderId(order._id),
      this.productUnits.getAssignedByOrderId(order._id)
    ])
    const unitsByOrderItem = new Map()

    for (const unit of units) {
      if (!unit.orderItemId) continue
      const key = String(unit.orderItemId)
      const grouped = unitsByOrderItem.get(key) || []
      grouped.push({
        serialNumber: unit.serialNumber,
        status: unit.status,
        reservedAt: toIsoString(unit.reservedAt),
        soldAt: toIsoString(unit.soldAt),
        reservationExpiresAt: toIsoString(unit.reservationExpiresAt)
      })
      unitsByOrderItem.set(key, grouped)
    }

    return {
      order: {
        orderNumber: order.orderNumber,
        createdAt: toIsoString(order.createdAt),
        updatedAt: toIsoString(order.updatedAt),
        status: order.status,
        statusHistory: statusHistoryDto(order.statusHistory),
        fulfillmentStatus: getEffectiveFulfillmentStatus(order),
        fulfillmentHistory: fulfillmentHistoryDto(order.fulfillmentHistory),
        paidAt: toIsoString(order.paidAt),
        cancelledAt: toIsoString(order.cancelledAt),
        expiredAt: toIsoString(order.expiredAt),
        readyForPickupAt: toIsoString(order.readyForPickupAt),
        pickedUpAt: toIsoString(order.pickedUpAt),
        attentionReason: order.attentionReason || ''
      },
      buyer: {
        firstName: order.buyerSnapshot?.firstName || '',
        lastName: order.buyerSnapshot?.lastName || '',
        email: order.buyerSnapshot?.email || '',
        role: order.buyerSnapshot?.role || ''
      },
      items: items.map((item) => ({
        productId: idToString(item.productId),
        productNameSnapshot: item.productSnapshot?.name || '',
        quantity: item.quantity,
        priceType: item.priceType,
        unitPriceUsd: decimalToString(item.unitPriceUsd),
        vatRate: decimalToString(item.vatRate),
        lineNetUsd: decimalToString(item.lineNetUsd),
        lineVatUsd: decimalToString(item.lineVatUsd),
        lineTotalUsd: decimalToString(item.totalUsd),
        productUnits: unitsByOrderItem.get(String(item._id)) || []
      })),
      financial: {
        totalUsd: decimalToString(order.totals?.totalUsd),
        totalArs: decimalToString(order.totals?.totalArs),
        exchangeRateSnapshot: safeExchangeRateSnapshotDto(order.exchangeRateSnapshot)
      },
      payment: payment
        ? {
            provider: payment.provider,
            normalizedStatus: payment.normalizedStatus,
            providerStatus: payment.providerStatus,
            providerStatusDetail: payment.providerStatusDetail,
            providerOrderId: payment.providerOrderId,
            providerPaymentId: payment.providerPaymentId,
            approvedAt: toIsoString(payment.approvedAt),
            lastProviderCheckAt: toIsoString(payment.lastProviderCheckAt)
          }
        : null,
      timeline: buildTimeline({ order, payment, units })
    }
  }
}

export { OrderQueryService }
export default new OrderQueryService()
