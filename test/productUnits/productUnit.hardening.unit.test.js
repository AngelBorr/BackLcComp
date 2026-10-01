/* eslint-env mocha */
import assert from 'node:assert/strict'
import mongoose from 'mongoose'
import ProductUnitManager from '../../src/dao/managers/productUnit.manager.js'
import ProductModel from '../../src/dao/models/produtc.model.js'
import ProductUnitModel from '../../src/dao/models/productUnit.model.js'
import ProductUnitService from '../../src/services/productUnit.service.js'
import ProductsService from '../../src/services/service.products.js'
import FileService from '../../src/services/service.files.js'

const productId = new mongoose.Types.ObjectId().toString()
const unitId = new mongoose.Types.ObjectId().toString()
const userId = new mongoose.Types.ObjectId().toString()
const orderId = new mongoose.Types.ObjectId().toString()

const queryResult = (value) => ({
  session() {
    return this
  },
  lean: async () => value
})

const createSession = () => {
  let active = false

  return {
    hasEnded: false,
    committed: false,
    aborted: false,
    ended: false,
    transactionOptions: null,
    inTransaction: () => active,
    async withTransaction(callback, options) {
      this.transactionOptions = options
      active = true

      try {
        await callback()
        this.committed = true
      } catch (error) {
        this.aborted = true
        throw error
      } finally {
        active = false
      }
    },
    async endSession() {
      this.hasEnded = true
      this.ended = true
    }
  }
}

const createExternalSession = () => ({
  hasEnded: false,
  inTransaction: () => true
})

