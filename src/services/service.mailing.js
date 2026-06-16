// src/services/service.mailing.js
import env from '../config.js'
import EmailLogService from './emailLog.service.js'
import { log, error as logError, secureLog } from '../utils/logger.js'
import { sendResendEmail } from '../utils/resend.js'

class MailingService {
  normalizeAttachments(files = []) {
    return files.map((file) => ({
      filename: file.originalname,
      content: file.buffer.toString('base64')
    }))
  }

  validateMessengerEmailData({
    email,
    subject,
    content,
    sendName,
    sendType,
    recipientId,
    messageId
  }) {
    if (!email || typeof email !== 'string' || !email.trim()) {
      throw new Error('Debe indicar un email válido')
    }

    if (!subject || typeof subject !== 'string' || !subject.trim()) {
      throw new Error('Debe indicar un asunto válido')
    }

    if (!content || typeof content !== 'string' || !content.trim()) {
      throw new Error('Debe indicar el contenido del email')
    }

    if (!sendName || typeof sendName !== 'string' || !sendName.trim()) {
      throw new Error('Debe indicar el nombre del envío')
    }

    if (!sendType || typeof sendType !== 'string') {
      throw new Error('Debe indicar el tipo de envío')
    }

    if (!['individual', 'massive'].includes(sendType)) {
      throw new Error('El tipo de envío debe ser individual o massive')
    }

    if (!recipientId || typeof recipientId !== 'string' || !recipientId.trim()) {
      throw new Error('Debe indicar el destinatario del envío')
    }

    if (!messageId || typeof messageId !== 'string' || !messageId.trim()) {
      throw new Error('Debe indicar el mensaje utilizado en el envío')
    }
  }

  async sendMessengerEmail({
    email,
    subject,
    content,
    sendName,
    sendType,
    recipientId,
    messageId,
    internalNote,
    files = []
  }) {
    const emailLogService = new EmailLogService()

    const normalizedData = {
      email: email?.trim(),
      subject: subject?.trim(),
      content: content?.trim(),
      sendName: sendName?.trim(),
      sendType,
      recipientId: recipientId?.trim(),
      messageId: messageId?.trim(),
      internalNote: internalNote?.trim() || ''
    }

    console.log('📤 Enviando email desde Messenger a:', normalizedData.email)

    try {
      this.validateMessengerEmailData(normalizedData)

      const attachments = this.normalizeAttachments(files)

      const payload = {
        from: env.resend.from,
        to: normalizedData.email,
        subject: normalizedData.subject,
        html: normalizedData.content,
        ...(attachments.length > 0 && { attachments })
      }

      secureLog('📤 Resend payload Messenger:', {
        ...payload,
        attachments: attachments.map((file) => ({
          filename: file.filename,
          hasContent: Boolean(file.content)
        }))
      })

      const sent = await sendResendEmail(payload)

      log(`✅ Messenger email enviado correctamente a ${normalizedData.email}`)

      await emailLogService.addLog({
        email: normalizedData.email,
        type: 'messenger_send',
        status: 'success',
        subject: normalizedData.subject,
        payload: {
          to: normalizedData.email,
          subject: normalizedData.subject,
          sendName: normalizedData.sendName,
          sendType: normalizedData.sendType,
          recipientId: normalizedData.recipientId,
          messageId: normalizedData.messageId,
          internalNote: normalizedData.internalNote,
          hasContent: true,
          attachments: attachments.map((file) => ({
            filename: file.filename
          }))
        }
      })

      return sent
    } catch (err) {
      logError('❌ Error en MailingService.sendMessengerEmail:', err.message)

      await emailLogService.addLog({
        email: normalizedData.email || 'unknown',
        type: 'messenger_send',
        status: 'failed',
        subject: normalizedData.subject || 'Sin asunto',
        errorMessage: err.message,
        payload: {
          to: normalizedData.email || null,
          subject: normalizedData.subject || null,
          sendName: normalizedData.sendName || null,
          sendType: normalizedData.sendType || null,
          recipientId: normalizedData.recipientId || null,
          messageId: normalizedData.messageId || null,
          internalNote: normalizedData.internalNote || '',
          attachmentsCount: files.length
        }
      })

      throw new Error(`Error al enviar email desde Messenger: ${err.message}`)
    }
  }
}

export default MailingService
