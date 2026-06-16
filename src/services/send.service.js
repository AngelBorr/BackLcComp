import mongoose from 'mongoose'
import env from '../config.js'
import SendManager from '../dao/managers/send.mongo.js'
import EmailLogManager from '../dao/managers/emailLog.mongo.js'
import MessageTemplateManager from '../dao/managers/messageTemplate.mongo.js'
import { sendResendEmail } from '../utils/resend.js'
import { log, error as logError, secureLog } from '../utils/logger.js'

class SendService {
  constructor() {
    this.sendManager = new SendManager()
    this.emailLogManager = new EmailLogManager()
    this.messageManager = new MessageTemplateManager()
  }

  normalizeAttachments(files = []) {
    return files.map((file) => ({
      filename: file.originalname,
      content: file.buffer.toString('base64')
    }))
  }

  getAttachmentMetadata(files = []) {
    return files.map((file) => ({
      filename: file.originalname,
      mimetype: file.mimetype,
      size: file.size
    }))
  }

  validateSendData({ email, subject, content, sendName, sendType, recipientId, messageId }) {
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

    if (!sendType || !['individual', 'massive'].includes(sendType)) {
      throw new Error('El tipo de envío debe ser individual o massive')
    }

    if (!recipientId || typeof recipientId !== 'string' || !recipientId.trim()) {
      throw new Error('Debe indicar el destinatario del envío')
    }

    if (!messageId || typeof messageId !== 'string' || !messageId.trim()) {
      throw new Error('Debe indicar el mensaje utilizado en el envío')
    }
  }

  validateBatchSendData({ subject, content, sendName, sendType, messageId, recipients }) {
    if (!subject || typeof subject !== 'string' || !subject.trim()) {
      throw new Error('Debe indicar un asunto válido')
    }

    if (!content || typeof content !== 'string' || !content.trim()) {
      throw new Error('Debe indicar el contenido del email')
    }

    if (!sendName || typeof sendName !== 'string' || !sendName.trim()) {
      throw new Error('Debe indicar el nombre del envío')
    }

    if (!sendType || !['individual', 'massive'].includes(sendType)) {
      throw new Error('El tipo de envío debe ser individual o massive')
    }

    if (!messageId || typeof messageId !== 'string' || !messageId.trim()) {
      throw new Error('Debe indicar el mensaje utilizado en el envío')
    }

    if (!Array.isArray(recipients) || recipients.length === 0) {
      throw new Error('Debe indicar recipients válidos')
    }

    if (sendType === 'individual' && recipients.length !== 1) {
      throw new Error('El envío individual debe tener exactamente un destinatario')
    }

    if (sendType === 'massive' && recipients.length < 2) {
      throw new Error('El envío masivo debe tener dos o más destinatarios')
    }

    recipients.forEach((recipient) => {
      if (!recipient.email || typeof recipient.email !== 'string' || !recipient.email.trim()) {
        throw new Error('Cada destinatario debe tener un email válido')
      }
    })
  }

  normalizeRecipients(recipients = []) {
    const map = new Map()

    recipients.forEach((recipient) => {
      const email = String(recipient.email || '')
        .trim()
        .toLowerCase()

      if (!email) return

      map.set(email, {
        recipientId: recipient.recipientId || recipient.id || undefined,
        email,
        name: recipient.name || '',
        status: 'pending'
      })
    })

    return Array.from(map.values())
  }

  async resolveMessageSnapshot({ messageId, subject, content }) {
    if (!mongoose.Types.ObjectId.isValid(messageId)) {
      return {
        realMessageId: null,
        subjectSnapshot: subject.trim(),
        contentSnapshot: content.trim(),
        usedFallback: true
      }
    }

    const message = await this.messageManager.getReadyTemplateById(messageId)

    if (!message) {
      throw new Error('El mensaje indicado no existe o no está listo para enviar')
    }

    return {
      realMessageId: message._id,
      subjectSnapshot: message.subject,
      contentSnapshot: message.htmlContent,
      usedFallback: false
    }
  }

