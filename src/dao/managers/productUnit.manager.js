import ProductUnitModel from '../models/productUnit.model.js'

class ProductUnitManager {
  async create(data, { session } = {}) {
    const unit = new ProductUnitModel(data)
    return unit.save({ session })
  }

  async bulkCreate(units, { session } = {}) {
    return ProductUnitModel.insertMany(units, { ordered: true, session })
  }

  async getById(id, { session } = {}) {
    const query = ProductUnitModel.findOne({
      _id: id,
      isDeleted: false
    })

    if (session) query.session(session)

    return query
  }

  async getBySerial(serialNumber, { session } = {}) {
    const query = ProductUnitModel.findOne({
      serialNumber: String(serialNumber).trim().toUpperCase(),
      isDeleted: false
    })

    if (session) query.session(session)

    return query
  }

  async getExistingSerials(serialNumbers, { session } = {}) {
    const query = ProductUnitModel.find({
      serialNumber: { $in: serialNumbers },
      isDeleted: false
    })
      .select({ serialNumber: 1 })
      .lean()

    if (session) query.session(session)

    return query
  }

  async existsByProduct(productId, { session } = {}) {
    const query = ProductUnitModel.exists({ productId })

    if (session) query.session(session)

    return query
  }

  async listByProduct(productId, filters = {}, { session } = {}) {
    const query = {
      productId,
      isDeleted: false
    }

    if (filters.status) {
      query.status = filters.status
    }

    if (filters.search) {
      query.serialNumber = {
        $regex: filters.search,
        $options: 'i'
      }
    }

    const productUnitsQuery = ProductUnitModel.find(query).sort({ createdAt: -1 }).lean()

    if (session) productUnitsQuery.session(session)

    return productUnitsQuery
  }

  async countByProductAndStatus(productId, { session } = {}) {
    const aggregate = ProductUnitModel.aggregate([
      {
        $match: {
          productId,
          isDeleted: false
        }
      },
      {
        $group: {
          _id: '$status',
          count: { $sum: 1 }
        }
      }
    ])

    if (session) aggregate.session(session)

    return aggregate
  }

  async update(id, data, { session, expectedStatus } = {}) {
    const filter = {
      _id: id,
      isDeleted: false
    }

    if (expectedStatus) filter.status = expectedStatus

    return ProductUnitModel.findOneAndUpdate(
      filter,
      data,
      { new: true, session, runValidators: true }
    )
  }

  async softDelete(id, updatedBy, { session, expectedStatus } = {}) {
    const statusFilters = [{ status: { $nin: ['reserved', 'sold'] } }]

    if (expectedStatus) statusFilters.push({ status: expectedStatus })

    return ProductUnitModel.findOneAndUpdate(
      {
        _id: id,
        isDeleted: false,
        $and: statusFilters
      },
      {
        isDeleted: true,
        updatedBy
      },
      { new: true, session, runValidators: true }
    )
  }

  async findAvailableUnits(productId, quantity, { session } = {}) {
    const query = ProductUnitModel.find({
      productId,
      status: 'available',
      isDeleted: false
    })
      .sort({ createdAt: 1 })
      .limit(quantity)

    if (session) query.session(session)

    return query
  }

  async reserveAvailableUnits(
    { unitIds, orderId, orderItemId, reservedAt, reservationExpiresAt },
    { session } = {}
  ) {
    return ProductUnitModel.updateMany(
      {
        _id: { $in: unitIds },
        status: 'available',
        isDeleted: false
      },
      {
        $set: {
          status: 'reserved',
          orderId,
          orderItemId: orderItemId ?? null,
          reservedByOrderId: orderId,
          reservedAt,
          reservationExpiresAt
        }
      },
      { session }
    )
  }

  async findExpiredReservations(now, { session } = {}) {
    const query = ProductUnitModel.find({
      status: 'reserved',
      reservationExpiresAt: { $lte: now },
      isDeleted: false
    }).sort({ reservationExpiresAt: 1 })

    if (session) query.session(session)

    return query
  }

  async releaseExpiredReservations(unitIds, now, { session } = {}) {
    return ProductUnitModel.updateMany(
      {
        _id: { $in: unitIds },
        status: 'reserved',
        isDeleted: false,
        reservationExpiresAt: { $lte: now }
      },
      {
        $set: {
          status: 'available',
          orderId: null,
          orderItemId: null,
          reservedByOrderId: null,
          reservedAt: null,
          reservationExpiresAt: null
        }
      },
      { session }
    )
  }

  async findReservedUnitsByOrder(orderId, { session } = {}) {
    const query = ProductUnitModel.find({
      status: 'reserved',
      isDeleted: false,
      $or: [{ orderId }, { reservedByOrderId: orderId }]
    }).sort({ createdAt: 1 })

    if (session) query.session(session)

    return query
  }

  async markReservedUnitsSold(unitIds, orderId, soldAt, { session } = {}) {
    return ProductUnitModel.updateMany(
      {
        _id: { $in: unitIds },
        status: 'reserved',
        isDeleted: false,
        orderId,
        reservedByOrderId: orderId
      },
      {
        $set: {
          status: 'sold',
          soldByOrderId: orderId,
          soldAt
        }
      },
      { session }
    )
  }

  async getByIds(unitIds, { session } = {}) {
    const query = ProductUnitModel.find({
      _id: { $in: unitIds },
      isDeleted: false
    }).sort({ createdAt: 1 })

    if (session) query.session(session)

    return query
  }
}

export default new ProductUnitManager()
