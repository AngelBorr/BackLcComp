// controllers/controller.products.js
import ProductsService from '../services/service.products.js'
import { error as logError, secureLog } from '../utils/logger.js'

const productsService = new ProductsService()

export const getProducts = async (req, res, next) => {
  try {
    req.logger?.debug?.('[products.controller] getProducts')
    const products = await productsService.getProducts()
    console.log('controller', products)
    return res.status(200).json({
      status: 'success',
      message: products.length
        ? 'Productos obtenidos correctamente.'
        : 'No se encontraron productos.',
      data: products
    })
  } catch (err) {
    logError('❌ controller.products.getProducts error:', err)
    next(err)
  }
}

export const getProductById = async (req, res, next) => {
  try {
    req.logger?.debug?.('[products.controller] getProductById')
    const { id } = req.params

    const product = await productsService.getProductById(id)
    return res.status(200).json({
      status: 'success',
      message: 'Producto obtenido correctamente.',
      data: product
    })
  } catch (err) {
    logError('❌ controller.products.getProductById error:', err)
    next(err)
  }
}

export const createProduct = async (req, res, next) => {
  try {
    req.logger?.debug?.('[products.controller] createProduct')

    secureLog('📦 body:', req.body)
    secureLog(
      '🖼️ files:',
      (req.files || []).map((f) => ({
        fieldname: f.fieldname,
        originalname: f.originalname,
        mimetype: f.mimetype,
        size: f.size
      }))
    )

    const created = await productsService.createProduct(req.body, req.files)

    return res.status(201).json({
      status: 'success',
      message: 'Producto creado correctamente.',
      data: created
    })
  } catch (err) {
    logError('❌ controller.products.createProduct error:', err)
    next(err)
  }
}

// controllers/products.controller.js
export const updateProduct = async (req, res, next) => {
  try {
    req.logger?.debug?.('[products.controller] updateProduct')
    const { id } = req.params

    secureLog('📦 body:', req.body)
    secureLog(
      '🖼️ files:',
      (req.files || []).map((f) => ({
        fieldname: f.fieldname,
        originalname: f.originalname,
        mimetype: f.mimetype,
        size: f.size
      }))
    )

    const updated = await productsService.updateProduct(id, req.body, req.files)

    return res.status(200).json({
      status: 'success',
      message: 'Producto actualizado correctamente.',
      data: updated
    })
  } catch (err) {
    logError('❌ controller.products.updateProduct error:', err)
    next(err)
  }
}

export const deleteProduct = async (req, res, next) => {
  try {
    req.logger?.debug?.('[products.controller] deleteProduct')
    const { id } = req.params

    const deleteImages = String(req.query.deleteImages || 'false').toLowerCase() === 'true'
    const soft = String(req.query.soft || 'false').toLowerCase() === 'true'

    const result = await productsService.deleteProduct(id, { deleteImages, soft })
    return res.status(200).json({
      status: 'success',
      message: `Producto eliminado (${result.mode}).`,
      data: result
    })
  } catch (err) {
    logError('❌ controller.products.deleteProduct error:', err)
    next(err)
  }
}