  async createAndSendMessengerEmail({
    email,
    subject,
    content,
    sendName,
    sendType,
    recipientId,
    messageId,
    internalNote,
    files = [],
    createdBy
  }) {
    const normalizedData = {
      email: email?.trim().toLowerCase(),
      subject: subject?.trim(),
      content: content?.trim(),
      sendName: sendName?.trim(),
      sendType,
      recipientId: recipientId?.trim(),
      messageId: messageId?.trim(),
      internalNote: internalNote?.trim() || '',
      createdBy
    }

    this.validateSendData(normalizedData)

    const messageSnapshot = await this.resolveMessageSnapshot({
      messageId: normalizedData.messageId,
      subject: normalizedData.subject,
      content: normalizedData.content
    })

    const attachmentMetadata = this.getAttachmentMetadata(files)
    const attachments = this.normalizeAttachments(files)

    const send = await this.sendManager.createSend({
      sendName: normalizedData.sendName,
      sendType: normalizedData.sendType,
      messageId: messageSnapshot.realMessageId,
      subjectSnapshot: messageSnapshot.subjectSnapshot,
      contentSnapshot: messageSnapshot.contentSnapshot,
      internalNote: normalizedData.internalNote,
      totalRecipients: 1,
      successCount: 0,
      failedCount: 0,
      status: 'processing',
      provider: 'resend',
      attachments: attachmentMetadata,
      createdBy: normalizedData.createdBy,
      recipients: [
        {
          recipientId: mongoose.Types.ObjectId.isValid(normalizedData.recipientId)
            ? normalizedData.recipientId
            : undefined,
          email: normalizedData.email,
          status: 'pending'
        }
      ]
    })

    try {
      const resendPayload = {
        from: env.resend.from,
        to: normalizedData.email,
        subject: messageSnapshot.subjectSnapshot,
        html: messageSnapshot.contentSnapshot,
        ...(attachments.length > 0 && { attachments })
      }

      secureLog('📤 Resend payload Messenger:', {
        ...resendPayload,
        attachments: attachmentMetadata
      })

      const sent = await sendResendEmail(resendPayload)

      const emailLog = await this.emailLogManager.createLog({
        sendId: send._id,
        recipientId: mongoose.Types.ObjectId.isValid(normalizedData.recipientId)
          ? normalizedData.recipientId
          : undefined,
        email: normalizedData.email,
        type: 'messenger_send',
        status: 'success',
        sendName: normalizedData.sendName,
        sendType: normalizedData.sendType,
        subjectSnapshot: messageSnapshot.subjectSnapshot,
        contentSnapshot: messageSnapshot.contentSnapshot,
        provider: 'resend',
        providerMessageId: sent?.id || sent?.data?.id,
        attachments: attachmentMetadata,
        payload: {
          sendId: send._id,
          messageId: messageSnapshot.realMessageId,
          usedFallback: messageSnapshot.usedFallback,
          internalNote: normalizedData.internalNote
        }
      })

      await this.sendManager.updateRecipientResult(send._id, normalizedData.email, {
        status: 'success',
        emailLogId: emailLog._id
      })

      const updatedSend = await this.sendManager.updateSendStatus(send._id, {
        status: 'completed',
        successCount: 1,
        failedCount: 0
      })

      log(`✅ SendService → email enviado correctamente a ${normalizedData.email}`)

      return {
        send: updatedSend,
        emailLog,
        providerResponse: sent
      }
    } catch (err) {
      logError('❌ SendService → error enviando email:', err.message)

      const emailLog = await this.emailLogManager.createLog({
        sendId: send._id,
        recipientId: mongoose.Types.ObjectId.isValid(normalizedData.recipientId)
          ? normalizedData.recipientId
          : undefined,
        email: normalizedData.email,
        type: 'messenger_send',
        status: 'failed',
        sendName: normalizedData.sendName,
        sendType: normalizedData.sendType,
        subjectSnapshot: messageSnapshot.subjectSnapshot,
        contentSnapshot: messageSnapshot.contentSnapshot,
        errorMessage: err.message,
        provider: 'resend',
        attachments: attachmentMetadata,
        payload: {
          sendId: send._id,
          messageId: messageSnapshot.realMessageId,
          usedFallback: messageSnapshot.usedFallback,
          internalNote: normalizedData.internalNote
        }
      })

      await this.sendManager.updateRecipientResult(send._id, normalizedData.email, {
        status: 'failed',
        errorMessage: err.message,
        emailLogId: emailLog._id
      })

      await this.sendManager.updateSendStatus(send._id, {
        status: 'failed',
        successCount: 0,
        failedCount: 1
      })

      throw new Error(`Error al enviar email desde Messenger: ${err.message}`)
    }
  }

  async getSends(params) {
    return await this.sendManager.getSends(params)
  }

  async getSendById(id) {
    const send = await this.sendManager.getSendById(id)

    if (!send) {
      throw new Error('Envío no encontrado')
    }

    return send
  }

