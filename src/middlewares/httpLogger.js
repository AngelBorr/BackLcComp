// src/middlewares/httpLogger.js
import morgan from 'morgan'
import logger from '../utils/logger.js'

const isProd = process.env.NODE_ENV === 'production'

// Stream personalizado para que morgan use winston
const stream = {
  write: (message) => {
    const msg = message.trim()
    if (isProd) {
      logger.info(msg)
    } else {
      logger.debug(msg)
    }
  }
}

// Podés definir el formato que más te guste
const httpLogger = morgan(':method :url :status :res[content-length] - :response-time ms', {
  stream
})

export default httpLogger
