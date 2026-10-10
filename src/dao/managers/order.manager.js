import OrderModel from '../models/order.model.js'

const escapeRegex = (value) => String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

const legacyStatusesByFulfillment = Object.freeze({
  pending: ['pending_payment'],
  preparing: ['paid'],
  cancelled: ['cancelled', 'expired']
})

const fulfillmentFilter = (fulfillmentStatus) => {
  if (!fulfillmentStatus) return null

  const legacyStatuses = legacyStatusesByFulfillment[fulfillmentStatus] || []
  const alternatives = [{ fulfillmentStatus }]

  if (legacyStatuses.length) {
    alternatives.push({
      fulfillmentStatus: null,
      status: { $in: legacyStatuses }
    })
  }

  return { $or: alternatives }
}

const combineFilters = (...filters) => {
  const present = filters.filter(Boolean)
  if (!present.length) return {}
  if (present.length === 1) return present[0]
  return { $and: present }
}

const reconciliationDueFilter = (now) => ({
  $and: [
    {
      $or: [
        { reconciliationNextAt: { $lte: now } },
        { reconciliationNextAt: null },
        { reconciliationNextAt: { $exists: false } }
      ]
    },
    {
      $or: [
        { reconciliationLeaseUntil: { $lte: now } },
        { reconciliationLeaseUntil: null },
        { reconciliationLeaseUntil: { $exists: false } }
      ]
    }
  ]
})

const reconciliationCursorFilter = (afterCursor) => {
  if (!afterCursor) return null

  const cursorId = afterCursor._id || afterCursor.id
  if (!cursorId) throw new TypeError('afterCursor requiere _id')

  if (
    afterCursor.reservationExpiresAt === null ||
    afterCursor.reservationExpiresAt === undefined
  ) {
    return {
      $or: [
        { reservationExpiresAt: null, _id: { $gt: cursorId } },
        { reservationExpiresAt: { $type: 'date' } }
      ]
    }
  }

  const reservationExpiresAt = new Date(afterCursor.reservationExpiresAt)
  if (Number.isNaN(reservationExpiresAt.getTime())) {
    throw new TypeError('afterCursor.reservationExpiresAt es invalido')
  }

  return {
    $or: [
      { reservationExpiresAt: { $gt: reservationExpiresAt } },
      { reservationExpiresAt, _id: { $gt: cursorId } }
    ]
  }
}

class OrderManager {
  async create(data, { session } = {}) {
    const order = new OrderModel(data)
    return order.save({ session })
  }

  async getById(id, { session } = {}) {
    const query = OrderModel.findById(id).lean()
    if (session) query.session(session)
    return query
  }

  async getByOrderNumber(orderNumber, { session } = {}) {
    const query = OrderModel.findOne({
      orderNumber: String(orderNumber || '').trim().toUpperCase()
    }).lean()

    if (session) query.session(session)
    return query
  }

  async getByOrderNumberAndUserId(orderNumber, userId, { session } = {}) {
    const query = OrderModel.findOne({
      orderNumber: String(orderNumber || '').trim().toUpperCase(),
      userId
    }).lean()

    if (session) query.session(session)
    return query
  }

  async getByUserId(userId, { session } = {}) {
    const query = OrderModel.find({ userId }).sort({ createdAt: -1 }).lean()
    if (session) query.session(session)
    return query
  }

  async getFinanciallyUnresolvedByUserId(userId, { session } = {}) {
    const query = OrderModel.find({
      userId,
      status: { $ne: 'paid' }
    }).sort({ createdAt: -1, _id: -1 }).lean()

    if (session) query.session(session)
    return query
  }

  async listCustomerPage(
    { userId, status, fulfillmentStatus, page, limit },
    { session } = {}
  ) {
    const filter = combineFilters(
      { userId },
      status ? { status } : null,
      fulfillmentFilter(fulfillmentStatus)
    )
    const skip = (page - 1) * limit
    const ordersQuery = OrderModel.find(filter)
      .sort({ createdAt: -1, _id: -1 })
      .skip(skip)
      .limit(limit)
      .lean()
    const countQuery = OrderModel.countDocuments(filter)

    if (session) {
      ordersQuery.session(session)
      countQuery.session(session)
    }

    const [orders, total] = await Promise.all([ordersQuery, countQuery])
    return { orders, total }
  }

