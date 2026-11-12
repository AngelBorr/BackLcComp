/* eslint-env mocha */
import assert from 'node:assert/strict'
import mongoose from 'mongoose'
import ProductUnitManager from '../../src/dao/managers/productUnit.manager.js'
import OrderItemManager from '../../src/dao/managers/orderItem.manager.js'
import ProductUnitModel from '../../src/dao/models/productUnit.model.js'
import OrderItemModel from '../../src/dao/models/orderItem.model.js'
import {
  OrderInventoryRepairReadService,
  extractExternalOrderItemIds,
  normalizeInventoryRepairId
} from '../../src/services/orderInventoryRepairRead.service.js'

const ids = Object.freeze({
  order: '507f1f77bcf86cd799439011',
  otherOrder: '507f1f77bcf86cd799439012',
  thirdOrder: '507f1f77bcf86cd799439013',
  itemA: '507f1f77bcf86cd799439021',
  itemB: '507f1f77bcf86cd799439022',
  itemC: '507f1f77bcf86cd799439023',
  unitA: '507f1f77bcf86cd799439031',
  unitB: '507f1f77bcf86cd799439032',
  unitC: '507f1f77bcf86cd799439033'
})

const objectId = (value) => new mongoose.Types.ObjectId(value)
const sameId = (left, right) => String(left) === String(right)

const deferred = () => {
  let fulfill
  let fail
  const promise = new Promise((resolve, reject) => {
    fulfill = resolve
    fail = reject
  })
  return { promise, resolve: fulfill, reject: fail }
}

const queryResult = (documents, capture) => ({
  sort(value) {
    capture.sort = value
    return this
  },
  lean() {
    capture.lean = true
    return this
  },
  session(value) {
    capture.session = value
    return this
  },
  then(resolve, reject) {
    return Promise.resolve(documents).then(resolve, reject)
  }
})

const makeReadService = ({ units = [], items = [], relatedUnits = [] } = {}) => {
  const calls = []
  const productUnitManager = {
    async getByIdsIncludingDeleted(requestedIds, options) {
      calls.push({ method: 'getByIdsIncludingDeleted', requestedIds, options })
      return units.filter((unit) => requestedIds.some((id) => sameId(id, unit._id)))
    },
    async getRelatedByOrderId(orderId, options) {
      calls.push({ method: 'getRelatedByOrderId', orderId, options })
      return relatedUnits
    }
  }
  const orderItemManager = {
    async getByIds(requestedIds, options) {
      calls.push({ method: 'getByIds', requestedIds, options })
      return items.filter((item) => requestedIds.some((id) => sameId(id, item._id)))
    },
    async getByOrderId(orderId, options) {
      calls.push({ method: 'getByOrderId', orderId, options })
      return items.filter((item) => sameId(item.orderId, orderId))
    }
  }

  return {
    calls,
    service: new OrderInventoryRepairReadService({ productUnitManager, orderItemManager })
  }
}

