import mongoose from 'mongoose'
import { log, error as logError, warn } from '../../utils/logger.js'
import emailLogModel from '../models/emailLog.model.js'

class EmailLogManager {
  async createLog(data) {
    try {
      log('📨 DAO → EmailLog.createLog')

      if (!data || typeof data !== 'object') {
        warn('⚠ EmailLogManager.createLog recibió datos inválidos')
        throw new Error('Datos de log inválidos')
      }

      const normalizedData = {
        ...data,
        email: data.email ? String(data.email).trim().toLowerCase() : undefined,
        subjectSnapshot: data.subjectSnapshot?.trim?.() || data.subjectSnapshot,
        sendName: data.sendName?.trim?.() || data.sendName
      }

      return await emailLogModel.create(normalizedData)
    } catch (err) {
      logError(`❌ Error DAO al crear EmailLog: ${err.message}`)
      throw new Error(`Error al guardar el log de email: ${err.message}`)
    }
  }

  async getLogs({ page = 1, limit = 20, search = '', status, type, sendId } = {}) {
    try {
      log('📨 DAO → EmailLog.getLogs')

      const query = {}

      if (search) {
        query.$or = [
          { email: { $regex: search, $options: 'i' } },
          { subjectSnapshot: { $regex: search, $options: 'i' } },
          { sendName: { $regex: search, $options: 'i' } }
        ]
      }

      if (status) query.status = status
      if (type) query.type = type

      if (sendId && mongoose.Types.ObjectId.isValid(sendId)) {
        query.sendId = sendId
      }

      const skip = (Number(page) - 1) * Number(limit)

      const [items, total] = await Promise.all([
        emailLogModel.find(query).sort({ createdAt: -1 }).skip(skip).limit(Number(limit)).lean(),
        emailLogModel.countDocuments(query)
      ])

      return {
        items,
        pagination: {
          total,
          page: Number(page),
          limit: Number(limit),
          pages: Math.ceil(total / Number(limit)) || 1
        }
      }
    } catch (err) {
      logError(`❌ Error DAO al obtener EmailLogs: ${err.message}`)
      throw new Error(`Error al obtener logs de email: ${err.message}`)
    }
  }

  async getLogById(id) {
    try {
      log(`📨 DAO → EmailLog.getLogById (${id})`)

      if (!mongoose.Types.ObjectId.isValid(id)) {
        throw new Error('ID de log inválido')
      }

      return await emailLogModel.findById(id).lean()
    } catch (err) {
      logError(`❌ Error DAO al obtener EmailLog por ID: ${err.message}`)
      throw new Error(`Error al obtener el log de email: ${err.message}`)
    }
  }

  async getLogsByEmail(email) {
    try {
      log(`📨 DAO → EmailLog.getLogsByEmail (${email})`)

      if (!email || typeof email !== 'string') {
        throw new Error('Email inválido')
      }

      return await emailLogModel
        .find({ email: email.trim().toLowerCase() })
        .sort({ createdAt: -1 })
        .lean()
    } catch (err) {
      logError(`❌ Error DAO al obtener logs por email: ${err.message}`)
      throw new Error(`Error al obtener logs por email: ${err.message}`)
    }
  }

  async getLogsBySendId(sendId) {
    try {
      log(`📨 DAO → EmailLog.getLogsBySendId (${sendId})`)

      if (!mongoose.Types.ObjectId.isValid(sendId)) {
        throw new Error('sendId inválido')
      }

      return await emailLogModel.find({ sendId }).sort({ createdAt: -1 }).lean()
    } catch (err) {
      logError(`❌ Error DAO al obtener logs por envío: ${err.message}`)
      throw new Error(`Error al obtener logs del envío: ${err.message}`)
    }
  }
}

export default EmailLogManager
