import mongoose from 'mongoose'
import { log, error as logError, secureLog } from '../utils/logger.js'
import ProductUnitManager from '../dao/managers/productUnit.manager.js'
import OrderManager from '../dao/managers/order.manager.js'
import OrderItemManager from '../dao/managers/orderItem.manager.js'
import PaymentManager from '../dao/managers/payment.manager.js'
import ProductModel, { getEffectiveInventoryMode } from '../dao/models/produtc.model.js'
import { ServiceError } from './service.products.js'

const RESERVATION_DURATION_MS = 6 * 60 * 60 * 1000
const TRANSACTION_OPTIONS = {
  readConcern: { level: 'snapshot' },
  writeConcern: { w: 'majority' }
}

class ProductUnitService {
  #assertActiveExternalSession(session) {
    if (
      session &&
      (session.hasEnded ||
        typeof session.inTransaction !== 'function' ||
        !session.inTransaction())
    ) {
      throw new ServiceError(
        'La sesión externa debe tener una transacción activa',
        'EXTERNAL_TRANSACTION_REQUIRED',
        400
      )
    }
  }

  async #runInTransaction(operation, { session: externalSession } = {}) {
    this.#assertActiveExternalSession(externalSession)

    if (externalSession) return operation(externalSession)

    const ownedSession = await mongoose.startSession()
    let result

    try {
      await ownedSession.withTransaction(async () => {
        result = await operation(ownedSession)
      }, TRANSACTION_OPTIONS)

      return result
    } finally {
      await ownedSession.endSession()
    }
  }

  async #acquireProductInventoryGuard(productId, allowedModes, session) {
    const product = await ProductModel.findOneAndUpdate(
      {
        _id: productId,
        inventoryMode: { $in: allowedModes }
      },
      { $inc: { __v: 1 } },
      { new: true, session }
    ).lean()

    if (product) return product

    const productQuery = ProductModel.findById(productId).lean()
    productQuery.session(session)
    const existingProduct = await productQuery

    if (!existingProduct) {
      throw new ServiceError('Producto no encontrado', 'PRODUCT_NOT_FOUND', 404)
    }

    throw new ServiceError(
      'El modo de inventario del producto no permite esta operación',
      'PRODUCT_INVENTORY_MODE_CONFLICT',
      409,
      { inventoryMode: getEffectiveInventoryMode(existingProduct) }
    )
  }

  #isDuplicateKeyError(error) {
    return (
      error?.code === 11000 ||
      error?.writeErrors?.some?.((writeError) => writeError?.code === 11000) ||
      error?.errorResponse?.code === 11000
    )
  }

  #duplicateSerialError() {
    return new ServiceError(
      'El número de serie ya está registrado',
      'PRODUCT_UNIT_SERIAL_DUPLICATE',
      409
    )
  }

  normalizeSerial(serial) {
    return String(serial || '')
      .trim()
      .toUpperCase()
  }

  parseEntryDate(entryDate) {
    if (entryDate === undefined || entryDate === null || entryDate === '') {
      return undefined
    }

    if (typeof entryDate !== 'string') {
      throw new ServiceError('La fecha de ingreso es inválida', 'INVALID_ENTRY_DATE', 400)
    }

    const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(entryDate)

    if (!match) {
      throw new ServiceError('La fecha de ingreso es inválida', 'INVALID_ENTRY_DATE', 400)
    }

    const [year, month, day] = match.slice(1).map(Number)
    const parsed = new Date(Date.UTC(year, month - 1, day))

    if (
      parsed.getUTCFullYear() !== year ||
      parsed.getUTCMonth() !== month - 1 ||
      parsed.getUTCDate() !== day
    ) {
      throw new ServiceError('La fecha de ingreso es inválida', 'INVALID_ENTRY_DATE', 400)
    }

    return parsed
  }

  async recalculateProductStock(productId, { session } = {}) {
    try {
      log('🔄 ProductUnitService → recalculando stock del producto')

      if (!mongoose.Types.ObjectId.isValid(productId)) {
        throw new Error('ID de producto inválido')
      }

      const productQuery = ProductModel.findById(productId).lean()
      if (session) productQuery.session(session)

      const product = await productQuery

      if (!product) {
        throw new Error('Producto no encontrado')
      }

      if (getEffectiveInventoryMode(product) !== 'serialized') {
        throw new Error('El stock solo puede recalcularse desde ProductUnits para productos serializados')
      }

      const objectProductId = new mongoose.Types.ObjectId(productId)

      const summary = await ProductUnitManager.countByProductAndStatus(objectProductId, { session })

      const available = summary.find((item) => item._id === 'available')?.count || 0

      await ProductModel.findByIdAndUpdate(
        productId,
        {
          prodStock: available
        },
        { session }
      )

      secureLog('📦 ProductUnitService stock recalculado', {
        productId,
        available,
        summary
      })

      return {
        available,
        summary
      }
    } catch (error) {
      logError('❌ ProductUnitService recalculateProductStock error:', error)
      throw error
    }
  }

  async #reserveAvailableUnitsWithSession(
    {
      objectProductId,
      requestedQuantity,
      objectOrderId,
      objectOrderItemId,
      requestedReservationExpiresAt
    },
    session
  ) {
    const product = await ProductModel.findById(objectProductId).session(session).lean()

    if (!product) {
      throw new ServiceError('Producto no encontrado', 'PRODUCT_NOT_FOUND', 404)
    }

    if (getEffectiveInventoryMode(product) !== 'serialized') {
      throw new ServiceError(
        'El producto no utiliza inventario serializado',
        'PRODUCT_NOT_SERIALIZED',
        409
      )
    }

    const availableUnits = await ProductUnitManager.findAvailableUnits(
      objectProductId,
      requestedQuantity,
      { session }
    )

    if (availableUnits.length < requestedQuantity) {
      throw new ServiceError(
        'No hay suficientes unidades disponibles para completar la reserva',
        'INSUFFICIENT_SERIALIZED_STOCK',
        409,
        {
          requested: requestedQuantity,
          available: availableUnits.length
        }
      )
    }

    const unitIds = availableUnits.map((unit) => unit._id)
    const reservedAt = new Date()
    const reservationExpiresAt = requestedReservationExpiresAt
      ? new Date(requestedReservationExpiresAt)
      : new Date(reservedAt.getTime() + RESERVATION_DURATION_MS)

    if (reservationExpiresAt.getTime() <= reservedAt.getTime()) {
      throw new ServiceError(
        'La fecha de expiración de la reserva debe ser futura',
        'INVALID_RESERVATION_EXPIRATION',
        400
      )
    }

    const updateResult = await ProductUnitManager.reserveAvailableUnits(
      {
        unitIds,
        orderId: objectOrderId,
        orderItemId: objectOrderItemId,
        reservedAt,
        reservationExpiresAt
      },
      { session }
    )

    if (updateResult.modifiedCount !== requestedQuantity) {
      throw new ServiceError(
        'Las unidades seleccionadas dejaron de estar disponibles',
        'RESERVATION_CONFLICT',
        409
      )
    }

    await this.recalculateProductStock(objectProductId, { session })

    const reservedUnits = await ProductUnitManager.getByIds(unitIds, { session })

    return {
      units: reservedUnits,
      reservedCount: reservedUnits.length,
      reservedAt,
      reservationExpiresAt
    }
  }

  async reserveAvailableUnits(
    { productId, quantity, orderId, orderItemId, reservationExpiresAt },
    { session: externalSession } = {}
  ) {
    try {
      log('🔒 ProductUnitService → reservando unidades disponibles')

      if (!mongoose.Types.ObjectId.isValid(productId)) {
        throw new ServiceError('ID de producto inválido', 'INVALID_PRODUCT_ID', 400)
      }

      if (!mongoose.Types.ObjectId.isValid(orderId)) {
        throw new ServiceError('ID de orden inválido', 'INVALID_ORDER_ID', 400)
      }

      if (orderItemId && !mongoose.Types.ObjectId.isValid(orderItemId)) {
        throw new ServiceError('ID de ítem de orden inválido', 'INVALID_ORDER_ITEM_ID', 400)
      }

      const requestedQuantity = Number(quantity)

      if (!Number.isInteger(requestedQuantity) || requestedQuantity <= 0) {
        throw new ServiceError(
          'La cantidad a reservar debe ser un entero mayor que cero',
          'INVALID_RESERVATION_QUANTITY',
          400
        )
      }

      let requestedReservationExpiresAt = null

      if (reservationExpiresAt !== undefined && reservationExpiresAt !== null) {
        requestedReservationExpiresAt = new Date(reservationExpiresAt)

        if (Number.isNaN(requestedReservationExpiresAt.getTime())) {
          throw new ServiceError(
            'La fecha de expiración de la reserva es inválida',
            'INVALID_RESERVATION_EXPIRATION',
            400
          )
        }
      }

      const reservationInput = {
        objectProductId: new mongoose.Types.ObjectId(productId),
        requestedQuantity,
        objectOrderId: new mongoose.Types.ObjectId(orderId),
        objectOrderItemId: orderItemId ? new mongoose.Types.ObjectId(orderItemId) : null,
        requestedReservationExpiresAt
      }

      const reservationResult = await this.#runInTransaction(
        (session) => this.#reserveAvailableUnitsWithSession(reservationInput, session),
        { session: externalSession }
      )

      secureLog('✅ ProductUnitService reserva procesada', {
        productId,
        orderId,
        transactionOwner: externalSession ? 'caller' : 'service',
        reservedCount: reservationResult.reservedCount,
        reservationExpiresAt: reservationResult.reservationExpiresAt
      })

      return reservationResult
    } catch (error) {
      logError('❌ ProductUnitService reserveAvailableUnits error:', error)
      if (error instanceof ServiceError) throw error

      throw new ServiceError(
        'No se pudo completar la reserva de unidades',
        'RESERVE_PRODUCT_UNITS_FAILED',
        500,
        { cause: error?.message }
      )
    }
  }

  async releaseExpiredReservations(
    { now = new Date() } = {},
    { session: externalSession } = {}
  ) {
    try {
      log('♻️ ProductUnitService → liberando reservas vencidas')

      const expirationLimit = new Date(now)

      if (Number.isNaN(expirationLimit.getTime())) {
        throw new ServiceError('Fecha de expiración inválida', 'INVALID_EXPIRATION_DATE', 400)
      }

      const releaseResult = await this.#runInTransaction(
        async (session) => {
          const expiredUnits = await ProductUnitManager.findExpiredReservations(expirationLimit, {
            session
          })

          if (!expiredUnits.length) {
            return {
              units: [],
              releasedCount: 0,
              productIds: []
            }
          }

          const unitIds = expiredUnits.map((unit) => unit._id)
          const productIds = [...new Set(expiredUnits.map((unit) => String(unit.productId)))]

          const updateResult = await ProductUnitManager.releaseExpiredReservations(
            unitIds,
            expirationLimit,
            { session }
          )

          if (updateResult.modifiedCount !== unitIds.length) {
            throw new ServiceError(
              'Una o más reservas cambiaron mientras se intentaban liberar',
              'RESERVATION_RELEASE_CONFLICT',
              409
            )
          }

          for (const affectedProductId of productIds) {
            const product = await ProductModel.findById(affectedProductId).session(session).lean()

            if (product && getEffectiveInventoryMode(product) === 'serialized') {
              await this.recalculateProductStock(affectedProductId, { session })
            }
          }

          const releasedUnits = await ProductUnitManager.getByIds(unitIds, { session })

          return {
            units: releasedUnits,
            releasedCount: releasedUnits.length,
            productIds
          }
        },
        { session: externalSession }
      )

      secureLog('✅ ProductUnitService reservas vencidas liberadas', {
        releasedCount: releaseResult.releasedCount,
        productIds: releaseResult.productIds
      })

      return releaseResult
    } catch (error) {
      logError('❌ ProductUnitService releaseExpiredReservations error:', error)
      if (error instanceof ServiceError) throw error

      throw new ServiceError(
        'No se pudieron liberar las reservas vencidas',
        'RELEASE_EXPIRED_RESERVATIONS_FAILED',
        500,
        { cause: error?.message }
      )
    }
  }

  async inspectOrderReservation({ orderId } = {}, { session } = {}) {
    if (!mongoose.Types.ObjectId.isValid(orderId)) {
      throw new ServiceError('ID de orden inválido', 'INVALID_ORDER_ID', 400)
    }

    if (!session) {
      throw new ServiceError(
        'La inspección de reservas requiere una transacción activa',
        'EXTERNAL_TRANSACTION_REQUIRED',
        500
      )
    }

    this.#assertActiveExternalSession(session)

    const [orderItems, reservedUnits] = await Promise.all([
      OrderItemManager.getByOrderId(orderId, { session }),
      ProductUnitManager.findReservedUnitsByOrder(orderId, { session })
    ])
    const expectedByItem = new Map(
      orderItems.map((item) => [String(item._id), {
        quantity: Number(item.quantity),
        productId: String(item.productId)
      }])
    )
    const actualByItem = new Map()
    let reason = null

    if (!orderItems.length) reason = 'ORDER_ITEMS_MISSING'

    for (const unit of reservedUnits) {
      const itemId = String(unit.orderItemId || '')
      const expected = expectedByItem.get(itemId)

      if (
        !expected ||
        String(unit.orderId || '') !== String(orderId) ||
        String(unit.reservedByOrderId || '') !== String(orderId) ||
        String(unit.productId || '') !== expected.productId
      ) {
        reason = 'RESERVATION_REFERENCE_MISMATCH'
        break
      }

      actualByItem.set(itemId, (actualByItem.get(itemId) || 0) + 1)
    }

    if (!reason) {
      for (const [itemId, expected] of expectedByItem.entries()) {
        if (actualByItem.get(itemId) !== expected.quantity) {
          reason = 'RESERVATION_QUANTITY_MISMATCH'
          break
        }
      }
    }

    const expectedCount = orderItems.reduce((total, item) => total + Number(item.quantity), 0)
    if (!reason && reservedUnits.length !== expectedCount) {
      reason = 'RESERVATION_QUANTITY_MISMATCH'
    }

    return {
      valid: reason === null,
      reason,
      expectedCount,
      units: reservedUnits
    }
  }

  async confirmReservedUnitsSold(
    { orderId, paymentId, soldAt = new Date() } = {},
    { session } = {}
  ) {
    if (!mongoose.Types.ObjectId.isValid(orderId)) {
      throw new ServiceError('ID de orden inválido', 'INVALID_ORDER_ID', 400)
    }

    if (!mongoose.Types.ObjectId.isValid(paymentId)) {
      throw new ServiceError(
        'La venta requiere una confirmación de pago aprobada',
        'APPROVED_PAYMENT_REQUIRED',
        409
      )
    }

    if (!session) {
      throw new ServiceError(
        'La venta requiere una transacción interna activa',
        'EXTERNAL_TRANSACTION_REQUIRED',
        500
      )
    }

    this.#assertActiveExternalSession(session)
    const confirmedAt = new Date(soldAt)

    if (Number.isNaN(confirmedAt.getTime())) {
      throw new ServiceError('Fecha de venta inválida', 'INVALID_SOLD_DATE', 400)
    }

    const [payment, order] = await Promise.all([
      PaymentManager.getById(paymentId, { session }),
      OrderManager.getById(orderId, { session })
    ])

    if (
      !payment ||
      payment.provider !== 'mercado_pago' ||
      payment.normalizedStatus !== 'approved' ||
      String(payment.orderId) !== String(orderId)
    ) {
      throw new ServiceError(
        'La venta requiere un pago Mercado Pago aprobado para la misma orden',
        'APPROVED_PAYMENT_REQUIRED',
        409
      )
    }

    if (!order || order.status !== 'pending_payment') {
      throw new ServiceError(
        'La orden no está disponible para confirmar la venta',
        'ORDER_NOT_PENDING_PAYMENT',
        409
      )
    }

    const inspection = await this.inspectOrderReservation({ orderId }, { session })

    if (!inspection.valid) {
      throw new ServiceError(
        'La reserva serializada ya no es íntegra',
        'RESERVATION_INTEGRITY_CONFLICT',
        409,
        { reason: inspection.reason }
      )
    }

    const unitIds = inspection.units.map((unit) => unit._id)
    const updateResult = await ProductUnitManager.markReservedUnitsSold(
      unitIds,
      orderId,
      confirmedAt,
      { session }
    )

    if (updateResult.modifiedCount !== inspection.expectedCount) {
      throw new ServiceError(
        'Las reservas cambiaron durante la confirmación de venta',
        'RESERVATION_SALE_CONFLICT',
        409
      )
    }

    return {
      soldCount: updateResult.modifiedCount,
      soldAt: confirmedAt,
      unitIds: unitIds.map(String)
    }
  }

  async createUnit(
    {
      productId,
      serialNumber,
      entryDate,
      supplier,
      invoiceNumber,
      notes,
      userId
    },
    { session: externalSession } = {}
  ) {
    try {
      log('➕ ProductUnitService → creando unidad de producto')

      if (!mongoose.Types.ObjectId.isValid(productId)) {
        throw new ServiceError('ID de producto inválido', 'INVALID_PRODUCT_ID', 400)
      }

      const serial = this.normalizeSerial(serialNumber)
      const parsedEntryDate = this.parseEntryDate(entryDate)

      if (!serial) {
        throw new ServiceError(
          'El número de serie es obligatorio',
          'PRODUCT_UNIT_SERIAL_REQUIRED',
          400
        )
      }

      secureLog('🧾 ProductUnitService createUnit payload', {
        productId,
        serialNumber: serial,
        entryDate: parsedEntryDate || null,
        supplier,
        invoiceNumber,
        hasNotes: Boolean(notes),
        userId
      })

      const unit = await this.#runInTransaction(
        async (session) => {
          const product = await this.#acquireProductInventoryGuard(
            productId,
            ['serializing', 'serialized'],
            session
          )

          const exists = await ProductUnitManager.getBySerial(serial, { session })

          if (exists) throw this.#duplicateSerialError()

          const created = await ProductUnitManager.create(
            {
              productId,
              serialNumber: serial,
              status: 'available',
              ...(parsedEntryDate && { entryDate: parsedEntryDate }),
              supplier,
              invoiceNumber,
              notes,
              createdBy: userId
            },
            { session }
          )

          if (getEffectiveInventoryMode(product) === 'serialized') {
            await this.recalculateProductStock(productId, { session })
          }

          return created
        },
        { session: externalSession }
      )

      secureLog('✅ ProductUnitService unidad creada', {
        unitId: unit._id,
        productId,
        serialNumber: unit.serialNumber,
        status: unit.status
      })

      return unit
    } catch (error) {
      logError('❌ ProductUnitService createUnit error:', error)

      if (error instanceof ServiceError) throw error
      if (this.#isDuplicateKeyError(error)) throw this.#duplicateSerialError()

      throw new ServiceError(
        'No se pudo crear la unidad de producto',
        'CREATE_PRODUCT_UNIT_FAILED',
        500,
        { cause: error?.message }
      )
    }
  }

  async bulkCreateUnits(
    { productId, serialNumbers, entryDate, supplier, invoiceNumber, notes, userId },
    { session: externalSession } = {}
  ) {
    try {
      log('➕ ProductUnitService → creación masiva de unidades')

      if (!mongoose.Types.ObjectId.isValid(productId)) {
        throw new ServiceError('ID de producto inválido', 'INVALID_PRODUCT_ID', 400)
      }

      if (!Array.isArray(serialNumbers)) {
        throw new ServiceError(
          'serialNumbers debe ser un array',
          'INVALID_PRODUCT_UNIT_SERIALS',
          400
        )
      }

      const normalizedSerials = serialNumbers
        .map((serial) => this.normalizeSerial(serial))
        .filter(Boolean)
      const seenSerials = new Set()
      const repeatedSerials = new Set()

      for (const serial of normalizedSerials) {
        if (seenSerials.has(serial)) repeatedSerials.add(serial)
        seenSerials.add(serial)
      }

      if (repeatedSerials.size) {
        throw new ServiceError(
          `El lote contiene números de serie repetidos: ${[...repeatedSerials].join(', ')}`,
          'DUPLICATE_PRODUCT_UNIT_SERIALS_IN_PAYLOAD',
          400
        )
      }

      const cleanSerials = [...seenSerials]

      if (!cleanSerials.length) {
        throw new ServiceError(
          'Debe indicar al menos un número de serie válido',
          'PRODUCT_UNIT_SERIAL_REQUIRED',
          400
        )
      }

      const parsedEntryDate = this.parseEntryDate(entryDate)

      secureLog('🧾 ProductUnitService bulkCreate payload', {
        productId,
        requested: serialNumbers.length,
        normalized: cleanSerials.length,
        entryDate: parsedEntryDate || null,
        userId
      })

      const units = cleanSerials.map((serialNumber) => ({
        productId,
        serialNumber,
        status: 'available',
        ...(parsedEntryDate && { entryDate: parsedEntryDate }),
        supplier,
        invoiceNumber,
        notes,
        createdBy: userId
      }))

      const created = await this.#runInTransaction(
        async (session) => {
          const product = await this.#acquireProductInventoryGuard(
            productId,
            ['serializing', 'serialized'],
            session
          )
          const existing = await ProductUnitManager.getExistingSerials(cleanSerials, { session })

          if (existing.length) {
            const duplicated = existing.map((item) => item.serialNumber)

            secureLog('⚠️ ProductUnitService seriales duplicados detectados', {
              productId,
              duplicated
            })

            throw new ServiceError(
              `Ya existen estos números de serie: ${duplicated.join(', ')}`,
              'PRODUCT_UNIT_SERIAL_DUPLICATE',
              409
            )
          }

          const inserted = await ProductUnitManager.bulkCreate(units, { session })

          if (getEffectiveInventoryMode(product) === 'serialized') {
            await this.recalculateProductStock(productId, { session })
          }

          return inserted
        },
        { session: externalSession }
      )

      secureLog('✅ ProductUnitService unidades creadas masivamente', {
        productId,
        created: created.length,
        userId
      })

      return created
    } catch (error) {
      logError('❌ ProductUnitService bulkCreateUnits error:', error)

      if (error instanceof ServiceError) throw error
      if (this.#isDuplicateKeyError(error)) throw this.#duplicateSerialError()

      throw new ServiceError(
        'No se pudieron crear las unidades de producto',
        'BULK_CREATE_PRODUCT_UNITS_FAILED',
        500,
        { cause: error?.message }
      )
    }
  }

  async listByProduct(productId, filters = {}) {
    try {
      log('📋 ProductUnitService → listando unidades por producto')

      if (!mongoose.Types.ObjectId.isValid(productId)) {
        throw new Error('ID de producto inválido')
      }

      const product = await ProductModel.findById(productId).lean()

      if (!product) {
        throw new Error('Producto no encontrado')
      }

      secureLog('🔎 ProductUnitService list filters', {
        productId,
        status: filters.status || null,
        search: filters.search || null
      })

      const units = await ProductUnitManager.listByProduct(productId, filters)

      const summary = await ProductUnitManager.countByProductAndStatus(
        new mongoose.Types.ObjectId(productId)
      )

      secureLog('📦 ProductUnitService list result', {
        productId,
        totalUnits: units.length,
        summary
      })

      return {
        product: {
          _id: product._id,
          prodName: product.prodName,
          prodStock: product.prodStock
        },
        units,
        summary
      }
    } catch (error) {
      logError('❌ ProductUnitService listByProduct error:', error)
      throw error
    }
  }

  async updateStatus(
    { unitId, status, userId, notes },
    { session: externalSession } = {}
  ) {
    try {
      log('🔁 ProductUnitService → actualizando estado de unidad')

      if (!mongoose.Types.ObjectId.isValid(unitId)) {
        throw new ServiceError('ID de unidad inválido', 'INVALID_PRODUCT_UNIT_ID', 400)
      }

      const allowedStatus = ['available', 'inactive', 'warranty', 'returned']

      if (!allowedStatus.includes(status)) {
        if (status === 'reserved' || status === 'sold') {
          throw new ServiceError(
            `El estado ${status} sólo puede asignarse mediante operaciones internas`,
            'MANUAL_STATUS_TRANSITION_FORBIDDEN',
            409
          )
        }

        throw new ServiceError('Estado inválido', 'INVALID_PRODUCT_UNIT_STATUS', 400)
      }

      const result = await this.#runInTransaction(
        async (session) => {
          const unit = await ProductUnitManager.getById(unitId, { session })

          if (!unit) {
            throw new ServiceError('Unidad no encontrada', 'PRODUCT_UNIT_NOT_FOUND', 404)
          }

          await this.#acquireProductInventoryGuard(unit.productId, ['serialized'], session)

          if (unit.status === 'reserved') {
            throw new ServiceError(
              'Una unidad reservada sólo puede modificarse mediante operaciones internas',
              'RESERVED_STATE_MANAGED_INTERNALLY',
              409
            )
          }

          if (unit.status === 'sold' && status !== 'returned') {
            throw new ServiceError(
              'Una unidad vendida no puede modificarse manualmente',
              'SOLD_STATE_TRANSITION_FORBIDDEN',
              409
            )
          }

          secureLog('🧾 ProductUnitService updateStatus payload', {
            unitId,
            productId: unit.productId,
            previousStatus: unit.status,
            nextStatus: status,
            userId,
            hasNotes: Boolean(notes)
          })

          const updated = await ProductUnitManager.update(
            unitId,
            {
              status,
              notes: notes ?? unit.notes,
              updatedBy: userId,
              reservedByOrderId: null,
              reservedAt: null,
              reservationExpiresAt: null,
              ...(unit.status !== 'sold' && {
                orderId: null,
                orderItemId: null,
                soldByOrderId: null,
                soldAt: null
              })
            },
            { session, expectedStatus: unit.status }
          )

          if (!updated) {
            throw new ServiceError(
              'El estado de la unidad cambió durante la operación',
              'PRODUCT_UNIT_STATUS_CONFLICT',
              409
            )
          }

          await this.recalculateProductStock(unit.productId, { session })

          return { unit, updated }
        },
        { session: externalSession }
      )

      const { unit, updated } = result

      secureLog('✅ ProductUnitService estado actualizado', {
        unitId,
        productId: unit.productId,
        previousStatus: unit.status,
        nextStatus: updated.status
      })

      return updated
    } catch (error) {
      logError('❌ ProductUnitService updateStatus error:', error)

      if (error instanceof ServiceError) throw error

      throw new ServiceError(
        'No se pudo actualizar el estado de la unidad',
        'UPDATE_PRODUCT_UNIT_STATUS_FAILED',
        500,
        { cause: error?.message }
      )
    }
  }

  async deleteUnit(unitId, userId, { session: externalSession } = {}) {
    try {
      log('🗑️ ProductUnitService → baja lógica de unidad')

      if (!mongoose.Types.ObjectId.isValid(unitId)) {
        throw new ServiceError('ID de unidad inválido', 'INVALID_PRODUCT_UNIT_ID', 400)
      }

      const result = await this.#runInTransaction(
        async (session) => {
          const unit = await ProductUnitManager.getById(unitId, { session })

          if (!unit) {
            throw new ServiceError('Unidad no encontrada', 'PRODUCT_UNIT_NOT_FOUND', 404)
          }

          const product = await this.#acquireProductInventoryGuard(
            unit.productId,
            ['serializing', 'serialized'],
            session
          )
          const inventoryMode = getEffectiveInventoryMode(product)

          if (unit.status === 'sold') {
            throw new ServiceError(
              'No se puede eliminar una unidad vendida',
              'SOLD_PRODUCT_UNIT_DELETE_FORBIDDEN',
              409
            )
          }

          if (unit.status === 'reserved') {
            throw new ServiceError(
              'No se puede eliminar una unidad reservada',
              'RESERVED_PRODUCT_UNIT_DELETE_FORBIDDEN',
              409
            )
          }

          secureLog('🧾 ProductUnitService deleteUnit payload', {
            unitId,
            productId: unit.productId,
            serialNumber: unit.serialNumber,
            status: unit.status,
            userId
          })

          const deleted = await ProductUnitManager.softDelete(unitId, userId, {
            session,
            expectedStatus: unit.status
          })

          if (!deleted) {
            throw new ServiceError(
              'La unidad cambió durante la operación y no pudo eliminarse',
              'PRODUCT_UNIT_DELETE_CONFLICT',
              409
            )
          }

          if (inventoryMode === 'serialized') {
            await this.recalculateProductStock(unit.productId, { session })
          }

          return { unit, deleted }
        },
        { session: externalSession }
      )

      const { unit, deleted } = result

      secureLog('✅ ProductUnitService unidad eliminada lógicamente', {
        unitId,
        productId: unit.productId,
        userId
      })

      return deleted
    } catch (error) {
      logError('❌ ProductUnitService deleteUnit error:', error)

      if (error instanceof ServiceError) throw error

      throw new ServiceError(
        'No se pudo eliminar la unidad',
        'DELETE_PRODUCT_UNIT_FAILED',
        500,
        { cause: error?.message }
      )
    }
  }
}

export default new ProductUnitService()
