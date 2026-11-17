import { randomUUID } from 'node:crypto'
import mongoose from 'mongoose'
import UserModel from '../../../src/dao/models/userAdmin.model.js'
import ProductModel from '../../../src/dao/models/produtc.model.js'
import ProductUnitModel from '../../../src/dao/models/productUnit.model.js'
import OrderModel from '../../../src/dao/models/order.model.js'
import OrderItemModel from '../../../src/dao/models/orderItem.model.js'
import PaymentModel from '../../../src/dao/models/payment.model.js'
import CommerceCounterModel from '../../../src/dao/models/commerceCounter.model.js'
import OrderItemManager from '../../../src/dao/managers/orderItem.manager.js'
import ProductUnitManager from '../../../src/dao/managers/productUnit.manager.js'
import PaymentService, { PaymentService as PaymentServiceClass } from '../../../src/services/payment.service.js'
import ProductUnitService from '../../../src/services/productUnit.service.js'
import { CheckoutService } from '../../../src/services/checkout.service.js'
import { ExchangeRateService } from '../../../src/services/exchangeRate.service.js'

const syntheticQuote = Object.freeze({
  source: 'BNA',
  quoteType: 'billete_venta',
  baseCurrency: 'USD',
  quoteCurrency: 'ARS',
  rate: '1500.00',
  sourceDate: '2026-11-10',
  sourceUpdatedTime: '12:00',
  sourceEffectiveAt: '2026-11-10T15:00:00.000Z',
  fetchedAt: '2026-11-10T15:00:01.000Z',
  sourceUrl: 'https://www.bna.com.ar/Personas'
})

const transactionOptions = Object.freeze({
  readConcern: { level: 'snapshot' },
  writeConcern: { w: 'majority' }
})

const uniqueToken = (prefix) => `${prefix}_${randomUUID().replaceAll('-', '')}`

const exchangeRateService = new ExchangeRateService({
  provider: {
    async getUsdArsSellingQuote () {
      return { ...syntheticQuote }
    }
  }
})

const financialGuard = Object.freeze({
  async assertCanCreateCheckout () {},
  async assertCanContinueCheckout () {}
})

export const initializeCommerceModels = async () => {
  for (const model of [
    UserModel,
    ProductModel,
    ProductUnitModel,
    OrderModel,
    OrderItemModel,
    PaymentModel,
    CommerceCounterModel
  ]) {
    await model.init()
  }
}

export const createSyntheticBuyer = async ({ session } = {}) => {
  const token = uniqueToken('buyer')
  const buyer = new UserModel({
    firstName: 'Integration',
    lastName: 'Buyer',
    email: `${token}@example.test`,
    password: 'synthetic-not-a-real-password',
    role: 'USER',
    emailVerified: true,
    emailVerifiedAt: new Date()
  })
  return buyer.save({ session })
}

export const createSerializedInventory = async (
  { buyerId, unitCount = 1, stock = unitCount, productOverrides = {} },
  { session } = {}
) => {
  const token = uniqueToken('product')
  const product = new ProductModel({
    prodName: `Synthetic ${token}`,
    prodDescription: 'Ephemeral integration fixture',
    prodPrecioMinorista: 100,
    prodPrecioMayorista: 90,
    prodIva: 0.21,
    prodCategoria: 'Testing',
    prodMarca: 'LC-COMP-TEST',
    prodStock: stock,
    inventoryMode: 'serialized',
    isActive: true,
    ...productOverrides
  })
  await product.save({ session })

  const units = []
  for (let index = 0; index < unitCount; index += 1) {
    const unit = new ProductUnitModel({
      productId: product._id,
      serialNumber: `${token}_${String(index + 1).padStart(2, '0')}`,
      status: 'available',
      createdBy: buyerId,
      isDeleted: false
    })
    units.push(await unit.save({ session }))
  }

  return { product, units }
}

export const createSyntheticCommerceContext = async ({ unitCount = 1 } = {}) => {
  const buyer = await createSyntheticBuyer()
  const { product, units } = await createSerializedInventory({
    buyerId: buyer._id,
    unitCount
  })

  return { buyer, product, units }
}

export const createCheckoutService = ({
  paymentService = PaymentService,
  productUnitService = ProductUnitService
} = {}) =>
  new CheckoutService({
    exchangeRateService,
    checkoutFinancialGuardService: financialGuard,
    paymentService,
    productUnitService
  })

export const createCheckoutInput = (context, { quantity = 1 } = {}) => ({
  userId: String(context.buyer._id),
  items: [{ productId: String(context.product._id), quantity }],
  idempotencyKey: uniqueToken('checkout')
})

