// src/controllers/controller.recipient.js
import RecipientService from '../services/recipient.service.js'
import { log, error as logError } from '../utils/logger.js'

const recipientService = new RecipientService()

export const getAllRecipients = async (req, res, next) => {
  try {
    log('📥 Controller → getAllRecipients')

    const result = await recipientService.getAllRecipients(req.query)

    return res.status(200).json({
      success: true,
      data: result,
      message: 'Destinatarios obtenidos correctamente'
    })
  } catch (err) {
    logError('❌ Error en getAllRecipients:', err.message)
    err.statusCode = 500
    return next(err)
  }
}

export const getRecipientById = async (req, res, next) => {
  try {
    const { id } = req.params

    const recipient = await recipientService.getRecipientById(id)

    return res.status(200).json({
      success: true,
      data: recipient,
      message: 'Destinatario obtenido correctamente'
    })
  } catch (err) {
    logError('❌ Error en getRecipientById:', err.message)
    err.statusCode = err.message.includes('no encontrado') ? 404 : 500
    return next(err)
  }
}

export const createRecipient = async (req, res, next) => {
  try {
    log('📥 Controller → createRecipient')

    const recipient = await recipientService.createRecipient(req.body)

    return res.status(201).json({
      success: true,
      data: recipient,
      message: 'Destinatario creado correctamente'
    })
  } catch (err) {
    logError('❌ Error en createRecipient:', err.message)

    if (err.message.includes('email válido') || err.message.includes('Ya existe')) {
      err.statusCode = 400
    } else {
      err.statusCode = 500
    }

    return next(err)
  }
}

export const createRecipientsBulk = async (req, res, next) => {
  try {
    log('📥 Controller → createRecipientsBulk')

    const { recipients } = req.body

    const result = await recipientService.createRecipientsBulk(recipients)

    return res.status(201).json({
      success: true,
      data: result,
      message: 'Carga masiva procesada correctamente'
    })
  } catch (err) {
    logError('❌ Error en createRecipientsBulk:', err.message)
    err.statusCode = 400
    return next(err)
  }
}

export const updateRecipient = async (req, res, next) => {
  try {
    const { id } = req.params

    log(`📥 Controller → updateRecipient (${id})`)

    const updated = await recipientService.updateRecipient(id, req.body)

    return res.status(200).json({
      success: true,
      data: updated,
      message: 'Destinatario actualizado correctamente'
    })
  } catch (err) {
    logError('❌ Error en updateRecipient:', err.message)

    if (err.message.includes('no encontrado')) err.statusCode = 404
    else if (err.message.includes('email válido') || err.message.includes('Ya existe')) {
      err.statusCode = 400
    } else {
      err.statusCode = 500
    }

    return next(err)
  }
}

export const deleteRecipient = async (req, res, next) => {
  try {
    const { id } = req.params

    log(`📥 Controller → deleteRecipient (${id})`)

    const deleted = await recipientService.deleteRecipient(id)

    return res.status(200).json({
      success: true,
      data: deleted,
      message: 'Destinatario eliminado correctamente'
    })
  } catch (err) {
    logError('❌ Error en deleteRecipient:', err.message)
    err.statusCode = err.message.includes('no encontrado') ? 404 : 500
    return next(err)
  }
}

export const importRecipients = async (req, res, next) => {
  try {
    log('📥 Controller → importRecipients')

    if (!req.file) {
      const err = new Error('Debe adjuntar un archivo CSV o XLSX')
      err.statusCode = 400
      throw err
    }

    const result = await recipientService.importRecipientsFromFile(req.file)

    return res.status(201).json({
      success: true,
      data: result,
      message: 'Importación procesada correctamente'
    })
  } catch (err) {
    logError('❌ Error en importRecipients:', err.message)
    err.statusCode = err.statusCode || 400
    return next(err)
  }
}
