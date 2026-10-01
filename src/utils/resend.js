// src/utils/resend.js
import env from '../config.js'

const RESEND_TIMEOUT_MS = 10 * 1000

class ResendHttpError extends Error {
  constructor(message) {
    super(message)
    this.name = 'ResendHttpError'
  }
}

const parseResponseBody = async (response) => {
  const body = await response.text()

  if (!body) return {}

  try {
    return JSON.parse(body)
  } catch {
    return {}
  }
}

export const sendResendEmail = async (payload) => {
  if (!env.resend.apiKey || !env.resend.url) {
    throw new Error('Configuración de Resend incompleta')
  }

  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), RESEND_TIMEOUT_MS)

  try {
    const response = await fetch(env.resend.url, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${env.resend.apiKey}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify(payload),
      signal: controller.signal
    })

    const data = await parseResponseBody(response)

    if (!response.ok) {
      throw new ResendHttpError(
        data?.message || `Resend rechazó el envío (HTTP ${response.status})`
      )
    }

    return data
  } catch (error) {
    if (error?.name === 'AbortError') {
      throw new Error('Tiempo de espera agotado al enviar email con Resend')
    }

    if (error instanceof ResendHttpError) {
      throw error
    }

    throw new Error('No se pudo conectar con el proveedor de email')
  } finally {
    clearTimeout(timeout)
  }
}
