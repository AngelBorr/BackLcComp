import mongoose from 'mongoose'
import OrderManager from '../dao/managers/order.manager.js'
import OrderItemManager from '../dao/managers/orderItem.manager.js'
import PaymentManager from '../dao/managers/payment.manager.js'
import ProductUnitManager from '../dao/managers/productUnit.manager.js'
import OrderAttentionResolutionManager from '../dao/managers/orderAttentionResolution.manager.js'
import PaymentRefundManager from '../dao/managers/paymentRefund.manager.js'
import { ORDER_STATUSES, ORDER_FULFILLMENT_STATUSES } from '../dao/models/order.model.js'
import { PAYMENT_STATUSES } from '../dao/models/payment.model.js'
import { ServiceError } from './service.products.js'
import OrderAttentionService from './orderAttention.service.js'
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

const productUnitAdminDto = (unit) => ({
  _id: idToString(unit._id || unit.productUnitId),
  serialNumber: unit.serialNumber,
  status: unit.status,
  productId: idToString(unit.productId),
  orderId: idToString(unit.orderId),
  orderItemId: idToString(unit.orderItemId),
  reservedByOrderId: idToString(unit.reservedByOrderId),
  reservedAt: toIsoString(unit.reservedAt),
  reservationExpiresAt: toIsoString(unit.reservationExpiresAt),
  soldByOrderId: idToString(unit.soldByOrderId),
  soldAt: toIsoString(unit.soldAt),
  isDeleted: unit.isDeleted === true
})

const providerEvidenceDto = (evidence) => evidence
  ? {
      provider: evidence.provider || '',
      evidenceSource: evidence.evidenceSource || null,
      providerOrderId: evidence.providerOrderId || null,
      providerPaymentId: evidence.providerPaymentId || null,
      paymentsApiPaymentId: evidence.paymentsApiPaymentId || null,
      externalReference: evidence.externalReference || null,
      providerStatus: evidence.providerStatus || null,
      providerStatusDetail: evidence.providerStatusDetail || null,
      amountArs: evidence.amountArs || null,
      totalAmount: evidence.totalAmount || null,
      totalPaidAmount: evidence.totalPaidAmount || null,
      currency: evidence.currency || null,
      transactionAmountRefunded: evidence.transactionAmountRefunded ?? null,
      refundCount: Number.isInteger(evidence.refundCount) ? evidence.refundCount : null,
      orderMpReferenceId: evidence.orderMpReferenceId || null,
      observedAt: toIsoString(evidence.observedAt),
      remoteClassification: evidence.remoteClassification || null,
      accreditedPayment: evidence.accreditedPayment
        ? {
            providerPaymentId: evidence.accreditedPayment.providerPaymentId || null,
            status: evidence.accreditedPayment.status || null,
            statusDetail: evidence.accreditedPayment.statusDetail || null,
            amount: evidence.accreditedPayment.amount || null,
            paidAmount: evidence.accreditedPayment.paidAmount || null
          }
        : null
    }
  : null

const resolutionStateDto = (state) => state
  ? {
      orderStatus: state.orderStatus || null,
      paymentStatus: state.paymentStatus || null,
      fulfillmentStatus: state.fulfillmentStatus || null,
      attentionReason: state.attentionReason || '',
      attentionResolutionVersion: Number(state.attentionResolutionVersion || 0),
      paymentApprovedAt: toIsoString(state.paymentApprovedAt),
      paymentLastProviderCheckAt: toIsoString(state.paymentLastProviderCheckAt)
    }
  : null

const resolutionResultDto = (result) => result
  ? {
      outcome: result.outcome || '',
      reason: result.reason || '',
      orderStatus: result.orderStatus || null,
      paymentStatus: result.paymentStatus || null,
      fulfillmentStatus: result.fulfillmentStatus || null,
      attentionResolutionVersion: Number.isInteger(result.attentionResolutionVersion)
        ? result.attentionResolutionVersion
        : null,
      soldCount: Number.isInteger(result.soldCount) ? result.soldCount : 0
    }
  : null

const resolutionDto = (resolution) => ({
  _id: idToString(resolution._id),
  paymentId: idToString(resolution.paymentId),
  action: resolution.action,
  originalAttentionReason: resolution.originalAttentionReason,
  actorUserId: idToString(resolution.actorUserId),
  actorRole: resolution.actorRole,
  note: resolution.note || '',
  requestedAt: toIsoString(resolution.requestedAt),
  completedAt: toIsoString(resolution.completedAt),
  status: resolution.status,
  providerEvidence: providerEvidenceDto(resolution.providerEvidence),
  previousState: resolutionStateDto(resolution.previousState),
  previousProductUnits: (resolution.previousProductUnits || []).map(productUnitAdminDto),
  finalProductUnits: (resolution.finalProductUnits || []).map(productUnitAdminDto),
  finalResult: resolutionResultDto(resolution.finalResult),
  sanitizedError: resolution.sanitizedError
    ? {
        code: resolution.sanitizedError.code || '',
        message: resolution.sanitizedError.message || ''
      }
    : null
})

