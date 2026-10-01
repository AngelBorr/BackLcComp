import mongoose from 'mongoose'
import UserAdminManager from '../dao/managers/userAdmin.mongo.js'
import ProductModel, { getEffectiveInventoryMode } from '../dao/models/produtc.model.js'
import { ServiceError } from './service.products.js'
import { log, error as logError, secureLog } from '../utils/logger.js'

const PRODUCT_CURRENCY = 'USD'
const VALID_VAT_RATES = new Set([0.105, 0.21])

const eligibilityMessages = {
  PRODUCT_NOT_SERIALIZED: 'El producto no utiliza inventario serializado',
  PRODUCT_INACTIVE: 'El producto no está activo',
  OUT_OF_STOCK: 'El producto no tiene stock disponible',
  INVALID_PRICE: 'El producto no tiene un precio válido para el usuario',
  INVALID_VAT: 'El producto no tiene un IVA válido'
}

class CommercePricingService {
  constructor() {
    this.users = new UserAdminManager()
  }

  async getAuthoritativeUserContext(userId, { session } = {}) {
    if (!mongoose.Types.ObjectId.isValid(userId)) {
      throw new ServiceError('ID de usuario inválido', 'INVALID_USER_ID', 400)
    }

    const user = await this.users.getUserById(userId, { session })

    if (!user) {
      throw new ServiceError('Usuario no encontrado', 'USER_NOT_FOUND', 404)
    }

    return {
      user,
      userId: user._id,
      role: String(user.role || '').trim().toUpperCase()
    }
  }

  #resolvePricing(product, role) {
    if (role === 'ADMIN') {
      throw new ServiceError(
        'La política de compra para ADMIN todavía no está definida',
        'PURCHASE_ROLE_NOT_DEFINED',
        403
      )
    }

    const priceConfig = {
      USER: {
        field: 'prodPrecioMinorista',
        type: 'retail'
      },
      PREMIUM: {
        field: 'prodPrecioMayorista',
        type: 'wholesale'
      }
    }[role]

    if (!priceConfig) {
      throw new ServiceError('El usuario no tiene un rol habilitado para comprar', 'BUYER_ROLE_NOT_ALLOWED', 403)
    }

    const unitPrice = Number(product?.[priceConfig.field])

    if (!Number.isFinite(unitPrice) || unitPrice <= 0) {
      return {
        eligible: false,
        code: 'INVALID_PRICE'
      }
    }

    return {
      eligible: true,
      pricing: {
        unitPrice,
        priceType: priceConfig.type,
        priceField: priceConfig.field,
        vatRate: product.prodIva,
        currency: PRODUCT_CURRENCY
      }
    }
  }

  #evaluateProductEligibility(product, role) {
    if (getEffectiveInventoryMode(product) !== 'serialized') {
      return { eligible: false, code: 'PRODUCT_NOT_SERIALIZED' }
    }

    if (product.isActive !== true) {
      return { eligible: false, code: 'PRODUCT_INACTIVE' }
    }

    const availableStock = Number(product.prodStock)

    if (!Number.isFinite(availableStock) || availableStock <= 0) {
      return { eligible: false, code: 'OUT_OF_STOCK' }
    }

    if (!VALID_VAT_RATES.has(product.prodIva)) {
      return { eligible: false, code: 'INVALID_VAT' }
    }

    return this.#resolvePricing(product, role)
  }

  async getProductPurchaseContext({ userId, productId }, { session } = {}) {
    try {
      log('🛒 CommercePricingService → resolviendo contexto comercial')

      if (!mongoose.Types.ObjectId.isValid(productId)) {
        throw new ServiceError('ID de producto inválido', 'INVALID_PRODUCT_ID', 400)
      }

      const { user, userId: authoritativeUserId, role } =
        await this.getAuthoritativeUserContext(userId, { session })
      const productQuery = ProductModel.findById(productId).lean()
      if (session) productQuery.session(session)
      const product = await productQuery

      if (!product) {
        throw new ServiceError('Producto no encontrado', 'PRODUCT_NOT_FOUND', 404)
      }

      const eligibility = this.#evaluateProductEligibility(product, role)

      if (!eligibility.eligible) {
        throw new ServiceError(
          eligibilityMessages[eligibility.code] || 'El producto no es elegible para compra online',
          eligibility.code,
          409
        )
      }

      secureLog('✅ CommercePricingService contexto comercial resuelto', {
        userId: authoritativeUserId,
        role,
        productId: product._id,
        priceType: eligibility.pricing.priceType,
        currency: PRODUCT_CURRENCY
      })

      return {
        user,
        product,
        pricing: eligibility.pricing
      }
    } catch (error) {
      logError('❌ CommercePricingService getProductPurchaseContext error:', error)
      if (error instanceof ServiceError) throw error

      throw new ServiceError(
        'No se pudo resolver el contexto comercial',
        'COMMERCE_CONTEXT_FAILED',
        500,
        { cause: error?.message }
      )
    }
  }

  async getOrderItemSnapshot({ userId, productId, quantity }, { session } = {}) {
    const normalizedQuantity = Number(quantity)

    if (!Number.isInteger(normalizedQuantity) || normalizedQuantity <= 0) {
      throw new ServiceError(
        'La cantidad debe ser un entero mayor que cero',
        'INVALID_ORDER_ITEM_QUANTITY',
        400
      )
    }

    const { user, product, pricing } = await this.getProductPurchaseContext(
      { userId, productId },
      { session }
    )

    if (normalizedQuantity > Number(product.prodStock)) {
      throw new ServiceError(
        'No hay stock suficiente para la cantidad solicitada',
        'INSUFFICIENT_SERIALIZED_STOCK',
        409,
        {
          requested: normalizedQuantity,
          available: Number(product.prodStock)
        }
      )
    }

    return {
      user,
      item: {
        productId: product._id,
        productSnapshot: {
          name: product.prodName,
          brand: product.prodMarca || '',
          category: product.prodCategoria || ''
        },
        quantity: normalizedQuantity,
        priceType: pricing.priceType,
        unitPriceUsd: pricing.unitPrice,
        vatRate: pricing.vatRate,
        currency: pricing.currency
      }
    }
  }
}

export { CommercePricingService, PRODUCT_CURRENCY, VALID_VAT_RATES }
export default new CommercePricingService()