  async getByUserAndCheckoutIdempotencyKey(userId, checkoutIdempotencyKey, { session } = {}) {
    const query = OrderModel.findOne({ userId, checkoutIdempotencyKey }).lean()
    if (session) query.session(session)
    return query
  }

  async list({ status } = {}, { session } = {}) {
    const filter = status ? { status } : {}
    const query = OrderModel.find(filter).sort({ createdAt: -1 }).lean()
    if (session) query.session(session)
    return query
  }

  async findReconciliationCandidates({ now, limit, afterCursor = null }) {
    if (!Number.isInteger(limit) || limit <= 0) {
      throw new TypeError('limit es obligatorio y debe ser un entero positivo')
    }

    const filter = combineFilters(
      { status: 'pending_payment' },
      reconciliationDueFilter(now),
      reconciliationCursorFilter(afterCursor)
    )

    return OrderModel.find(filter)
      .sort({ reservationExpiresAt: 1, _id: 1 })
      .limit(limit)
      .lean()
  }

  async claimForReconciliation({ orderId, ownerToken, now, leaseUntil }) {
    return OrderModel.findOneAndUpdate(
      combineFilters(
        { _id: orderId, status: 'pending_payment' },
        reconciliationDueFilter(now)
      ),
      {
        $set: {
          reconciliationLeaseOwner: ownerToken,
          reconciliationLeaseUntil: leaseUntil
        },
        $inc: { reconciliationAttempts: 1 }
      },
      { new: true, runValidators: true }
    ).lean()
  }

  async renewReconciliationClaim({ orderId, ownerToken, now, leaseUntil }) {
    return OrderModel.findOneAndUpdate(
      {
        _id: orderId,
        status: 'pending_payment',
        reconciliationLeaseOwner: ownerToken,
        reconciliationLeaseUntil: { $gt: now }
      },
      { $set: { reconciliationLeaseUntil: leaseUntil } },
      { new: true, runValidators: true }
    ).lean()
  }

  async assertReconciliationOwnership({ orderId, ownerToken, now }, { session } = {}) {
    const query = OrderModel.findOne({
      _id: orderId,
      status: 'pending_payment',
      reconciliationLeaseOwner: ownerToken,
      reconciliationLeaseUntil: { $gt: now }
    }).lean()

    if (session) query.session(session)
    return query
  }

  async releaseReconciliationClaim({ orderId, ownerToken }) {
    return OrderModel.findOneAndUpdate(
      { _id: orderId, reconciliationLeaseOwner: ownerToken },
      {
        $set: {
          reconciliationLeaseOwner: null,
          reconciliationLeaseUntil: null
        }
      },
      { new: true, runValidators: true }
    ).lean()
  }

  async scheduleNextReconciliation({ orderId, ownerToken, now, nextAt }) {
    return OrderModel.findOneAndUpdate(
      {
        _id: orderId,
        status: 'pending_payment',
        reconciliationLeaseOwner: ownerToken,
        reconciliationLeaseUntil: { $gt: now }
      },
      { $set: { reconciliationNextAt: nextAt } },
      { new: true, runValidators: true }
    ).lean()
  }

  async markReconciliationFailure({ orderId, ownerToken, now, nextAt }) {
    return OrderModel.findOneAndUpdate(
      {
        _id: orderId,
        status: 'pending_payment',
        reconciliationLeaseOwner: ownerToken,
        reconciliationLeaseUntil: { $gt: now }
      },
      {
        $set: { reconciliationNextAt: nextAt },
        $inc: { reconciliationFailures: 1 }
      },
      { new: true, runValidators: true }
    ).lean()
  }

