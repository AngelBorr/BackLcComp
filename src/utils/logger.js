// src/utils/logger.js
import winston from 'winston'

const isProd = process.env.NODE_ENV === 'production'

const logger = winston.createLogger({
  level: isProd ? 'info' : 'debug',
  format: winston.format.combine(
    winston.format.timestamp(),
    winston.format.printf(({ level, message, timestamp }) => {
      return `[${timestamp}] [${level.toUpperCase()}] ${message}`
    })
  ),
  transports: [new winston.transports.Console()]
})

// ✅ stringify seguro (no rompe con Buffer / circular / BigInt / Error)
const safeToString = (value) => {
  try {
    if (value === null) return 'null'
    if (value === undefined) return 'undefined'

    const t = typeof value
    if (t === 'string') return value
    if (t === 'number' || t === 'boolean') return String(value)
    if (t === 'bigint') return value.toString()
    if (t === 'function') return `[Function ${value.name || 'anonymous'}]`

    // Buffer
    if (typeof Buffer !== 'undefined' && Buffer.isBuffer(value)) {
      return `[Buffer length=${value.length}]`
    }

    // Error
    if (value instanceof Error) {
      return `${value.name}: ${value.message}`
    }

    // Objetos (incluye arrays) con manejo de circular
    const seen = new WeakSet()
    return JSON.stringify(
      value,
      (k, v) => {
        if (typeof v === 'bigint') return v.toString()
        if (typeof Buffer !== 'undefined' && Buffer.isBuffer(v))
          return `[Buffer length=${v.length}]`
        if (v instanceof Error) return { name: v.name, message: v.message, stack: v.stack }

        if (typeof v === 'object' && v !== null) {
          if (seen.has(v)) return '[Circular]'
          seen.add(v)
        }
        return v
      },
      2
    )
  } catch (e) {
    // fallback final, nunca romper
    try {
      return String(value)
    } catch (_) {
      return '[Unserializable value]'
    }
  }
}

const joinArgs = (args) => args.map(safeToString).join(' ')

// 🌐 Log normal → solo en dev
export const log = (...args) => {
  if (!isProd) {
    logger.debug(joinArgs(args))
  }
}

// ⚠️ Advertencias → siempre
export const warn = (...args) => {
  logger.warn(joinArgs(args))
}

// ❌ Errores → siempre
export const error = (...args) => {
  logger.error(joinArgs(args))
}

// 🔐 Logs sensibles → solo datos en dev
export const secureLog = (...args) => {
  if (!isProd) {
    logger.debug(joinArgs(args))
  } else {
    logger.info('[secureLog] Información sensible omitida en producción.')
  }
}

export default logger
