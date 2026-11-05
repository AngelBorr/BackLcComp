import PaymentRefundModel from '../models/paymentRefund.model.js'

class PaymentRefundManager {
  async create(data, { session } = {}) {
    const refund = new PaymentRefundModel(data)
    return refund.save({ session })
  }

  async getById(id, { session } = {}) {
    const query = PaymentRefundModel.findById(id).lean()
    if (session) query.session(session)
    return query
  }

  async getByOrderAndIdempotencyKey(orderId, idempotencyKey, { session } = {}) {
    const query = PaymentRefundModel.findOne({ orderId, idempotencyKey }).lean()
    if (session) query.session(session)
    return query
  }

  async getActiveByPaymentId(paymentId, { session } = {}) {
    const query = PaymentRefundModel.findOne({
      paymentId,
      operationScope: 'total_refund'
    }).lean()
    if (session) query.session(session)
    return query
  }

  async getActiveByProviderOrderId(providerOrderId, { session } = {}) {
    const query = PaymentRefundModel.findOne({
      provider: 'mercado_pago',
      providerOrderId,
      operationScope: 'total_refund'
    }).lean()
    if (session) query.session(session)
    return query
  }

  async getByProviderRefundId(providerRefundId, { session } = {}) {
    const query = PaymentRefundModel.findOne({
      provider: 'mercado_pago',
      providerRefundId
    }).lean()
    if (session) query.session(session)
    return query
  }

  async listByOrderId(orderId, { session } = {}) {
    const query = PaymentRefundModel.find({ orderId }).sort({ requestedAt: 1, _id: 1 }).lean()
    if (session) query.session(session)
    return query
  }

  async transition(refundId, expectedStatuses, update, { session } = {}) {
    return PaymentRefundModel.findOneAndUpdate(
      { _id: refundId, status: { $in: expectedStatuses } },
      { $set: update, $inc: { version: 1 } },
      { new: true, session, runValidators: true }
    ).lean()
  }

  async finalizeSucceeded(
    refundId,
    {
      expectedStatuses, expectedVersion, providerRefundId, confirmedAmountArs,
      providerStatus, providerStatusDetail, providerEvidenceSnapshot,
      checkedAt, completedAt
    },
    { session } = {}
  ) {
    return PaymentRefundModel.findOneAndUpdate(
      {
        _id: refundId,
        status: { $in: expectedStatuses },
        version: expectedVersion,
        operationScope: 'total_refund'
      },
      {
        $set: {
          status: 'succeeded',
          providerRefundId,
          confirmedAmountArs,
          providerStatus,
          providerStatusDetail,
          providerEvidenceSnapshot,
          lastProviderCheckAt: checkedAt,
          completedAt,
          attemptOwnerToken: null,
          attemptLeaseUntil: null,
          sanitizedError: null
        },
        $inc: { version: 1 }
      },
      { new: true, session, runValidators: true }
    ).lean()
  }

  async markRejected(refundId, expectedStatuses, update, { session } = {}) {
    return PaymentRefundModel.findOneAndUpdate(
      { _id: refundId, status: { $in: expectedStatuses } },
      {
        $set: {
          status: 'rejected',
          operationScope: null,
          attemptOwnerToken: null,
          attemptLeaseUntil: null,
          ...update
        },
        $inc: { version: 1 }
      },
      { new: true, session, runValidators: true }
    ).lean()
  }
}

export { PaymentRefundManager }
export default new PaymentRefundManager()
