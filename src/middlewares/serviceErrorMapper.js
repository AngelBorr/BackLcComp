import { ServiceError } from '../services/services.users.js'

export const mapServiceErrorToHttp = (err) => {
  if (!(err instanceof ServiceError)) {
    return { status: 500, message: 'Error interno del servidor' }
  }

  switch (err.code) {
    case 'INVALID_USER_PAYLOAD':
    case 'MISSING_REQUIRED_FIELDS':
    case 'INVALID_ROLE':
    case 'MISSING_ID':
    case 'INVALID_ID': // ✅ NUEVO
    case 'INVALID_ROLE_PAYLOAD':
    case 'MISSING_ROLE':
    case 'INVALID_DATA_FORMAT':
      return { status: 400, message: err.message }

    case 'USER_ALREADY_EXISTS':
      return { status: 409, message: err.message }

    case 'UPDATE_ROLE_NOT_SUPPORTED':
      return { status: 500, message: err.message }

    case 'INVALID_PASSWORD':
      return { status: 400, message: err.message }

    default:
      return { status: 500, message: err.message || 'Error interno del servidor' }
  }
}