  async listAdminPage(
    {
      page,
      limit,
      search,
      status,
      paymentStatus,
      fulfillmentStatus,
      createdFrom,
      createdTo
    },
    { session } = {}
  ) {
    const baseFilters = []

    if (status) baseFilters.push({ status })
    if (fulfillmentStatus) baseFilters.push(fulfillmentFilter(fulfillmentStatus))
    if (createdFrom || createdTo) {
      baseFilters.push({
        createdAt: {
          ...(createdFrom && { $gte: createdFrom }),
          ...(createdTo && { $lte: createdTo })
        }
      })
    }

    const pipeline = []
    if (baseFilters.length) pipeline.push({ $match: combineFilters(...baseFilters) })

    pipeline.push(
      {
        $lookup: {
          from: 'payments',
          let: { orderId: '$_id' },
          pipeline: [
            { $match: { $expr: { $eq: ['$orderId', '$$orderId'] } } },
            { $sort: { createdAt: -1, _id: -1 } },
            { $limit: 1 }
          ],
          as: '_payments'
        }
      },
      { $set: { _payment: { $arrayElemAt: ['$_payments', 0] } } },
      {
        $lookup: {
          from: 'order_items',
          let: { orderId: '$_id' },
          pipeline: [
            { $match: { $expr: { $eq: ['$orderId', '$$orderId'] } } },
            { $project: { _id: 1 } }
          ],
          as: '_items'
        }
      }
    )

    if (search) {
      pipeline.push({
        $lookup: {
          from: 'product_units',
          let: { orderId: '$_id' },
          pipeline: [
            {
              $match: {
                $expr: {
                  $or: [
                    { $eq: ['$orderId', '$$orderId'] },
                    { $eq: ['$soldByOrderId', '$$orderId'] }
                  ]
                },
                isDeleted: false
              }
            },
            { $project: { serialNumber: 1 } }
          ],
          as: '_units'
        }
      })
    }

    const joinedFilters = []
    if (paymentStatus) joinedFilters.push({ '_payment.normalizedStatus': paymentStatus })
    if (search) {
      const expression = new RegExp(escapeRegex(search), 'i')
      joinedFilters.push({
        $or: [
          { orderNumber: expression },
          { 'buyerSnapshot.firstName': expression },
          { 'buyerSnapshot.lastName': expression },
          { 'buyerSnapshot.email': expression },
          { '_units.serialNumber': expression }
        ]
      })
    }
    if (joinedFilters.length) pipeline.push({ $match: combineFilters(...joinedFilters) })

    pipeline.push({
      $facet: {
        rows: [
          { $sort: { createdAt: -1, _id: -1 } },
          { $skip: (page - 1) * limit },
          { $limit: limit },
          {
            $set: {
              _itemsCount: { $size: '$_items' }
            }
          },
          { $unset: ['_payments', '_items', '_units'] }
        ],
        metadata: [{ $count: 'total' }]
      }
    })

    const aggregate = OrderModel.aggregate(pipeline)
    if (session) aggregate.session(session)
    const [result = { rows: [], metadata: [] }] = await aggregate

    return {
      orders: result.rows,
      total: result.metadata[0]?.total || 0
    }
  }

  async updateFulfillmentStatus(
    orderId,
    expectedStatus,
    { nextStatus, changedAt, changedBy = null, reason = '' },
    { session } = {}
  ) {
    const expectedFilter = fulfillmentFilter(expectedStatus)
    const set = { fulfillmentStatus: nextStatus }

    if (nextStatus === 'ready_for_pickup') set.readyForPickupAt = changedAt
    if (nextStatus === 'picked_up') set.pickedUpAt = changedAt

    return OrderModel.findOneAndUpdate(
      combineFilters({ _id: orderId }, expectedFilter),
      {
        $set: set,
        $push: {
          fulfillmentHistory: {
            status: nextStatus,
            changedAt,
            changedBy,
            reason
          }
        }
      },
      { new: true, session, runValidators: true }
    ).lean()
  }

  async updateStatus(
    orderId,
    expectedStatus,
    { nextStatus, changedAt, reason = '' },
    { session } = {}
  ) {
    const set = { status: nextStatus }

    if (nextStatus === 'paid') set.paidAt = changedAt
    if (nextStatus === 'cancelled') {
      set.cancelledAt = changedAt
      set.cancellationReason = reason
    }
    if (nextStatus === 'expired') set.expiredAt = changedAt
    if (nextStatus === 'requires_attention') set.attentionReason = reason

    return OrderModel.findOneAndUpdate(
      { _id: orderId, status: expectedStatus },
      {
        $set: set,
        $push: {
          statusHistory: {
            status: nextStatus,
            changedAt,
            reason
          }
        }
      },
      { new: true, session, runValidators: true }
    ).lean()
  }
}

export { OrderManager, reconciliationCursorFilter }
export default new OrderManager()
