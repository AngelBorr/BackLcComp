import mongoose from 'mongoose'
import OrderManager from '../dao/managers/order.manager.js'
import PaymentManager from '../dao/managers/payment.manager.js'
import PaymentRefundManager from '../dao/managers/paymentRefund.manager.js'
import MercadoPagoProvider, {
  MercadoPagoProviderError
} from '../providers/mercadoPago.provider.js'
import { ServiceError } from './service.products.js'
import { getEffectiveFulfillmentStatus } from '../utils/orderFulfillment.js'
import { createHash } from 'node:crypto'
import {
  classifyRefundEvidence,
  REFUND_RECONCILIATION_OUTCOMES
} from './mercadoPagoRefundClassification.service.js'
import { toMinorUnits } from '../utils/commerceMoney.js'

const TRANSACTION_OPTIONS = Object.freeze({
  readConcern: { level: 'snapshot' },
  writeConcern: { w: 'majority' }
})

const sameMoney = (left, right) => {
  try {
    return toMinorUnits(left) === toMinorUnits(right)
  } catch {
    return false
  }
}

const safeEvidence = (providerOrder, classification) => {
  const providerPayment = classification.payment || providerOrder.payments?.find(
    (payment) => payment.providerPaymentId === classification.refund?.providerPaymentId
  )

  return {
    providerOrderId: providerOrder.providerOrderId,
    externalReference: providerOrder.externalReference,
    totalAmount: providerOrder.totalAmount,
    totalPaidAmount: providerOrder.totalPaidAmount,
    totalPaidAmountPresent:
      providerOrder.reconciliationSource?.totalPaidAmountPresent === true,
    totalRefundedAmountPresent:
      providerOrder.reconciliationSource?.totalRefundedAmountPresent === true,
    ...(providerOrder.reconciliationSource?.totalRefundedAmountPresent === true && {
      totalRefundedAmount: providerOrder.totalRefundedAmount
    }),
    currency: providerOrder.currency,
    providerStatus: providerOrder.status,
    providerStatusDetail: providerOrder.statusDetail,
    providerRefundId: classification.refund?.providerRefundId || null,
    providerPaymentId: classification.refund?.providerPaymentId || null,
    providerPaymentStatus: providerPayment?.status || null,
    providerPaymentStatusDetail: providerPayment?.statusDetail || null,
    providerPaymentRefundedAmountPresent:
      providerPayment?.refundedAmountPresent === true,
    ...(providerPayment?.refundedAmountPresent === true && {
      providerPaymentRefundedAmount: providerPayment.refundedAmount
    }),
    refundAmount: classification.refund?.amount || null,
    refundStatus: classification.refund?.status || null,
    refundStatusDetail: classification.refund?.statusDetail || null
  }
}

class PaymentRefundReconciliationService {
  constructor({
    mongooseInstance = mongoose,
    orderManager = OrderManager,
    paymentManager = PaymentManager,
    paymentRefundManager = PaymentRefundManager,
    provider = MercadoPagoProvider
  } = {}) {
    this.mongoose = mongooseInstance
    this.orders = orderManager
    this.payments = paymentManager
    this.refunds = paymentRefundManager
    this.provider = provider
  }

