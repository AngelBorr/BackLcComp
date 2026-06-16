// src/dao/managers/send.mongo.js
import mongoose from 'mongoose'
import { log, error as logError, warn } from '../../utils/logger.js'
import sendModel from '../models/send.model.js'

class SendManager {
  async createSend(data) {
    try {
      log('📤 DAO → Send.createSend')

      if (!data || typeof data !== 'object') {
        warn('⚠ SendManager.createSend recibió datos inválidos')
        throw new Error('Datos de envío inválidos')
      }

      const normalizedData = {
        ...data,
        sendName: data.sendName?.trim?.(),
        subjectSnapshot: data.subjectSnapshot?.trim?.(),
        internalNote: data.internalNote?.trim?.() || '',
        totalRecipients: data.totalRecipients ?? data.recipients?.length ?? 0
      }

      return await sendModel.create(normalizedData)
    } catch (err) {
      logError(`❌ Error DAO al crear Send: ${err.message}`)
      throw new Error(`Error al guardar el envío: ${err.message}`)
    }
  }

  async getSends({ page = 1, limit = 20, search = '', status, sendType } = {}) {
    try {
      log('📤 DAO → Send.getSends')

      const query = {}

      if (search) {
        query.$or = [
          { sendName: { $regex: search, $options: 'i' } },
          { subjectSnapshot: { $regex: search, $options: 'i' } }
        ]
      }

      if (status) query.status = status
      if (sendType) query.sendType = sendType

      const skip = (Number(page) - 1) * Number(limit)

      const [items, total] = await Promise.all([
        sendModel.find(query).sort({ createdAt: -1 }).skip(skip).limit(Number(limit)).lean(),
        sendModel.countDocuments(query)
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
      logError(`❌ Error DAO al obtener Sends: ${err.message}`)
      throw new Error(`Error al obtener envíos: ${err.message}`)
    }
  }

  async getSendById(id) {
    try {
      log(`📤 DAO → Send.getSendById (${id})`)

      if (!mongoose.Types.ObjectId.isValid(id)) {
        throw new Error('ID de envío inválido')
      }

      return await sendModel.findById(id).lean()
    } catch (err) {
      logError(`❌ Error DAO al obtener Send: ${err.message}`)
      throw new Error(`Error al obtener el envío: ${err.message}`)
    }
  }

  async updateSendStatus(id, { status, successCount, failedCount }) {
    try {
      log(`📤 DAO → Send.updateSendStatus (${id})`)

      if (!mongoose.Types.ObjectId.isValid(id)) {
        throw new Error('ID de envío inválido')
      }

      return await sendModel.findByIdAndUpdate(
        id,
        {
          ...(status && { status }),
          ...(typeof successCount === 'number' && { successCount }),
          ...(typeof failedCount === 'number' && { failedCount })
        },
        { new: true }
      )
    } catch (err) {
      logError(`❌ Error DAO al actualizar estado de Send: ${err.message}`)
      throw new Error(`Error al actualizar el envío: ${err.message}`)
    }
  }

  async updateRecipientResult(sendId, recipientEmail, data) {
    try {
      log(`📤 DAO → Send.updateRecipientResult (${recipientEmail})`)

      if (!mongoose.Types.ObjectId.isValid(sendId)) {
        throw new Error('ID de envío inválido')
      }

      return await sendModel.findOneAndUpdate(
        {
          _id: sendId,
          'recipients.email': recipientEmail.trim().toLowerCase()
        },
        {
          $set: {
            'recipients.$.status': data.status,
            'recipients.$.errorMessage': data.errorMessage || '',
            'recipients.$.emailLogId': data.emailLogId || null
          }
        },
        { new: true }
      )
    } catch (err) {
      logError(`❌ Error DAO al actualizar destinatario del Send: ${err.message}`)
      throw new Error(`Error al actualizar destinatario del envío: ${err.message}`)
    }
  }

  async getFailedRecipients(sendId) {
    try {
      log(`📤 DAO → Send.getFailedRecipients (${sendId})`)

      if (!mongoose.Types.ObjectId.isValid(sendId)) {
        throw new Error('ID de envío inválido')
      }

      const send = await sendModel
        .findById(sendId, {
          recipients: 1,
          subjectSnapshot: 1,
          contentSnapshot: 1,
          attachments: 1,
          sendName: 1,
          sendType: 1,
          messageId: 1,
          provider: 1
        })
        .lean()

      if (!send) {
        throw new Error('Envío no encontrado')
      }

      return {
        send,
        failedRecipients: (send.recipients || []).filter(
          (recipient) => recipient.status === 'failed'
        )
      }
    } catch (err) {
      logError(`❌ Error DAO al obtener destinatarios fallidos: ${err.message}`)
      throw new Error(`Error al obtener destinatarios fallidos: ${err.message}`)
    }
  }

  async recalculateSendCounters(sendId) {
    try {
      log(`📤 DAO → Send.recalculateSendCounters (${sendId})`)

      if (!mongoose.Types.ObjectId.isValid(sendId)) {
        throw new Error('ID de envío inválido')
      }

      const send = await sendModel.findById(sendId).lean()

      if (!send) {
        throw new Error('Envío no encontrado')
      }

      const recipients = send.recipients || []
      const successCount = recipients.filter((recipient) => recipient.status === 'success').length
      const failedCount = recipients.filter((recipient) => recipient.status === 'failed').length
      const pendingCount = recipients.filter((recipient) => recipient.status === 'pending').length
      const totalRecipients = recipients.length

      let status = 'processing'

      if (totalRecipients === 0) {
        status = 'failed'
      } else if (successCount === totalRecipients) {
        status = 'completed'
      } else if (failedCount === totalRecipients) {
        status = 'failed'
      } else if (pendingCount > 0) {
        status = 'processing'
      } else {
        status = 'partial_failed'
      }

      return await sendModel.findByIdAndUpdate(
        sendId,
        {
          totalRecipients,
          successCount,
          failedCount,
          status
        },
        { new: true }
      )
    } catch (err) {
      logError(`❌ Error DAO al recalcular contadores del Send: ${err.message}`)
      throw new Error(`Error al recalcular contadores del envío: ${err.message}`)
    }
  }
}

export default SendManager
