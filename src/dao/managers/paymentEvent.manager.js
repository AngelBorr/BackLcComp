import PaymentEventModel from '../models/paymentEvent.model.js'

class PaymentEventManager {
  async create(data, { session } = {}) {
    const paymentEvent = new PaymentEventModel(data)
    return paymentEvent.save({ session })
  }

  async getByProviderEventId(provider, providerEventId, { session } = {}) {
    const query = PaymentEventModel.findOne({ provider, providerEventId }).lean()
    if (session) query.session(session)
    return query
  }

  async getByProviderPaymentId(providerPaymentId, { session } = {}) {
    const query = PaymentEventModel.find({ providerPaymentId }).sort({ receivedAt: 1 }).lean()
    if (session) query.session(session)
    return query
  }

  async updateProcessingStatus(
    eventId,
    expectedStatus,
    { processingStatus, processedAt = null, lastError = null, incrementAttempts = false },
    { session } = {}
  ) {
    const update = {
      $set: { processingStatus, processedAt, lastError }
    }

    if (incrementAttempts) update.$inc = { attempts: 1 }

    return PaymentEventModel.findOneAndUpdate(
      { _id: eventId, processingStatus: expectedStatus },
      update,
      { new: true, session, runValidators: true }
    ).lean()
  }

  async claimForProcessing(
    {
      provider,
      providerEventId,
      providerOrderId,
      receivedAt,
      processingStartedAt,
      staleBefore
    },
    { session } = {}
  ) {
    const claimable = [
      { processingStatus: { $in: ['received', 'failed'] } },
      {
        processingStatus: 'processing',
        $or: [
          { processingStartedAt: null },
          { processingStartedAt: { $exists: false } },
          { processingStartedAt: { $lte: staleBefore } }
        ]
      }
    ]

    const claimed = await PaymentEventModel.findOneAndUpdate(
      { provider, providerEventId, $or: claimable },
      {
        $set: {
          providerOrderId,
          processingStatus: 'processing',
          processingStartedAt,
          processedAt: null,
          lastError: null
        },
        $inc: { attempts: 1 }
      },
      { new: true, session, runValidators: true }
    ).lean()

    if (claimed) return { event: claimed, claimed: true }

    const existing = await this.getByProviderEventId(provider, providerEventId, { session })
    if (existing) return { event: existing, claimed: false }

    try {
      const created = await this.create(
        {
          provider,
          providerEventId,
          providerOrderId,
          receivedAt,
          processedAt: null,
          processingStatus: 'processing',
          processingStartedAt,
          attempts: 1,
          lastError: null
        },
        { session }
      )

      return {
        event: typeof created?.toObject === 'function' ? created.toObject() : created,
        claimed: true
      }
    } catch (error) {
      if (error?.code !== 11000 && error?.errorResponse?.code !== 11000) throw error

      const concurrent = await this.getByProviderEventId(provider, providerEventId, { session })
      if (!concurrent) throw error
      return { event: concurrent, claimed: false }
    }
  }

  async markProcessed(
    eventId,
    { processingStatus = 'processed', processedAt, orderId = null, providerPaymentId = null },
    { session } = {}
  ) {
    return PaymentEventModel.findOneAndUpdate(
      { _id: eventId, processingStatus: 'processing' },
      {
        $set: {
          processingStatus,
          processedAt,
          processingStartedAt: null,
          orderId,
          providerPaymentId,
          lastError: null
        }
      },
      { new: true, session, runValidators: true }
    ).lean()
  }

  async markFailed(eventId, lastError, { session } = {}) {
    return PaymentEventModel.findOneAndUpdate(
      { _id: eventId, processingStatus: 'processing' },
      {
        $set: {
          processingStatus: 'failed',
          processingStartedAt: null,
          processedAt: null,
          lastError
        }
      },
      { new: true, session, runValidators: true }
    ).lean()
  }
}

export { PaymentEventManager }
export default new PaymentEventManager()
