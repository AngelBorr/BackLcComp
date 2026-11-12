/* eslint-env mocha */
import assert from 'node:assert/strict'
import mongoose from 'mongoose'
import ProductUnitManager from '../../src/dao/managers/productUnit.manager.js'
import ProductUnitModel from '../../src/dao/models/productUnit.model.js'
import { PLAN_OUTCOMES } from '../../src/services/orderInventoryRepairPlanner.service.js'
import {
  OrderInventoryRepairSelectorService
} from '../../src/services/orderInventoryRepairSelector.service.js'

const ids = Object.freeze({
  order: '507f1f77bcf86cd799439001',
  itemA: '507f1f77bcf86cd799439011',
  itemB: '507f1f77bcf86cd799439012',
  productA: '507f1f77bcf86cd799439021',
  productB: '507f1f77bcf86cd799439022',
  unitA: '507f1f77bcf86cd799439031',
  unitB: '507f1f77bcf86cd799439032',
  unitC: '507f1f77bcf86cd799439033',
  unitD: '507f1f77bcf86cd799439034',
  reclaimA: '507f1f77bcf86cd799439041'
})

const objectId = (value) => new mongoose.Types.ObjectId(value)
const asId = (value) => String(value).toLowerCase()

const deferred = () => {
  let resolveGate
  let rejectGate
  const promise = new Promise((resolve, reject) => {
    resolveGate = resolve
    rejectGate = reject
  })
  return { promise, resolve: resolveGate, reject: rejectGate }
}

const candidate = ({
  id = ids.unitA,
  productId = ids.productA,
  serialNumber = `SERIAL-${id.slice(-2).toUpperCase()}`,
  createdAt = new Date('2026-11-01T10:00:00.000Z'),
  ...overrides
} = {}) => ({
  _id: objectId(id),
  productId: objectId(productId),
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
  createdAt,
  ...overrides
})

const itemPlan = ({
  orderItemId = ids.itemA,
  productId = ids.productA,
  replacementCount = 1,
  reclaimUnitIds = []
} = {}) => ({
  orderItemId,
  productId,
  quantity: replacementCount + reclaimUnitIds.length,
  preserveReserved: [],
  alreadySold: [],
  reclaimAvailableOriginals: reclaimUnitIds.map((productUnitId) => ({ productUnitId })),
  replaceableDeficitOriginals: [],
  replacementCount,
  blocked: []
})

const readyPlan = ({ items = [itemPlan()], globalExcludedProductUnitIds } = {}) => {
  const reclaimIds = items.flatMap((item) => (
    item.reclaimAvailableOriginals.map((entry) => entry.productUnitId)
  ))
  return {
    outcome: PLAN_OUTCOMES.READY,
    repairable: true,
    eligibility: { allowed: true },
    orderId: ids.order,
    items,
    replacementCount: items.reduce((total, item) => total + item.replacementCount, 0),
    globalExcludedProductUnitIds: globalExcludedProductUnitIds ?? reclaimIds,
    blocked: []
  }
}