  async createAndSendMessengerBatch({
    subject,
    content,
    sendName,
    sendType,
    messageId,
    sendSource,
    internalNote,
    recipients = [],
    files = [],
    createdBy
  }) {
    log(`📨 Iniciando envío masivo: ${sendName} | Destinatarios: ${recipients.length}`)

    const normalizedRecipients = this.normalizeRecipients(recipients)

    const normalizedData = {
      subject: subject?.trim(),
      content: content?.trim(),
      sendName: sendName?.trim(),
      sendType,
      messageId: messageId?.trim(),
      sendSource: sendSource || 'template',
      internalNote: internalNote?.trim() || '',
      recipients: normalizedRecipients,
      createdBy
    }

    this.validateBatchSendData(normalizedData)

    const messageSnapshot = await this.resolveMessageSnapshot({
      messageId: normalizedData.messageId,
      subject: normalizedData.subject,
      content: normalizedData.content
    })

    const attachmentMetadata = this.getAttachmentMetadata(files)
    const attachments = this.normalizeAttachments(files)

    const send = await this.sendManager.createSend({
      sendName: normalizedData.sendName,
      sendType: normalizedData.sendType,
      messageId: messageSnapshot.realMessageId,
      subjectSnapshot: messageSnapshot.subjectSnapshot,
      contentSnapshot: messageSnapshot.contentSnapshot,
      internalNote: normalizedData.internalNote,
      totalRecipients: normalizedRecipients.length,
      successCount: 0,
      failedCount: 0,
      status: 'processing',
      provider: 'resend',
      attachments: attachmentMetadata,
      createdBy: normalizedData.createdBy,
      recipients: normalizedRecipients.map((recipient) => ({
        recipientId: mongoose.Types.ObjectId.isValid(recipient.recipientId)
          ? recipient.recipientId
          : undefined,
        email: recipient.email,
        name: recipient.name || '',
        status: 'pending'
      }))
    })

    let successCount = 0
    let failedCount = 0
    const results = []

    for (const recipient of normalizedRecipients) {
      try {
        const resendPayload = {
          from: env.resend.from,
          to: recipient.email,
          subject: messageSnapshot.subjectSnapshot,
          html: messageSnapshot.contentSnapshot,
          ...(attachments.length > 0 && { attachments })
        }

        secureLog('📤 Resend payload Messenger Batch:', {
          sendName: normalizedData.sendName,
          sendType: normalizedData.sendType,

          to: resendPayload.to,

          subject: resendPayload.subject,

          htmlLength: resendPayload.html?.length || 0,

          attachmentsCount: attachmentMetadata.length,

          attachments: attachmentMetadata.map((file) => ({
            filename: file.filename,
            size: file.size
          }))
        })

        const sent = await sendResendEmail(resendPayload)

        const emailLog = await this.emailLogManager.createLog({
          sendId: send._id,
          recipientId: mongoose.Types.ObjectId.isValid(recipient.recipientId)
            ? recipient.recipientId
            : undefined,
          email: recipient.email,
          type: 'messenger_send',
          status: 'success',
          sendName: normalizedData.sendName,
          sendType: normalizedData.sendType,
          subjectSnapshot: messageSnapshot.subjectSnapshot,
          contentSnapshot: messageSnapshot.contentSnapshot,
          provider: 'resend',
          providerMessageId: sent?.id || sent?.data?.id,
          attachments: attachmentMetadata,
          payload: {
            sendId: send._id,
            messageId: messageSnapshot.realMessageId,
            usedFallback: messageSnapshot.usedFallback,
            sendSource: normalizedData.sendSource,
            internalNote: normalizedData.internalNote
          }
        })

        await this.sendManager.updateRecipientResult(send._id, recipient.email, {
          status: 'success',
          emailLogId: emailLog._id
        })

        successCount += 1

        results.push({
          email: recipient.email,
          status: 'success',
          emailLogId: emailLog._id
        })
      } catch (err) {
        logError(`❌ Error enviando a ${recipient.email}:`, err.message)

        const emailLog = await this.emailLogManager.createLog({
          sendId: send._id,
          recipientId: mongoose.Types.ObjectId.isValid(recipient.recipientId)
            ? recipient.recipientId
            : undefined,
          email: recipient.email,
          type: 'messenger_send',
          status: 'failed',
          sendName: normalizedData.sendName,
          sendType: normalizedData.sendType,
          subjectSnapshot: messageSnapshot.subjectSnapshot,
          contentSnapshot: messageSnapshot.contentSnapshot,
          errorMessage: err.message,
          provider: 'resend',
          attachments: attachmentMetadata,
          payload: {
            sendId: send._id,
            messageId: messageSnapshot.realMessageId,
            usedFallback: messageSnapshot.usedFallback,
            sendSource: normalizedData.sendSource,
            internalNote: normalizedData.internalNote
          }
        })

        await this.sendManager.updateRecipientResult(send._id, recipient.email, {
          status: 'failed',
          errorMessage: err.message,
          emailLogId: emailLog._id
        })

        failedCount += 1

        results.push({
          email: recipient.email,
          status: 'failed',
          errorMessage: err.message,
          emailLogId: emailLog._id
        })
      }
    }

    const finalStatus =
      successCount === normalizedRecipients.length
        ? 'completed'
        : successCount === 0
          ? 'failed'
          : 'partial_failed'

    const updatedSend = await this.sendManager.updateSendStatus(send._id, {
      status: finalStatus,
      successCount,
      failedCount
    })

    log(`✅ SendService Batch → envío finalizado. Success: ${successCount}, Failed: ${failedCount}`)

    return {
      send: updatedSend,
      results,
      summary: {
        totalRecipients: normalizedRecipients.length,
        successCount,
        failedCount,
        status: finalStatus
      }
    }
  }

