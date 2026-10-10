import PaymentModel from '../models/payment.model.js'

class PaymentManager {
  async create(data, { session } = {}) {
    const payment = new PaymentModel(data)
    return payment.save({ session })
  }

  async getById(id, { session } = {}) {
    const query = PaymentModel.findById(id).lean()
    if (session) query.session(session)
    return query
  }

  async getByOrderId(orderId, { session } = {}) {
    const query = PaymentModel.find({ orderId }).sort({ createdAt: -1 }).lean()
    if (session) query.session(session)
    return query
  }

  async getLatestByOrderId(orderId, { session } = {}) {
    const query = PaymentModel.findOne({ orderId }).sort({ createdAt: -1 }).lean()
    if (session) query.session(session)
    return query
  }

  async getByProviderPaymentId(providerPaymentId, { session } = {}) {
    const query = PaymentModel.findOne({ providerPaymentId }).lean()
    if (session) query.session(session)
    return query
  }

  async getByProviderOrderId(provider, providerOrderId, { session } = {}) {
    const query = PaymentModel.findOne({ provider, providerOrderId }).lean()
    if (session) query.session(session)
    return query
  }

  async associateProviderOrderIfMissing(
    paymentId,
    providerOrderId,
    { providerStatus, providerStatusDetail },
    { session } = {}
  ) {
    return PaymentModel.findOneAndUpdate(
      {
        _id: paymentId,
        provider: 'mercado_pago',
        normalizedStatus: 'pending',
        $or: [
          { providerOrderId: null },
          { providerOrderId: { $exists: false } }
        ]
      },
      {
        $set: {
          providerOrderId,
          providerStatus,
          providerStatusDetail
        }
      },
      { new: true, session, runValidators: true }
    ).lean()
  }

  async updateProviderObservation(paymentId, update, { session } = {}) {
    return PaymentModel.findOneAndUpdate(
      { _id: paymentId, provider: 'mercado_pago' },
      { $set: update },
      { new: true, session, runValidators: true }
    ).lean()
  }

  async claimBuyerProviderCheck(
    paymentId,
    { checkedAt, cooldownThreshold },
    { session } = {}
  ) {
    return PaymentModel.findOneAndUpdate(
      {
        _id: paymentId,
        provider: 'mercado_pago',
        normalizedStatus: 'pending',
        providerOrderId: { $type: 'string', $ne: '' },
        $or: [
          { lastProviderCheckAt: null },
          { lastProviderCheckAt: { $exists: false } },
          { lastProviderCheckAt: { $lte: cooldownThreshold } }
        ]
      },
      { $set: { lastProviderCheckAt: checkedAt } },
      { new: true, session, runValidators: true }
    ).lean()
  }

  async assignProviderIdempotencyKeyIfMissing(paymentId, provider, providerIdempotencyKey) {
    return PaymentModel.findOneAndUpdate(
      {
        _id: paymentId,
        provider,
        normalizedStatus: 'pending',
        $or: [
          { providerIdempotencyKey: null },
          { providerIdempotencyKey: { $exists: false } }
        ]
      },
      { $set: { providerIdempotencyKey } },
      { new: true, runValidators: true }
    ).lean()
  }

  async prepareProviderRequestSnapshot(
    paymentId,
    providerIdempotencyKey,
    providerRequestSnapshot
  ) {
    return PaymentModel.findOneAndUpdate(
      {
        _id: paymentId,
        provider: 'mercado_pago',
        normalizedStatus: 'pending',
        providerIdempotencyKey,
        providerOrderId: null,
        providerRequestSnapshot: null
      },
      {
        $set: {
          providerRequestSnapshot,
          providerAttemptStatus: 'prepared'
        }
      },
      { new: true, runValidators: true }
    ).lean()
  }

  async updateProviderAttemptStatus(
    paymentId,
    providerIdempotencyKey,
    providerAttemptStatus
  ) {
    return PaymentModel.findOneAndUpdate(
      {
        _id: paymentId,
        provider: 'mercado_pago',
        normalizedStatus: 'pending',
        providerIdempotencyKey,
        providerOrderId: null
      },
      { $set: { providerAttemptStatus } },
      { new: true, runValidators: true }
    ).lean()
  }

