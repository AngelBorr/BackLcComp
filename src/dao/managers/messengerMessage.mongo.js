import mongoose from 'mongoose'
import { log, error as logError, warn, error } from '../../utils/logger.js'
import messengerMessageModel from '../models/messengerMessage.model.js'

class MessengerMessageManager {
  async createMessage(data) {
    try {
      log('✉️ DAO → MessengerMessage.createMessage')

      if (!data || typeof data !== 'object') {
        warn('⚠ MessengerMessageManager.createMessage recibió datos inválidos')
        throw new Error(`Datos de mensaje inválidos: ${error.message}`)
      }

      const normalizedData = {
        ...data,
        name: data.name?.trim?.(),
        subject: data.subject?.trim?.(),
        category: data.category?.trim?.() || '',
        tags: Array.isArray(data.tags)
          ? data.tags.map((tag) => String(tag).trim().toLowerCase()).filter(Boolean)
          : []
      }

      return await messengerMessageModel.create(normalizedData)
    } catch (err) {
      logError(`❌ Error DAO al crear MessengerMessage:, ${error.message}`)
      throw new Error(`Error al guardar el mensaje : ${error.message}`)
    }
  }

  async getMessages({ page = 1, limit = 20, search = '', status } = {}) {
    try {
      log('✉️ DAO → MessengerMessage.getMessages')

      const query = {
        isDeleted: false
      }

      if (search) {
        query.$or = [
          { name: { $regex: search, $options: 'i' } },
          { subject: { $regex: search, $options: 'i' } },
          { content: { $regex: search, $options: 'i' } }
        ]
      }

      if (status) query.status = status

      const skip = (Number(page) - 1) * Number(limit)

      const [items, total] = await Promise.all([
        messengerMessageModel
          .find(query)
          .sort({ createdAt: -1 })
          .skip(skip)
          .limit(Number(limit))
          .lean(),
        messengerMessageModel.countDocuments(query)
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
      logError(`❌ Error DAO al obtener MessengerMessages:, ${error.message}`)
      throw new Error(`Error al obtener mensajes : ${error.message}`)
    }
  }

  async getMessageById(id) {
    try {
      log(`✉️ DAO → MessengerMessage.getMessageById (${id})`)

      if (!mongoose.Types.ObjectId.isValid(id)) {
        throw new Error(`ID de mensaje inválido: ${error.message}`)
      }

      return await messengerMessageModel
        .findOne({
          _id: id,
          isDeleted: false
        })
        .lean()
    } catch (err) {
      logError(`❌ Error DAO al obtener MessengerMessage:, ${error.message}`)
      throw new Error(`Error al obtener el mensaje : ${error.message}`)
    }
  }

  async getReadyMessageById(id) {
    try {
      log(`✉️ DAO → MessengerMessage.getReadyMessageById (${id})`)

      if (!mongoose.Types.ObjectId.isValid(id)) {
        throw new Error(`ID de mensaje inválido: ${error.message}`)
      }

      return await messengerMessageModel
        .findOne({
          _id: id,
          status: 'ready',
          isDeleted: false
        })
        .lean()
    } catch (err) {
      logError(`❌ Error DAO al obtener mensaje listo:, ${error.message}`)
      throw new Error(`Error al obtener mensaje listo : ${error.message}`)
    }
  }

  async updateMessage(id, data) {
    try {
      log(`✉️ DAO → MessengerMessage.updateMessage (${id})`)

      if (!mongoose.Types.ObjectId.isValid(id)) {
        throw new Error(`ID de mensaje inválido: ${error.message}`)
      }

      const normalizedData = {
        ...data,
        ...(data.name && { name: data.name.trim() }),
        ...(data.subject && { subject: data.subject.trim() }),
        ...(data.category !== undefined && { category: data.category.trim() }),
        ...(Array.isArray(data.tags) && {
          tags: data.tags.map((tag) => String(tag).trim().toLowerCase()).filter(Boolean)
        })
      }

      return await messengerMessageModel.findByIdAndUpdate(id, normalizedData, {
        new: true,
        runValidators: true
      })
    } catch (err) {
      logError(`❌ Error DAO al actualizar MessengerMessage:, ${error.message}`)
      throw new Error(`Error al actualizar el mensaje : ${error.message}`)
    }
  }

  async deleteMessage(id) {
    try {
      log(`✉️ DAO → MessengerMessage.deleteMessage (${id})`)

      if (!mongoose.Types.ObjectId.isValid(id)) {
        throw new Error(`ID de mensaje inválido: ${error.message}`)
      }

      return await messengerMessageModel.findByIdAndUpdate(
        id,
        {
          isDeleted: true,
          status: 'archived'
        },
        { new: true }
      )
    } catch (err) {
      logError(`❌ Error DAO al eliminar MessengerMessage:, ${error.message}`)
      throw new Error(`Error al eliminar el mensaje : ${error.message}`)
    }
  }
}

export default MessengerMessageManager
