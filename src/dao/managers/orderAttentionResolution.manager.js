import mongoose from 'mongoose'
import OrderAttentionResolutionModel from '../models/orderAttentionResolution.model.js'

const inventoryRepairResolutionError = (message, code, status = 400) => {
  const error = new Error(message)
  error.name = 'OrderAttentionResolutionManagerError'
  error.code = code
  error.status = status
  error.statusCode = status
  return error
}

const assertActiveInventoryRepairTransaction = (session) => {
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
    throw inventoryRepairResolutionError(
      'La resolucion de reparacion requiere una transaccion activa',
      'INVENTORY_REPAIR_TRANSACTION_REQUIRED',
      500
    )
  }
}

const validDate = (value) => value instanceof Date && !Number.isNaN(value.getTime())
const text = (value) => String(value ?? '').trim()

const assertInventoryRepairResolutionIdentity = ({
  orderId,
  orderNumber,
  paymentId,
  action,
  originalAttentionReason,
  actorUserId,
  actorRole,
  idempotencyKey,
  requestHash,
  note,
  requestedAt,
  repairAt
}) => {
  if (
    !mongoose.Types.ObjectId.isValid(orderId) ||
    !mongoose.Types.ObjectId.isValid(paymentId) ||
    !mongoose.Types.ObjectId.isValid(actorUserId) ||
    !/^LC-\d{4}-\d{6,}$/.test(text(orderNumber).toUpperCase()) ||
    action !== 'reassign_inventory' ||
    !text(originalAttentionReason) ||
    !['ADMIN', 'SUPERADMIN'].includes(text(actorRole).toUpperCase()) ||
    !text(idempotencyKey) ||
    text(idempotencyKey).length > 128 ||
    !/^[a-f0-9]{64}$/.test(text(requestHash)) ||
    text(note).length > 2000 ||
    !validDate(requestedAt) ||
    !validDate(repairAt)
  ) {
    throw inventoryRepairResolutionError(
      'El contrato de la resolucion de reparacion es invalido',
      'INVALID_INVENTORY_REPAIR_RESOLUTION'
    )
  }
}

class OrderAttentionResolutionManager {
  constructor({ model = OrderAttentionResolutionModel } = {}) {
    this.Model = model
  }

  async createPreparedResolution(data, { session } = {}) {
    const resolution = new this.Model({
      ...data,
      status: 'prepared',
      completedAt: null,
      finalProductUnits: [],
      finalResult: null,
      sanitizedError: null
    })
    return resolution.save({ session })
  }

  async getById(resolutionId, { session } = {}) {
    const query = this.Model.findById(resolutionId).lean()
    if (session) query.session(session)
    return query
  }

  async getByOrderAndIdempotencyKey(orderId, idempotencyKey, { session } = {}) {
    const query = this.Model.findOne({ orderId, idempotencyKey }).lean()
    if (session) query.session(session)
    return query
  }

  async findByIdempotencyKey(idempotencyKey, { session } = {}) {
    const query = this.Model.find({ idempotencyKey })
      .sort({ requestedAt: 1, _id: 1 })
      .limit(2)
      .lean()
    if (session) query.session(session)
    return query
  }

  async findCompletedByOrderAndAction(
    orderId,
    action = 'reassign_inventory',
    { session } = {}
  ) {
    const query = this.Model.findOne({ orderId, action, status: 'completed' }).lean()
    if (session) query.session(session)
    return query
  }

  async getOrderResolutionHistory(orderId, { session } = {}) {
    const query = this.Model.find({ orderId }).sort({ requestedAt: 1, _id: 1 }).lean()
    if (session) query.session(session)
    return query
  }

  async claimPreparedResolutionAttempt(resolutionId, attemptToken, { session } = {}) {
    return this.Model.findOneAndUpdate(
      {
        _id: resolutionId,
        status: 'prepared',
        activeAttemptToken: null
      },
      { $set: { activeAttemptToken: attemptToken } },
      { new: true, session, runValidators: true }
    ).lean()
  }

