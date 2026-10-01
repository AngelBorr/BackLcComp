import { log, error as logError, secureLog } from '../utils/logger.js'
import ProductUnitService from '../services/productUnit.service.js'

const getAuthenticatedUserId = (req) => {
  const userId = req.user?._id || req.user?.id || null

  if (!userId) {
    throw new Error('No se pudo identificar al usuario autenticado')
  }

  return userId
}

class ProductUnitController {
  async listByProduct(req, res) {
    try {
      log('📋 ProductUnitController → listByProduct')

      const { productId } = req.params
      const { status, search } = req.query

      secureLog('🔎 ProductUnitController list query', {
        productId,
        status: status || null,
        search: search || null
      })

      const result = await ProductUnitService.listByProduct(productId, {
        status,
        search
      })

      return res.json({
        status: 'success',
        payload: result
      })
    } catch (error) {
      logError('❌ ProductUnitController listByProduct error:', error)

      return res.status(400).json({
        status: 'error',
        message: error.message || 'Error al obtener unidades del producto'
      })
    }
  }

  async create(req, res, next) {
    try {
      log('➕ ProductUnitController → create')

      const { productId } = req.params
      const userId = getAuthenticatedUserId(req)

      secureLog('🧾 ProductUnitController create body', {
        productId,
        serialNumber: req.body?.serialNumber || null,
        entryDate: req.body?.entryDate || null,
        supplier: req.body?.supplier || null,
        invoiceNumber: req.body?.invoiceNumber || null,
        hasNotes: Boolean(req.body?.notes),
        userId
      })

      const unit = await ProductUnitService.createUnit({
        productId,
        ...req.body,
        userId
      })

      return res.status(201).json({
        status: 'success',
        payload: unit
      })
    } catch (error) {
      logError('❌ ProductUnitController create error:', error)

      if (error?.statusCode) return next(error)

      return res.status(400).json({
        status: 'error',
        message: error.message || 'Error al crear unidad del producto'
      })
    }
  }

  async bulkCreate(req, res, next) {
    try {
      log('➕ ProductUnitController → bulkCreate')

      const { productId } = req.params
      const { serialNumbers, entryDate, supplier, invoiceNumber, notes } = req.body
      const userId = getAuthenticatedUserId(req)

      secureLog('🧾 ProductUnitController bulkCreate body', {
        productId,
        serialNumbersCount: Array.isArray(serialNumbers) ? serialNumbers.length : null,
        entryDate: entryDate || null,
        userId
      })

      const created = await ProductUnitService.bulkCreateUnits({
        productId,
        serialNumbers,
        entryDate,
        supplier,
        invoiceNumber,
        notes,
        userId
      })

      return res.status(201).json({
        status: 'success',
        payload: created
      })
    } catch (error) {
      logError('❌ ProductUnitController bulkCreate error:', error)

      if (error?.statusCode) return next(error)

      return res.status(400).json({
        status: 'error',
        message: error.message || 'Error al crear unidades del producto'
      })
    }
  }

  async updateStatus(req, res, next) {
    try {
      log('🔁 ProductUnitController → updateStatus')

      const { unitId } = req.params
      const { status, notes } = req.body
      const userId = getAuthenticatedUserId(req)

      secureLog('🧾 ProductUnitController updateStatus body', {
        unitId,
        status,
        hasNotes: Boolean(notes),
        userId
      })

      const updated = await ProductUnitService.updateStatus({
        unitId,
        status,
        notes,
        userId
      })

      return res.json({
        status: 'success',
        payload: updated
      })
    } catch (error) {
      logError('❌ ProductUnitController updateStatus error:', error)

      if (error?.statusCode) return next(error)

      return res.status(400).json({
        status: 'error',
        message: error.message || 'Error al actualizar estado de unidad'
      })
    }
  }

  async delete(req, res, next) {
    try {
      log('🗑️ ProductUnitController → delete')

      const { unitId } = req.params
      const userId = getAuthenticatedUserId(req)

      secureLog('🧾 ProductUnitController delete params', {
        unitId,
        userId
      })

      const deleted = await ProductUnitService.deleteUnit(unitId, userId)

      return res.json({
        status: 'success',
        payload: deleted
      })
    } catch (error) {
      logError('❌ ProductUnitController delete error:', error)

      if (error?.statusCode) return next(error)

      return res.status(400).json({
        status: 'error',
        message: error.message || 'Error al eliminar unidad'
      })
    }
  }
}

export default new ProductUnitController()
