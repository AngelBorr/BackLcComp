import mongoose from 'mongoose'
import { log, error as logError, warn } from '../../utils/logger.js'
import messageTemplateModel from '../models/messageTemplate.model.js'

class MessageTemplateManager {
  async createTemplate(data) {
    try {
      log('✉️ DAO → MessageTemplate.createTemplate')

      if (!data || typeof data !== 'object') {
        warn('⚠ MessageTemplateManager.createTemplate recibió datos inválidos')
        throw new Error('Datos de plantilla inválidos')
      }

      return await messageTemplateModel.create(data)
    } catch (err) {
      logError('❌ Error DAO al crear plantilla:', err.message)
      throw err
    }
  }

  async getTemplates({ page = 1, limit = 20, search = '', status } = {}) {
    try {
      log('✉️ DAO → MessageTemplate.getTemplates')

      const query = {
        isDeleted: false
      }

      if (search) {
        query.$or = [
          { name: { $regex: search, $options: 'i' } },
          { subject: { $regex: search, $options: 'i' } },
          { plainTextContent: { $regex: search, $options: 'i' } }
        ]
      }

      if (status) {
        query.status = status
      }

      const skip = (Number(page) - 1) * Number(limit)

      const [items, total] = await Promise.all([
        messageTemplateModel
          .find(query)
          .sort({ createdAt: -1 })
          .skip(skip)
          .limit(Number(limit))
          .lean(),

        messageTemplateModel.countDocuments(query)
      ])

      return {
        items,
        pagination: {
          total,
          page: Number(page),
          limit: Number(limit),
          pages: Math.ceil(total / Number(limit))
        }
      }
    } catch (err) {
      logError('❌ Error DAO al obtener plantillas:', err.message)
      throw err
    }
  }

  async getTemplateById(id) {
    try {
      log(`✉️ DAO → MessageTemplate.getTemplateById (${id})`)

      if (!mongoose.Types.ObjectId.isValid(id)) {
        throw new Error('ID de plantilla inválido')
      }

      return await messageTemplateModel
        .findOne({
          _id: id,
          isDeleted: false
        })
        .lean()
    } catch (err) {
      logError('❌ Error DAO al obtener plantilla:', err.message)
      throw err
    }
  }

  async getReadyTemplateById(id) {
    try {
      log(`✉️ DAO → MessageTemplate.getReadyTemplateById (${id})`)

      if (!mongoose.Types.ObjectId.isValid(id)) {
        throw new Error('ID de plantilla inválido')
      }

      return await messageTemplateModel
        .findOne({
          _id: id,
          status: 'ready',
          isDeleted: false
        })
        .lean()
    } catch (err) {
      logError('❌ Error DAO al obtener plantilla lista:', err.message)
      throw err
    }
  }

  async updateTemplate(id, data) {
    try {
      log(`✉️ DAO → MessageTemplate.updateTemplate (${id})`)

      if (!mongoose.Types.ObjectId.isValid(id)) {
        throw new Error('ID de plantilla inválido')
      }

      return await messageTemplateModel.findByIdAndUpdate(id, data, {
        new: true,
        runValidators: true
      })
    } catch (err) {
      logError('❌ Error DAO al actualizar plantilla:', err.message)
      throw err
    }
  }

  async deleteTemplate(id) {
    try {
      log(`✉️ DAO → MessageTemplate.deleteTemplate (${id})`)

      if (!mongoose.Types.ObjectId.isValid(id)) {
        throw new Error('ID de plantilla inválido')
      }

      return await messageTemplateModel.findByIdAndUpdate(
        id,
        {
          isDeleted: true,
          status: 'archived'
        },
        { new: true }
      )
    } catch (err) {
      logError('❌ Error DAO al eliminar plantilla:', err.message)
      throw err
    }
  }
}

export default MessageTemplateManager