  async retryFailedRecipients(sendId, retriedBy) {
    const { send, failedRecipients } = await this.sendManager.getFailedRecipients(sendId)

    if (!failedRecipients.length) {
      throw new Error('El envío no posee destinatarios fallidos para reintentar')
    }

    if (!send.subjectSnapshot || !send.contentSnapshot) {
      throw new Error('El envío no posee contenido válido para reintentar')
    }

    log(
      `🔁 SendService Retry → reenviando fallidos del envío ${sendId}. Total: ${failedRecipients.length}`
    )

    let retrySuccessCount = 0
    let retryFailedCount = 0
    const results = []

    for (const recipient of failedRecipients) {
      try {
        const resendPayload = {
          from: env.resend.from,
          to: recipient.email,
          subject: send.subjectSnapshot,
          html: send.contentSnapshot
          // Importante:
          // No se reenvían adjuntos en retry porque hoy solo guardamos metadata.
          // Para reenviar adjuntos reales, hay que persistirlos en GridFS o storage.
        }

        secureLog('🔁 Resend payload Retry:', {
          sendName: send.sendName,
          sendType: send.sendType,
          to: recipient.email,
          subject: send.subjectSnapshot,
          htmlLength: send.contentSnapshot?.length || 0,
          attachmentsCount: send.attachments?.length || 0,
          attachments: (send.attachments || []).map((file) => ({
            filename: file.filename,
            size: file.size
          }))
        })

        const sent = await sendResendEmail(resendPayload)

        const emailLog = await this.emailLogManager.createLog({
          sendId: send._id,
          recipientId: mongoose.Types.ObjectId.isValid(recipient.recipientId)
            ? recipient.recipientId
            : undefined,
          email: recipient.email,
          type: 'messenger_send_retry',
          status: 'success',
          sendName: send.sendName,
          sendType: send.sendType,
          subjectSnapshot: send.subjectSnapshot,
          contentSnapshot: send.contentSnapshot,
          provider: send.provider || 'resend',
          providerMessageId: sent?.id || sent?.data?.id,
          attachments: send.attachments || [],
          payload: {
            sendId: send._id,
            originalEmailLogId: recipient.emailLogId || null,
            messageId: send.messageId || null,
            retriedBy,
            retry: true
          }
        })

        await this.sendManager.updateRecipientResult(send._id, recipient.email, {
          status: 'success',
          errorMessage: '',
          emailLogId: emailLog._id
        })

        retrySuccessCount += 1

        results.push({
          email: recipient.email,
          status: 'success',
          emailLogId: emailLog._id
        })
      } catch (err) {
        logError(`❌ Retry falló para ${recipient.email}:`, err.message)

        const emailLog = await this.emailLogManager.createLog({
          sendId: send._id,
          recipientId: mongoose.Types.ObjectId.isValid(recipient.recipientId)
            ? recipient.recipientId
            : undefined,
          email: recipient.email,
          type: 'messenger_send_retry',
          status: 'failed',
          sendName: send.sendName,
          sendType: send.sendType,
          subjectSnapshot: send.subjectSnapshot,
          contentSnapshot: send.contentSnapshot,
          provider: send.provider || 'resend',
          errorMessage: err.message,
          attachments: send.attachments || [],
          payload: {
            sendId: send._id,
            originalEmailLogId: recipient.emailLogId || null,
            messageId: send.messageId || null,
            retriedBy,
            retry: true
          }
        })

        await this.sendManager.updateRecipientResult(send._id, recipient.email, {
          status: 'failed',
          errorMessage: err.message,
          emailLogId: emailLog._id
        })

        retryFailedCount += 1

        results.push({
          email: recipient.email,
          status: 'failed',
          errorMessage: err.message,
          emailLogId: emailLog._id
        })
      }
    }

    const updatedSend = await this.sendManager.recalculateSendCounters(send._id)

    log(
      `✅ SendService Retry → finalizado. Success: ${retrySuccessCount}, Failed: ${retryFailedCount}`
    )

    return {
      send: updatedSend,
      results,
      summary: {
        retriedRecipients: failedRecipients.length,
        successCount: retrySuccessCount,
        failedCount: retryFailedCount,
        status: updatedSend.status
      }
    }
  }
}

export default SendService
