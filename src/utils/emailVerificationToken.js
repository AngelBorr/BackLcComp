import { createHash, randomBytes } from 'node:crypto'

export const EMAIL_VERIFICATION_TOKEN_TTL_MS = 24 * 60 * 60 * 1000

export const generateVerificationToken = () => randomBytes(32).toString('base64url')

export const hashVerificationToken = (token) => {
  const normalizedToken = String(token || '').trim()

  if (!normalizedToken) {
    throw new Error('Token de verificación inválido')
  }

  return createHash('sha256').update(normalizedToken).digest('hex')
}

export const getVerificationTokenExpiration = (issuedAt = new Date()) => {
  return new Date(issuedAt.getTime() + EMAIL_VERIFICATION_TOKEN_TTL_MS)
}
