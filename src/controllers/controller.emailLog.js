import EmailLogService from '../services/emailLog.service.js'
import { log, error as logError } from '../utils/logger.js'

const emailLogService = new EmailLogService()

export const getAllEmailLogs = async (req, res, next) => {
  try {
    log('📥 Controller → getAllEmailLogs')

    const logs = await emailLogService.getAllLogs(req.query)

    return res.status(200).json({
      success: true,
      data: logs,
      message: 'Registros de email obtenidos correctamente'
    })
  } catch (err) {
    logError('❌ Error en getAllEmailLogs:', err.message)
    err.statusCode = 500
    return next(err)
  }
}

export const getEmailLogById = async (req, res, next) => {
  try {
    const { id } = req.params

    log(`📥 Controller → getEmailLogById (${id})`)

    const logDetail = await emailLogService.getLogById(id)

    return res.status(200).json({
      success: true,
      data: logDetail,
      message: 'Detalle del log obtenido correctamente'
    })
  } catch (err) {
    logError('❌ Error en getEmailLogById:', err.message)
    err.statusCode = err.message.includes('no encontrado') ? 404 : 400
    return next(err)
  }
}

export const getEmailLogsByEmail = async (req, res, next) => {
  try {
    const { email } = req.params

    log(`📥 Controller → getEmailLogsByEmail (${email})`)

    const logs = await emailLogService.getLogsByEmail(email)

    return res.status(200).json({
      success: true,
      data: logs,
      message: `Logs obtenidos para: ${email}`
    })
  } catch (err) {
    logError('❌ Error en getEmailLogsByEmail:', err.message)
    err.statusCode = err.message.includes('email válido') ? 400 : 500
    return next(err)
  }
}

export const getEmailLogsBySendId = async (req, res, next) => {
  try {
    const { sendId } = req.params

    log(`📥 Controller → getEmailLogsBySendId (${sendId})`)

    const logs = await emailLogService.getLogsBySendId(sendId)

    return res.status(200).json({
      success: true,
      data: logs,
      message: 'Logs del envío obtenidos correctamente'
    })
  } catch (err) {
    logError('❌ Error en getEmailLogsBySendId:', err.message)
    err.statusCode = 400
    return next(err)
  }
}