  async rotateProviderIdempotencyKey(
    paymentId,
    expectedProviderIdempotencyKey,
    providerIdempotencyKey,
    providerRequestSnapshot
  ) {
    return PaymentModel.findOneAndUpdate(
      {
        _id: paymentId,
        provider: 'mercado_pago',
        normalizedStatus: 'pending',
        providerIdempotencyKey: expectedProviderIdempotencyKey,
        providerAttemptStatus: 'rejected',
        providerRequestSnapshot: { $type: 'object' },
        providerOrderId: null
      },
      {
        $set: {
          providerIdempotencyKey,
          providerRequestSnapshot,
          providerAttemptStatus: 'prepared'
        }
      },
      { new: true, runValidators: true }
    ).lean()
  }

  async attachProviderOrder(
    paymentId,
    providerIdempotencyKey,
    { providerOrderId, providerCheckoutUrl, providerStatus }
  ) {
    return PaymentModel.findOneAndUpdate(
      {
        _id: paymentId,
        provider: 'mercado_pago',
        normalizedStatus: 'pending',
        providerIdempotencyKey,
        $or: [
          { providerOrderId: null },
          { providerOrderId: { $exists: false } }
        ]
      },
      {
        $set: {
          providerOrderId,
          providerCheckoutUrl,
          providerStatus,
          providerAttemptStatus: 'succeeded'
        }
      },
      { new: true, runValidators: true }
    ).lean()
  }

  async prepareProviderCancellationIfMissing(
    paymentId,
    providerOrderId,
    providerCancellationIdempotencyKey
  ) {
    return PaymentModel.findOneAndUpdate(
      {
        _id: paymentId,
        provider: 'mercado_pago',
        normalizedStatus: 'pending',
        providerOrderId,
        $and: [
          {
            $or: [
              { providerCancellationIdempotencyKey: null },
              { providerCancellationIdempotencyKey: { $exists: false } }
            ]
          },
          {
            $or: [
              { providerCancellationStatus: null },
              { providerCancellationStatus: { $exists: false } }
            ]
          }
        ]
      },
      {
        $set: {
          providerCancellationIdempotencyKey,
          providerCancellationStatus: 'prepared'
        }
      },
      { new: true, runValidators: true }
    ).lean()
  }

  async markProviderCancellationAttempt(
    paymentId,
    providerCancellationIdempotencyKey,
    attemptedAt
  ) {
    return PaymentModel.findOneAndUpdate(
      {
        _id: paymentId,
        provider: 'mercado_pago',
        normalizedStatus: 'pending',
        providerCancellationIdempotencyKey,
        providerCancellationStatus: { $in: ['prepared', 'uncertain'] }
      },
      { $set: { providerCancellationAttemptedAt: attemptedAt } },
      { new: true, runValidators: true }
    ).lean()
  }

  async updateProviderCancellationStatus(
    paymentId,
    providerCancellationIdempotencyKey,
    providerCancellationStatus,
    { completedAt = null } = {}
  ) {
    return PaymentModel.findOneAndUpdate(
      {
        _id: paymentId,
        provider: 'mercado_pago',
        normalizedStatus: 'pending',
        providerCancellationIdempotencyKey,
        providerCancellationStatus: { $in: ['prepared', 'uncertain'] }
      },
      {
        $set: {
          providerCancellationStatus,
          ...(completedAt && { providerCancellationCompletedAt: completedAt })
        }
      },
      { new: true, runValidators: true }
    ).lean()
  }

  async updateStatus(paymentId, expectedStatus, update, { session } = {}) {
    return PaymentModel.findOneAndUpdate(
      { _id: paymentId, normalizedStatus: expectedStatus },
      { $set: update },
      { new: true, session, runValidators: true }
    ).lean()
  }
}

export { PaymentManager }
export default new PaymentManager()
