// src/app.js
import express from 'express'
import mongoose from 'mongoose'
import cors from 'cors'
import displayRoutes from 'express-routemap'
import env from './config.js'

import UsersRouter from './routes/users.router.js'
import SessionsRouter from './routes/sessions.router.js'
import FilesRouter from './routes/files.router.js'
import ProductsRouter from './routes/products.router.js'

import initializePassport from './config/passport.config.js'
import passport from 'passport'

import srcDirname from './utils/utils.js'
import cookieParser from 'cookie-parser'

// ✅ IMPORTANTE: usar el GridFSBucket del driver que trae mongoose
const { GridFSBucket } = mongoose.mongo

// Logger
import { log } from './utils/logger.js'

// ✅ Middlewares (AAA-style)
import httpLogger from './middlewares/httpLogger.js'
import { notFoundHandler, errorHandler } from './middlewares/errorHandler.js'
import { attachLogger } from './middlewares/attachLogger.js'
import { serviceErrorHandler } from './middlewares/serviceErrorHandler.js'

const PORT = env.port

const rutaMongo =
  process.env.MONGO_URI ||
  `mongodb+srv://${env.userMongo}:${env.passMongo}@${env.dbCluster}/${env.dbColecction}?retryWrites=true&w=majority`

const app = express()

// --------------------------------------------------------------
// ✅ Trust proxy (IMPORTANT en Railway/Render/Nginx)
// --------------------------------------------------------------
app.set('trust proxy', 1)

// --------------------------------------------------------------
// ✅ CORS
// --------------------------------------------------------------
const allowedOrigins = ['https://lccomp.com.ar', 'http://localhost:5173']

app.use(
  cors({
    origin: (origin, cb) => {
      if (!origin) return cb(null, true)
      if (allowedOrigins.includes(origin)) return cb(null, true)
      return cb(new Error(`CORS blocked for origin: ${origin}`))
    },
    credentials: true,
    methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'Authorization']
  })
)

app.options('*', cors())

// --------------------------------------------------------------
// ✅ Parsers
// --------------------------------------------------------------
app.use(cookieParser())
app.use(express.json())
app.use(express.urlencoded({ extended: true }))

// --------------------------------------------------------------
// ✅ Logger
// --------------------------------------------------------------
app.use(httpLogger)
app.use(attachLogger)

// --------------------------------------------------------------
// ✅ Static
// --------------------------------------------------------------
app.use(express.static(srcDirname + '/public'))

// --------------------------------------------------------------
// ✅ Passport (solo initialize, JWT stateless)
// --------------------------------------------------------------
initializePassport()
app.use(passport.initialize())

// --------------------------------------------------------------
// ✅ Routes instances
// --------------------------------------------------------------
const usersRouter = new UsersRouter()
const sessionsRouter = new SessionsRouter()
const filesRouter = new FilesRouter()
const productsRouter = new ProductsRouter()

// --------------------------------------------------------------
// 📦 GridFS (opcional: bucket en req) - consistente con mongoose
// --------------------------------------------------------------
let gfsBucket
app.use((req, res, next) => {
  // Solo inicializa si la conexión está lista
  if (!gfsBucket && mongoose.connection.readyState === 1 && mongoose.connection.db) {
    gfsBucket = new GridFSBucket(mongoose.connection.db, { bucketName: 'productFiles' })
    log('📁 GridFSBucket inicializado correctamente (mongoose.mongo.GridFSBucket)')
  }
  req.gfsBucket = gfsBucket
  next()
})

// --------------------------------------------------------------
// ✅ Routes
// --------------------------------------------------------------
app.use('/api/users', usersRouter.getRouter())
app.use('/api/sessions', sessionsRouter.getRouter())
app.use('/api/files', filesRouter.getRouter())
app.use('/api/products', productsRouter.getRouter())

// --------------------------------------------------------------
// ✅ 404 + error handlers (SIEMPRE al final)
// --------------------------------------------------------------
app.use(notFoundHandler)
app.use(serviceErrorHandler)
app.use(errorHandler)

// --------------------------------------------------------------
// ✅ Start server after DB
// --------------------------------------------------------------
mongoose
  .connect(rutaMongo)
  .then(() => {
    console.log('conectado a mongo')

    app.listen(PORT, () => {
      displayRoutes(app)
      console.log(`Server running on port ${PORT}`)
    })
  })
  .catch((err) => {
    console.error('Error conectando a Mongo:', err)
    process.exit(1)
  })

export default app
