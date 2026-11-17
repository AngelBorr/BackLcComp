/* eslint-env mocha */
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import mongoose from 'mongoose'
import ProductUnitManager from '../../src/dao/managers/productUnit.manager.js'
import ProductUnitModel from '../../src/dao/models/productUnit.model.js'
import ProductModel from '../../src/dao/models/produtc.model.js'
import ProductUnitService from '../../src/services/productUnit.service.js'
import {
  OrderInventoryRepairWriterService
} from '../../src/services/orderInventoryRepairWriter.service.js'

const ids = Object.freeze({
  order: '507f1f77bcf86cd799439001',
  itemA: '507f1f77bcf86cd799439011',
  itemB: '507f1f77bcf86cd799439012',
  productA: '507f1f77bcf86cd799439021',
  productB: '507f1f77bcf86cd799439022',
  preserveA: '507f1f77bcf86cd799439031',
  reclaimA: '507f1f77bcf86cd799439032',
  replacementA: '507f1f77bcf86cd799439033',
  alreadyA: '507f1f77bcf86cd799439034',
  deficitA: '507f1f77bcf86cd799439035',
  extraA: '507f1f77bcf86cd799439036',
  replacementB: '507f1f77bcf86cd799439037',
  deficitB: '507f1f77bcf86cd799439038'
})

const dates = Object.freeze({
  reservedAt: new Date('2026-11-01T10:00:00.000Z'),
  reservationExpiresAt: new Date('2026-11-01T16:00:00.000Z'),
  alreadySoldAt: new Date('2026-11-01T11:00:00.000Z'),
  repairAt: new Date('2026-11-02T12:00:00.000Z'),
  candidateCreatedAt: new Date('2026-10-01T10:00:00.000Z')
})

const activeSession = () => ({ hasEnded: false, inTransaction: () => true })
const objectId = (value) => new mongoose.Types.ObjectId(value)
const asId = (value) => String(value).toLowerCase()

const deferred = () => {
  let resolveGate
  const promise = new Promise((resolve) => {
    resolveGate = resolve
  })
  return { promise, resolve: resolveGate }
}

const availableUnit = ({
  id,
  productId = ids.productA,
  serialNumber = `SERIAL-${id.slice(-2).toUpperCase()}`,
  createdAt = dates.candidateCreatedAt
}) => ({
  _id: id,
  productId,
  serialNumber,
  status: 'available',
  isDeleted: false,
  orderId: null,
  orderItemId: null,
  reservedByOrderId: null,
  reservedAt: null,
  reservationExpiresAt: null,
  soldByOrderId: null,
  soldAt: null,
  createdAt
})

const reservedUnit = ({
  id = ids.preserveA,
  itemId = ids.itemA,
  productId = ids.productA
} = {}) => ({
  _id: id,
  productId,
  serialNumber: `SERIAL-${id.slice(-2).toUpperCase()}`,
  status: 'reserved',
  isDeleted: false,
  orderId: ids.order,
  orderItemId: itemId,
  reservedByOrderId: ids.order,
  reservedAt: dates.reservedAt,
  reservationExpiresAt: dates.reservationExpiresAt,
  soldByOrderId: null,
  soldAt: null,
  createdAt: dates.candidateCreatedAt
})

const soldUnit = ({
  id,
  itemId = ids.itemA,
  productId = ids.productA,
  reservedByOrderId = null,
  reservedAt = null,
  reservationExpiresAt = null,
  soldAt = dates.alreadySoldAt
}) => ({
  _id: id,
  productId,
  serialNumber: `SERIAL-${id.slice(-2).toUpperCase()}`,
  status: 'sold',
  isDeleted: false,
  orderId: ids.order,
  orderItemId: itemId,
  reservedByOrderId,
  reservedAt,
  reservationExpiresAt,
  soldByOrderId: ids.order,
  soldAt,
  createdAt: dates.candidateCreatedAt
})

