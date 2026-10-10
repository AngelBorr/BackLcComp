import mongoose from 'mongoose'
import OrderManager from '../dao/managers/order.manager.js'
import PaymentManager from '../dao/managers/payment.manager.js'
import ProductUnitService from './productUnit.service.js'
import MercadoPagoProvider, {
  MercadoPagoProviderError
} from '../providers/mercadoPago.provider.js'
import { ServiceError } from './service.products.js'
import { toMinorUnits } from '../utils/commerceMoney.js'
import { error as logError, secureLog } from '../utils/logger.js'
import {
  REMOTE_ORDER_CLASSIFICATIONS,
  classifyRemoteOrder
} from './mercadoPagoOrderClassification.service.js'

const TRANSACTION_OPTIONS = Object.freeze({
  readConcern: { level: 'snapshot' },
  writeConcern: { w: 'majority' }
})

const INVENTORY_CONFLICT_CODES = new Set([
  'RESERVATION_INTEGRITY_CONFLICT',
  'RESERVATION_SALE_CONFLICT'
])

const asText = (value) => String(value ?? '').trim()

const moneyToCents = (value, field) => {
  try {
    return toMinorUnits(value, field)
  } catch {
    throw new ServiceError(
      `Importe invÃ¡lido en ${field}`,
      'MERCADOPAGO_RECONCILIATION_MISMATCH',
      409
    )
  }
}

class MercadoPagoReconciliationService {
  constructor({
    mongooseInstance = mongoose,
    orderManager = OrderManager,
    paymentManager = PaymentManager,
    productUnitService = ProductUnitService,
    provider = MercadoPagoProvider
  } = {}) {
    this.mongoose = mongooseInstance
    this.orders = orderManager
    this.payments = paymentManager
    this.productUnits = productUnitService
    this.provider = provider
  }

  async #runTransaction(operation) {
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

  async #locateContext(providerOrder, session) {
    let payment = await this.payments.getByProviderOrderId(
      'mercado_pago',
      providerOrder.providerOrderId,
      { session }
    )
    let order = payment ? await this.orders.getById(payment.orderId, { session }) : null

    if (!payment) {
      const externalReference = asText(providerOrder.externalReference).toUpperCase()
      if (!externalReference) return null

      order = await this.orders.getByOrderNumber(externalReference, { session })
      if (!order) return null

      payment = await this.payments.getLatestByOrderId(order._id, { session })
      if (!payment) return { order, payment: null, associationRequired: false }

      return { order, payment, associationRequired: true }
    }