  async completePreparedResolution(
    resolutionId,
    { completedAt, providerEvidence, finalProductUnits, finalResult, expectedAttemptToken },
    { session } = {}
  ) {
    return this.Model.findOneAndUpdate(
      {
        _id: resolutionId,
        status: 'prepared',
        ...(expectedAttemptToken && { activeAttemptToken: expectedAttemptToken })
      },
      {
        $set: {
          status: 'completed',
          activeAttemptToken: null,
          completedAt,
          providerEvidence,
          finalProductUnits,
          finalResult,
          sanitizedError: null
        }
      },
      { new: true, session, runValidators: true }
    ).lean()
  }

  async failPreparedResolution(
    resolutionId,
    { completedAt, providerEvidence, finalProductUnits, finalResult, sanitizedError },
    { session } = {}
  ) {
    return this.Model.findOneAndUpdate(
      { _id: resolutionId, status: 'prepared', activeAttemptToken: null },
      {
        $set: {
          status: 'failed',
          completedAt,
          providerEvidence,
          finalProductUnits,
          finalResult,
          sanitizedError
        }
      },
      { new: true, session, runValidators: true }
    ).lean()
  }

  async createPreparedInventoryRepairResolution(data, { session } = {}) {
    assertActiveInventoryRepairTransaction(session)
    assertInventoryRepairResolutionIdentity(data)

    const resolution = new this.Model({
      orderId: data.orderId,
      orderNumber: text(data.orderNumber).toUpperCase(),
      paymentId: data.paymentId,
      idempotencyKey: text(data.idempotencyKey),
      requestHash: text(data.requestHash),
      action: 'reassign_inventory',
      originalAttentionReason: text(data.originalAttentionReason),
      actorUserId: data.actorUserId,
      actorRole: text(data.actorRole).toUpperCase(),
      note: text(data.note),
      requestedAt: data.requestedAt,
      repairAt: data.repairAt,
      previousState: data.previousState,
      status: 'prepared',
      activeAttemptToken: null,
      completedAt: null,
      finalProductUnits: [],
      inventoryRepairSummary: undefined,
      finalResult: null,
      sanitizedError: null
    })

    return resolution.save({ session })
  }

  async completeInventoryRepairResolution(
    {
      resolutionId,
      orderId,
      idempotencyKey,
      requestHash,
      completedAt,
      finalProductUnits = [],
      inventoryRepairSummary,
      finalResult
    },
    { session } = {}
  ) {
    assertActiveInventoryRepairTransaction(session)

    if (
      !mongoose.Types.ObjectId.isValid(resolutionId) ||
      !mongoose.Types.ObjectId.isValid(orderId) ||
      !text(idempotencyKey) ||
      !/^[a-f0-9]{64}$/.test(text(requestHash)) ||
      !validDate(completedAt) ||
      !inventoryRepairSummary ||
      !finalResult
    ) {
      throw inventoryRepairResolutionError(
        'La finalizacion de reparacion es invalida',
        'INVALID_INVENTORY_REPAIR_RESOLUTION'
      )
    }

    const result = await this.Model.updateOne(
      {
        _id: resolutionId,
        orderId,
        action: 'reassign_inventory',
        status: 'prepared',
        idempotencyKey: text(idempotencyKey),
        requestHash: text(requestHash)
      },
      {
        $set: {
          status: 'completed',
          activeAttemptToken: null,
          completedAt,
          finalProductUnits,
          inventoryRepairSummary,
          finalResult,
          sanitizedError: null
        }
      },
      { session, runValidators: true }
    )

    if (result?.matchedCount !== 1 || result?.modifiedCount !== 1) {
      throw inventoryRepairResolutionError(
        'La resolucion cambio durante la reparacion de inventario',
        'ATTENTION_RESOLUTION_CAS_CONFLICT',
        409
      )
    }

    return result
  }
}

export {
  OrderAttentionResolutionManager,
  assertActiveInventoryRepairTransaction
}
export default new OrderAttentionResolutionManager()
