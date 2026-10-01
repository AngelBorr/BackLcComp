import env from '../config.js'
import { buildEmailVerificationTemplate } from '../templates/emailVerification.js'
import { sendResendEmail } from '../utils/resend.js'
import { log, error as logError } from '../utils/logger.js'

class TransactionalEmailService {
  buildVerificationUrl(token) {
    const frontendUrl = String(env.frontendUrl || '')
      .trim()
      .replace(/\/+$/, '')

    if (!frontendUrl) {
      throw new Error('FRONTEND_URL no está configurada')
    }

    try {
      const verificationUrl = new URL(`${frontendUrl}/verify-email`)
      verificationUrl.searchParams.set('token', token)
      return verificationUrl.toString()
    } catch {
      throw new Error('FRONTEND_URL no es una URL válida')
    }
  }

  async sendEmailVerification({ email, firstName, token }) {
    const normalizedEmail = String(email || '')
      .trim()
      .toLowerCase()

    if (!normalizedEmail || !token) {
      throw new Error('Datos inválidos para enviar la verificación de email')
    }

    const verificationUrl = this.buildVerificationUrl(token)
    const template = buildEmailVerificationTemplate({
      firstName,
      verificationUrl
    })

    try {
      const sent = await sendResendEmail({
        from: env.resend.from,
        to: normalizedEmail,
        subject: template.subject,
        html: template.html,
        text: template.text
      })

      log('TransactionalEmailService → email de verificación enviado')

      return {
        provider: 'resend',
        providerMessageId: sent?.id || sent?.data?.id || null
      }
    } catch (error) {
      logError('TransactionalEmailService → error enviando verificación:', error.message)
      throw error
    }
  }
}

export default TransactionalEmailService