  async #transaction(operation) {
    const session = await this.mongoose.startSession()
    let result
    try {
      await session.withTransaction(async () => {
        result = await operation(session)
      }, TRANSACTION_OPTIONS)
      return result
    } finally {
      await session.endSession()
    }
  }

  #expected(payment, order) {
    return {
      providerOrderId: payment.providerOrderId,
      providerPaymentId: payment.providerPaymentId,
      externalReference: order.orderNumber,
      amount: payment.amountArs,
      currency: payment.currency
    }
  }

  async reconcileRefund(refundId, { now = new Date(), providerOrder = null } = {}) {
    const checkedAt = new Date(now)
    if (Number.isNaN(checkedAt.getTime())) {
      throw new ServiceError('Fecha de reconciliacion invalida', 'INVALID_REFUND_DATE', 400)
    }

    const initialRefund = await this.refunds.getById(refundId)
    if (!initialRefund) throw new ServiceError('Reembolso no encontrado', 'REFUND_NOT_FOUND', 404)
    if (initialRefund.status === 'succeeded') {
      return { refund: initialRefund, outcome: 'succeeded', idempotent: true }
    }

    let observed = providerOrder
    if (!observed) {
      try {
        observed = await this.provider.getOrder(initialRefund.providerOrderId)
      } catch (error) {
        if (error instanceof MercadoPagoProviderError) {
          throw new ServiceError(error.message, error.code, error.status)
        }
        throw error
      }
    }

    return this.#transaction(async (session) => {
      const refund = await this.refunds.getById(refundId, { session })
      const payment = refund && await this.payments.getById(refund.paymentId, { session })
      const order = refund && await this.orders.getById(refund.orderId, { session })

      if (!refund || !payment || !order) {
        throw new ServiceError(
          'Contexto local de reembolso incompleto',
          'REFUND_LOCAL_CONTEXT_MISSING',
          409
        )
      }
      if (refund.status === 'succeeded') {
        return { refund, outcome: 'succeeded', idempotent: true }
      }

      const classification = classifyRefundEvidence(observed, this.#expected(payment, order))
      const evidence = safeEvidence(observed, classification)

      if (classification.outcome === REFUND_RECONCILIATION_OUTCOMES.SUCCEEDED) {
        const adminSubmissionValid = refund.origin === 'admin' && refund.submittedAt != null
        const providerObservedValid = refund.origin === 'provider_observed' &&
          refund.submittedAt == null
        if (
          order.status !== 'paid' ||
          !order.paidAt ||
          String(order.activeRefundId || '') !== String(refund._id) ||
          payment.normalizedStatus !== 'approved' ||
          !payment.approvedAt ||
          refund.operationScope !== 'total_refund' ||
          String(refund.orderId) !== String(order._id) ||
          String(refund.paymentId) !== String(payment._id) ||
          refund.providerOrderId !== payment.providerOrderId ||
          refund.providerPaymentId !== payment.providerPaymentId ||
          refund.currency !== payment.currency ||
          !sameMoney(refund.requestedAmountArs, payment.amountArs) ||
          (refund.providerRefundId != null &&
            refund.providerRefundId !== classification.refund.providerRefundId) ||
          (!adminSubmissionValid && !providerObservedValid)
        ) {
          throw new ServiceError(
            'El contexto local cambio durante el reembolso',
            'REFUND_FINALIZATION_CONFLICT',
            409
          )
        }

        const finalizedPayment = await this.payments.finalizeTotalRefund(
          payment._id,
          {
            providerOrderId: payment.providerOrderId,
            providerPaymentId: payment.providerPaymentId,
            approvedAt: payment.approvedAt,
            expectedAmountArs: payment.amountArs,
            currency: payment.currency,
            providerStatus: observed.status,
            providerStatusDetail: observed.statusDetail,
            checkedAt
          },
          { session }
        )
        const finalizedOrder = finalizedPayment && await this.orders.finalizeTotalRefund(
          order._id,
          refund._id,
          {
            refundedAt: checkedAt,
            paidAt: order.paidAt,
            expectedFulfillmentStatus: getEffectiveFulfillmentStatus(order)
          },
          { session }
        )
        const finalizedRefund = finalizedOrder && await this.refunds.finalizeSucceeded(
          refund._id,
          {
            expectedStatuses: ['prepared', 'submitted', 'processing', 'requires_attention'],
            expectedVersion: refund.version,
            orderId: refund.orderId,
            paymentId: refund.paymentId,
            providerOrderId: refund.providerOrderId,
            providerPaymentId: refund.providerPaymentId,
            providerIdempotencyKey: refund.providerIdempotencyKey,
            idempotencyKey: refund.idempotencyKey,
            requestedAmountArs: refund.requestedAmountArs,
            currency: refund.currency,
            origin: refund.origin,
            submittedAt: refund.submittedAt,
            expectedProviderRefundId: refund.providerRefundId,
            providerRefundId: classification.refund.providerRefundId,
            confirmedAmountArs: refund.requestedAmountArs,
            providerStatus: observed.status,
            providerStatusDetail: observed.statusDetail,
            providerEvidenceSnapshot: evidence,
            checkedAt,
            completedAt: checkedAt
          },
          { session }
        )

        if (!finalizedPayment || !finalizedOrder || !finalizedRefund) {
          throw new ServiceError(
            'Conflicto al confirmar el reembolso',
            'REFUND_FINALIZATION_CONFLICT',
            409
          )
        }

        return { refund: finalizedRefund, outcome: 'succeeded', idempotent: false }
      }

      if (classification.outcome === REFUND_RECONCILIATION_OUTCOMES.REJECTED_DEFINITIVE) {
        const rejected = await this.refunds.markRejected(
          refund._id,
          ['prepared', 'submitted', 'processing'],
          {
            providerRefundId: classification.refund?.providerRefundId || null,
            providerStatus: classification.refund?.status || null,
            providerStatusDetail: classification.refund?.statusDetail || null,
            providerEvidenceSnapshot: evidence,
            lastProviderCheckAt: checkedAt,
            completedAt: checkedAt
          },
          { session }
        )
        const cleared = rejected && await this.orders.clearActiveRefund(
          order._id,
          refund._id,
          { session }
        )
        if (!rejected || !cleared) {
          throw new ServiceError('Conflicto al rechazar el reembolso', 'REFUND_REJECTION_CONFLICT', 409)
        }
        return { refund: rejected, outcome: 'rejected', idempotent: false }
      }

      const nextStatus = classification.outcome === REFUND_RECONCILIATION_OUTCOMES.PROCESSING ||
        classification.outcome === REFUND_RECONCILIATION_OUTCOMES.NOT_OBSERVED
        ? 'processing'
        : 'requires_attention'
      const updated = await this.refunds.transition(
        refund._id,
        ['prepared', 'submitted', 'processing', 'requires_attention'],
        {
          status: nextStatus,
          providerStatus: observed.status,
          providerStatusDetail: observed.statusDetail,
          providerEvidenceSnapshot: evidence,
          lastProviderCheckAt: checkedAt,
          sanitizedError: nextStatus === 'requires_attention'
            ? { code: classification.reason, message: 'La evidencia remota requiere revision' }
            : null
        },
        { session }
      )
      if (!updated) {
        throw new ServiceError('Conflicto al reconciliar el reembolso', 'REFUND_RECONCILIATION_CONFLICT', 409)
      }
      return { refund: updated, outcome: nextStatus, idempotent: false }
    })
  }

  async reconcileProviderOrder(providerOrder, { now = new Date() } = {}) {
    const hasRemoteRefund = providerOrder?.reconciliationSource?.refundsPresent === true &&
      providerOrder?.reconciliationSource?.refundsIsArray === true &&
      (providerOrder.refunds || []).length > 0

    if (!hasRemoteRefund) return { handled: false }

    const payment = await this.payments.getByProviderOrderId(
      'mercado_pago',
      providerOrder.providerOrderId
    )
    if (!payment) return { handled: false }
    const order = await this.orders.getById(payment.orderId)
    if (!order) return { handled: false }

    let refund = await this.refunds.getActiveByProviderOrderId(providerOrder.providerOrderId)
    if (!refund) {
      const checkedAt = new Date(now)
      const classification = classifyRefundEvidence(
        providerOrder,
        this.#expected(payment, order)
      )
      const providerRefundId = classification.refund?.providerRefundId ||
        providerOrder.refunds?.[0]?.providerRefundId || 'unidentified'
      const requestHash = createHash('sha256')
        .update(`provider_observed:${providerOrder.providerOrderId}:${providerRefundId}`)
        .digest('hex')

      refund = await this.#transaction(async (session) => {
        const concurrent = await this.refunds.getActiveByProviderOrderId(
          providerOrder.providerOrderId,
          { session }
        )
        if (concurrent) return concurrent
        if (order.status !== 'paid' || payment.normalizedStatus !== 'approved') {
          throw new ServiceError(
            'El reembolso externo requiere revision administrativa',
            'REFUND_EXTERNAL_CONTEXT_CONFLICT',
            409
          )
        }

        const refundId = new mongoose.Types.ObjectId()
        const created = await this.refunds.create({
          _id: refundId,
          orderId: order._id,
          paymentId: payment._id,
          provider: 'mercado_pago',
          providerOrderId: payment.providerOrderId,
          providerPaymentId: payment.providerPaymentId,
          type: 'total',
          requestedAmountArs: payment.amountArs,
          confirmedAmountArs: null,
          currency: payment.currency,
          status: classification.outcome === REFUND_RECONCILIATION_OUTCOMES.SUCCEEDED
            ? 'processing'
            : 'requires_attention',
          idempotencyKey: null,
          providerIdempotencyKey: null,
          requestHash,
          providerRefundId: classification.refund?.providerRefundId || null,
          operationScope: 'total_refund',
          providerStatus: classification.refund?.status || providerOrder.status,
          providerStatusDetail: classification.refund?.statusDetail || providerOrder.statusDetail,
          requestedAt: checkedAt,
          submittedAt: null,
          lastProviderCheckAt: checkedAt,
          providerRequestSnapshot: null,
          providerEvidenceSnapshot: safeEvidence(providerOrder, classification),
          origin: 'provider_observed',
          requestedBy: null,
          requestedByRole: null,
          reasonCode: 'provider_observed',
          note: '',
          sanitizedError: classification.outcome === REFUND_RECONCILIATION_OUTCOMES.SUCCEEDED
            ? null
            : {
                code: classification.reason,
                message: 'Reembolso externo pendiente de revision'
              }
        }, { session })
        const fenced = await this.orders.attachActiveRefund(order._id, refundId, { session })
        if (!fenced) {
          throw new ServiceError(
            'La orden cambio al observar el reembolso',
            'REFUND_EXTERNAL_CONTEXT_CONFLICT',
            409
          )
        }
        return typeof created?.toObject === 'function' ? created.toObject() : created
      })
    }

    const result = await this.reconcileRefund(refund._id, { now, providerOrder })
    return { handled: true, ...result }
  }
}

export { PaymentRefundReconciliationService, TRANSACTION_OPTIONS }
export default new PaymentRefundReconciliationService()
