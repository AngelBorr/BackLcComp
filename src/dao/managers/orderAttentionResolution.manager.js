import OrderAttentionResolutionModel from '../models/orderAttentionResolution.model.js'

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
}

export { OrderAttentionResolutionManager }
export default new OrderAttentionResolutionManager()
