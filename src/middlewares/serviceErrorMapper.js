import { ServiceError as ProductsServiceError } from '../services/service.products.js'
import { ServiceError as UsersServiceError } from '../services/services.users.js'

export const mapServiceErrorToHttp = (err) => {
  if (!(err instanceof UsersServiceError) && !(err instanceof ProductsServiceError)) {
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
    case 'EMAIL_VERIFICATION_TOKEN_INVALID':
      return { status: 400, message: err.message }

    case 'EMAIL_VERIFICATION_TOKEN_EXPIRED':
      return { status: 410, message: err.message }

    case 'USER_ALREADY_EXISTS':
      return { status: 409, message: err.message }

    case 'PRODUCT_HAS_PRODUCT_UNITS':
    case 'PRODUCT_DELETE_CONFLICT':
      return { status: 409, message: err.message }

    case 'UPDATE_ROLE_NOT_SUPPORTED':
    case 'EMAIL_VERIFICATION_FAILED':
      return { status: 500, message: err.message }

    case 'INVALID_PASSWORD':
      return { status: 400, message: err.message }

    case 'MERCADOPAGO_TIMEOUT':
      return { status: 503, message: err.message }

    default:
      return {
        status: err instanceof ProductsServiceError ? err.status : 500,
        message: err.message || 'Error interno del servidor'
      }
  }
}
