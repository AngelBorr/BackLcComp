import EmailLogManager from '../dao/managers/emailLog.mongo.js'
import { log, warn, error as logError } from '../utils/logger.js'

class EmailLogService {
  constructor() {
    this.emailLogDAO = new EmailLogManager()
  }

  normalizeEmail(email) {
    return String(email || '')
      .trim()
      .toLowerCase()
  }

  async addLog(data) {
    try {
      const normalizedEmail = this.normalizeEmail(data.email)

      log(`📨 EmailLogService → guardando log (${data.status}) para ${normalizedEmail}`)

      return await this.emailLogDAO.createLog({
        ...data,
        email: normalizedEmail
      })
    } catch (err) {
      logError('❌ Error EmailLogService.addLog:', err.message)
      return null
    }
  }

  async getAllLogs(params) {
    try {
      log('📥 EmailLogService → getAllLogs')
      return await this.emailLogDAO.getLogs(params)
    } catch (err) {
      logError('❌ Error en EmailLogService → getAllLogs:', err.message)
      throw new Error('Error al obtener los registros de logs de email')
    }
  }

  async getLogById(id) {
    try {
      const logDetail = await this.emailLogDAO.getLogById(id)

      if (!logDetail) {
        throw new Error('Log no encontrado')
      }

      return logDetail
    } catch (err) {
      logError('❌ Error en EmailLogService → getLogById:', err.message)
      throw err
    }
  }

  async getLogsByEmail(email) {
    try {
      const normalizedEmail = this.normalizeEmail(email)

      if (!normalizedEmail || !/^\S+@\S+\.\S+$/.test(normalizedEmail)) {
        warn('⚠ Email inválido al solicitar logs')
        throw new Error('Debe proporcionar un email válido')
      }

      return await this.emailLogDAO.getLogsByEmail(normalizedEmail)
    } catch (err) {
      logError('❌ Error en EmailLogService → getLogsByEmail:', err.message)
      throw err
    }
  }

  async getLogsBySendId(sendId) {
    try {
      return await this.emailLogDAO.getLogsBySendId(sendId)
    } catch (err) {
      logError('❌ Error en EmailLogService → getLogsBySendId:', err.message)
      throw err
    }
  }

  async getFailedEmails() {
    try {
      return await this.emailLogDAO.getLogs({
        status: 'failed',
        limit: 100
      })
    } catch (err) {
      logError('❌ Error en EmailLogService → getFailedEmails:', err.message)
      throw new Error('Error al obtener logs fallidos')
    }
  }
}

export default EmailLogService