const refundAdminDto = (refund) => ({
  refundId: idToString(refund._id),
  type: refund.type,
  status: refund.status,
  origin: refund.origin,
  requestedAmountArs: decimalToString(refund.requestedAmountArs),
  confirmedAmountArs: decimalToString(refund.confirmedAmountArs),
  currency: refund.currency,
  providerRefundId: refund.providerRefundId || null,
  providerStatus: refund.providerStatus || null,
  providerStatusDetail: refund.providerStatusDetail || null,
  reasonCode: refund.reasonCode || '',
  note: refund.note || '',
  requestedBy: idToString(refund.requestedBy),
  requestedByRole: refund.requestedByRole || null,
  requestedAt: toIsoString(refund.requestedAt),
  submittedAt: toIsoString(refund.submittedAt),
  lastProviderCheckAt: toIsoString(refund.lastProviderCheckAt),
  completedAt: toIsoString(refund.completedAt),
  sanitizedError: refund.sanitizedError
    ? { code: refund.sanitizedError.code || '', message: refund.sanitizedError.message || '' }
    : null
})

const buildTimeline = ({ order, payment, units, refunds = [] }) => {
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

  for (const refund of refunds) {
    push('refund_requested', refund.requestedAt, 'Reembolso total solicitado')
    push('refund_completed', refund.completedAt, `Reembolso: ${refund.status}`)
  }

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
    productUnitManager = ProductUnitManager,
    paymentRefundManager = PaymentRefundManager,
    attentionResolutionManager = OrderAttentionResolutionManager,
    orderAttentionService = OrderAttentionService
  } = {}) {
    this.orders = orderManager
    this.orderItems = orderItemManager
    this.payments = paymentManager
    this.productUnits = productUnitManager
    this.refunds = paymentRefundManager
    this.attentionResolutions = attentionResolutionManager
    this.orderAttention = orderAttentionService
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

    const [items, payment, units, resolutions, refunds] = await Promise.all([
      this.orderItems.getByOrderId(order._id),
      this.payments.getLatestByOrderId(order._id),
      order.status === 'requires_attention'
        ? this.productUnits.getRelatedByOrderId(order._id)
        : this.productUnits.getAssignedByOrderId(order._id),
      this.attentionResolutions.getOrderResolutionHistory(order._id),
      this.refunds.listByOrderId(order._id)
    ])
    const unitsByOrderItem = new Map()

    for (const unit of units) {
      if (!unit.orderItemId) continue
      const key = String(unit.orderItemId)
      const grouped = unitsByOrderItem.get(key) || []
      grouped.push(productUnitAdminDto(unit))
      unitsByOrderItem.set(key, grouped)
    }

    const attention = order.status === 'requires_attention'
      ? this.orderAttention.buildReadModel({
        order,
        payment,
        orderItems: items,
        productUnits: units,
        resolutions
      })
      : null
    const attentionResolutionVersion = Number.isInteger(order.attentionResolutionVersion)
      ? order.attentionResolutionVersion
      : 0

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
        refundedAt: toIsoString(order.refundedAt),
        activeRefundId: idToString(order.activeRefundId),
        cancelledAt: toIsoString(order.cancelledAt),
        expiredAt: toIsoString(order.expiredAt),
        readyForPickupAt: toIsoString(order.readyForPickupAt),
        pickedUpAt: toIsoString(order.pickedUpAt),
        attentionReason: order.attentionReason || '',
        reservationExpiresAt: toIsoString(order.reservationExpiresAt),
        attentionResolutionVersion
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
            amountArs: decimalToString(payment.amountArs),
            currency: payment.currency,
            approvedAt: toIsoString(payment.approvedAt),
            lastProviderCheckAt: toIsoString(payment.lastProviderCheckAt)
          }
        : null,
      attention,
      resolutions: resolutions.map(resolutionDto),
      refunds: refunds.map(refundAdminDto),
      refundSummary: {
        totalRefundedArs: decimalToString(
          refunds.find((refund) => refund.status === 'succeeded')?.confirmedAmountArs
        ) || '0.00',
        refundableAmountArs: order.status === 'paid' && payment?.normalizedStatus === 'approved'
          ? decimalToString(payment.amountArs)
          : '0.00',
        activeRefundId: idToString(order.activeRefundId),
        canRequestRefund: order.status === 'paid' &&
          payment?.normalizedStatus === 'approved' &&
          !order.activeRefundId &&
          !refunds.some((refund) => refund.status === 'succeeded'),
        blockers: [
          ...(order.status !== 'paid' ? ['ORDER_NOT_PAID'] : []),
          ...(payment?.normalizedStatus !== 'approved' ? ['PAYMENT_NOT_APPROVED'] : []),
          ...(order.activeRefundId ? ['ACTIVE_REFUND'] : []),
          ...(refunds.some((refund) => refund.status === 'succeeded')
            ? ['TOTAL_REFUND_ALREADY_SUCCEEDED']
            : [])
        ]
      },
      timeline: buildTimeline({ order, payment, units, refunds })
    }
  }
}

export { OrderQueryService }
export default new OrderQueryService()