export const createBareOrderWithItem = async (
  {
    buyer,
    product,
    quantity = 1,
    orderId = new mongoose.Types.ObjectId(),
    orderItemId = new mongoose.Types.ObjectId(),
    orderNumber = `LC-2099-${randomUUID().slice(0, 8)}`,
    reservationExpiresAt = new Date(Date.now() + 6 * 60 * 60 * 1000)
  },
  { session } = {}
) => {
  const now = new Date()
  const order = new OrderModel({
    _id: orderId,
    orderNumber,
    userId: buyer._id,
    buyerSnapshot: {
      firstName: buyer.firstName,
      lastName: buyer.lastName,
      email: buyer.email,
      role: buyer.role
    },
    fulfillmentMode: 'pickup',
    fulfillmentStatus: 'pending',
    status: 'pending_payment',
    commercialCurrency: 'USD',
    paymentCurrency: 'ARS',
    totals: { totalUsd: String(100 * quantity), totalArs: String(150000 * quantity) },
    exchangeRateSnapshot: { ...syntheticQuote },
    reservationExpiresAt,
    statusHistory: [{ status: 'pending_payment', changedAt: now, reason: '' }],
    fulfillmentHistory: [{
      status: 'pending',
      changedAt: now,
      changedBy: null,
      reason: 'integration_fixture'
    }]
  })
  await order.save({ session })

  const item = new OrderItemModel({
    _id: orderItemId,
    orderId: order._id,
    productId: product._id,
    productSnapshot: {
      name: product.prodName,
      brand: product.prodMarca,
      category: product.prodCategoria
    },
    quantity,
    priceType: 'retail',
    currency: 'USD',
    vatRate: '0.21',
    unitPriceUsd: '100.00',
    netUnitPriceUsd: '82.64',
    vatAmountPerUnitUsd: '17.36',
    lineNetUsd: String(82.64 * quantity),
    lineVatUsd: String(17.36 * quantity),
    totalUsd: String(100 * quantity)
  })
  await item.save({ session })

  return { order, item }
}

export const createBareOrderItem = async (
  {
    order,
    product,
    quantity = 1,
    orderItemId = new mongoose.Types.ObjectId()
  },
  { session } = {}
) => {
  const item = new OrderItemModel({
    _id: orderItemId,
    orderId: order._id,
    productId: product._id,
    productSnapshot: {
      name: product.prodName,
      brand: product.prodMarca,
      category: product.prodCategoria
    },
    quantity,
    priceType: 'retail',
    currency: 'USD',
    vatRate: '0.21',
    unitPriceUsd: '100.00',
    netUnitPriceUsd: '82.64',
    vatAmountPerUnitUsd: '17.36',
    lineNetUsd: String(82.64 * quantity),
    lineVatUsd: String(17.36 * quantity),
    totalUsd: String(100 * quantity)
  })
  return item.save({ session })
}

export const captureSyntheticOriginalReservation = async (
  { item, units, capturedAt = new Date('2026-11-10T15:30:00.000Z') },
  { session } = {}
) => {
  item.originalReservation = {
    capturedAt,
    units: units.map((unit) => ({
      productUnitId: unit._id,
      serial: unit.serialNumber
    }))
  }
  return item.save({ session })
}

export const markSyntheticOrderRequiresInventoryAttention = async (
  { order, attentionReason = 'RESERVATION_QUANTITY_MISMATCH' },
  { session } = {}
) => {
  order.status = 'requires_attention'
  order.attentionReason = attentionReason
  return order.save({ session })
}

export const createSyntheticApprovedPayment = async (
  {
    order,
    approvedAt = new Date('2026-11-10T16:00:00.000Z'),
    paymentOverrides = {}
  },
  { session } = {}
) => {
  const token = uniqueToken('payment')
  const payment = new PaymentModel({
    orderId: order._id,
    provider: 'mercado_pago',
    providerOrderId: `ORDER-${token}`,
    providerPaymentId: `PAY-${token}`,
    externalReference: order.orderNumber,
    normalizedStatus: 'approved',
    providerStatus: 'processed',
    providerStatusDetail: 'accredited',
    amountArs: order.totals.totalArs.toString(),
    currency: 'ARS',
    approvedAt,
    ...paymentOverrides
  })
  return payment.save({ session })
}

export const buildOriginalReservation = (reservationResult) => ({
  capturedAt: new Date(reservationResult.reservedAt),
  units: reservationResult.units.map((unit) => ({
    productUnitId: unit._id,
    serial: unit.serialNumber
  }))
})

export const canonicalLedger = (ledger) => ledger == null
  ? ledger
  : {
      capturedAt: new Date(ledger.capturedAt).toISOString(),
      units: ledger.units.map((unit) => ({
        productUnitId: String(unit.productUnitId),
        serial: String(unit.serial)
      }))
    }

export {
  mongoose,
  transactionOptions,
  syntheticQuote,
  UserModel,
  ProductModel,
  ProductUnitModel,
  OrderModel,
  OrderItemModel,
  PaymentModel,
  OrderItemManager,
  ProductUnitManager,
  PaymentService,
  PaymentServiceClass,
  ProductUnitService
}
