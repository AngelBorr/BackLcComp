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
  }
}
