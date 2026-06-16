// src/utils/resend.js
import env from '../config.js'

export const sendResendEmail = async (payload) => {
  const response = await fetch(env.resend.url, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${env.resend.apiKey}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify(payload)
  })

  const data = await response.json()

  if (!response.ok) {
    throw new Error(data?.message || 'Error al enviar email con Resend')
  }

  return data
}
