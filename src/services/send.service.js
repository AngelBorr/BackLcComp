import mongoose from 'mongoose'
import env from '../config.js'
import SendManager from '../dao/managers/send.mongo.js'
import EmailLogManager from '../dao/managers/emailLog.mongo.js'
import MessageTemplateManager from '../dao/managers/messageTemplate.mongo.js'
import FileAssetService from '../services/service.fileAsset.js'
import { sendResendEmail } from '../utils/resend.js'
import { log, error as logError, secureLog } from '../utils/logger.js'

class SendService {
  constructor() {
    this.sendManager = new SendManager()
    this.emailLogManager = new EmailLogManager()
    this.messageManager = new MessageTemplateManager()
    this.fileAssetService = FileAssetService
  }

  normalizeAttachments(files = []) {
    return files.map((file) => ({
      filename: file.originalname,
      content: file.buffer.toString('base64')
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

  async persistMessengerAttachments({ files = [], createdBy = null, sendData = {} }) {
    if (!Array.isArray(files) || files.length === 0) return []

    return await this.fileAssetService.uploadMessengerAttachments({
      files,
      uploadedBy: createdBy,
      entityId: null,
      data: sendData
    })
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

    const resendAttachments = this.normalizeAttachments(files)

    const attachmentMetadata = await this.persistMessengerAttachments({
      files,
      createdBy: normalizedData.createdBy,
      sendData: {
        sendName: normalizedData.sendName,
        sendType: normalizedData.sendType,
        sendSource: 'legacy_individual'
      }
    })

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

    await this.fileAssetService.attachAssetsToSend(attachmentMetadata, send._id)

    try {
      const resendPayload = {
        from: env.resend.from,
        to: normalizedData.email,
        subject: messageSnapshot.subjectSnapshot,
        html: messageSnapshot.contentSnapshot,
        ...(resendAttachments.length > 0 && { attachments: resendAttachments })
      }

      secureLog('📤 Resend payload Messenger:', {
        sendName: normalizedData.sendName,
        sendType: normalizedData.sendType,
        to: normalizedData.email,
        subject: messageSnapshot.subjectSnapshot,
        htmlLength: messageSnapshot.contentSnapshot?.length || 0,
        attachmentsCount: resendAttachments.length,
        attachments: attachmentMetadata.map((file) => ({
          filename: file.originalName || file.filename,
          size: file.size,
          hasFileId: Boolean(file.fileId),
          hasFileAssetId: Boolean(file.fileAssetId)
        }))
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

    const resendAttachments = this.normalizeAttachments(files)

    const attachmentMetadata = await this.persistMessengerAttachments({
      files,
      createdBy: normalizedData.createdBy,
      sendData: {
        sendName: normalizedData.sendName,
        sendType: normalizedData.sendType,
        sendSource: normalizedData.sendSource
      }
    })

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

    await this.fileAssetService.attachAssetsToSend(attachmentMetadata, send._id)

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
          ...(resendAttachments.length > 0 && { attachments: resendAttachments })
        }

        secureLog('📤 Resend payload Messenger Batch:', {
          sendName: normalizedData.sendName,
          sendType: normalizedData.sendType,
          to: recipient.email,
          subject: messageSnapshot.subjectSnapshot,
          htmlLength: messageSnapshot.contentSnapshot?.length || 0,
          attachmentsCount: resendAttachments.length,
          attachments: attachmentMetadata.map((file) => ({
            filename: file.originalName || file.filename,
            size: file.size,
            hasFileId: Boolean(file.fileId),
            hasFileAssetId: Boolean(file.fileAssetId)
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

    const retryAttachments = await this.fileAssetService.buildResendAttachmentsFromAssets(
      send.attachments || []
    )

    log(
      `🔁 SendService Retry → reenviando fallidos del envío ${sendId}. Total: ${failedRecipients.length} | Adjuntos: ${retryAttachments.length}`
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
          html: send.contentSnapshot,
          ...(retryAttachments.length > 0 && { attachments: retryAttachments })
        }

        secureLog('🔁 Resend payload Retry:', {
          sendName: send.sendName,
          sendType: send.sendType,
          to: recipient.email,
          subject: send.subjectSnapshot,
          htmlLength: send.contentSnapshot?.length || 0,
          attachmentsCount: retryAttachments.length,
          attachments: (send.attachments || []).map((file) => ({
            filename: file.originalName || file.filename,
            size: file.size,
            hasFileId: Boolean(file.fileId),
            hasFileAssetId: Boolean(file.fileAssetId)
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
            retry: true,
            retryWithAttachments: retryAttachments.length > 0,
            attachmentsCount: retryAttachments.length
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
            retry: true,
            retryWithAttachments: retryAttachments.length > 0,
            attachmentsCount: retryAttachments.length
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
        attachmentsCount: retryAttachments.length,
        status: updatedSend.status
      }
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
}

export default SendService
