import SendService from '../services/send.service.js'
import { error as logError } from '../utils/logger.js'

const sendService = new SendService()

/* -------------------------------------------------------------
   📌 POST → Crear envío y enviar email desde Messenger
------------------------------------------------------------- */

export const sendMessengerEmail = async (req, res, next) => {
  try {
    console.log('📥 Controller → sendMessengerEmail - Payload recibido:', {
      sendName: req.body.sendName,
      sendType: req.body.sendType,
      sendSource: req.body.sendSource,
      messageId: req.body.messageId,
      subject: req.body.subject,
      contentLength: req.body.content?.length || 0,
      recipientsCount: req.body.recipients ? JSON.parse(req.body.recipients).length : 0,
      hasInternalNote: Boolean(req.body.internalNote),
      attachmentsCount: req.files?.length || 0
    })

    const {
      email,
      subject,
      content,
      sendName,
      sendType,
      recipientId,
      messageId,
      sendSource,
      internalNote,
      recipients
    } = req.body

    const files = req.files || []

    let parsedRecipients = []

    if (recipients) {
      parsedRecipients = JSON.parse(recipients)
    } else if (email && recipientId) {
      parsedRecipients = [
        {
          recipientId,
          email
        }
      ]
    }

    const result = await sendService.createAndSendMessengerBatch({
      subject,
      content,
      sendName,
      sendType,
      messageId,
      sendSource,
      internalNote,
      recipients: parsedRecipients,
      files,
      createdBy: req.user?._id || req.user?.id
    })

    return res.status(201).json({
      success: true,
      data: result,
      message: 'Envío registrado y procesado correctamente'
    })
  } catch (err) {
    logError('❌ Error en controller.send → sendMessengerEmail:', err.message)

    if (
      err.message.includes('email válido') ||
      err.message.includes('asunto válido') ||
      err.message.includes('contenido') ||
      err.message.includes('nombre del envío') ||
      err.message.includes('tipo de envío') ||
      err.message.includes('destinatario') ||
      err.message.includes('mensaje') ||
      err.message.includes('recipients') ||
      err.message.includes('no existe') ||
      err.message.includes('no está listo')
    ) {
      err.statusCode = 400
    } else {
      err.statusCode = 500
    }

    return next(err)
  }
}

export const getSends = async (req, res, next) => {
  try {
    const result = await sendService.getSends(req.query)

    return res.status(200).json({
      success: true,
      data: result
    })
  } catch (err) {
    logError('❌ Error en controller.send → getSends:', err.message)
    err.statusCode = 500
    return next(err)
  }
}

export const getSendById = async (req, res, next) => {
  try {
    const send = await sendService.getSendById(req.params.id)

    return res.status(200).json({
      success: true,
      data: send
    })
  } catch (err) {
    logError('❌ Error en controller.send → getSendById:', err.message)
    err.statusCode = err.message.includes('no encontrado') ? 404 : 400
    return next(err)
  }
}

export const retryFailedRecipients = async (req, res, next) => {
  try {
    const result = await sendService.retryFailedRecipients(
      req.params.id,
      req.user?._id || req.user?.id
    )

    return res.status(200).json({
      success: true,
      data: result,
      message: 'Destinatarios fallidos reenviados correctamente'
    })
  } catch (err) {
    logError('❌ Error en controller.send → retryFailedRecipients:', err.message)

    if (
      err.message.includes('inválido') ||
      err.message.includes('no encontrado') ||
      err.message.includes('fallidos') ||
      err.message.includes('contenido')
    ) {
      err.statusCode = 400
    } else {
      err.statusCode = 500
    }

    return next(err)
  }
}