describe('ProductUnits transactional hardening (isolated unit tests)', () => {
  const restorations = []

  const stub = (target, property, replacement) => {
    const original = target[property]
    restorations.push(() => {
      target[property] = original
    })
    target[property] = replacement
  }

  afterEach(() => {
    while (restorations.length) restorations.pop()()
  })

  it('creates one unit and recalculates stock with the same owned transaction', async () => {
    const session = createSession()
    let createSessionReceived
    let recalculateSessionReceived

    stub(mongoose, 'startSession', async () => session)
    stub(ProductModel, 'findOneAndUpdate', () => queryResult({
      _id: productId,
      inventoryMode: 'serialized'
    }))
    stub(ProductUnitManager, 'getBySerial', async () => null)
    stub(ProductUnitManager, 'create', async (data, options) => {
      createSessionReceived = options.session
      return { _id: unitId, ...data }
    })
    stub(ProductUnitService, 'recalculateProductStock', async (id, options) => {
      assert.equal(id, productId)
      recalculateSessionReceived = options.session
      return { available: 1, summary: [] }
    })

    const unit = await ProductUnitService.createUnit({
      productId,
      serialNumber: ' serial-1 ',
      userId
    })

    assert.equal(unit.serialNumber, 'SERIAL-1')
    assert.equal(createSessionReceived, session)
    assert.equal(recalculateSessionReceived, session)
    assert.equal(session.committed, true)
    assert.equal(session.ended, true)
    assert.deepEqual(session.transactionOptions, {
      readConcern: { level: 'snapshot' },
      writeConcern: { w: 'majority' }
    })
  })

  it('aborts create when stock recalculation fails', async () => {
    const session = createSession()

    stub(mongoose, 'startSession', async () => session)
    stub(ProductModel, 'findOneAndUpdate', () => queryResult({
      _id: productId,
      inventoryMode: 'serialized'
    }))
    stub(ProductUnitManager, 'getBySerial', async () => null)
    stub(ProductUnitManager, 'create', async (data) => ({ _id: unitId, ...data }))
    stub(ProductUnitService, 'recalculateProductStock', async () => {
      throw new Error('simulated stock failure')
    })

    await assert.rejects(
      ProductUnitService.createUnit({ productId, serialNumber: 'SERIAL-2', userId }),
      (error) => error.code === 'CREATE_PRODUCT_UNIT_FAILED'
    )

    assert.equal(session.aborted, true)
    assert.equal(session.committed, false)
    assert.equal(session.ended, true)
  })

  it('lets the unique serial authority accept only one concurrent create', async () => {
    let serialClaimed = false

    stub(mongoose, 'startSession', async () => createSession())
    stub(ProductModel, 'findOneAndUpdate', () => queryResult({
      _id: productId,
      inventoryMode: 'serialized'
    }))
    stub(ProductUnitManager, 'getBySerial', async () => null)
    stub(ProductUnitManager, 'create', async (data) => {
      if (serialClaimed) {
        const error = new Error('duplicate key details')
        error.code = 11000
        throw error
      }

      serialClaimed = true
      return { _id: unitId, ...data }
    })
    stub(ProductUnitService, 'recalculateProductStock', async () => ({
      available: 1,
      summary: []
    }))

    const results = await Promise.allSettled([
      ProductUnitService.createUnit({ productId, serialNumber: 'SAME-SERIAL', userId }),
      ProductUnitService.createUnit({ productId, serialNumber: 'SAME-SERIAL', userId })
    ])

    assert.equal(results.filter((result) => result.status === 'fulfilled').length, 1)
    assert.equal(results.filter((result) => result.status === 'rejected').length, 1)
    assert.equal(
      results.find((result) => result.status === 'rejected').reason.code,
      'PRODUCT_UNIT_SERIAL_DUPLICATE'
    )
  })

  it('rejects duplicate serials inside a bulk payload before persistence', async () => {
    let bulkCalled = false

    stub(ProductUnitManager, 'bulkCreate', async () => {
      bulkCalled = true
      return []
    })

    await assert.rejects(
      ProductUnitService.bulkCreateUnits({
        productId,
        serialNumbers: ['DUP-1', ' dup-1 '],
        userId
      }),
      (error) => error.code === 'DUPLICATE_PRODUCT_UNIT_SERIALS_IN_PAYLOAD'
    )

    assert.equal(bulkCalled, false)
  })

  it('aborts the complete bulk operation when insertMany fails', async () => {
    const session = createSession()

    stub(mongoose, 'startSession', async () => session)
    stub(ProductModel, 'findOneAndUpdate', () => queryResult({
      _id: productId,
      inventoryMode: 'serialized'
    }))
    stub(ProductUnitManager, 'getExistingSerials', async () => [])
    stub(ProductUnitManager, 'bulkCreate', async () => {
      const error = new Error('duplicate key details')
      error.code = 11000
      throw error
    })

    await assert.rejects(
      ProductUnitService.bulkCreateUnits({
        productId,
        serialNumbers: ['BULK-1', 'BULK-2'],
        userId
      }),
      (error) =>
        error.code === 'PRODUCT_UNIT_SERIAL_DUPLICATE' &&
        error.message === 'El número de serie ya está registrado'
    )

    assert.equal(session.aborted, true)
    assert.equal(session.ended, true)
  })

  it('rolls back the bulk transaction on a non-duplicate intermediate write error', async () => {
    const session = createSession()

    stub(mongoose, 'startSession', async () => session)
    stub(ProductModel, 'findOneAndUpdate', () => queryResult({
      _id: productId,
      inventoryMode: 'serialized'
    }))
    stub(ProductUnitManager, 'getExistingSerials', async () => [])
    stub(ProductUnitManager, 'bulkCreate', async () => {
      throw new Error('simulated intermediate write failure')
    })

    await assert.rejects(
      ProductUnitService.bulkCreateUnits({
        productId,
        serialNumbers: ['BULK-3', 'BULK-4', 'BULK-5'],
        userId
      }),
      (error) => error.code === 'BULK_CREATE_PRODUCT_UNITS_FAILED'
    )

    assert.equal(session.aborted, true)
    assert.equal(session.committed, false)
  })

  it('detects a status race through compare-and-set', async () => {
    const session = createExternalSession()
    let recalculated = false

    stub(ProductUnitManager, 'getById', async () => ({
      _id: unitId,
      productId,
      status: 'available',
      notes: ''
    }))
    stub(ProductModel, 'findOneAndUpdate', () => queryResult({
      _id: productId,
      inventoryMode: 'serialized'
    }))
    stub(ProductUnitManager, 'update', async () => null)
    stub(ProductUnitService, 'recalculateProductStock', async () => {
      recalculated = true
    })

    await assert.rejects(
      ProductUnitService.updateStatus(
        { unitId, status: 'inactive', userId },
        { session }
      ),
      (error) => error.code === 'PRODUCT_UNIT_STATUS_CONFLICT'
    )

    assert.equal(recalculated, false)
  })

  it('updates status and stock atomically with the expected current status', async () => {
    const session = createSession()
    let updateOptions
    let recalculateSession

    stub(mongoose, 'startSession', async () => session)
    stub(ProductUnitManager, 'getById', async () => ({
      _id: unitId,
      productId,
      status: 'available',
      notes: ''
    }))
    stub(ProductModel, 'findOneAndUpdate', () => queryResult({
      _id: productId,
      inventoryMode: 'serialized'
    }))
    stub(ProductUnitManager, 'update', async (id, data, options) => {
      updateOptions = options
      return { _id: id, ...data }
    })
    stub(ProductUnitService, 'recalculateProductStock', async (id, options) => {
      recalculateSession = options.session
      return { available: 0, summary: [] }
    })

    const updated = await ProductUnitService.updateStatus({
      unitId,
      status: 'inactive',
      userId
    })

    assert.equal(updated.status, 'inactive')
    assert.equal(updateOptions.expectedStatus, 'available')
    assert.equal(updateOptions.session, session)
    assert.equal(recalculateSession, session)
    assert.equal(session.committed, true)
  })

  it('does not delete a unit that became reserved or was concurrently deleted', async () => {
    const session = createExternalSession()

    stub(ProductUnitManager, 'getById', async () => ({
      _id: unitId,
      productId,
      serialNumber: 'RACE-1',
      status: 'available'
    }))
    stub(ProductModel, 'findOneAndUpdate', () => queryResult({
      _id: productId,
      inventoryMode: 'serialized'
    }))
    stub(ProductUnitManager, 'softDelete', async () => null)

    await assert.rejects(
      ProductUnitService.deleteUnit(unitId, userId, { session }),
      (error) => error.code === 'PRODUCT_UNIT_DELETE_CONFLICT'
    )
  })

  it('allows only one of two concurrent finishSerialization attempts to win', async () => {
    const productsService = new ProductsService()
    let guardClaimed = false
    let inventoryMode = 'serializing'

    stub(mongoose, 'startSession', async () => createSession())
    stub(ProductUnitManager, 'countByProductAndStatus', async () => [
      { _id: 'available', count: 3 }
    ])
    stub(ProductModel, 'findById', () => queryResult({ _id: productId, inventoryMode }))
    stub(ProductModel, 'findOneAndUpdate', (filter, update) => {
      if (update.$inc) {
        if (guardClaimed) return queryResult(null)
        guardClaimed = true
        return queryResult({ _id: productId, inventoryMode: 'serializing', prodStock: 8 })
      }

      inventoryMode = 'serialized'
      return queryResult({ _id: productId, inventoryMode, prodStock: 3 })
    })

    const results = await Promise.allSettled([
      productsService.finishSerialization(productId),
      productsService.finishSerialization(productId)
    ])

    assert.equal(results.filter((result) => result.status === 'fulfilled').length, 1)
    assert.equal(results.filter((result) => result.status === 'rejected').length, 1)
    assert.equal(
      results.find((result) => result.status === 'rejected').reason.code,
      'INVENTORY_MODE_TRANSITION_CONFLICT'
    )
  })

  it('retries the create outcome as serialized when finishSerialization wins the guard', async () => {
    const productsService = new ProductsService()
    let resolveFinishCommit
    const finishCommitted = new Promise((resolve) => {
      resolveFinishCommit = resolve
    })
    let stockRecalculated = false

    stub(mongoose, 'startSession', async () => createSession())
    stub(ProductUnitManager, 'countByProductAndStatus', async () => [])
    stub(ProductUnitManager, 'getBySerial', async () => null)
    stub(ProductUnitManager, 'create', async (data) => ({ _id: unitId, ...data }))
    stub(ProductUnitService, 'recalculateProductStock', async () => {
      stockRecalculated = true
      return { available: 1, summary: [] }
    })
    stub(ProductModel, 'findOneAndUpdate', (filter, update) => {
      if (filter.inventoryMode === 'serializing' && update.$inc) {
        return queryResult({ _id: productId, inventoryMode: 'serializing', prodStock: 4 })
      }

      if (update.$set?.inventoryMode === 'serialized') {
        resolveFinishCommit()
        return queryResult({ _id: productId, inventoryMode: 'serialized', prodStock: 0 })
      }

      return {
        lean: async () => {
          await finishCommitted
          return { _id: productId, inventoryMode: 'serialized', prodStock: 0 }
        }
      }
    })

    const [finishResult, createdUnit] = await Promise.all([
      productsService.finishSerialization(productId),
      ProductUnitService.createUnit({ productId, serialNumber: 'AFTER-FINISH', userId })
    ])

    assert.equal(finishResult.inventoryMode, 'serialized')
    assert.equal(createdUnit.serialNumber, 'AFTER-FINISH')
    assert.equal(stockRecalculated, true)
  })

  it('uses the Product write guard for create, bulk and delete mutations', async () => {
    const session = createExternalSession()
    const guardCalls = []

    stub(ProductModel, 'findOneAndUpdate', (filter, update, options) => {
      guardCalls.push({ filter, update, options })
      return queryResult({ _id: productId, inventoryMode: 'serialized' })
    })
    stub(ProductUnitManager, 'getBySerial', async () => null)
    stub(ProductUnitManager, 'create', async (data) => ({ _id: unitId, ...data }))
    stub(ProductUnitManager, 'getExistingSerials', async () => [])
    stub(ProductUnitManager, 'bulkCreate', async (units) => units)
    stub(ProductUnitManager, 'getById', async () => ({
      _id: unitId,
      productId,
      serialNumber: 'GUARD-DELETE',
      status: 'available'
    }))
    stub(ProductUnitManager, 'softDelete', async () => ({ _id: unitId, isDeleted: true }))
    stub(ProductUnitService, 'recalculateProductStock', async () => ({
      available: 0,
      summary: []
    }))

    await ProductUnitService.createUnit(
      { productId, serialNumber: 'GUARD-CREATE', userId },
      { session }
    )
    await ProductUnitService.bulkCreateUnits(
      { productId, serialNumbers: ['GUARD-BULK'], userId },
      { session }
    )
    await ProductUnitService.deleteUnit(unitId, userId, { session })

    assert.equal(guardCalls.length, 3)
    assert.ok(guardCalls.every((call) => call.update.$inc.__v === 1))
    assert.ok(guardCalls.every((call) => call.options.session === session))
  })

  it('blocks hard delete when any ProductUnit exists before deleting images', async () => {
    const productsService = new ProductsService()
    let productDeleted = false
    let imageDeleted = false

    stub(mongoose, 'startSession', async () => createSession())
    stub(ProductModel, 'findOneAndUpdate', () => queryResult({
      _id: productId,
      prodImgs: [{ fileId: new mongoose.Types.ObjectId() }]
    }))
    stub(ProductUnitManager, 'existsByProduct', async () => ({ _id: unitId }))
    stub(ProductModel, 'deleteOne', async () => {
      productDeleted = true
      return { deletedCount: 1 }
    })
    stub(FileService, 'deleteFileById', async () => {
      imageDeleted = true
    })

    await assert.rejects(
      productsService.deleteProduct(productId, { deleteImages: true }),
      (error) => error.code === 'PRODUCT_HAS_PRODUCT_UNITS'
    )

    assert.equal(productDeleted, false)
    assert.equal(imageDeleted, false)
  })

  it('checks hard-delete references without excluding soft-deleted ProductUnits', async () => {
    const session = createExternalSession()
    let capturedFilter

    stub(ProductUnitModel, 'exists', (filter) => {
      capturedFilter = filter
      return queryResult({ _id: unitId })
    })

    await ProductUnitManager.existsByProduct(productId, { session })

    assert.deepEqual(capturedFilter, { productId })
    assert.equal(Object.hasOwn(capturedFilter, 'isDeleted'), false)
  })

  it('preserves reservation and expired-release behavior with external sessions', async () => {
    const reservationSession = createExternalSession()
    const releaseSession = createExternalSession()
    const reservedUnitIds = [new mongoose.Types.ObjectId(), new mongoose.Types.ObjectId()]
    const sessionsSeen = []
    const sharedExpiration = new Date(Date.now() + 6 * 60 * 60 * 1000)
    let reservationWrite

    stub(ProductModel, 'findById', () => ({
      session(session) {
        sessionsSeen.push(session)
        return this
      },
      lean: async () => ({ _id: productId, inventoryMode: 'serialized' })
    }))
    stub(ProductUnitManager, 'findAvailableUnits', async (id, quantity, options) => {
      sessionsSeen.push(options.session)
      return reservedUnitIds.map((_id) => ({ _id }))
    })
    stub(ProductUnitManager, 'reserveAvailableUnits', async (data, options) => {
      sessionsSeen.push(options.session)
      reservationWrite = data
      return { modifiedCount: data.unitIds.length }
    })
    stub(ProductUnitManager, 'getByIds', async (ids, options) => {
      sessionsSeen.push(options.session)
      return ids.map((_id) => ({ _id, status: 'reserved' }))
    })
    stub(ProductUnitService, 'recalculateProductStock', async (id, options) => {
      sessionsSeen.push(options.session)
      return { available: 0, summary: [] }
    })

    const reservation = await ProductUnitService.reserveAvailableUnits(
      { productId, quantity: 2, orderId, reservationExpiresAt: sharedExpiration },
      { session: reservationSession }
    )

    assert.equal(reservation.reservedCount, 2)
    assert.equal(reservation.reservationExpiresAt.toISOString(), sharedExpiration.toISOString())
    assert.equal(reservationWrite.reservationExpiresAt.toISOString(), sharedExpiration.toISOString())
    assert.ok(sessionsSeen.every((session) => session === reservationSession))

    stub(ProductUnitManager, 'findExpiredReservations', async (now, options) => {
      assert.equal(options.session, releaseSession)
      return []
    })

    const release = await ProductUnitService.releaseExpiredReservations(
      { now: new Date() },
      { session: releaseSession }
    )

    assert.deepEqual(release, { units: [], releasedCount: 0, productIds: [] })
  })
})