describe('P1C-B0B F2A authoritative inventory reads', () => {
  let originalProductUnitFind
  let originalOrderItemFind

  beforeEach(() => {
    originalProductUnitFind = ProductUnitModel.find
    originalOrderItemFind = OrderItemModel.find
  })

  afterEach(() => {
    ProductUnitModel.find = originalProductUnitFind
    OrderItemModel.find = originalOrderItemFind
  })

  it('getByIdsIncludingDeleted queries exclusively by exact IDs and propagates session', async () => {
    const session = { id: 'session' }
    const capture = {}
    const returned = [
      { _id: objectId(ids.unitA), isDeleted: false },
      { _id: objectId(ids.unitB), isDeleted: true }
    ]
    ProductUnitModel.find = (filter) => {
      capture.filter = filter
      return queryResult(returned, capture)
    }

    const result = await ProductUnitManager.getByIdsIncludingDeleted(
      [ids.unitA, ids.unitB],
      { session }
    )

    assert.deepEqual(result, returned)
    assert.deepEqual(capture.filter, { _id: { $in: [ids.unitA, ids.unitB] } })
    assert.equal(Object.hasOwn(capture.filter, 'isDeleted'), false)
    assert.equal(Object.hasOwn(capture.filter, 'serialNumber'), false)
    assert.equal(capture.lean, true)
    assert.equal(capture.session, session)
  })

  it('loads an active original ProductUnit', async () => {
    const unit = { _id: objectId(ids.unitA), isDeleted: false }
    const { service } = makeReadService({ units: [unit] })
    const result = await service.loadOriginalProductUnits([ids.unitA])

    assert.equal(result.byId.get(ids.unitA), unit)
    assert.deepEqual(result.unitsInRequestedOrder, [unit])
    assert.deepEqual(result.missingIds, [])
  })

  it('loads a soft-deleted original ProductUnit without hiding it', async () => {
    const unit = { _id: objectId(ids.unitA), isDeleted: true }
    const { service } = makeReadService({ units: [unit] })
    const result = await service.loadOriginalProductUnits([ids.unitA])

    assert.equal(result.byId.get(ids.unitA), unit)
    assert.deepEqual(result.unitsInRequestedOrder, [unit])
    assert.deepEqual(result.missingIds, [])
  })

  it('identifies a physically missing original ProductUnit', async () => {
    const { service } = makeReadService()
    const result = await service.loadOriginalProductUnits([ids.unitB])

    assert.equal(result.byId.size, 0)
    assert.deepEqual(result.unitsInRequestedOrder, [])
    assert.deepEqual(result.missingIds, [ids.unitB])
  })

  it('preserves requested order across active, deleted and missing originals', async () => {
    const active = { _id: objectId(ids.unitA), isDeleted: false }
    const deleted = { _id: objectId(ids.unitB), isDeleted: true }
    const { service } = makeReadService({ units: [deleted, active] })
    const result = await service.loadOriginalProductUnits([
      ids.unitA,
      ids.unitC,
      ids.unitB
    ])

    assert.deepEqual(result.unitsInRequestedOrder, [active, deleted])
    assert.deepEqual(result.missingIds, [ids.unitC])
  })

  it('rejects duplicate requested ProductUnit IDs fail-closed', async () => {
    const { service } = makeReadService()

    await assert.rejects(
      service.loadOriginalProductUnits([ids.unitA, ids.unitA.toUpperCase()]),
      (error) => error.code === 'DUPLICATE_ORIGINAL_PRODUCT_UNIT_ID'
    )
  })

  it('accepts real ObjectIds and rejects arbitrary object stringification', async () => {
    assert.equal(normalizeInventoryRepairId(objectId(ids.unitA)), ids.unitA)
    assert.equal(normalizeInventoryRepairId({ toString: () => ids.unitA }), null)
  })

  it('rejects principal invalid ID shapes before querying originals', async () => {
    let queryCalls = 0
    const service = new OrderInventoryRepairReadService({
      productUnitManager: {
        async getByIdsIncludingDeleted() {
          queryCalls += 1
          return []
        }
      },
      orderItemManager: {}
    })

    for (const invalidId of [null, undefined, '', 'abc', 123, {}, [], true, false]) {
      await assert.rejects(
        service.loadOriginalProductUnits([invalidId]),
        (error) => error.code === 'INVALID_ORIGINAL_PRODUCT_UNIT_IDS'
      )
    }
    assert.equal(queryCalls, 0)
  })

  it('propagates session while loading originals through the read service', async () => {
    const session = { id: 'transaction' }
    const { service, calls } = makeReadService()
    await service.loadOriginalProductUnits([ids.unitA], { session })

    assert.equal(calls[0].options.session, session)
  })

  for (const [label, relation] of [
    ['orderId', { orderId: ids.order }],
    ['reservedByOrderId', { reservedByOrderId: ids.order }],
    ['soldByOrderId', { soldByOrderId: ids.order }]
  ]) {
    it(`getRelatedByOrderId observes a relation exclusively through ${label}`, async () => {
      const capture = {}
      const related = [{ _id: ids.unitA, status: 'available', ...relation }]
      ProductUnitModel.find = (filter) => {
        capture.filter = filter
        const matches = related.filter((unit) => filter.$or.some((entry) => (
          Object.entries(entry).every(([field, value]) => sameId(unit[field], value))
        )))
        return queryResult(matches, capture)
      }

      const result = await ProductUnitManager.getRelatedByOrderId(ids.order)
      assert.deepEqual(result, related)
      assert.equal(capture.filter.$or.length, 3)
    })
  }

  it('getRelatedByOrderId includes soft-deleted and all referenced statuses', async () => {
    const capture = {}
    const related = [
      { _id: ids.unitA, orderId: ids.order, status: 'available', isDeleted: true },
      { _id: ids.unitB, reservedByOrderId: ids.order, status: 'reserved', isDeleted: false },
      { _id: ids.unitC, soldByOrderId: ids.order, status: 'sold', isDeleted: false }
    ]
    ProductUnitModel.find = (filter) => {
      capture.filter = filter
      return queryResult(related, capture)
    }

    const result = await ProductUnitManager.getRelatedByOrderId(ids.order)
    assert.deepEqual(result, related)
    assert.equal(Object.hasOwn(capture.filter, 'isDeleted'), false)
    assert.equal(Object.hasOwn(capture.filter, 'status'), false)
  })

  it('getRelatedByOrderId does not hide inactive, warranty or returned relations', async () => {
    const capture = {}
    const related = ['inactive', 'warranty', 'returned'].map((status, index) => ({
      _id: [ids.unitA, ids.unitB, ids.unitC][index],
      orderId: ids.order,
      status
    }))
    ProductUnitModel.find = () => queryResult(related, capture)

    const result = await ProductUnitManager.getRelatedByOrderId(ids.order)
    assert.deepEqual(result, related)
  })

  it('getRelatedByOrderId excludes a unit without target Order references', async () => {
    const capture = {}
    const units = [
      { _id: ids.unitA, orderId: ids.otherOrder },
      { _id: ids.unitB, reservedByOrderId: ids.order }
    ]
    ProductUnitModel.find = (filter) => {
      capture.filter = filter
      const matches = units.filter((unit) => filter.$or.some((entry) => (
        Object.entries(entry).every(([field, value]) => sameId(unit[field], value))
      )))
      return queryResult(matches, capture)
    }

    const result = await ProductUnitManager.getRelatedByOrderId(ids.order)
    assert.deepEqual(result, [units[1]])
  })

  it('getRelatedByOrderId propagates session', async () => {
    const session = { id: 'session' }
    const capture = {}
    ProductUnitModel.find = () => queryResult([], capture)

    await ProductUnitManager.getRelatedByOrderId(ids.order, { session })
    assert.equal(capture.session, session)
  })

  it('extracts only exact OrderItem IDs referenced by another Order', () => {
    const result = extractExternalOrderItemIds({
      targetOrderId: ids.order,
      originalProductUnits: [
        { orderId: ids.order, orderItemId: ids.itemA },
        { reservedByOrderId: ids.otherOrder, orderItemId: ids.itemB },
        { soldByOrderId: ids.thirdOrder, orderItemId: ids.itemC },
        { orderId: ids.otherOrder, orderItemId: null }
      ]
    })

    assert.deepEqual(result, [ids.itemB, ids.itemC])
  })

  it('deduplicates and deterministically sorts external OrderItem IDs', () => {
    const result = extractExternalOrderItemIds({
      targetOrderId: ids.order,
      originalProductUnits: [
        { orderId: ids.otherOrder, orderItemId: ids.itemC },
        { reservedByOrderId: ids.otherOrder, orderItemId: ids.itemA },
        { soldByOrderId: ids.thirdOrder, orderItemId: ids.itemC }
      ]
    })

    assert.deepEqual(result, [ids.itemA, ids.itemC])
  })

  it('loads evidence IDs for partial external ownership without classifying it', () => {
    const result = extractExternalOrderItemIds({
      targetOrderId: ids.order,
      originalProductUnits: [
        { orderId: ids.otherOrder, reservedByOrderId: null, orderItemId: ids.itemA },
        { orderId: null, reservedByOrderId: ids.otherOrder, orderItemId: ids.itemB },
        { orderId: ids.order, soldByOrderId: ids.otherOrder, orderItemId: ids.itemC }
      ]
    })

    assert.deepEqual(result, [ids.itemA, ids.itemB, ids.itemC])
  })

  it('OrderItem getByIds queries only exact IDs and propagates session', async () => {
    const session = { id: 'session' }
    const capture = {}
    const returned = [{ _id: ids.itemA, orderId: ids.otherOrder, productId: ids.unitA }]
    OrderItemModel.find = (filter) => {
      capture.filter = filter
      return queryResult(returned, capture)
    }

    const result = await OrderItemManager.getByIds([ids.itemA], { session })
    assert.deepEqual(result, returned)
    assert.deepEqual(capture.filter, { _id: { $in: [ids.itemA] } })
    assert.equal(Object.hasOwn(capture.filter, 'orderId'), false)
    assert.equal(capture.lean, true)
    assert.equal(capture.session, session)
  })

  it('keeps a missing external OrderItem explicit', async () => {
    const existing = { _id: objectId(ids.itemA), orderId: ids.otherOrder, productId: ids.unitA }
    const { service } = makeReadService({ items: [existing] })
    const result = await service.loadExternalOrderItems([ids.itemA, ids.itemB])

    assert.equal(result.byId.get(ids.itemA), existing)
    assert.deepEqual(result.itemsInRequestedOrder, [existing])
    assert.deepEqual(result.missingIds, [ids.itemB])
  })

  it('rejects duplicate external OrderItem IDs fail-closed', async () => {
    const { service } = makeReadService()
    await assert.rejects(
      service.loadExternalOrderItems([ids.itemA, objectId(ids.itemA)]),
      (error) => error.code === 'DUPLICATE_EXTERNAL_ORDER_ITEM_ID'
    )
  })

  it('getByOrderId uses createdAt and _id as a stable tie-breaker', async () => {
    const session = { id: 'session' }
    const capture = {}
    OrderItemModel.find = (filter) => {
      capture.filter = filter
      return queryResult([], capture)
    }

    await OrderItemManager.getByOrderId(ids.order, { session })
    assert.deepEqual(capture.filter, { orderId: ids.order })
    assert.deepEqual(capture.sort, { createdAt: 1, _id: 1 })
    assert.equal(capture.session, session)
  })

  it('composes the authoritative read model without planner, stock or writes', async () => {
    const session = { id: 'transaction' }
    const original = {
      _id: objectId(ids.unitA),
      orderId: objectId(ids.otherOrder),
      orderItemId: objectId(ids.itemB),
      reservedByOrderId: objectId(ids.otherOrder),
      isDeleted: false
    }
    const targetItem = { _id: objectId(ids.itemA), orderId: objectId(ids.order) }
    const externalItem = { _id: objectId(ids.itemB), orderId: objectId(ids.otherOrder) }
    const related = [{ _id: objectId(ids.unitC), soldByOrderId: objectId(ids.order) }]
    const { service, calls } = makeReadService({
      units: [original],
      items: [targetItem, externalItem],
      relatedUnits: related
    })

    const result = await service.loadAuthoritativeInputs(
      { orderId: ids.order, originalProductUnitIds: [ids.unitA, ids.unitB] },
      { session }
    )

    assert.deepEqual(result.orderItems, [targetItem])
    assert.deepEqual(result.originalProductUnits, [original])
    assert.deepEqual(result.missingOriginalProductUnitIds, [ids.unitB])
    assert.deepEqual(result.relatedProductUnits, related)
    assert.deepEqual(result.externalOrderItemIds, [ids.itemB])
    assert.deepEqual(result.externalOrderItems, [externalItem])
    assert.equal(result.externalOrderItemsById.get(ids.itemB), externalItem)
    assert.ok(calls.every((call) => call.options.session === session))
  })

  it('executes every session-bound read sequentially in authoritative order', async () => {
    const session = { id: 'transaction' }
    const events = []
    const targetGate = deferred()
    const originalGate = deferred()
    const relatedGate = deferred()
    const externalGate = deferred()
    const originalStarted = deferred()
    const relatedStarted = deferred()
    const externalStarted = deferred()
    const original = {
      _id: objectId(ids.unitA),
      orderId: objectId(ids.otherOrder),
      orderItemId: objectId(ids.itemB)
    }
    const externalItem = {
      _id: objectId(ids.itemB),
      orderId: objectId(ids.otherOrder),
      productId: objectId(ids.unitC)
    }
    const service = new OrderInventoryRepairReadService({
      orderItemManager: {
        async getByOrderId(orderId, options) {
          assert.equal(options.session, session)
          events.push('target:start')
          const result = await targetGate.promise
          events.push('target:end')
          return result
        },
        async getByIds(orderItemIds, options) {
          assert.equal(options.session, session)
          events.push('external:start')
          externalStarted.resolve()
          const result = await externalGate.promise
          events.push('external:end')
          return result
        }
      },
      productUnitManager: {
        async getByIdsIncludingDeleted(unitIds, options) {
          assert.equal(options.session, session)
          events.push('original:start')
          originalStarted.resolve()
          const result = await originalGate.promise
          events.push('original:end')
          return result
        },
        async getRelatedByOrderId(orderId, options) {
          assert.equal(options.session, session)
          events.push('related:start')
          relatedStarted.resolve()
          const result = await relatedGate.promise
          events.push('related:end')
          return result
        }
      }
    })

    const resultPromise = service.loadAuthoritativeInputs(
      { orderId: ids.order, originalProductUnitIds: [ids.unitA] },
      { session }
    )
    assert.deepEqual(events, ['target:start'])

    targetGate.resolve([])
    await originalStarted.promise
    assert.deepEqual(events, ['target:start', 'target:end', 'original:start'])

    originalGate.resolve([original])
    await relatedStarted.promise
    assert.deepEqual(events, [
      'target:start',
      'target:end',
      'original:start',
      'original:end',
      'related:start'
    ])

    relatedGate.resolve([])
    await externalStarted.promise
    assert.deepEqual(events, [
      'target:start',
      'target:end',
      'original:start',
      'original:end',
      'related:start',
      'related:end',
      'external:start'
    ])

    externalGate.resolve([externalItem])
    const result = await resultPromise
    assert.deepEqual(events, [
      'target:start',
      'target:end',
      'original:start',
      'original:end',
      'related:start',
      'related:end',
      'external:start',
      'external:end'
    ])
    assert.equal(result.externalOrderItemsById.get(ids.itemB), externalItem)
  })

  it('does not query external OrderItems when no external IDs exist', async () => {
    let externalQueries = 0
    const service = new OrderInventoryRepairReadService({
      orderItemManager: {
        async getByOrderId() { return [] },
        async getByIds() {
          externalQueries += 1
          return []
        }
      },
      productUnitManager: {
        async getByIdsIncludingDeleted() {
          return [{ _id: objectId(ids.unitA), orderId: objectId(ids.order) }]
        },
        async getRelatedByOrderId() { return [] }
      }
    })

    const result = await service.loadAuthoritativeInputs({
      orderId: ids.order,
      originalProductUnitIds: [ids.unitA]
    })

    assert.equal(externalQueries, 0)
    assert.deepEqual(result.externalOrderItemIds, [])
  })

  it('stops after a target OrderItem read failure and preserves the original error', async () => {
    const mongoError = new Error('target read failed')
    const calls = []
    const service = new OrderInventoryRepairReadService({
      orderItemManager: {
        async getByOrderId() {
          calls.push('target')
          throw mongoError
        },
        async getByIds() { calls.push('external') }
      },
      productUnitManager: {
        async getByIdsIncludingDeleted() { calls.push('original') },
        async getRelatedByOrderId() { calls.push('related') }
      }
    })

    await assert.rejects(
      service.loadAuthoritativeInputs({
        orderId: ids.order,
        originalProductUnitIds: [ids.unitA]
      }),
      (error) => error === mongoError
    )
    assert.deepEqual(calls, ['target'])
  })

  it('stops after an original ProductUnit read failure and preserves the original error', async () => {
    const mongoError = new Error('original read failed')
    const calls = []
    const service = new OrderInventoryRepairReadService({
      orderItemManager: {
        async getByOrderId() {
          calls.push('target')
          return []
        },
        async getByIds() { calls.push('external') }
      },
      productUnitManager: {
        async getByIdsIncludingDeleted() {
          calls.push('original')
          throw mongoError
        },
        async getRelatedByOrderId() { calls.push('related') }
      }
    })

    await assert.rejects(
      service.loadAuthoritativeInputs({
        orderId: ids.order,
        originalProductUnitIds: [ids.unitA]
      }),
      (error) => error === mongoError
    )
    assert.deepEqual(calls, ['target', 'original'])
  })

  it('propagates manager query errors without wrapping them', async () => {
    const mongoError = new Error('simulated Mongo read error')
    const service = new OrderInventoryRepairReadService({
      productUnitManager: {
        async getByIdsIncludingDeleted() { throw mongoError }
      },
      orderItemManager: {}
    })

    await assert.rejects(
      service.loadOriginalProductUnits([ids.unitA]),
      (error) => error === mongoError
    )
  })
})
