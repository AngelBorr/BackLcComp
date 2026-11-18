import mongoose from 'mongoose'
import PaymentModel from '../models/payment.model.js'

const inventoryRepairPaymentError = (message, code, status = 400) => {
  const error = new Error(message)
  error.name = 'PaymentManagerError'
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
    throw inventoryRepairPaymentError(
      'El fence de evidencia requiere una transaccion activa',
      'INVENTORY_REPAIR_TRANSACTION_REQUIRED',
      500
    )
  }
}

const validDate = (value) => value instanceof Date && !Number.isNaN(value.getTime())
const nonEmptyText = (value) => typeof value === 'string' && value.trim() !== ''

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
    attemptedAt,
    { payableStatus, payableObservedAt }
  ) {
    return PaymentModel.findOneAndUpdate(
      {
        _id: paymentId,
        provider: 'mercado_pago',
        normalizedStatus: 'pending',
        providerCancellationIdempotencyKey,
        providerCancellationStatus: { $in: ['prepared', 'uncertain'] },
        $and: [
          {
            $or: [
              { providerPaymentId: null },
              { providerPaymentId: { $exists: false } }
            ]
          },
          {
            $or: [
              { approvedAt: null },
              { approvedAt: { $exists: false } }
            ]
          }
        ]
      },
      {
        $set: {
          providerCancellationAttemptedAt: attemptedAt,
          providerCancellationPayableStatus: payableStatus,
          providerCancellationPayableObservedAt: payableObservedAt
        }
      },
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

  async fenceApprovedInventoryRepairEvidence(
    {
      paymentId,
      orderId,
      provider,
      normalizedStatus,
      providerOrderId,
      providerPaymentId,
      approvedAt,
      externalReference,
      amountArs,
      currency,
      expectedUpdatedAt,
      repairAt
    },
    { session } = {}
  ) {
    assertActiveInventoryRepairTransaction(session)

    if (
      !mongoose.Types.ObjectId.isValid(paymentId) ||
      !mongoose.Types.ObjectId.isValid(orderId) ||
      provider !== 'mercado_pago' ||
      normalizedStatus !== 'approved' ||
      !nonEmptyText(providerOrderId) ||
      !nonEmptyText(providerPaymentId) ||
      !validDate(approvedAt) ||
      !nonEmptyText(externalReference) ||
      amountArs == null ||
      !nonEmptyText(currency) ||
      !validDate(expectedUpdatedAt) ||
      !validDate(repairAt)
    ) {
      throw inventoryRepairPaymentError(
        'La evidencia aprobada para el fence es invalida',
        'INVALID_INVENTORY_REPAIR_PAYMENT_EVIDENCE'
      )
    }

    if (repairAt.getTime() <= expectedUpdatedAt.getTime()) {
      throw inventoryRepairPaymentError(
        'repairAt debe ser posterior al timestamp de Payment',
        'INVENTORY_REPAIR_PAYMENT_FENCE_TIMESTAMP_CONFLICT',
        409
      )
    }

    const result = await PaymentModel.updateOne(
      {
        _id: paymentId,
        orderId,
        provider,
        normalizedStatus: 'approved',
        providerOrderId,
        providerPaymentId,
        approvedAt,
        externalReference,
        amountArs,
        currency,
        updatedAt: expectedUpdatedAt
      },
      { $set: { updatedAt: repairAt } },
      { session, runValidators: true, timestamps: false }
    )

    if (result?.matchedCount !== 1 || result?.modifiedCount !== 1) {
      throw inventoryRepairPaymentError(
        'La evidencia financiera cambio durante la reparacion',
        'INVENTORY_REPAIR_PAYMENT_EVIDENCE_CHANGED',
        409
      )
    }

    return result
  }

  async finalizeTotalRefund(
    paymentId,
    {
      providerOrderId,
      providerPaymentId,
      approvedAt,
      expectedAmountArs,
      currency,
      providerStatus,
      providerStatusDetail,
      checkedAt
    },
    { session } = {}
  ) {
    return PaymentModel.findOneAndUpdate(
      {
        _id: paymentId,
        normalizedStatus: 'approved',
        approvedAt,
        provider: 'mercado_pago',
        providerOrderId,
        providerPaymentId,
        amountArs: expectedAmountArs,
        currency
      },
      {
        $set: {
          normalizedStatus: 'refunded',
          providerStatus,
          providerStatusDetail,
          lastProviderCheckAt: checkedAt
        }
      },
      { new: true, session, runValidators: true }
    ).lean()
  }

  async confirmApprovedAttentionEvidence(
    paymentId,
    {
      orderId,
      providerOrderId,
      providerPaymentId,
      approvedAt,
      amountArs,
      currency,
      expectedLastProviderCheckAt,
      observedAt,
      providerStatus,
      providerStatusDetail
    },
    { session } = {}
  ) {
    const lastProviderCheckFilter = expectedLastProviderCheckAt == null
      ? {
          $or: [
            { lastProviderCheckAt: null },
            { lastProviderCheckAt: { $exists: false } }
          ]
        }
      : { lastProviderCheckAt: expectedLastProviderCheckAt }

    return PaymentModel.findOneAndUpdate(
      {
        $and: [
          {
            _id: paymentId,
            orderId,
            provider: 'mercado_pago',
            normalizedStatus: 'approved',
            providerOrderId,
            providerPaymentId,
            approvedAt,
            amountArs,
            currency
          },
          lastProviderCheckFilter
        ]
      },
      {
        $set: {
          providerStatus,
          providerStatusDetail,
          lastProviderCheckAt: observedAt
        }
      },
      { new: true, session, runValidators: true }
    ).lean()
  }

  async transitionPendingWithTerminalUnpaidObservation(
    paymentId,
    {
      orderId,
      providerOrderId,
      observedAt,
      nextStatus,
      cancellationContext = null
    },
    { session } = {}
  ) {
    return PaymentModel.findOneAndUpdate(
      {
        _id: paymentId,
        orderId,
        provider: 'mercado_pago',
        normalizedStatus: 'pending',
        providerOrderId,
        providerStatus: 'canceled',
        lastProviderCheckAt: observedAt,
        ...(cancellationContext && {
          providerCancellationIdempotencyKey:
            cancellationContext.providerCancellationIdempotencyKey,
          providerCancellationStatus: cancellationContext.providerCancellationStatus,
          providerCancellationAttemptedAt: cancellationContext.providerCancellationAttemptedAt,
          providerCancellationPayableStatus:
            cancellationContext.providerCancellationPayableStatus,
          providerCancellationPayableObservedAt:
            cancellationContext.providerCancellationPayableObservedAt,
          externalReference: cancellationContext.verifiedExternalReference,
          amountArs: cancellationContext.verifiedAmountArs,
          currency: cancellationContext.verifiedCurrency
        }),
        $and: [
          {
            $or: [
              { providerPaymentId: null },
              { providerPaymentId: { $exists: false } }
            ]
          },
          {
            $or: [
              { approvedAt: null },
              { approvedAt: { $exists: false } }
            ]
          }
        ]
      },
      { $set: { normalizedStatus: nextStatus } },
      { new: true, session, runValidators: true }
    ).lean()
  }

  async cancelAttentionWithTerminalUnpaidEvidence(
    paymentId,
    {
      orderId,
      expectedNormalizedStatus,
      providerOrderId,
      externalReference,
      amountArs,
      currency,
      expectedProviderStatus,
      expectedProviderStatusDetail,
      expectedLastProviderCheckAt,
      observedAt,
      providerStatus,
      providerStatusDetail,
      cancellationContext = null
    },
    { session } = {}
  ) {
    const cancellationFilter = cancellationContext
      ? {
          providerCancellationIdempotencyKey:
            cancellationContext.providerCancellationIdempotencyKey,
          providerCancellationStatus: cancellationContext.providerCancellationStatus,
          providerCancellationAttemptedAt:
            cancellationContext.providerCancellationAttemptedAt,
          providerCancellationCompletedAt:
            cancellationContext.providerCancellationCompletedAt,
          providerCancellationPayableStatus:
            cancellationContext.providerCancellationPayableStatus,
          providerCancellationPayableObservedAt:
            cancellationContext.providerCancellationPayableObservedAt
        }
      : {}

    return PaymentModel.findOneAndUpdate(
      {
        _id: paymentId,
        orderId,
        provider: 'mercado_pago',
        normalizedStatus: expectedNormalizedStatus,
        providerOrderId,
        externalReference,
        amountArs,
        currency,
        providerStatus: expectedProviderStatus,
        providerStatusDetail: expectedProviderStatusDetail,
        lastProviderCheckAt: expectedLastProviderCheckAt,
        ...cancellationFilter,
        $and: [
          {
            $or: [
              { providerPaymentId: null },
              { providerPaymentId: { $exists: false } }
            ]
          },
          {
            $or: [
              { approvedAt: null },
              { approvedAt: { $exists: false } }
            ]
          }
        ]
      },
      {
        $set: {
          normalizedStatus: 'cancelled',
          providerStatus,
          providerStatusDetail,
          lastProviderCheckAt: observedAt
        }
      },
      { new: true, session, runValidators: true }
    ).lean()
  }
}

export { PaymentManager }
export default new PaymentManager()
