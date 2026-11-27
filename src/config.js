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

const parsePositiveInteger = (value, fallback) => {
  const parsed = Number(value)
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback
}

const VALID_NODE_ENVIRONMENTS = new Set(['development', 'test', 'staging', 'production'])
const TEST_DATABASE_NAME = /^(?:test|test[_-][a-z0-9][a-z0-9_-]*|[a-z0-9][a-z0-9_-]*[_-]test)$/i

const resolveNodeEnvironment = (environment = process.env) => {
  const nodeEnvironment = String(environment.NODE_ENV || 'development').trim().toLowerCase()

  if (!VALID_NODE_ENVIRONMENTS.has(nodeEnvironment)) {
    throw new Error('NODE_ENV must be development, test, staging, or production')
  }

  return nodeEnvironment
}

const parseMongoDatabaseName = (uri) => {
  let parsed

  try {
    parsed = new URL(uri)
  } catch {
    throw new Error('Production MONGO_URI must include an explicit database name')
  }

  if (!['mongodb:', 'mongodb+srv:'].includes(parsed.protocol) || !parsed.hostname) {
    throw new Error('Production MONGO_URI must include an explicit database name')
  }

  const encodedDatabaseName = parsed.pathname.startsWith('/')
    ? parsed.pathname.slice(1)
    : ''

  if (!encodedDatabaseName || encodedDatabaseName.includes('/')) {
    throw new Error('Production MONGO_URI must include an explicit database name')
  }

  let databaseName

  try {
    databaseName = decodeURIComponent(encodedDatabaseName)
  } catch {
    throw new Error('Production MONGO_URI must include an explicit database name')
  }

  if (!databaseName || databaseName.includes('/')) {
    throw new Error('Production MONGO_URI must include an explicit database name')
  }

  return databaseName
}

export const validateCriticalEnvironment = (environment = process.env) => {
  const nodeEnvironment = resolveNodeEnvironment(environment)

  if (nodeEnvironment !== 'production') {
    return { nodeEnvironment, databaseName: null }
  }

  const jwtPrivateKey = typeof environment.JWT_PRIVATE_KEY === 'string'
    ? environment.JWT_PRIVATE_KEY.trim()
    : ''

  if (!jwtPrivateKey) {
    throw new Error('JWT_PRIVATE_KEY is required in production')
  }

  const mongoUri = typeof environment.MONGO_URI === 'string'
    ? environment.MONGO_URI.trim()
    : ''

  if (!mongoUri) {
    throw new Error('MONGO_URI is required in production')
  }

  const databaseName = parseMongoDatabaseName(mongoUri)

  if (TEST_DATABASE_NAME.test(databaseName)) {
    throw new Error('Production database cannot use a test database name')
  }

  return { nodeEnvironment, databaseName }
}

export const resolvePaymentReconciliationConfig = (environment = process.env) => ({
  batchSize: parsePositiveInteger(environment.PAYMENT_RECONCILIATION_BATCH_SIZE, 20),
  maxOrdersPerRun: parsePositiveInteger(environment.PAYMENT_RECONCILIATION_MAX_PER_RUN, 100),
  concurrency: parsePositiveInteger(environment.PAYMENT_RECONCILIATION_CONCURRENCY, 2)
})

export const resolveCookieConfig = (environment = process.env) => {
  const nodeEnvironment = resolveNodeEnvironment(environment)
  const isProduction = nodeEnvironment === 'production'
  const crossSiteHttps = ['staging', 'production'].includes(nodeEnvironment)
  const defaultSameSite = crossSiteHttps ? 'none' : 'lax'
  const configuredDomain = String(environment.COOKIE_DOMAIN || '').trim()

  return {
    name: environment.COOKIE_NAME || 'cookieToken',
    maxAge:
      Number(environment.cookie_MAX_AGE) || Number(environment.COOKIE_MAX_AGE) || 3600000,
    sameSite: isProduction
      ? 'none'
      : parseSameSite(environment.COOKIE_SAME_SITE, defaultSameSite),
    secure: isProduction
      ? true
      : parseBoolean(environment.COOKIE_SECURE, crossSiteHttps),
    ...(configuredDomain && !isProduction ? { domain: configuredDomain } : {})
  }
}

const criticalEnvironment = validateCriticalEnvironment()
const configuredJwtPrivateKey = String(process.env.JWT_PRIVATE_KEY || '').trim()

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
    privateKey: criticalEnvironment.nodeEnvironment === 'production'
      ? configuredJwtPrivateKey
      : configuredJwtPrivateKey || 'devFallbackKey',
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
  },

  paymentReconciliation: resolvePaymentReconciliationConfig()
}
