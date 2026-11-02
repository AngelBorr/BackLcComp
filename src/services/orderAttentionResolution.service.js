import mongoose from 'mongoose'
import OrderAttentionResolutionManager from '../dao/managers/orderAttentionResolution.manager.js'
import { ORDER_ATTENTION_RESOLUTION_ACTIONS } from '../dao/models/orderAttentionResolution.model.js'
import { ServiceError } from './service.products.js'

const isDuplicateKeyError = (error) => (
  error?.code === 11000 || error?.errorResponse?.code === 11000
)

const asText = (value) => String(value ?? '').trim()
const sameId = (left, right) => asText(left) === asText(right)

const toPlainObject = (value) => (
  typeof value?.toObject === 'function' ? value.toObject() : value
)

class OrderAttentionResolutionService {
  constructor({ resolutionManager = OrderAttentionResolutionManager } = {}) {
    this.resolutions = resolutionManager
  }

  #validatePreparedInput(input) {
    for (const field of ['orderId', 'paymentId', 'actorUserId']) {
      if (!mongoose.Types.ObjectId.isValid(input?.[field])) {
        throw new ServiceError(`${field} invalido`, 'INVALID_ATTENTION_RESOLUTION', 400)
      }
    }

    const idempotencyKey = asText(input.idempotencyKey)
    const originalAttentionReason = asText(input.originalAttentionReason)
    const actorRole = asText(input.actorRole).toUpperCase()
    const action = asText(input.action)
    const requestedAt = input.requestedAt == null ? null : new Date(input.requestedAt)

    if (!idempotencyKey || idempotencyKey.length > 128) {
      throw new ServiceError(
        'Idempotency key invalida',
        'INVALID_ATTENTION_RESOLUTION_IDEMPOTENCY_KEY',
        400
      )
    }
    if (!ORDER_ATTENTION_RESOLUTION_ACTIONS.includes(action)) {
      throw new ServiceError('Accion invalida', 'INVALID_ATTENTION_RESOLUTION_ACTION', 400)
    }
    if (!originalAttentionReason) {
      throw new ServiceError(
        'La razon original es obligatoria',
        'ATTENTION_RESOLUTION_REASON_REQUIRED',
        400
      )
    }
    if (!['ADMIN', 'SUPERADMIN'].includes(actorRole)) {
      throw new ServiceError('Actor administrativo requerido', 'ATTENTION_RESOLUTION_FORBIDDEN', 403)
    }
    if (!requestedAt || Number.isNaN(requestedAt.getTime())) {
      throw new ServiceError('requestedAt invalido', 'INVALID_ATTENTION_RESOLUTION_DATE', 400)
    }

    return {
      ...input,
      idempotencyKey,
      action,
      originalAttentionReason,
      actorRole,
      note: asText(input.note),
      requestedAt
    }
  }

  #isSameLogicalOperation(existing, requested) {
    return sameId(existing.orderId, requested.orderId) &&
      sameId(existing.paymentId, requested.paymentId) &&
      existing.action === requested.action &&
      existing.originalAttentionReason === requested.originalAttentionReason &&
      sameId(existing.actorUserId, requested.actorUserId) &&
      existing.actorRole === requested.actorRole
  }

  async createPreparedResolution(input, { session } = {}) {
    const prepared = this.#validatePreparedInput(input)

    try {
      const resolution = await this.resolutions.createPreparedResolution(prepared, { session })
      return { resolution: toPlainObject(resolution), idempotent: false }
    } catch (error) {
      if (!isDuplicateKeyError(error)) throw error

      const existing = await this.resolutions.getByOrderAndIdempotencyKey(
        prepared.orderId,
        prepared.idempotencyKey,
        { session }
      )

      if (!existing || !this.#isSameLogicalOperation(existing, prepared)) {
        throw new ServiceError(
          'La idempotency key ya corresponde a otra resolucion',
          'ATTENTION_RESOLUTION_IDEMPOTENCY_CONFLICT',
          409
        )
      }

      return { resolution: existing, idempotent: true }
    }
  }

  async completePreparedResolution(
    {
      resolutionId,
      completedAt = new Date(),
      providerEvidence = null,
      finalProductUnits = [],
      finalResult = null,
      expectedAttemptToken = null
    },
    { session } = {}
  ) {
    const completed = completedAt == null ? null : new Date(completedAt)
    if (
      !mongoose.Types.ObjectId.isValid(resolutionId) ||
      !completed ||
      Number.isNaN(completed.getTime())
    ) {
      throw new ServiceError('Resolucion invalida', 'INVALID_ATTENTION_RESOLUTION', 400)
    }

    const resolution = await this.resolutions.completePreparedResolution(
      resolutionId,
      {
        completedAt: completed,
        providerEvidence,
        finalProductUnits,
        finalResult,
        expectedAttemptToken
      },
      { session }
    )

    if (!resolution) {
      throw new ServiceError(
        'La resolucion ya fue finalizada',
        'ATTENTION_RESOLUTION_STATE_CONFLICT',
        409
      )
    }

    return resolution
  }

  async failPreparedResolution(
    {
      resolutionId,
      completedAt = new Date(),
      providerEvidence = null,
      finalProductUnits = [],
      finalResult = null,
      sanitizedError
    },
    { session } = {}
  ) {
    const completed = completedAt == null ? null : new Date(completedAt)
    if (
      !mongoose.Types.ObjectId.isValid(resolutionId) ||
      !completed ||
      Number.isNaN(completed.getTime())
    ) {
      throw new ServiceError('Resolucion invalida', 'INVALID_ATTENTION_RESOLUTION', 400)
    }

    const errorSnapshot = {
      code: asText(sanitizedError?.code).slice(0, 100),
      message: asText(sanitizedError?.message).slice(0, 500)
    }
    const resolution = await this.resolutions.failPreparedResolution(
      resolutionId,
      {
        completedAt: completed,
        providerEvidence,
        finalProductUnits,
        finalResult,
        sanitizedError: errorSnapshot
      },
      { session }
    )

    if (!resolution) {
      throw new ServiceError(
        'La resolucion ya fue finalizada',
        'ATTENTION_RESOLUTION_STATE_CONFLICT',
        409
      )
    }

    return resolution
  }
}

export { OrderAttentionResolutionService }
export default new OrderAttentionResolutionService()
