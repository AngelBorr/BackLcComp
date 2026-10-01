import dotenv from 'dotenv'

dotenv.config()

const parseBoolean = (value, fallback) => {
  if (typeof value !== 'string') return fallback

  const normalized = value.trim().toLowerCase()
  if (normalized === 'true') return true
  if (normalized === 'false') return false
  return fallback
}

const parseSameSite = (value, fallback) => {
  const normalized = String(value || '').trim().toLowerCase()
  return ['lax', 'strict', 'none'].includes(normalized) ? normalized : fallback
}

export const resolveCookieConfig = (environment = process.env) => {
  const nodeEnvironment = String(environment.NODE_ENV || 'development').trim().toLowerCase()
  const crossSiteHttps = ['staging', 'production'].includes(nodeEnvironment)
  const defaultSameSite = crossSiteHttps ? 'none' : 'lax'
  const configuredDomain = String(environment.COOKIE_DOMAIN || '').trim()

  return {
    name: environment.COOKIE_NAME || 'cookieToken',
    maxAge:
      Number(environment.cookie_MAX_AGE) || Number(environment.COOKIE_MAX_AGE) || 3600000,
    sameSite: parseSameSite(environment.COOKIE_SAME_SITE, defaultSameSite),
    secure: parseBoolean(environment.COOKIE_SECURE, crossSiteHttps),
    ...(configuredDomain ? { domain: configuredDomain } : {})
  }
}

const cookieConfig = resolveCookieConfig()

export default {
  port: process.env.PORT,
  userMongo: process.env.USER_MONGO,
  passMongo: process.env.PASS_MONGO,
  dbColecction: process.env.DB_NAME,
  keyPrivate: process.env.PRIVATE_KEY,
  secret: process.env.DATASESSION,
  dbCluster: process.env.DB_CLUSTER,
  baseUrl: process.env.BASE_URL,
  frontendUrl: process.env.FRONTEND_URL,

  // 🗝️ KEYS
  privateKey: process.env.PRIVATE_KEY || 'devAAASecretKey10',
  jwt: {
    privateKey: process.env.JWT_PRIVATE_KEY || 'devFallbackKey',
    expiresIn: process.env.JWT_EXPIRES_IN || '1h'
  },

  // 🍪 COOKIE
  cookie: cookieConfig,

  // 🔑 SESSION
  session: {
    secret: process.env.DATASESSION || 'sessionSecretAAA'
  },

  // 📧 NODEMAIL — SMTP CONFIG FIJA + FALLBACK
  email: {
    user: process.env.USER_EMAIL, // obligatorio
    pass: process.env.PASS_EMAIL, // obligatorio

    // Estos valores JAMÁS quedan null
    host: process.env.EMAIL_HOST || 'luis@lccomp.com.ar',

    port: process.env.EMAIL_PORT ? Number(process.env.EMAIL_PORT) : 26 // fallback seguro al puerto SMTP de cPanel
  },

  // 🔍 DEBUG EMAIL ENDPOINT
  debugMailSecret: process.env.DEBUG_MAIL_SECRET || 'MiClaveSuperSegura123',

  resend: {
    apiKey: process.env.RESEND_API_KEY,
    from: process.env.RESEND_FROM,
    url: process.env.RESEND_URL || 'https://api.resend.com/emails'
  },

  mercadoPago: {
    accessToken: process.env.MERCADOPAGO_ACCESS_TOKEN,
    webhookSecret: process.env.MERCADOPAGO_WEBHOOK_SECRET,
    returnBaseUrl: process.env.MERCADOPAGO_RETURN_BASE_URL,
    timeoutMs: process.env.MERCADOPAGO_TIMEOUT_MS
      ? Number(process.env.MERCADOPAGO_TIMEOUT_MS)
      : 10000
  }
}