const fixture = () => {
  const preserve = reservedUnit()
  const reclaim = availableUnit({ id: ids.reclaimA })
  const replacement = availableUnit({ id: ids.replacementA })
  const already = soldUnit({ id: ids.alreadyA })
  const deficit = {
    ...availableUnit({ id: ids.deficitA }),
    status: 'inactive'
  }
  const planItem = {
    orderItemId: ids.itemA,
    productId: ids.productA,
    quantity: 4,
    preserveReserved: [{ productUnitId: ids.preserveA }],
    alreadySold: [{ productUnitId: ids.alreadyA }],
    reclaimAvailableOriginals: [{ productUnitId: ids.reclaimA }],
    replaceableDeficitOriginals: [{ productUnitId: ids.deficitA }],
    replacementCount: 1,
    blocked: []
  }
  const input = {
    order: {
      _id: ids.order,
      status: 'requires_attention',
      reservationExpiresAt: dates.reservationExpiresAt
    },
    authoritativeInputs: {
      orderItems: [{
        _id: ids.itemA,
        orderId: ids.order,
        productId: ids.productA,
        quantity: 4
      }],
      originalProductUnits: [preserve, reclaim, already, deficit]
    },
    plan: {
      outcome: 'PLAN_READY',
      repairable: true,
      orderId: ids.order,
      items: [planItem],
      replacementCount: 1,
      blocked: []
    },
    selection: {
      orderId: ids.order,
      byOrderItem: [{
        orderItemId: ids.itemA,
        productId: ids.productA,
        reclaimUnitIds: [ids.reclaimA],
        newReplacementCandidates: [replacement],
        newReplacementCandidateIds: [ids.replacementA],
        replacementCount: 1
      }],
      selectedNewProductUnitIds: [ids.replacementA]
    },
    repairAt: dates.repairAt
  }

  const actualUnits = [
    soldUnit({
      id: ids.preserveA,
      reservedByOrderId: ids.order,
      reservedAt: dates.reservedAt,
      reservationExpiresAt: dates.reservationExpiresAt,
      soldAt: dates.repairAt
    }),
    soldUnit({
      id: ids.reclaimA,
      reservedByOrderId: ids.order,
      reservedAt: dates.repairAt,
      reservationExpiresAt: dates.reservationExpiresAt,
      soldAt: dates.repairAt
    }),
    soldUnit({
      id: ids.replacementA,
      reservedByOrderId: ids.order,
      reservedAt: dates.repairAt,
      reservationExpiresAt: dates.reservationExpiresAt,
      soldAt: dates.repairAt
    }),
    soldUnit({ id: ids.alreadyA })
  ]

  return { input, actualUnits }
}

const alreadySoldOnlyFixture = () => {
  const already = soldUnit({ id: ids.alreadyA })
  return {
    input: {
      order: { _id: ids.order, reservationExpiresAt: dates.reservationExpiresAt },
      authoritativeInputs: {
        orderItems: [{
          _id: ids.itemA,
          orderId: ids.order,
          productId: ids.productA,
          quantity: 1
        }],
        originalProductUnits: [already]
      },
      plan: {
        outcome: 'PLAN_READY',
        repairable: true,
        orderId: ids.order,
        items: [{
          orderItemId: ids.itemA,
          productId: ids.productA,
          quantity: 1,
          preserveReserved: [],
          alreadySold: [{ productUnitId: ids.alreadyA }],
          reclaimAvailableOriginals: [],
          replaceableDeficitOriginals: [],
          replacementCount: 0,
          blocked: []
        }],
        replacementCount: 0,
        blocked: []
      },
      selection: {
        orderId: ids.order,
        byOrderItem: [{
          orderItemId: ids.itemA,
          productId: ids.productA,
          reclaimUnitIds: [],
          newReplacementCandidates: [],
          newReplacementCandidateIds: [],
          replacementCount: 0
        }],
        selectedNewProductUnitIds: []
      },
      repairAt: dates.repairAt
    },
    actualUnits: [already]
  }
}

const addSecondProductReplacement = (data) => {
  const replacement = availableUnit({
    id: ids.replacementB,
    productId: ids.productB
  })
  data.input.authoritativeInputs.orderItems.push({
    _id: ids.itemB,
    orderId: ids.order,
    productId: ids.productB,
    quantity: 1
  })
  data.input.authoritativeInputs.originalProductUnits.push({
    ...availableUnit({ id: ids.deficitB, productId: ids.productB }),
    status: 'inactive'
  })
  data.input.plan.items.push({
    orderItemId: ids.itemB,
    productId: ids.productB,
    quantity: 1,
    preserveReserved: [],
    alreadySold: [],
    reclaimAvailableOriginals: [],
    replaceableDeficitOriginals: [{ productUnitId: ids.deficitB }],
    replacementCount: 1,
    blocked: []
  })
  data.input.plan.replacementCount = 2
  data.input.selection.byOrderItem.push({
    orderItemId: ids.itemB,
    productId: ids.productB,
    reclaimUnitIds: [],
    newReplacementCandidates: [replacement],
    newReplacementCandidateIds: [ids.replacementB],
    replacementCount: 1
  })
  data.input.selection.selectedNewProductUnitIds.push(ids.replacementB)

  return [soldUnit({
    id: ids.replacementB,
    itemId: ids.itemB,
    productId: ids.productB,
    reservedByOrderId: ids.order,
    reservedAt: dates.repairAt,
    reservationExpiresAt: dates.reservationExpiresAt,
    soldAt: dates.repairAt
  })]
}

const makeWriter = ({ input, actualUnits }, overrides = {}) => {
  const calls = []
  const manager = {
    async markExactReservedUnitsSoldForRepair(data, options) {
      calls.push({ type: 'reserved', data, options })
      if (overrides.reserved) return overrides.reserved(data, options)
      return { matchedCount: data.units.length, modifiedCount: data.units.length }
    },
    async markExactAvailableUnitsSoldForRepair(data, options) {
      calls.push({ type: 'available', data, options })
      if (overrides.available) return overrides.available(data, options)
      return { matchedCount: data.unitIds.length, modifiedCount: data.unitIds.length }
    },
    async getSoldUnitsForOrderItem(data, options) {
      calls.push({ type: 'read', data, options })
      if (overrides.read) return overrides.read(data, options)
      return actualUnits
    }
  }
  const productUnitService = {
    async acquireInventoryRepairGuards(productIds, options) {
      calls.push({ type: 'guards', productIds, options })
      if (overrides.guards) return overrides.guards(productIds, options)
      return productIds
    },
    async recalculateProductStock(productId, options) {
      calls.push({ type: 'stock', productId, options })
      if (overrides.stock) return overrides.stock(productId, options)
      return { available: 0 }
    }
  }

  return {
    calls,
    input,
    writer: new OrderInventoryRepairWriterService({
      productUnitManager: manager,
      productUnitService
    })
  }
}

