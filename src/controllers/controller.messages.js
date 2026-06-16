import MessagesService from '../services/messages.service.js'
import { error as logError } from '../utils/logger.js'

const messagesService = new MessagesService()

export const createMessage = async (req, res, next) => {
  try {
    const template = await messagesService.createTemplate(req.body, req.user?._id || req.user?.id)

    return res.status(201).json({
      success: true,
      data: template,
      message: 'Plantilla creada correctamente'
    })
  } catch (err) {
    logError('❌ Error en createMessage:', err.message)
    err.statusCode = 400
    return next(err)
  }
}

export const importHtmlMessage = async (req, res, next) => {
  try {
    const template = await messagesService.importHtmlTemplate({
      file: req.file,
      body: req.body,
      userId: req.user?._id || req.user?.id
    })

    return res.status(201).json({
      success: true,
      data: template,
      message: 'Plantilla HTML importada correctamente'
    })
  } catch (err) {
    logError('❌ Error en importHtmlMessage:', err.message)
    err.statusCode = 400
    return next(err)
  }
}

export const getMessages = async (req, res, next) => {
  try {
    const result = await messagesService.getTemplates(req.query)

    return res.status(200).json({
      success: true,
      data: result
    })
  } catch (err) {
    logError('❌ Error en getMessages:', err.message)
    err.statusCode = 500
    return next(err)
  }
}

export const getMessageById = async (req, res, next) => {
  try {
    const template = await messagesService.getTemplateById(req.params.id)

    return res.status(200).json({
      success: true,
      data: template
    })
  } catch (err) {
    logError('❌ Error en getMessageById:', err.message)
    err.statusCode = 404
    return next(err)
  }
}

export const updateMessage = async (req, res, next) => {
  try {
    const template = await messagesService.updateTemplate(
      req.params.id,
      req.body,
      req.user?._id || req.user?.id
    )

    return res.status(200).json({
      success: true,
      data: template,
      message: 'Plantilla actualizada correctamente'
    })
  } catch (err) {
    logError('❌ Error en updateMessage:', err.message)
    err.statusCode = 400
    return next(err)
  }
}

export const deleteMessage = async (req, res, next) => {
  try {
    const template = await messagesService.deleteTemplate(req.params.id)

    return res.status(200).json({
      success: true,
      data: template,
      message: 'Plantilla eliminada correctamente'
    })
  } catch (err) {
    logError('❌ Error en deleteMessage:', err.message)
    err.statusCode = 400
    return next(err)
  }
}