const makeService = (implementation) => {
  const calls = []
  const manager = {
    async findAvailableRepairCandidates(input, options) {
      calls.push({ input, options })
      return implementation ? implementation(input, options, calls.length - 1) : []
    }
  }
  return {
    calls,
    service: new OrderInventoryRepairSelectorService({ productUnitManager: manager })
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
  limit(value) {
    capture.limit = value
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

describe('P1C-B0B F2B deterministic inventory repair selector', () => {
  let originalFind

  beforeEach(() => {
    originalFind = ProductUnitModel.find
  })

  afterEach(() => {
    ProductUnitModel.find = originalFind
  })

  it('manager queries the exact product with strict available and deletion state', async () => {
    const capture = {}
    const productId = objectId(ids.productA)
    ProductUnitModel.find = (filter) => {
      capture.filter = filter
      return queryResult([], capture)
    }

    await ProductUnitManager.findAvailableRepairCandidates({ productId, limit: 2 })

    assert.equal(capture.filter.productId, productId)
    assert.equal(capture.filter.status, 'available')
    assert.equal(capture.filter.isDeleted, false)
  })

  it('manager requires every ownership, reservation and sale reference to exist as null', async () => {
    const capture = {}
    ProductUnitModel.find = (filter) => {
      capture.filter = filter
      return queryResult([], capture)
    }

    await ProductUnitManager.findAvailableRepairCandidates({
      productId: objectId(ids.productA),
      limit: 1
    })

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
    assert.equal(Object.hasOwn(capture.filter, 'invoiceId'), false)
  })

  it('manager requires a string serial containing non-whitespace characters', async () => {
    const capture = {}
    ProductUnitModel.find = (filter) => {
      capture.filter = filter
      return queryResult([], capture)
    }

    await ProductUnitManager.findAvailableRepairCandidates({
      productId: objectId(ids.productA),
      limit: 1
    })

    assert.equal(capture.filter.serialNumber.$type, 'string')
    assert.equal(capture.filter.serialNumber.$regex.source, '\\S')
  })

  it('manager requires BSON date createdAt and exact FIFO sort and limit', async () => {
    const capture = {}
    ProductUnitModel.find = (filter) => {
      capture.filter = filter
      return queryResult([], capture)
    }

    await ProductUnitManager.findAvailableRepairCandidates({
      productId: objectId(ids.productA),
      limit: 3
    })

    assert.deepEqual(capture.filter.createdAt, { $type: 'date' })
    assert.deepEqual(capture.sort, { createdAt: 1, _id: 1 })
    assert.equal(capture.limit, 3)
    assert.equal(capture.lean, true)
  })

  it('manager uses explicit ObjectIds in $nin and propagates the same session', async () => {
    const capture = {}
    const session = { id: 'transaction' }
    const excludeIds = [objectId(ids.unitA), objectId(ids.unitB)]
    ProductUnitModel.find = (filter) => {
      capture.filter = filter
      return queryResult([], capture)
    }

    await ProductUnitManager.findAvailableRepairCandidates(
      { productId: objectId(ids.productA), excludeIds, limit: 1 },
      { session }
    )

    assert.deepEqual(capture.filter._id, { $nin: excludeIds })
    assert(capture.filter._id.$nin.every((id) => id instanceof mongoose.Types.ObjectId))
    assert.equal(capture.session, session)
  })

  it('manager omits $nin when exclusions are empty', async () => {
    const capture = {}
    ProductUnitModel.find = (filter) => {
      capture.filter = filter
      return queryResult([], capture)
    }

    await ProductUnitManager.findAvailableRepairCandidates({
      productId: objectId(ids.productA),
      excludeIds: [],
      limit: 1
    })

    assert.equal(Object.hasOwn(capture.filter, '_id'), false)
  })

  it('selects exact candidates and returns only candidate semantics', async () => {
    const unit = candidate()
    const { service } = makeService(async () => [unit])
    const result = await service.selectCandidates(readyPlan())

    assert.deepEqual(result.selectedNewProductUnitIds, [ids.unitA])
    assert.deepEqual(result.byOrderItem[0].newReplacementCandidates, [unit])
    assert.deepEqual(result.byOrderItem[0].newReplacementCandidateIds, [ids.unitA])
    assert.equal(Object.hasOwn(result.byOrderItem[0], 'assigned'), false)
    assert.equal(Object.hasOwn(result.byOrderItem[0], 'sold'), false)
  })

  it('does not query the manager when replacementCount is zero', async () => {
    const plan = readyPlan({ items: [itemPlan({ replacementCount: 0 })] })
    const { service, calls } = makeService(async () => {
      throw new Error('manager must not be called')
    })

    const result = await service.selectCandidates(plan)

    assert.equal(calls.length, 0)
    assert.deepEqual(result.byOrderItem[0].newReplacementCandidates, [])
    assert.deepEqual(result.byOrderItem[0].newReplacementCandidateIds, [])
  })

  it('fails closed with complete details when inventory is insufficient', async () => {
    const { service } = makeService(async () => [candidate()])
    const plan = readyPlan({ items: [itemPlan({ replacementCount: 2 })] })

    await assert.rejects(service.selectCandidates(plan), (error) => (
      error.code === 'INSUFFICIENT_REPAIR_INVENTORY' &&
      error.details.orderItemId === ids.itemA &&
      error.details.productId === ids.productA &&
      error.details.required === 2 &&
      error.details.available === 1
    ))
  })

  it('passes replacementCount unchanged as the exact manager limit', async () => {
    const units = [
      candidate(),
      candidate({ id: ids.unitB, createdAt: new Date('2026-11-01T10:00:01.000Z') })
    ]
    const { service, calls } = makeService(async () => units)

    await service.selectCandidates(readyPlan({ items: [itemPlan({ replacementCount: 2 })] }))

    assert.equal(calls[0].input.limit, 2)
  })

  it('propagates exactly the same session reference to every query', async () => {
    const session = { id: 'same-session' }
    const items = [
      itemPlan(),
      itemPlan({ orderItemId: ids.itemB, productId: ids.productB })
    ]
    const units = [candidate(), candidate({ id: ids.unitB, productId: ids.productB })]
    const { service, calls } = makeService(async (input, options, index) => [units[index]])

    await service.selectCandidates(readyPlan({ items }), { session })

    assert.equal(calls.length, 2)
    assert(calls.every((call) => call.options.session === session))
  })

  it('executes manager queries sequentially without overlap', async () => {
    const firstGate = deferred()
    const secondStarted = deferred()
    const items = [itemPlan(), itemPlan({ orderItemId: ids.itemB })]
    const calls = []
    const service = new OrderInventoryRepairSelectorService({
      productUnitManager: {
        async findAvailableRepairCandidates(input) {
          calls.push(input)
          if (calls.length === 1) return firstGate.promise
          secondStarted.resolve()
          return [candidate({ id: ids.unitB, createdAt: new Date('2026-11-01T10:00:01.000Z') })]
        }
      }
    })

    const resultPromise = service.selectCandidates(readyPlan({ items }))
    assert.equal(calls.length, 1)

    firstGate.resolve([candidate()])
    await secondStarted.promise
    assert.equal(calls.length, 2)

    const result = await resultPromise
    assert.deepEqual(result.selectedNewProductUnitIds, [ids.unitA, ids.unitB])
  })

  it('does not reuse candidates across two items for the same product', async () => {
    const items = [
      itemPlan({ replacementCount: 2 }),
      itemPlan({ orderItemId: ids.itemB, replacementCount: 2 })
    ]
    const pool = [ids.unitA, ids.unitB, ids.unitC, ids.unitD].map((id, index) => candidate({
      id,
      createdAt: new Date(`2026-11-01T10:00:0${index}.000Z`)
    }))
    const { service, calls } = makeService(async (input) => {
      const excluded = new Set(input.excludeIds.map(asId))
      return pool.filter((unit) => !excluded.has(asId(unit._id))).slice(0, input.limit)
    })

    const result = await service.selectCandidates(readyPlan({ items }))

    assert.deepEqual(result.byOrderItem[0].newReplacementCandidateIds, [ids.unitA, ids.unitB])
    assert.deepEqual(result.byOrderItem[1].newReplacementCandidateIds, [ids.unitC, ids.unitD])
    assert.deepEqual(calls[1].input.excludeIds.map(asId), [ids.unitA, ids.unitB].sort())
    assert.deepEqual(
      result.finalExcludedProductUnitIds,
      [ids.unitA, ids.unitB, ids.unitC, ids.unitD].sort()
    )
  })

  it('keeps candidate queries isolated by item product', async () => {
    const items = [
      itemPlan(),
      itemPlan({ orderItemId: ids.itemB, productId: ids.productB })
    ]
    const units = [candidate(), candidate({ id: ids.unitB, productId: ids.productB })]
    const { service, calls } = makeService(async (input, options, index) => [units[index]])

    await service.selectCandidates(readyPlan({ items }))

    assert.equal(asId(calls[0].input.productId), ids.productA)
    assert.equal(asId(calls[1].input.productId), ids.productB)
  })

  it('passes every global exclusion to the first query as sorted ObjectIds', async () => {
    const excluded = [ids.unitC, ids.unitA]
    const { service, calls } = makeService(async () => [candidate({ id: ids.unitB })])

    await service.selectCandidates(readyPlan({ globalExcludedProductUnitIds: excluded }))

    assert.deepEqual(calls[0].input.excludeIds.map(asId), [...excluded].sort())
  })

  it('keeps reclaim IDs in output without querying FIFO when replacements are zero', async () => {
    const plan = readyPlan({
      items: [itemPlan({ replacementCount: 0, reclaimUnitIds: [ids.reclaimA] })]
    })
    const { service, calls } = makeService()

    const result = await service.selectCandidates(plan)

    assert.equal(calls.length, 0)
    assert.deepEqual(result.byOrderItem[0].reclaimUnitIds, [ids.reclaimA])
    assert(result.finalExcludedProductUnitIds.includes(ids.reclaimA))
  })

  it('keeps reclaim separate while selecting an additional new replacement', async () => {
    const plan = readyPlan({
      items: [itemPlan({ replacementCount: 1, reclaimUnitIds: [ids.reclaimA] })]
    })
    const { service, calls } = makeService(async () => [candidate()])

    const result = await service.selectCandidates(plan)

    assert.deepEqual(result.byOrderItem[0].reclaimUnitIds, [ids.reclaimA])
    assert.deepEqual(result.byOrderItem[0].newReplacementCandidateIds, [ids.unitA])
    assert(calls[0].input.excludeIds.some((id) => asId(id) === ids.reclaimA))
  })

  it('compares ObjectId candidates against string exclusions by normalized value', async () => {
    const { service } = makeService(async () => [candidate()])
    const plan = readyPlan({ globalExcludedProductUnitIds: [ids.unitA] })

    await assert.rejects(
      service.selectCandidates(plan),
      (error) => error.code === 'AMBIGUOUS_REPAIR_CANDIDATE_SELECTION'
    )
  })

  it('rejects a candidate belonging to another product', async () => {
    const { service } = makeService(async () => [candidate({ productId: ids.productB })])
    await assert.rejects(
      service.selectCandidates(readyPlan()),
      (error) => error.code === 'AMBIGUOUS_REPAIR_CANDIDATE_SELECTION'
    )
  })

  it('rejects candidates without a valid identity or with duplicate identities', async () => {
    const withoutId = candidate()
    delete withoutId._id
    const invalid = makeService(async () => [withoutId])
    await assert.rejects(
      invalid.service.selectCandidates(readyPlan()),
      (error) => error.code === 'AMBIGUOUS_REPAIR_CANDIDATE_SELECTION'
    )

    const duplicate = makeService(async () => [candidate(), candidate()])
    await assert.rejects(
      duplicate.service.selectCandidates(
        readyPlan({ items: [itemPlan({ replacementCount: 2 })] })
      ),
      (error) => error.code === 'AMBIGUOUS_REPAIR_CANDIDATE_SELECTION'
    )
  })

  it('rejects a non-array manager result or more candidates than requested', async () => {
    const nonArray = makeService(async () => null)
    await assert.rejects(
      nonArray.service.selectCandidates(readyPlan()),
      (error) => error.code === 'AMBIGUOUS_REPAIR_CANDIDATE_SELECTION'
    )

    const excessive = makeService(async () => [candidate(), candidate({ id: ids.unitB })])
    await assert.rejects(
      excessive.service.selectCandidates(readyPlan()),
      (error) => error.code === 'AMBIGUOUS_REPAIR_CANDIDATE_SELECTION'
    )
  })

  for (const field of [
    'orderId',
    'orderItemId',
    'reservedByOrderId',
    'reservedAt',
    'reservationExpiresAt',
    'soldByOrderId',
    'soldAt'
  ]) {
    it(`rejects a candidate when ${field} is residual or missing`, async () => {
      const withResidue = candidate({ [field]: field.endsWith('At') ? new Date() : objectId(ids.order) })
      const { service: residueService } = makeService(async () => [withResidue])
      await assert.rejects(
        residueService.selectCandidates(readyPlan()),
        (error) => error.code === 'AMBIGUOUS_REPAIR_CANDIDATE_SELECTION'
      )

      const missing = candidate()
      delete missing[field]
      const { service: missingService } = makeService(async () => [missing])
      await assert.rejects(
        missingService.selectCandidates(readyPlan()),
        (error) => error.code === 'AMBIGUOUS_REPAIR_CANDIDATE_SELECTION'
      )
    })
  }

  it('rejects a candidate whose status is not available', async () => {
    const { service } = makeService(async () => [candidate({ status: 'reserved' })])
    await assert.rejects(
      service.selectCandidates(readyPlan()),
      (error) => error.code === 'AMBIGUOUS_REPAIR_CANDIDATE_SELECTION'
    )
  })

  it('rejects a candidate unless isDeleted is exactly false', async () => {
    for (const isDeleted of [true, undefined]) {
      const unit = candidate({ isDeleted })
      const { service } = makeService(async () => [unit])
      await assert.rejects(
        service.selectCandidates(readyPlan()),
        (error) => error.code === 'AMBIGUOUS_REPAIR_CANDIDATE_SELECTION'
      )
    }
  })

  it('rejects missing, null, string and invalid candidate createdAt', async () => {
    const missingCreatedAt = candidate()
    delete missingCreatedAt.createdAt
    const invalidCandidates = [
      missingCreatedAt,
      candidate({ createdAt: null }),
      candidate({ createdAt: '2026-11-01T10:00:00.000Z' }),
      candidate({ createdAt: new Date('invalid') })
    ]

    for (const unit of invalidCandidates) {
      const { service } = makeService(async () => [unit])
      await assert.rejects(
        service.selectCandidates(readyPlan()),
        (error) => error.code === 'AMBIGUOUS_REPAIR_CANDIDATE_SELECTION'
      )
    }
  })

  it('rejects non-canonical, empty and non-string candidate serials', async () => {
    for (const serialNumber of [' serial-1 ', '   ', 123, null]) {
      const unit = candidate({ serialNumber })
      const { service } = makeService(async () => [unit])
      await assert.rejects(
        service.selectCandidates(readyPlan()),
        (error) => error.code === 'AMBIGUOUS_REPAIR_CANDIDATE_SELECTION'
      )
    }
  })

  it('fails closed when candidates are not in createdAt and _id FIFO order', async () => {
    const later = candidate({ id: ids.unitB, createdAt: new Date('2026-11-01T10:00:01.000Z') })
    const earlier = candidate({ id: ids.unitA, createdAt: new Date('2026-11-01T10:00:00.000Z') })
    const { service } = makeService(async () => [later, earlier])

    await assert.rejects(
      service.selectCandidates(readyPlan({ items: [itemPlan({ replacementCount: 2 })] })),
      (error) => error.code === 'AMBIGUOUS_REPAIR_CANDIDATE_SELECTION'
    )
  })

  it('uses _id as the exact tie-breaker for equal createdAt', async () => {
    const createdAt = new Date('2026-11-01T10:00:00.000Z')
    const higher = candidate({ id: ids.unitB, createdAt })
    const lower = candidate({ id: ids.unitA, createdAt })
    const { service } = makeService(async () => [higher, lower])

    await assert.rejects(
      service.selectCandidates(readyPlan({ items: [itemPlan({ replacementCount: 2 })] })),
      (error) => error.code === 'AMBIGUOUS_REPAIR_CANDIDATE_SELECTION'
    )
  })

  it('preserves Mongo error identity, code and labels', async () => {
    const mongoError = new Error('simulated Mongo read failure')
    mongoError.code = 251
    mongoError.errorLabels = ['TransientTransactionError']
    const { service } = makeService(async () => { throw mongoError })

    await assert.rejects(service.selectCandidates(readyPlan()), (error) => (
      error === mongoError &&
      error.code === 251 &&
      error.errorLabels === mongoError.errorLabels
    ))
  })

  it('returns deep-equal output for the same plan and candidates', async () => {
    const plan = readyPlan()
    const first = makeService(async () => [candidate()])
    const second = makeService(async () => [candidate()])

    assert.deepEqual(
      await first.service.selectCandidates(plan),
      await second.service.selectCandidates(plan)
    )
  })

  it('does not mutate a deeply frozen plan or frozen candidates', async () => {
    const plan = deepFreeze(readyPlan())
    const unit = Object.freeze(candidate())
    const snapshot = JSON.stringify(plan)
    const { service } = makeService(async () => [unit])

    await service.selectCandidates(plan)

    assert.equal(JSON.stringify(plan), snapshot)
    assert.equal(Object.isFrozen(plan), true)
    assert.equal(Object.isFrozen(unit), true)
  })

  it('rejects non-ready, blocked and non-repairable plans before querying', async () => {
    const variants = [
      { ...readyPlan(), outcome: PLAN_OUTCOMES.BLOCKED },
      { ...readyPlan(), repairable: false },
      { ...readyPlan(), blocked: [{ reason: 'BLOCKED' }] }
    ]
    const { service, calls } = makeService()

    for (const plan of variants) {
      await assert.rejects(
        service.selectCandidates(plan),
        (error) => error.code === 'INVALID_INVENTORY_REPAIR_SELECTOR_INPUT'
      )
    }
    assert.equal(calls.length, 0)
  })

  it('rejects invalid Order, OrderItem, Product and global exclusion IDs', async () => {
    const invalidOrder = { ...readyPlan(), orderId: 'invalid' }
    const invalidItem = readyPlan()
    invalidItem.items[0].orderItemId = null
    const invalidProduct = readyPlan()
    invalidProduct.items[0].productId = true
    const invalidExclusion = readyPlan({ globalExcludedProductUnitIds: ['invalid'] })

    for (const plan of [invalidOrder, invalidItem, invalidProduct, invalidExclusion]) {
      const { service, calls } = makeService()
      await assert.rejects(
        service.selectCandidates(plan),
        (error) => error.code === 'INVALID_INVENTORY_REPAIR_SELECTOR_INPUT'
      )
      assert.equal(calls.length, 0)
    }
  })

  it('rejects a reclaim missing from global exclusions', async () => {
    const plan = readyPlan({
      items: [itemPlan({ replacementCount: 0, reclaimUnitIds: [ids.reclaimA] })],
      globalExcludedProductUnitIds: []
    })
    const { service, calls } = makeService()

    await assert.rejects(
      service.selectCandidates(plan),
      (error) => error.code === 'INVALID_INVENTORY_REPAIR_SELECTOR_INPUT'
    )
    assert.equal(calls.length, 0)
  })

  it('rejects unsafe replacement counts without numeric coercion', async () => {
    for (const replacementCount of ['1', 1.5, -1, Number.MAX_SAFE_INTEGER + 1]) {
      const plan = readyPlan()
      plan.items[0].replacementCount = replacementCount
      plan.replacementCount = replacementCount
      const { service } = makeService()
      await assert.rejects(
        service.selectCandidates(plan),
        (error) => error.code === 'INVALID_INVENTORY_REPAIR_SELECTOR_INPUT'
      )
    }
  })

  it('rejects duplicate OrderItems, global exclusions and reclaim IDs', async () => {
    const duplicateItems = readyPlan({ items: [itemPlan(), itemPlan()] })
    const duplicateExclusions = readyPlan({
      globalExcludedProductUnitIds: [ids.unitA, objectId(ids.unitA)]
    })
    const duplicateReclaim = readyPlan({
      items: [
        itemPlan({ replacementCount: 0, reclaimUnitIds: [ids.reclaimA] }),
        itemPlan({
          orderItemId: ids.itemB,
          replacementCount: 0,
          reclaimUnitIds: [objectId(ids.reclaimA)]
        })
      ],
      globalExcludedProductUnitIds: [ids.reclaimA]
    })

    for (const plan of [duplicateItems, duplicateExclusions, duplicateReclaim]) {
      const { service } = makeService()
      await assert.rejects(
        service.selectCandidates(plan),
        (error) => error.code === 'INVALID_INVENTORY_REPAIR_SELECTOR_INPUT'
      )
    }
  })

  it('rejects a global replacement total inconsistent with item totals', async () => {
    const plan = readyPlan()
    plan.replacementCount = 2
    const { service } = makeService()

    await assert.rejects(
      service.selectCandidates(plan),
      (error) => error.code === 'INVALID_INVENTORY_REPAIR_SELECTOR_INPUT'
    )
  })

  it('uses only the read candidate primitive and never Product or write methods', async () => {
    const calls = []
    const service = new OrderInventoryRepairSelectorService({
      productUnitManager: {
        async findAvailableRepairCandidates() {
          calls.push('findAvailableRepairCandidates')
          return [candidate()]
        },
        update() { calls.push('update') },
        reserveAvailableUnits() { calls.push('reserve') },
        bulkWrite() { calls.push('bulkWrite') }
      }
    })

    await service.selectCandidates(readyPlan())

    assert.deepEqual(calls, ['findAvailableRepairCandidates'])
  })
})
