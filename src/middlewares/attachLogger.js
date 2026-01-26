import logger from '../utils/logger.js'

/**
 * Middleware que inyecta el logger en req
 * Permite usar req.logger.debug / info / warn / error
 * en controllers y services (estilo AAA)
 */
export const attachLogger = (req, _res, next) => {
  req.logger = logger
  next()
}