    return { order, payment, associationRequired: false }
  }

  #getCoreMismatch(context, providerOrder) {
    const { payment, order } = context

    if (!payment || !order) return 'LOCAL_PAYMENT_OR_ORDER_MISSING'
    if (payment.provider !== 'mercado_pago') return 'PAYMENT_PROVIDER_MISMATCH'
    if (String(payment.orderId) !== String(order._id)) return 'PAYMENT_ORDER_MISMATCH'
    if (asText(providerOrder.externalReference).toUpperCase() !== asText(order.orderNumber)) {
      return 'EXTERNAL_REFERENCE_MISMATCH'
    }
    if (providerOrder.currency && asText(providerOrder.currency).toUpperCase() !== 'ARS') {
      return 'CURRENCY_MISMATCH'
    }

    const orderTotal = moneyToCents(order.totals?.totalArs, 'Order.totalArs')
    const paymentTotal = moneyToCents(payment.amountArs, 'Payment.amountArs')
    const providerTotal = moneyToCents(providerOrder.totalAmount, 'MercadoPago.totalAmount')

    if (orderTotal !== paymentTotal || orderTotal !== providerTotal) {
      return 'TOTAL_AMOUNT_MISMATCH'
    }

    const localProviderOrderId = asText(payment.providerOrderId)
    if (localProviderOrderId && localProviderOrderId !== providerOrder.providerOrderId) {
      return 'PROVIDER_ORDER_ID_MISMATCH'
    }

    if (context.associationRequired && payment.normalizedStatus !== 'pending') {
      return 'EARLY_WEBHOOK_PAYMENT_STATE_MISMATCH'
    }

    return null
  }

  async #associateEarlyWebhook(context, providerOrder, session) {
    if (!context.associationRequired) return context

    const associated = await this.payments.associateProviderOrderIfMissing(
      context.payment._id,
      providerOrder.providerOrderId,
      {
        providerStatus: providerOrder.status,
        providerStatusDetail: providerOrder.statusDetail
      },
      { session }
    )

    if (associated) return { ...context, payment: associated, associationRequired: false }

    const current = await this.payments.getByProviderOrderId(
      'mercado_pago',
      providerOrder.providerOrderId,
      { session }
    )

    if (!current || String(current._id) !== String(context.payment._id)) {
      throw new ServiceError(
        'No se pudo asociar la order de Mercado Pago de forma segura',
        'MERCADOPAGO_RECONCILIATION_CONFLICT',
        409
      )
    }

    return { ...context, payment: current, associationRequired: false }
  }

  async #observePayment(payment, providerOrder, now, session) {
    return this.payments.updateProviderObservation(
      payment._id,
      {
        providerStatus: providerOrder.status,
        providerStatusDetail: providerOrder.statusDetail,
        lastProviderCheckAt: now
      },
      { session }
    )
  }

  async #transitionPayment(payment, nextStatus, providerOrder, now, session, providerPaymentId) {
    if (payment.normalizedStatus === nextStatus) {
      return this.#observePayment(payment, providerOrder, now, session)
    }

    const update = {
      normalizedStatus: nextStatus,
      providerStatus: providerOrder.status,
      providerStatusDetail: providerOrder.statusDetail,
      lastProviderCheckAt: now,
      ...(providerPaymentId && { providerPaymentId })
    }

    if (nextStatus === 'approved') update.approvedAt = payment.approvedAt || now

    const updated = await this.payments.updateStatus(
      payment._id,
      payment.normalizedStatus,
      update,
      { session }
    )

    if (!updated) {
      throw new ServiceError(
        'El pago cambiÃ³ durante la reconciliaciÃ³n',
        'PAYMENT_STATUS_CONFLICT',
        409
      )
    }

    return updated
  }

  async #transitionOrderToAttention(order, reason, now, session) {
    if (order.status === 'requires_attention') return order

    const updated = await this.orders.updateStatus(
      order._id,
      order.status,
      { nextStatus: 'requires_attention', changedAt: now, reason },
      { session }
    )

    if (!updated) {
      throw new ServiceError(
        'La Order cambiÃ³ durante la reconciliaciÃ³n',
        'ORDER_STATUS_CONFLICT',
        409
      )
    }

    return updated
  }

  async #markRequiresAttention(context, providerOrder, reason, now, session) {
    let payment = context.payment

    if (payment && payment.normalizedStatus !== 'requires_attention') {
      payment = await this.#transitionPayment(
        payment,
        'requires_attention',
        providerOrder,
        now,
        session
      )
    } else if (payment) {
      payment = await this.#observePayment(payment, providerOrder, now, session)
    }

    const order = context.order
      ? await this.#transitionOrderToAttention(context.order, reason, now, session)
      : null

    return {
      outcome: 'requires_attention',
      orderId: order?._id || null,
      paymentId: payment?._id || null,
      providerPaymentId: payment?.providerPaymentId || null,
      reason
    }
  }

  #selectAccreditedPayment(providerOrder, expectedCents) {
    const candidates = providerOrder.payments.filter(
      (payment) => payment.status === 'processed' && payment.statusDetail === 'accredited'
    )

    if (candidates.length !== 1) return null
    const candidate = candidates[0]

    if (!candidate.providerPaymentId) return null

    try {
      if (
        moneyToCents(candidate.amount, 'MercadoPago.payment.amount') !== expectedCents ||
        moneyToCents(candidate.paidAmount, 'MercadoPago.payment.paidAmount') !== expectedCents
      ) {
        return null
      }
    } catch {
      return null
    }

    return candidate
  }

  async #reconcileInTransaction(providerOrder, now, session, { forceInventoryAttention }) {
    let context = await this.#locateContext(providerOrder, session)

    if (!context) {
      return {
        outcome: 'ignored',
        reason: 'UNKNOWN_PROVIDER_ORDER',
        orderId: null,
        paymentId: null,
        providerPaymentId: null
      }
    }

    const mismatch = this.#getCoreMismatch(context, providerOrder)
    if (mismatch) {
      return this.#markRequiresAttention(context, providerOrder, mismatch, now, session)
    }

    context = await this.#associateEarlyWebhook(context, providerOrder, session)
    const remoteClassification = classifyRemoteOrder(providerOrder, {
      expectedProviderOrderId: asText(context.payment.providerOrderId) ||
        providerOrder.providerOrderId,
      expectedExternalReference: context.order.orderNumber,
      expectedTotalAmount: context.order.totals.totalArs,
      expectedCurrency: 'ARS'
    })

    if (remoteClassification === REMOTE_ORDER_CLASSIFICATIONS.REFUNDED) {
      return this.#markRequiresAttention(
        context,
        providerOrder,
        'PROVIDER_REFUND_REQUIRES_ATTENTION',
        now,
        session
      )
    }

    if (remoteClassification === REMOTE_ORDER_CLASSIFICATIONS.INCONSISTENT) {
      return this.#markRequiresAttention(
        context,
        providerOrder,
        'PROVIDER_ORDER_INCONSISTENT',
        now,
        session
      )
    }

    if (remoteClassification !== REMOTE_ORDER_CLASSIFICATIONS.APPROVED) {
      const payment = await this.#observePayment(context.payment, providerOrder, now, session)
      return {
        outcome: 'pending',
        orderId: context.order._id,
        paymentId: payment._id,
        providerPaymentId: payment.providerPaymentId || null
      }
    }

    const expectedCents = moneyToCents(context.order.totals.totalArs, 'Order.totalArs')
    const providerPaidCents = providerOrder.totalPaidAmount === null
      ? expectedCents
      : moneyToCents(providerOrder.totalPaidAmount, 'MercadoPago.totalPaidAmount')
    const accreditedPayment = this.#selectAccreditedPayment(providerOrder, expectedCents)

    if (!accreditedPayment || providerPaidCents !== expectedCents) {
      return this.#markRequiresAttention(
        context,
        providerOrder,
        'PROVIDER_PAYMENT_AMBIGUOUS',
        now,
        session
      )
    }

    const paymentUsingProviderId = await this.payments.getByProviderPaymentId(
      accreditedPayment.providerPaymentId,
      { session }
    )

    if (
      (paymentUsingProviderId && String(paymentUsingProviderId._id) !== String(context.payment._id)) ||
      (context.payment.providerPaymentId &&
        context.payment.providerPaymentId !== accreditedPayment.providerPaymentId)
    ) {
      return this.#markRequiresAttention(
        context,
        providerOrder,
        'PROVIDER_PAYMENT_ID_CONFLICT',
        now,
        session
      )
    }

    if (
      context.payment.normalizedStatus === 'approved' &&
      context.order.status === 'paid'
    ) {
      const payment = await this.#observePayment(context.payment, providerOrder, now, session)
      return {
        outcome: 'paid',
        orderId: context.order._id,
        paymentId: payment._id,
        providerPaymentId: payment.providerPaymentId || accreditedPayment.providerPaymentId
      }
    }

    if (!['pending', 'approved'].includes(context.payment.normalizedStatus)) {
      return this.#markRequiresAttention(
        context,
        providerOrder,
        'LOCAL_PAYMENT_STATE_REQUIRES_ATTENTION',
        now,
        session
      )
    }

    const expiration = new Date(context.order.reservationExpiresAt)
    const expired = Number.isNaN(expiration.getTime()) || now.getTime() > expiration.getTime()
    const inspection = context.order.status === 'pending_payment' && !expired
      ? await this.productUnits.inspectOrderReservation(
        { orderId: context.order._id },
        { session }
      )
      : { valid: false, reason: expired ? 'RESERVATION_EXPIRED' : 'ORDER_NOT_PENDING_PAYMENT' }

    const payment = context.payment.normalizedStatus === 'approved'
      ? await this.#observePayment(context.payment, providerOrder, now, session)
      : await this.#transitionPayment(
        context.payment,
        'approved',
        providerOrder,
        now,
        session,
        accreditedPayment.providerPaymentId
      )

    if (forceInventoryAttention || !inspection.valid) {
      const order = await this.#transitionOrderToAttention(
        context.order,
        inspection.reason || 'RESERVATION_CHANGED_DURING_APPROVAL',
        now,
        session
      )

      return {
        outcome: 'requires_attention',
        orderId: order._id,
        paymentId: payment._id,
        providerPaymentId: accreditedPayment.providerPaymentId,
        reason: inspection.reason || 'RESERVATION_CHANGED_DURING_APPROVAL'
      }
    }

    await this.productUnits.confirmReservedUnitsSold(
      {
        orderId: context.order._id,
        paymentId: payment._id,
        soldAt: now
      },
      { session }
    )

    const preparingOrder = await this.orders.updateFulfillmentStatus(
      context.order._id,
      'pending',
      {
        nextStatus: 'preparing',
        changedAt: now,
        changedBy: null,
        reason: 'payment_approved'
      },
      { session }
    )

    if (!preparingOrder) {
      throw new ServiceError(
        'La preparaciÃ³n de la Order cambiÃ³ durante la confirmaciÃ³n del pago',
        'ORDER_FULFILLMENT_CONFLICT',
        409
      )
    }

    const paidOrder = await this.orders.updateStatus(
      context.order._id,
      'pending_payment',
      { nextStatus: 'paid', changedAt: now, reason: '' },
      { session }
    )

    if (!paidOrder) {
      throw new ServiceError(
        'La Order cambiÃ³ durante la confirmaciÃ³n del pago',
        'ORDER_STATUS_CONFLICT',
        409
      )
    }

    return {
      outcome: 'paid',
      orderId: paidOrder._id,
      paymentId: payment._id,
      providerPaymentId: accreditedPayment.providerPaymentId
    }
  }

  async reconcileProviderOrder(providerOrderId, { now = new Date() } = {}) {
    const normalizedProviderOrderId = asText(providerOrderId)
    const checkedAt = new Date(now)

    if (!normalizedProviderOrderId) {
      throw new ServiceError(
        'ID de order de Mercado Pago requerido',
        'MERCADOPAGO_PROVIDER_ORDER_ID_REQUIRED',
        400
      )
    }

    if (Number.isNaN(checkedAt.getTime())) {
      throw new ServiceError(
        'Fecha de reconciliaciÃ³n invÃ¡lida',
        'INVALID_PAYMENT_CHECK_DATE',
        400
      )
    }

    let providerOrder

    try {
      providerOrder = await this.provider.getOrder(normalizedProviderOrderId)
    } catch (error) {
      if (error instanceof MercadoPagoProviderError) {
        throw new ServiceError(error.message, error.code, error.status)
      }
      throw error
    }

    if (providerOrder.providerOrderId !== normalizedProviderOrderId) {
      throw new ServiceError(
        'Mercado Pago devolviÃ³ una order diferente',
        'MERCADOPAGO_INVALID_RESPONSE',
        502
      )
    }

    try {
      const result = await this.#runTransaction((session) =>
        this.#reconcileInTransaction(providerOrder, checkedAt, session, {
          forceInventoryAttention: false
        })
      )

      secureLog('MercadoPago reconciliation completada', {
        providerOrderId: normalizedProviderOrderId,
        orderId: result.orderId,
        paymentId: result.paymentId,
        providerStatus: providerOrder.status,
        providerStatusDetail: providerOrder.statusDetail,
        outcome: result.outcome
      })

      return result
    } catch (error) {
      if (INVENTORY_CONFLICT_CODES.has(error?.code)) {
        return this.#runTransaction((session) =>
          this.#reconcileInTransaction(providerOrder, checkedAt, session, {
            forceInventoryAttention: true
          })
        )
      }

      logError('MercadoPago reconciliation error', {
        providerOrderId: normalizedProviderOrderId,
        code: error?.code || 'MERCADOPAGO_RECONCILIATION_FAILED'
      })
      throw error
    }
  }
}

export { MercadoPagoReconciliationService, TRANSACTION_OPTIONS }
export default new MercadoPagoReconciliationService()