const deepFreeze = (value) => {
  if (!value || typeof value !== 'object' || Object.isFrozen(value)) return value
  for (const child of Object.values(value)) deepFreeze(child)
  return Object.freeze(value)
}

const queryResult = (documents, capture) => ({
  sort(value) {
    capture.sort = value
    return this
  },
  session(value) {
    capture.session = value
    return this
  },
  lean() {
    capture.lean = true
    return this
  },
  then(resolve, reject) {
    return Promise.resolve(documents).then(resolve, reject)
  }
})

describe('P1C-B0B F2C inventory repair writer', () => {
  let originalUpdateMany
  let originalBulkWrite
  let originalFind
  let originalProductFindOneAndUpdate
  let originalProductFindById

  beforeEach(() => {
    originalUpdateMany = ProductUnitModel.updateMany
    originalBulkWrite = ProductUnitModel.bulkWrite
    originalFind = ProductUnitModel.find
    originalProductFindOneAndUpdate = ProductModel.findOneAndUpdate
    originalProductFindById = ProductModel.findById
  })

  afterEach(() => {
    ProductUnitModel.updateMany = originalUpdateMany
    ProductUnitModel.bulkWrite = originalBulkWrite
    ProductUnitModel.find = originalFind
    ProductModel.findOneAndUpdate = originalProductFindOneAndUpdate
    ProductModel.findById = originalProductFindById
  })

  for (const [label, session] of [
    ['missing', undefined],
    ['ended', { hasEnded: true, inTransaction: () => true }],
    ['inactive', { hasEnded: false, inTransaction: () => false }],
    ['invalid', { hasEnded: false, inTransaction: () => { throw new Error('invalid') } }]
  ]) {
    it(`rejects a ${label} transaction before any operation`, async () => {
      const setup = makeWriter(fixture())
      await assert.rejects(
        setup.writer.writeRepair(setup.input, { session }),
        (error) => error.code === 'INVENTORY_REPAIR_TRANSACTION_REQUIRED'
      )
      assert.equal(setup.calls.length, 0)
    })
  }

  it('manager also rejects repair writes without a valid active transaction', async () => {
    for (const session of [
      undefined,
      { hasEnded: true, inTransaction: () => true },
      { hasEnded: false, inTransaction: () => false },
      { hasEnded: false, inTransaction: () => { throw new Error('invalid') } }
    ]) {
      await assert.rejects(
        ProductUnitManager.markExactAvailableUnitsSoldForRepair({ unitIds: [] }, { session }),
        (error) => error.code === 'INVENTORY_REPAIR_TRANSACTION_REQUIRED'
      )
      await assert.rejects(
        ProductUnitManager.markExactReservedUnitsSoldForRepair({ units: [] }, { session }),
        (error) => error.code === 'INVENTORY_REPAIR_TRANSACTION_REQUIRED'
      )
    }
  })

  it('manager preserves updateMany, bulkWrite and find Mongo errors by identity', async () => {
    const updateError = Object.assign(new Error('updateMany write conflict'), {
      code: 112,
      errorLabels: ['TransientTransactionError']
    })
    const bulkError = Object.assign(new Error('bulkWrite write conflict'), {
      code: 112,
      errorLabels: ['TransientTransactionError']
    })
    const findError = Object.assign(new Error('find read conflict'), {
      code: 112,
      errorLabels: ['TransientTransactionError']
    })
    ProductUnitModel.updateMany = async () => { throw updateError }
    ProductUnitModel.bulkWrite = async () => { throw bulkError }
    const session = activeSession()

    await assert.rejects(
      ProductUnitManager.markExactAvailableUnitsSoldForRepair({ unitIds: [] }, { session }),
      (error) => error === updateError && error.errorLabels === updateError.errorLabels
    )
    await assert.rejects(
      ProductUnitManager.markExactReservedUnitsSoldForRepair({
        units: [{
          productUnitId: objectId(ids.preserveA),
          reservedAt: dates.reservedAt,
          reservationExpiresAt: dates.reservationExpiresAt
        }],
        orderId: objectId(ids.order),
        orderItemId: objectId(ids.itemA),
        productId: objectId(ids.productA),
        repairAt: dates.repairAt
      }, { session }),
      (error) => error === bulkError && error.errorLabels === bulkError.errorLabels
    )

    ProductUnitModel.find = () => ({
      sort() { return this },
      session() { return this },
      lean() { return Promise.reject(findError) }
    })
    await assert.rejects(
      ProductUnitManager.getSoldUnitsForOrderItem({
        orderId: objectId(ids.order),
        orderItemId: objectId(ids.itemA),
        productId: objectId(ids.productA)
      }, { session }),
      (error) => error === findError && error.errorLabels === findError.errorLabels
    )
  })

  it('manager builds the exact available-to-sold filter and update', async () => {
    const capture = {}
    const session = activeSession()
    ProductUnitModel.updateMany = async (filter, update, options) => {
      Object.assign(capture, { filter, update, options })
      return { matchedCount: 2, modifiedCount: 2 }
    }

    await ProductUnitManager.markExactAvailableUnitsSoldForRepair({
      unitIds: [objectId(ids.reclaimA), objectId(ids.replacementA)],
      orderId: objectId(ids.order),
      orderItemId: objectId(ids.itemA),
      productId: objectId(ids.productA),
      repairAt: dates.repairAt,
      reservationExpiresAt: dates.reservationExpiresAt
    }, { session })

    assert.deepEqual(capture.filter._id.$in.map(asId), [ids.reclaimA, ids.replacementA])
    assert.equal(asId(capture.filter.productId), ids.productA)
    assert.equal(capture.filter.status, 'available')
    assert.equal(capture.filter.isDeleted, false)
    for (const field of [
      'orderId',
      'orderItemId',
      'reservedByOrderId',
      'reservedAt',
      'reservationExpiresAt',
      'soldByOrderId',
      'soldAt'
    ]) {
      assert.deepEqual(capture.filter[field], { $exists: true, $eq: null })
    }
    assert.deepEqual(capture.update, {
      $set: {
        status: 'sold',
        orderId: objectId(ids.order),
        orderItemId: objectId(ids.itemA),
        reservedByOrderId: objectId(ids.order),
        reservedAt: dates.repairAt,
        reservationExpiresAt: dates.reservationExpiresAt,
        soldByOrderId: objectId(ids.order),
        soldAt: dates.repairAt
      }
    })
    assert.equal(capture.options.session, session)
  })

  it('manager builds one exact reserved-to-sold CAS per ProductUnit', async () => {
    const capture = {}
    const session = activeSession()
    ProductUnitModel.bulkWrite = async (operations, options) => {
      Object.assign(capture, { operations, options })
      return { matchedCount: 1, modifiedCount: 1 }
    }

    await ProductUnitManager.markExactReservedUnitsSoldForRepair({
      units: [{
        productUnitId: objectId(ids.preserveA),
        reservedAt: dates.reservedAt,
        reservationExpiresAt: dates.reservationExpiresAt
      }],
      orderId: objectId(ids.order),
      orderItemId: objectId(ids.itemA),
      productId: objectId(ids.productA),
      repairAt: dates.repairAt
    }, { session })

    const operation = capture.operations[0].updateOne
    assert.equal(asId(operation.filter._id), ids.preserveA)
    assert.equal(asId(operation.filter.productId), ids.productA)
    assert.equal(operation.filter.status, 'reserved')
    assert.equal(operation.filter.isDeleted, false)
    assert.equal(asId(operation.filter.orderId), ids.order)
    assert.equal(asId(operation.filter.orderItemId), ids.itemA)
    assert.equal(asId(operation.filter.reservedByOrderId), ids.order)
    assert.equal(operation.filter.reservedAt, dates.reservedAt)
    assert.equal(operation.filter.reservationExpiresAt, dates.reservationExpiresAt)
    assert.deepEqual(operation.filter.soldByOrderId, { $exists: true, $eq: null })
    assert.deepEqual(operation.filter.soldAt, { $exists: true, $eq: null })
    assert.deepEqual(operation.update, {
      $set: {
        status: 'sold',
        soldByOrderId: objectId(ids.order),
        soldAt: dates.repairAt
      }
    })
    assert.equal(capture.options.ordered, true)
    assert.equal(capture.options.session, session)
  })

  it('manager final read loads all sold units without hiding metadata contradictions', async () => {
    const capture = {}
    const session = activeSession()
    ProductUnitModel.find = (filter) => {
      capture.filter = filter
      return queryResult([], capture)
    }

    await ProductUnitManager.getSoldUnitsForOrderItem({
      orderId: objectId(ids.order),
      orderItemId: objectId(ids.itemA),
      productId: objectId(ids.productA)
    }, { session })

    assert.equal(asId(capture.filter.orderId), ids.order)
    assert.equal(asId(capture.filter.orderItemId), ids.itemA)
    assert.equal(asId(capture.filter.productId), ids.productA)
    assert.equal(capture.filter.status, 'sold')
    assert.equal(capture.filter.isDeleted, false)
    assert.equal(asId(capture.filter.soldByOrderId), ids.order)
    for (const field of ['soldAt', 'reservedByOrderId', 'reservedAt', 'reservationExpiresAt']) {
      assert.equal(Object.hasOwn(capture.filter, field), false)
    }
    assert.deepEqual(capture.sort, { _id: 1 })
    assert.equal(capture.session, session)
    assert.equal(capture.lean, true)
  })

  it('uses one repairAt and the expired Order reservation date for every mutation', async () => {
    const setup = makeWriter(fixture())
    const result = await setup.writer.writeRepair(setup.input, { session: activeSession() })
    const reserved = setup.calls.find((call) => call.type === 'reserved')
    const available = setup.calls.find((call) => call.type === 'available')

    assert.equal(reserved.data.repairAt.getTime(), dates.repairAt.getTime())
    assert.equal(available.data.repairAt.getTime(), dates.repairAt.getTime())
    assert.equal(
      available.data.reservationExpiresAt.getTime(),
      dates.reservationExpiresAt.getTime()
    )
    assert(dates.reservationExpiresAt.getTime() < dates.repairAt.getTime())
    assert.equal(result.repairAt.getTime(), dates.repairAt.getTime())
  })

  it('batches reclaim and new replacements in one available CAS', async () => {
    const setup = makeWriter(fixture())
    const result = await setup.writer.writeRepair(setup.input, { session: activeSession() })
    const availableCalls = setup.calls.filter((call) => call.type === 'available')

    assert.equal(availableCalls.length, 1)
    assert.deepEqual(
      availableCalls[0].data.unitIds.map(asId),
      [ids.reclaimA, ids.replacementA]
    )
    assert.equal(result.byOrderItem[0].reclaimedSoldCount, 1)
    assert.equal(result.byOrderItem[0].replacementSoldCount, 1)
  })

  it('does not write, guard or recalculate an alreadySold-only item', async () => {
    const setup = makeWriter(alreadySoldOnlyFixture())
    const result = await setup.writer.writeRepair(setup.input, { session: activeSession() })

    assert.deepEqual(setup.calls.map((call) => call.type), ['read'])
    assert.equal(result.byOrderItem[0].alreadySoldCount, 1)
    assert.equal(result.affectedProductIds.length, 0)
  })

  for (const [label, result] of [
    ['available matched', { matchedCount: 1, modifiedCount: 2 }],
    ['available modified', { matchedCount: 2, modifiedCount: 1 }]
  ]) {
    it(`fails closed on ${label} count mismatch without labels`, async () => {
      const setup = makeWriter(fixture(), { available: async () => result })
      await assert.rejects(
        setup.writer.writeRepair(setup.input, { session: activeSession() }),
        (error) => (
          error.code === 'INVENTORY_REPAIR_CAS_CONFLICT' &&
          error.errorLabels === undefined
        )
      )
      assert.equal(setup.calls.some((call) => call.type === 'stock'), false)
      assert.equal(setup.calls.some((call) => call.type === 'read'), false)
    })
  }

  for (const [label, result] of [
    ['reserved matched', { matchedCount: 0, modifiedCount: 1 }],
    ['reserved modified', { matchedCount: 1, modifiedCount: 0 }]
  ]) {
    it(`fails closed on ${label} count mismatch before later operations`, async () => {
      const setup = makeWriter(fixture(), { reserved: async () => result })
      await assert.rejects(
        setup.writer.writeRepair(setup.input, { session: activeSession() }),
        (error) => error.code === 'INVENTORY_REPAIR_CAS_CONFLICT'
      )
      assert.deepEqual(setup.calls.map((call) => call.type), ['guards', 'reserved'])
    })
  }

  it('preserves Mongo error identity, code and labels', async () => {
    const mongoError = new Error('simulated transient write conflict')
    mongoError.code = 112
    mongoError.errorLabels = ['TransientTransactionError']
    const setup = makeWriter(fixture(), {
      reserved: async () => { throw mongoError }
    })

    await assert.rejects(
      setup.writer.writeRepair(setup.input, { session: activeSession() }),
      (error) => error === mongoError && error.errorLabels === mongoError.errorLabels
    )
  })

  it('preserves a transient guard error by identity and stops before mutations', async () => {
    const mongoError = new Error('simulated guard write conflict')
    mongoError.code = 112
    mongoError.errorLabels = ['TransientTransactionError']
    const setup = makeWriter(fixture(), {
      guards: async () => { throw mongoError }
    })

    await assert.rejects(
      setup.writer.writeRepair(setup.input, { session: activeSession() }),
      (error) => error === mongoError && error.errorLabels === mongoError.errorLabels
    )
    assert.deepEqual(setup.calls.map((call) => call.type), ['guards'])
  })

  it('preserves final read Mongo errors by identity', async () => {
    const mongoError = Object.assign(new Error('simulated final read conflict'), {
      code: 112,
      errorLabels: ['TransientTransactionError']
    })
    const setup = makeWriter(fixture(), {
      read: async () => { throw mongoError }
    })

    await assert.rejects(
      setup.writer.writeRepair(setup.input, { session: activeSession() }),
      (error) => error === mongoError && error.errorLabels === mongoError.errorLabels
    )
  })

  it('recalculateProductStock logs and rethrows the original Mongo error', async () => {
    const mongoError = Object.assign(new Error('simulated stock read conflict'), {
      code: 112,
      errorLabels: ['TransientTransactionError']
    })
    ProductModel.findById = () => { throw mongoError }

    await assert.rejects(
      ProductUnitService.recalculateProductStock(ids.productA, { session: activeSession() }),
      (error) => error === mongoError && error.errorLabels === mongoError.errorLabels
    )
  })

  it('acquires guards, mutates, recalculates and reads sequentially with one session', async () => {
    const session = activeSession()
    const setup = makeWriter(fixture())
    await setup.writer.writeRepair(setup.input, { session })

    assert.deepEqual(
      setup.calls.map((call) => call.type),
      ['guards', 'reserved', 'available', 'stock', 'read']
    )
    assert(setup.calls.every((call) => call.options?.session === session))
  })

  it('does not start each same-session stage before the previous promise resolves', async () => {
    const reservedGate = deferred()
    const availableGate = deferred()
    const stockGate = deferred()
    const setup = makeWriter(fixture(), {
      reserved: async (data) => {
        await reservedGate.promise
        return { matchedCount: data.units.length, modifiedCount: data.units.length }
      },
      available: async (data) => {
        await availableGate.promise
        return { matchedCount: data.unitIds.length, modifiedCount: data.unitIds.length }
      },
      stock: async () => {
        await stockGate.promise
        return { available: 0 }
      }
    })

    const writePromise = setup.writer.writeRepair(setup.input, { session: activeSession() })
    await Promise.resolve()
    await Promise.resolve()
    assert.deepEqual(setup.calls.map((call) => call.type), ['guards', 'reserved'])

    reservedGate.resolve()
    await new Promise((resolve) => setImmediate(resolve))
    assert.deepEqual(setup.calls.map((call) => call.type), ['guards', 'reserved', 'available'])

    availableGate.resolve()
    await new Promise((resolve) => setImmediate(resolve))
    assert.deepEqual(
      setup.calls.map((call) => call.type),
      ['guards', 'reserved', 'available', 'stock']
    )

    stockGate.resolve()
    await writePromise
    assert.deepEqual(
      setup.calls.map((call) => call.type),
      ['guards', 'reserved', 'available', 'stock', 'read']
    )
  })

  it('recalculates stock exactly once for each affected product', async () => {
    const setup = makeWriter(fixture())
    await setup.writer.writeRepair(setup.input, { session: activeSession() })

    const stockCalls = setup.calls.filter((call) => call.type === 'stock')
    assert.equal(stockCalls.length, 1)
    assert.equal(stockCalls[0].productId, ids.productA)
  })

  it('orders unique affected products, mutations, stock and verification deterministically', async () => {
    const data = fixture()
    const actualProductB = addSecondProductReplacement(data)
    const actualProductA = data.actualUnits
    const setup = makeWriter(data, {
      read: async (input) => (
        asId(input.orderItemId) === ids.itemA ? actualProductA : actualProductB
      )
    })

    const result = await setup.writer.writeRepair(setup.input, { session: activeSession() })
    const guards = setup.calls.find((call) => call.type === 'guards')
    const availableCalls = setup.calls.filter((call) => call.type === 'available')
    const stockCalls = setup.calls.filter((call) => call.type === 'stock')
    const readCalls = setup.calls.filter((call) => call.type === 'read')

    assert.deepEqual(guards.productIds, [ids.productA, ids.productB])
    assert.deepEqual(availableCalls.map((call) => asId(call.data.productId)), [
      ids.productA,
      ids.productB
    ])
    assert.deepEqual(stockCalls.map((call) => call.productId), [ids.productA, ids.productB])
    assert.deepEqual(readCalls.map((call) => asId(call.data.productId)), [
      ids.productA,
      ids.productB
    ])
    assert.deepEqual(result.affectedProductIds, [ids.productA, ids.productB])
  })

  it('returns only focal inventory repair semantics', async () => {
    const setup = makeWriter(fixture())
    const result = await setup.writer.writeRepair(setup.input, { session: activeSession() })

    assert.equal(result.orderId, ids.order)
    assert.deepEqual(result.affectedProductIds, [ids.productA])
    assert.deepEqual(result.selectedNewProductUnitIds, [ids.replacementA])
    assert.deepEqual(
      result.byOrderItem[0].expectedSoldProductUnitIds,
      [ids.alreadyA, ids.preserveA, ids.reclaimA, ids.replacementA]
    )
    assert.equal(result.byOrderItem[0].preserveSoldCount, 1)
    assert.equal(Object.hasOwn(result, 'orderStatus'), false)
    assert.equal(Object.hasOwn(result, 'paymentStatus'), false)
    assert.equal(Object.hasOwn(result, 'resolution'), false)
  })

  it('does not import or rerun the planner or selector', async () => {
    const source = await readFile(
      new URL('../../src/services/orderInventoryRepairWriter.service.js', import.meta.url),
      'utf8'
    )

    assert.doesNotMatch(source, /orderInventoryRepairPlanner/)
    assert.doesNotMatch(source, /orderInventoryRepairSelector/)
    assert.doesNotMatch(source, /buildInventoryRepairPlan/)
    assert.doesNotMatch(source, /selectCandidates/)
  })

  for (const [label, value] of [
    ['null', null],
    ['undefined', undefined],
    ['string', '2026-11-01T16:00:00.000Z'],
    ['invalid Date', new Date('invalid')],
    ['boolean', true],
    ['number', dates.reservationExpiresAt.getTime()]
  ]) {
    it(`rejects ${label} Order reservationExpiresAt before the first operation`, async () => {
      const data = fixture()
      data.input.order.reservationExpiresAt = value
      const setup = makeWriter(data)
      await assert.rejects(
        setup.writer.writeRepair(setup.input, { session: activeSession() }),
        (error) => error.code === 'INVALID_INVENTORY_REPAIR_WRITE_INPUT'
      )
      assert.equal(setup.calls.length, 0)
    })
  }

  for (const [label, value] of [
    ['null', null],
    ['string', '2026-11-02T12:00:00.000Z'],
    ['invalid Date', new Date('invalid')],
    ['number', dates.repairAt.getTime()]
  ]) {
    it(`rejects ${label} repairAt before the first operation`, async () => {
      const data = fixture()
      data.input.repairAt = value
      const setup = makeWriter(data)
      await assert.rejects(
        setup.writer.writeRepair(setup.input, { session: activeSession() }),
        (error) => error.code === 'INVALID_INVENTORY_REPAIR_WRITE_INPUT'
      )
      assert.equal(setup.calls.length, 0)
    })
  }

  it('rejects plan and selection reclaim disagreement before writes', async () => {
    const data = fixture()
    data.input.selection.byOrderItem[0].reclaimUnitIds = []
    const setup = makeWriter(data)
    await assert.rejects(
      setup.writer.writeRepair(setup.input, { session: activeSession() }),
      (error) => error.code === 'INVALID_INVENTORY_REPAIR_WRITE_INPUT'
    )
    assert.equal(setup.calls.length, 0)
  })

  it('rejects replacement count and candidate disagreement before writes', async () => {
    const data = fixture()
    data.input.selection.byOrderItem[0].newReplacementCandidateIds = []
    const setup = makeWriter(data)
    await assert.rejects(
      setup.writer.writeRepair(setup.input, { session: activeSession() }),
      (error) => error.code === 'INVALID_INVENTORY_REPAIR_WRITE_INPUT'
    )
    assert.equal(setup.calls.length, 0)
  })

  it('rejects duplicate expected IDs before writes', async () => {
    const data = fixture()
    data.input.plan.items[0].alreadySold[0].productUnitId = ids.preserveA
    const setup = makeWriter(data)
    await assert.rejects(
      setup.writer.writeRepair(setup.input, { session: activeSession() }),
      (error) => error.code === 'INVALID_INVENTORY_REPAIR_WRITE_INPUT'
    )
    assert.equal(setup.calls.length, 0)
  })

  it('rejects an expected ProductUnit shared by two OrderItems', async () => {
    const data = alreadySoldOnlyFixture()
    data.input.authoritativeInputs.orderItems.push({
      _id: ids.itemB,
      orderId: ids.order,
      productId: ids.productB,
      quantity: 1
    })
    data.input.plan.items.push({
      orderItemId: ids.itemB,
      productId: ids.productB,
      quantity: 1,
      preserveReserved: [],
      alreadySold: [{ productUnitId: ids.alreadyA }],
      reclaimAvailableOriginals: [],
      replaceableDeficitOriginals: [],
      replacementCount: 0,
      blocked: []
    })
    data.input.selection.byOrderItem.push({
      orderItemId: ids.itemB,
      productId: ids.productB,
      reclaimUnitIds: [],
      newReplacementCandidates: [],
      newReplacementCandidateIds: [],
      replacementCount: 0
    })

    const setup = makeWriter(data)
    await assert.rejects(
      setup.writer.writeRepair(setup.input, { session: activeSession() }),
      (error) => error.code === 'INVALID_INVENTORY_REPAIR_WRITE_INPUT'
    )
    assert.equal(setup.calls.length, 0)
  })

  it('rejects missing authoritative preserve evidence before writes', async () => {
    const data = fixture()
    data.input.authoritativeInputs.originalProductUnits = data.input.authoritativeInputs
      .originalProductUnits.filter((unit) => unit._id !== ids.preserveA)
    const setup = makeWriter(data)
    await assert.rejects(
      setup.writer.writeRepair(setup.input, { session: activeSession() }),
      (error) => error.code === 'INVALID_INVENTORY_REPAIR_WRITE_INPUT'
    )
    assert.equal(setup.calls.length, 0)
  })

  it('rejects preserve evidence with stale reservation dates before writes', async () => {
    const data = fixture()
    data.input.authoritativeInputs.originalProductUnits[0].reservedAt = 'stale'
    const setup = makeWriter(data)
    await assert.rejects(
      setup.writer.writeRepair(setup.input, { session: activeSession() }),
      (error) => error.code === 'INVALID_INVENTORY_REPAIR_WRITE_INPUT'
    )
    assert.equal(setup.calls.length, 0)
  })

  it('fails final verification when a sold unit is missing', async () => {
    const data = fixture()
    data.actualUnits = data.actualUnits.slice(0, -1)
    const setup = makeWriter(data)
    await assert.rejects(
      setup.writer.writeRepair(setup.input, { session: activeSession() }),
      (error) => error.code === 'INVENTORY_REPAIR_FINAL_STATE_CONFLICT'
    )
  })

  it('fails final verification when an extra sold unit exists', async () => {
    const data = fixture()
    data.actualUnits.push(soldUnit({ id: ids.extraA }))
    const setup = makeWriter(data)
    await assert.rejects(
      setup.writer.writeRepair(setup.input, { session: activeSession() }),
      (error) => error.code === 'INVENTORY_REPAIR_FINAL_STATE_CONFLICT'
    )
  })

  it('fails final verification when actual IDs are duplicated', async () => {
    const data = fixture()
    data.actualUnits.push(data.actualUnits[0])
    const setup = makeWriter(data)
    await assert.rejects(
      setup.writer.writeRepair(setup.input, { session: activeSession() }),
      (error) => error.code === 'INVENTORY_REPAIR_FINAL_STATE_CONFLICT'
    )
  })

  for (const [label, mutate] of [
    ['preserve reservedAt', (unit) => { unit.reservedAt = dates.repairAt }],
    ['preserve reservationExpiresAt', (unit) => { unit.reservationExpiresAt = dates.repairAt }],
    ['preserve soldAt', (unit) => { unit.soldAt = dates.alreadySoldAt }],
    ['reclaim repair metadata', (unit) => { unit.reservedByOrderId = null }],
    ['replacement repair metadata', (unit) => { unit.reservationExpiresAt = dates.repairAt }],
    ['alreadySold historical metadata', (unit) => { unit.soldAt = dates.repairAt }]
  ]) {
    it(`fails final verification on ${label} drift`, async () => {
      const data = fixture()
      const indexByLabel = label.startsWith('preserve')
        ? 0
        : label.startsWith('reclaim')
          ? 1
          : label.startsWith('replacement')
            ? 2
            : 3
      mutate(data.actualUnits[indexByLabel])
      const setup = makeWriter(data)
      await assert.rejects(
        setup.writer.writeRepair(setup.input, { session: activeSession() }),
        (error) => error.code === 'INVENTORY_REPAIR_FINAL_STATE_CONFLICT'
      )
    })
  }

  for (const [label, mutate] of [
    ['wrong Order', (unit) => { unit.orderId = ids.itemB }],
    ['wrong OrderItem', (unit) => { unit.orderItemId = ids.itemB }],
    ['wrong Product', (unit) => { unit.productId = ids.productB }]
  ]) {
    it(`fails final verification on ${label}`, async () => {
      const data = fixture()
      mutate(data.actualUnits[0])
      const setup = makeWriter(data)
      await assert.rejects(
        setup.writer.writeRepair(setup.input, { session: activeSession() }),
        (error) => error.code === 'INVENTORY_REPAIR_FINAL_STATE_CONFLICT'
      )
    })
  }

  it('does not mutate deeply frozen inputs or candidate objects', async () => {
    const data = fixture()
    const snapshot = JSON.stringify(data.input)
    deepFreeze(data.input)
    const setup = makeWriter(data)
    await setup.writer.writeRepair(setup.input, { session: activeSession() })

    assert.equal(JSON.stringify(data.input), snapshot)
    assert.equal(Object.isFrozen(data.input), true)
    assert.equal(Object.isFrozen(data.input.selection.byOrderItem[0].newReplacementCandidates[0]), true)
  })

  it('normalizes, deduplicates and sorts guard products sequentially', async () => {
    const session = activeSession()
    const calls = []
    ProductModel.findOneAndUpdate = (filter, update, options) => ({
      async lean() {
        calls.push({ filter, update, options })
        return { _id: filter._id, inventoryMode: 'serialized' }
      }
    })

    const result = await ProductUnitService.acquireInventoryRepairGuards(
      [ids.productB, objectId(ids.productA), ids.productB],
      { session }
    )

    assert.deepEqual(result, [ids.productA, ids.productB])
    assert.deepEqual(calls.map((call) => asId(call.filter._id)), [ids.productA, ids.productB])
    assert(calls.every((call) => call.options.session === session))
    assert(calls.every((call) => call.update.$inc.__v === 1))
  })

  it('does not begin the second guard write before the first resolves', async () => {
    const session = activeSession()
    const firstGate = deferred()
    const started = []
    ProductModel.findOneAndUpdate = (filter) => ({
      async lean() {
        started.push(asId(filter._id))
        if (started.length === 1) await firstGate.promise
        return { _id: filter._id, inventoryMode: 'serialized' }
      }
    })

    const guardPromise = ProductUnitService.acquireInventoryRepairGuards(
      [ids.productA, ids.productB],
      { session }
    )
    await Promise.resolve()
    await Promise.resolve()
    assert.deepEqual(started, [ids.productA])

    firstGate.resolve()
    await guardPromise
    assert.deepEqual(started, [ids.productA, ids.productB])
  })

  it('guard wrapper requires an active transaction and validates products', async () => {
    await assert.rejects(
      ProductUnitService.acquireInventoryRepairGuards([ids.productA]),
      (error) => error.code === 'INVENTORY_REPAIR_TRANSACTION_REQUIRED'
    )
    await assert.rejects(
      ProductUnitService.acquireInventoryRepairGuards(['invalid'], { session: activeSession() }),
      (error) => error.code === 'INVALID_INVENTORY_REPAIR_GUARD_INPUT'
    )
  })
})
