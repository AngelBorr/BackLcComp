import dotenv from 'dotenv'

dotenv.config()

export default {
  port: process.env.PORT,
  userMongo: process.env.USER_MONGO,
  passMongo: process.env.PASS_MONGO,
  dbColecction: process.env.DB_NAME,
  keyPrivate: process.env.PRIVATE_KEY,
  secret: process.env.DATASESSION,
  dbCluster: process.env.DB_CLUSTER,
  baseUrl: process.env.BASE_URL,

  // 🗝️ KEYS
  privateKey: process.env.PRIVATE_KEY || 'devAAASecretKey10',
  jwt: {
    privateKey: process.env.JWT_PRIVATE_KEY || 'devFallbackKey',
    expiresIn: process.env.JWT_EXPIRES_IN || '1h'
  },

  // 🍪 COOKIE
  cookie: {
    name: process.env.COOKIE_NAME || 'cookieToken',
    maxAge: Number(process.env.cookie_MAX_AGE) || Number(process.env.COOKIE_MAX_AGE) || 3600000,
    sameSite: process.env.COOKIE_SAME_SITE || 'none',
    secure: true
  },

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
  }
}
