import { strict as assert } from 'node:assert'
import { describe, it } from 'mocha'
import { ServiceError } from '../../src/services/service.products.js'
import {
  OrderInventoryRepairCommandService,
  inventoryRepairRequestHash,
  normalizeInventoryRepairCommandInput
} from '../../src/services/orderInventoryRepairCommand.service.js'

const ids = Object.freeze({
  order: '64b000000000000000000001',
  payment: '64b000000000000000000002',
  actor: '64b000000000000000000003',
  item: '64b000000000000000000004',
  product: '64b000000000000000000005',
  original: '64b000000000000000000006',
  replacement: '64b000000000000000000007',
  resolution: '64b000000000000000000008'
})

const dates = Object.freeze({
  paymentUpdatedAt: new Date('2026-11-20T12:00:00.500Z'),
  now: new Date('2026-11-20T12:00:00.000Z'),
  approvedAt: new Date('2026-11-20T10:00:00.000Z'),
  reservationExpiresAt: new Date('2026-11-20T11:00:00.000Z')
})

const request = (overrides = {}) => ({
  orderNumber: 'LC-2026-000123',
  idempotencyKey: 'repair:key:000123',
  actorUserId: ids.actor,
  actorRole: 'ADMIN',
  note: 'Reparacion autorizada',
  ...overrides
})

const order = (overrides = {}) => ({
  _id: ids.order,
  orderNumber: 'LC-2026-000123',
  status: 'requires_attention',
  fulfillmentStatus: 'pending',
  attentionReason: 'RESERVATION_EXPIRED',
  attentionResolutionVersion: 0,
  reservationExpiresAt: dates.reservationExpiresAt,
  activeRefundId: null,
  reconciliationNextAt: null,
  reconciliationLeaseOwner: null,
  reconciliationLeaseUntil: null,
  ...overrides
})

const payment = (overrides = {}) => ({
  _id: ids.payment,
  orderId: ids.order,
  provider: 'mercado_pago',
  normalizedStatus: 'approved',
  providerOrderId: 'ORD-123',
  providerPaymentId: 'PAY-123',
  approvedAt: dates.approvedAt,
  externalReference: 'LC-2026-000123',
  amountArs: '20497.40',
  currency: 'ARS',
  providerStatus: 'processed',
  providerStatusDetail: 'accredited',
  updatedAt: dates.paymentUpdatedAt,
  ...overrides
})

const item = () => ({
  _id: ids.item,
  orderId: ids.order,
  productId: ids.product,
  quantity: 1,
  originalReservation: {
    capturedAt: new Date('2026-11-20T09:00:00.000Z'),
    units: [{ productUnitId: ids.original, serial: 'SERIAL-1' }]
  }
})

const authoritative = () => ({
  orderItems: [item()],
  originalProductUnits: [{ _id: ids.original }],
  relatedProductUnits: [],
  externalOrderItemsById: new Map()
})

const plan = () => ({
  outcome: 'PLAN_READY',
  repairable: true,
  blocked: [],
  orderId: ids.order,
  replacementCount: 1,
  globalExcludedProductUnitIds: [ids.original],
  items: [{
    orderItemId: ids.item,
    productId: ids.product,
    quantity: 1,
    preserveReserved: [],
    alreadySold: [],
    reclaimAvailableOriginals: [],
    replaceableDeficitOriginals: [{ productUnitId: ids.original }],
    replacementCount: 1,
    blocked: []
  }]
})

const selection = () => ({
  orderId: ids.order,
  byOrderItem: [{
    orderItemId: ids.item,
    productId: ids.product,
    reclaimUnitIds: [],
    newReplacementCandidates: [{ _id: ids.replacement }],
    newReplacementCandidateIds: [ids.replacement],
    replacementCount: 1
  }],
  selectedNewProductUnitIds: [ids.replacement],
  finalExcludedProductUnitIds: [ids.original, ids.replacement]
})

const finalUnit = () => ({
  _id: ids.replacement,
  serialNumber: 'REPLACEMENT-1',
  status: 'sold',
  productId: ids.product,
  orderId: ids.order,
  orderItemId: ids.item,
  reservedByOrderId: ids.order,
  reservedAt: dates.paymentUpdatedAt,
  reservationExpiresAt: dates.reservationExpiresAt,
  soldByOrderId: ids.order,
  soldAt: new Date(dates.paymentUpdatedAt.getTime() + 1),
  isDeleted: false
})

const completedResolution = ({ requestHash, repairAt, summary, finalResult } = {}) => ({
  _id: ids.resolution,
  orderId: ids.order,
  orderNumber: 'LC-2026-000123',
  paymentId: ids.payment,
  action: 'reassign_inventory',
  status: 'completed',
  idempotencyKey: 'repair:key:000123',
  requestHash: requestHash || inventoryRepairRequestHash(request()),
  repairAt: repairAt || new Date(dates.paymentUpdatedAt.getTime() + 1),
  completedAt: repairAt || new Date(dates.paymentUpdatedAt.getTime() + 1),
  inventoryRepairSummary: summary || {
    alreadySoldCount: 0,
    preservedReservedCount: 0,
    reclaimedOriginalCount: 0,
    replacementCount: 1,
    soldCount: 1
  },
  finalResult: finalResult || {
    outcome: 'completed',
    orderStatus: 'paid',
    paymentStatus: 'approved',
    fulfillmentStatus: 'preparing',
    attentionResolutionVersion: 1
  }
})

const makeHarness = (options = {}) => {
  const events = []
  const captured = {
    prepared: [],
    fence: [],
    writes: [],
    orderCas: [],
    completed: [],
    readInputs: [],
    plans: [],
    selections: []
  }
  let ended = 0
  let transactionCalls = 0
  let orderReads = 0
  let paymentReads = 0
  let keyReads = 0
  const session = {
    inTransaction: () => true,
    async withTransaction(callback, transactionOptions) {
      transactionCalls += 1
      captured.transactionOptions = transactionOptions
      const attempts = options.callbackAttempts || 1
      let result
      for (let attempt = 0; attempt < attempts; attempt += 1) result = await callback()
      return result
    },
    async endSession() { ended += 1 }
  }

  const resolutionManager = {
    async findByIdempotencyKey() {
      keyReads += 1
      events.push('idempotency')
      if (options.findByKey) return options.findByKey(keyReads)
      return []
    },
    async findCompletedByOrderAndAction() {
      events.push('completed-gate')
      return options.completedByOrder || null
    }
  }
  const orderManager = {
    async getByOrderNumber() {
      orderReads += 1
      if (options.orderMissing) return null
      return order(options.orderOverrides)
    },
    async completeInventoryRepairAttention(orderId, input, callOptions) {
      events.push('order-cas')
      captured.orderCas.push({ orderId, input, options: callOptions })
      if (options.orderCasError) throw options.orderCasError
      return { matchedCount: 1, modifiedCount: 1 }
    }
  }
  const paymentManager = {
    async getLatestByOrderId() {
      paymentReads += 1
      return payment(paymentReads === 1
        ? options.preflightPaymentOverrides
        : options.freshPaymentOverrides)
    },
    async fenceApprovedInventoryRepairEvidence(input, callOptions) {
      events.push('payment-fence')
      captured.fence.push({ input, options: callOptions })
      if (options.fenceError) throw options.fenceError
      return { matchedCount: 1, modifiedCount: 1 }
    }
  }
  const orderItemManager = {
    async getByOrderId() {
      events.push('ledger-read')
      return [item()]
    }
  }
  const readService = {
    async loadAuthoritativeInputs(input, callOptions) {
      events.push('f2a')
      const result = authoritative()
      captured.readInputs.push({ input, options: callOptions, result })
      return result
    }
  }
  const plannerService = {
    buildInventoryRepairPlan(input) {
      events.push('planner')
      const result = options.planResult ? options.planResult() : plan()
      captured.plans.push({ input, result })
      return result
    }
  }
  const selectorService = {
    async selectCandidates(inputPlan, callOptions) {
      events.push('f2b')
      if (options.selectorError) throw options.selectorError
      const result = selection()
      captured.selections.push({ plan: inputPlan, options: callOptions, result })
      return result
    }
  }
  const writerService = {
    async writeRepair(input, callOptions) {
      events.push('f2c')
      captured.writes.push({ input, options: callOptions })
      if (options.writerError) throw options.writerError
      return {
        orderId: ids.order,
        repairAt: input.repairAt,
        affectedProductIds: [ids.product],
        selectedNewProductUnitIds: [ids.replacement],
        byOrderItem: [{ orderItemId: ids.item }],
        verifiedSoldProductUnitIds: [ids.replacement]
      }
    }
  }
  const resolutionService = {
    async createPreparedInventoryRepairResolution(input, callOptions) {
      events.push('prepared')
      captured.prepared.push({ input, options: callOptions })
      if (options.preparedError) throw options.preparedError
      return { _id: ids.resolution, ...input, status: 'prepared' }
    },
    async completeInventoryRepairResolution(input, callOptions) {
      events.push('complete-resolution')
      captured.completed.push({ input, options: callOptions })
      if (options.completeError) throw options.completeError
      return completedResolution({
        requestHash: input.requestHash,
        repairAt: input.completedAt,
        summary: input.inventoryRepairSummary,
        finalResult: input.finalResult
      })
    }
  }
  const productUnitManager = {
    async getByIds() {
      events.push('final-units')
      return options.finalUnits || [finalUnit()]
    }
  }

  const service = new OrderInventoryRepairCommandService({
    mongooseInstance: {
      async startSession() {
        if (options.startSessionError) throw options.startSessionError
        return session
      }
    },
    orderManager,
    orderItemManager,
    paymentManager,
    productUnitManager,
    resolutionManager,
    resolutionService,
    readService,
    plannerService,
    selectorService,
    writerService,
    attentionClassifier: (...args) => {
      events.push('classification')
      return options.attentionClassifier
        ? options.attentionClassifier(...args)
        : { attentionCategory: 'APPROVED_INVENTORY_ATTENTION' }
    },
    clock: options.clock || (() => dates.now)
  })

  return {
    service,
    events,
    captured,
    counts: () => ({ ended, transactionCalls, orderReads, paymentReads, keyReads })
  }
}

describe('OrderInventoryRepairCommandService', () => {
  describe('input validation and hashing', () => {
    for (const [label, mutate, code] of [
      ['missing input', () => null, 'INVALID_INVENTORY_REPAIR_INPUT'],
      ['invalid order number', (value) => ({ ...value, orderNumber: '123' }), 'INVALID_ORDER_NUMBER'],
      ['short key', (value) => ({ ...value, idempotencyKey: 'short' }), 'ATTENTION_RESOLUTION_IDEMPOTENCY_KEY_REQUIRED'],
      ['invalid key character', (value) => ({ ...value, idempotencyKey: 'repair/key' }), 'ATTENTION_RESOLUTION_IDEMPOTENCY_KEY_REQUIRED'],
      ['invalid actor', (value) => ({ ...value, actorUserId: 'invalid' }), 'ADMIN_UNAUTHENTICATED'],
      ['USER role', (value) => ({ ...value, actorRole: 'USER' }), 'ORDERS_ADMIN_FORBIDDEN'],
      ['PREMIUM role', (value) => ({ ...value, actorRole: 'PREMIUM' }), 'ORDERS_ADMIN_FORBIDDEN'],
      ['non-string note', (value) => ({ ...value, note: 123 }), 'INVALID_ATTENTION_NOTE'],
      ['long note', (value) => ({ ...value, note: 'x'.repeat(2001) }), 'INVALID_ATTENTION_NOTE'],
      ['extra authoritative field', (value) => ({ ...value, plan: {} }), 'INVALID_INVENTORY_REPAIR_INPUT']
    ]) {
      it(`rejects ${label} before opening a session`, async () => {
        const setup = makeHarness()
        await assert.rejects(
          setup.service.repairApprovedOrderInventory(mutate(request())),
          (error) => error.code === code
        )
        assert.equal(setup.counts().transactionCalls, 0)
      })
    }

    it('accepts ADMIN/SUPERADMIN and normalizes optional note deterministically', () => {
      const admin = normalizeInventoryRepairCommandInput(request({ note: '  note  ' }))
      const superadmin = normalizeInventoryRepairCommandInput(request({
        actorRole: 'superadmin',
        note: '   '
      }))
      assert.equal(admin.note, 'note')
      assert.equal(superadmin.actorRole, 'SUPERADMIN')
      assert.equal(superadmin.note, null)
    })

    it('builds a stable hash from order/action/note and excludes actor identity', () => {
      const first = inventoryRepairRequestHash(request({ actorUserId: ids.actor }))
      const second = inventoryRepairRequestHash(request({
        actorUserId: '64b000000000000000000099',
        actorRole: 'SUPERADMIN'
      }))
      assert.equal(first, second)
      assert.match(first, /^[a-f0-9]{64}$/)
      assert.notEqual(first, inventoryRepairRequestHash(request({ note: 'other' })))
    })
  })

  it('generates repairAt strictly after preflight Payment.updatedAt and delegates exact fence data', async () => {
    const setup = makeHarness()
    await setup.service.repairApprovedOrderInventory(request())
    const fence = setup.captured.fence[0].input
    assert.equal(fence.repairAt.getTime(), dates.paymentUpdatedAt.getTime() + 1)
    assert.equal(fence.expectedUpdatedAt.getTime(), dates.paymentUpdatedAt.getTime())
    assert.equal(fence.providerPaymentId, 'PAY-123')
    assert.equal(fence.amountArs, '20497.40')
  })

  it('fails closed when fresh Payment.updatedAt is equal to or newer than repairAt', async () => {
    for (const delta of [1, 2]) {
      const setup = makeHarness({
        freshPaymentOverrides: {
          updatedAt: new Date(dates.paymentUpdatedAt.getTime() + delta)
        }
      })
      await assert.rejects(
        setup.service.repairApprovedOrderInventory(request()),
        (error) => error.code === 'INVENTORY_REPAIR_PAYMENT_FENCE_TIMESTAMP_CONFLICT'
      )
      assert.equal(setup.captured.prepared.length, 0)
      assert.equal(setup.counts().ended, 1)
    }
  })

  it('returns a same-key/same-hash completed replay without session or writes', async () => {
    const resolution = completedResolution()
    const setup = makeHarness({ findByKey: () => [resolution] })
    const result = await setup.service.repairApprovedOrderInventory(request())
    assert.equal(result.idempotent, true)
    assert.equal(result.resolutionId, ids.resolution)
    assert.deepEqual(result.summary, {
      alreadySoldCount: 0,
      preservedReservedCount: 0,
      reclaimedOriginalCount: 0,
      replacementCount: 1,
      soldCount: 1
    })
    assert.equal(setup.counts().transactionCalls, 0)
  })

  it('rechecks same-key replay inside the transaction before F2A', async () => {
    const resolution = completedResolution()
    const setup = makeHarness({
      findByKey: (read) => read === 2 ? [resolution] : []
    })
    const result = await setup.service.repairApprovedOrderInventory(request())
    assert.equal(result.idempotent, true)
    assert.equal(setup.counts().transactionCalls, 1)
    assert.equal(setup.counts().ended, 1)
    assert.equal(setup.events.includes('f2a'), false)
  })

  it('rejects same key with different request and non-completed persisted states', async () => {
    const different = completedResolution({ requestHash: 'a'.repeat(64) })
    const setupDifferent = makeHarness({ findByKey: () => [different] })
    await assert.rejects(
      setupDifferent.service.repairApprovedOrderInventory(request()),
      (error) => error.code === 'IDEMPOTENCY_KEY_REUSED' && error.status === 409
    )

    const prepared = { ...completedResolution(), status: 'prepared' }
    const setupPrepared = makeHarness({ findByKey: () => [prepared] })
    await assert.rejects(
      setupPrepared.service.repairApprovedOrderInventory(request()),
      (error) => error.code === 'ATTENTION_RESOLUTION_STATE_CONFLICT'
    )
  })

  it('rejects a different key when the Order/action already completed before planning', async () => {
    const setup = makeHarness({ completedByOrder: completedResolution() })
    await assert.rejects(
      setup.service.repairApprovedOrderInventory(request()),
      (error) => error.code === 'ATTENTION_INVENTORY_REPAIR_ALREADY_COMPLETED'
    )
    assert.equal(setup.captured.plans.length, 0)
    assert.equal(setup.counts().ended, 1)
  })

  it('rejects wrong attention classification before completed gate and Planner', async () => {
    const setup = makeHarness({
      attentionClassifier: () => ({ attentionCategory: 'FINANCIAL_INCONSISTENCY' })
    })
    await assert.rejects(
      setup.service.repairApprovedOrderInventory(request()),
      (error) => error.code === 'ATTENTION_INVENTORY_REPAIR_NOT_ALLOWED'
    )
    assert.equal(setup.events.includes('completed-gate'), false)
    assert.equal(setup.events.includes('planner'), false)
  })

  it('rejects a blocked plan before prepared Resolution and preserves safe blockers', async () => {
    const setup = makeHarness({
      planResult: () => ({
        outcome: 'BLOCKED',
        repairable: false,
        blocked: [{ reason: 'ORIGINAL_MISSING', category: 'DATA_CORRUPTION', internal: 'hidden' }]
      })
    })
    await assert.rejects(
      setup.service.repairApprovedOrderInventory(request()),
      (error) => {
        assert.equal(error.code, 'INVENTORY_REPAIR_PLAN_BLOCKED')
        assert.deepEqual(error.details.blockers, [{
          reason: 'ORIGINAL_MISSING',
          category: 'DATA_CORRUPTION'
        }])
        return true
      }
    )
    assert.equal(setup.captured.prepared.length, 0)
  })

  it('propagates insufficient inventory and rolls back before fence/writer/Order CAS', async () => {
    const selectorError = new ServiceError(
      'Sin inventario',
      'INSUFFICIENT_REPAIR_INVENTORY',
      409
    )
    const setup = makeHarness({ selectorError })
    await assert.rejects(
      setup.service.repairApprovedOrderInventory(request()),
      (error) => error === selectorError
    )
    assert.equal(setup.captured.prepared.length, 1)
    assert.equal(setup.captured.fence.length, 0)
    assert.equal(setup.captured.writes.length, 0)
    assert.equal(setup.captured.orderCas.length, 0)
  })

  it('executes the integral command order and uses snapshot/majority transaction options', async () => {
    const setup = makeHarness()
    await setup.service.repairApprovedOrderInventory(request())
    assert.deepEqual(setup.events.slice(1), [
      'idempotency',
      'ledger-read',
      'f2a',
      'classification',
      'completed-gate',
      'planner',
      'prepared',
      'f2b',
      'payment-fence',
      'f2c',
      'final-units',
      'order-cas',
      'complete-resolution'
    ])
    assert.deepEqual(setup.captured.transactionOptions, {
      readConcern: { level: 'snapshot' },
      writeConcern: { w: 'majority' }
    })
  })

  it('creates prepared before writes from DB evidence and normalizes note to null', async () => {
    const setup = makeHarness()
    await setup.service.repairApprovedOrderInventory(request({ note: '   ' }))
    const prepared = setup.captured.prepared[0]
    assert.equal(prepared.input.note, null)
    assert.equal(prepared.input.orderId, ids.order)
    assert.equal(prepared.input.paymentId, ids.payment)
    assert.equal(prepared.input.previousState.paymentProviderPaymentId, 'PAY-123')
    assert.equal(prepared.input.previousState.paymentAmountArs, '20497.40')
    assert.equal(prepared.options.session, setup.captured.fence[0].options.session)
    assert(setup.events.indexOf('prepared') < setup.events.indexOf('payment-fence'))
  })

  it('delegates F2C even for an already-satisfied no-op plan', async () => {
    const setup = makeHarness({
      planResult: () => ({
        ...plan(),
        replacementCount: 0,
        items: [{
          ...plan().items[0],
          alreadySold: [{ productUnitId: ids.original }],
          replaceableDeficitOriginals: [],
          replacementCount: 0
        }]
      })
    })
    setup.service.selector.selectCandidates = async (inputPlan, callOptions) => ({
      orderId: ids.order,
      byOrderItem: [{
        orderItemId: ids.item,
        productId: ids.product,
        reclaimUnitIds: [],
        newReplacementCandidates: [],
        newReplacementCandidateIds: [],
        replacementCount: 0
      }],
      selectedNewProductUnitIds: [],
      finalExcludedProductUnitIds: [ids.original],
      callOptions,
      inputPlan
    })
    await setup.service.repairApprovedOrderInventory(request())
    assert.equal(setup.captured.writes.length, 1)
  })

  it('calls Order CAS only after F2C verification and completes Resolution after Order CAS', async () => {
    const setup = makeHarness()
    await setup.service.repairApprovedOrderInventory(request())
    assert(setup.events.indexOf('f2c') < setup.events.indexOf('order-cas'))
    assert(setup.events.indexOf('order-cas') < setup.events.indexOf('complete-resolution'))
    const orderCas = setup.captured.orderCas[0].input
    assert.equal(orderCas.expectedAttentionResolutionVersion, 0)
    assert.equal(orderCas.paymentApprovedAt.getTime(), dates.approvedAt.getTime())
    assert.equal(orderCas.actorUserId, ids.actor)
  })

  it('does not call Order CAS when F2C fails and does not complete Resolution when Order CAS fails', async () => {
    const writerError = new ServiceError('CAS', 'INVENTORY_REPAIR_CAS_CONFLICT', 409)
    const writerFailure = makeHarness({ writerError })
    await assert.rejects(
      writerFailure.service.repairApprovedOrderInventory(request()),
      (error) => error === writerError
    )
    assert.equal(writerFailure.captured.orderCas.length, 0)
    assert.equal(writerFailure.captured.completed.length, 0)

    const orderError = new ServiceError('Order CAS', 'INVENTORY_REPAIR_ORDER_STATE_CHANGED', 409)
    const orderFailure = makeHarness({ orderCasError: orderError })
    await assert.rejects(
      orderFailure.service.repairApprovedOrderInventory(request()),
      (error) => error === orderError
    )
    assert.equal(orderFailure.captured.completed.length, 0)
  })

  it('builds and persists the per-item summary and returns a safe completed result', async () => {
    const setup = makeHarness()
    const result = await setup.service.repairApprovedOrderInventory(request())
    const completion = setup.captured.completed[0].input
    assert.deepEqual(completion.inventoryRepairSummary.items[0], {
      orderItemId: ids.item,
      productId: ids.product,
      alreadySoldProductUnitIds: [],
      preservedReservedProductUnitIds: [],
      reclaimedOriginalProductUnitIds: [],
      replacementProductUnitIds: [ids.replacement]
    })
    assert.equal(completion.inventoryRepairSummary.soldCount, 1)
    assert.equal(completion.finalResult.attentionResolutionVersion, 1)
    assert.equal(result.idempotent, false)
    assert.equal(result.orderStatus, 'paid')
    assert.equal(result.paymentStatus, 'approved')
    assert.equal(result.fulfillmentStatus, 'preparing')
    assert.equal(Object.hasOwn(result, 'serialNumber'), false)
    assert.equal(Object.hasOwn(result, 'providerPaymentId'), false)
    assert.equal(setup.counts().ended, 1)
  })

  it('does not request any financial mutation beyond the exact Payment fence', async () => {
    const setup = makeHarness()
    await setup.service.repairApprovedOrderInventory(request())
    assert.deepEqual(Object.keys(setup.captured.fence[0].input).sort(), [
      'amountArs',
      'approvedAt',
      'currency',
      'expectedUpdatedAt',
      'externalReference',
      'normalizedStatus',
      'orderId',
      'paymentId',
      'provider',
      'providerOrderId',
      'providerPaymentId',
      'repairAt'
    ])
  })

  it('reconstructs F2A/Planner/F2B/fence/F2C/CAS on driver retry with stable hash and repairAt', async () => {
    const setup = makeHarness({ callbackAttempts: 2 })
    await setup.service.repairApprovedOrderInventory(request())
    assert.equal(setup.captured.readInputs.length, 2)
    assert.equal(setup.captured.plans.length, 2)
    assert.equal(setup.captured.selections.length, 2)
    assert.equal(setup.captured.fence.length, 2)
    assert.equal(setup.captured.writes.length, 2)
    assert.equal(setup.captured.orderCas.length, 2)
    assert.notEqual(setup.captured.readInputs[0].result, setup.captured.readInputs[1].result)
    assert.notEqual(setup.captured.plans[0].result, setup.captured.plans[1].result)
    assert.notEqual(setup.captured.selections[0].result, setup.captured.selections[1].result)
    assert.equal(
      setup.captured.prepared[0].input.requestHash,
      setup.captured.prepared[1].input.requestHash
    )
    assert.equal(
      setup.captured.prepared[0].input.repairAt.getTime(),
      setup.captured.prepared[1].input.repairAt.getTime()
    )
  })

  it('does not manually retry a non-transient domain CAS conflict', async () => {
    const domainError = new ServiceError(
      'Payment changed',
      'INVENTORY_REPAIR_PAYMENT_EVIDENCE_CHANGED',
      409
    )
    const setup = makeHarness({ fenceError: domainError })
    await assert.rejects(
      setup.service.repairApprovedOrderInventory(request()),
      (error) => error === domainError
    )
    assert.equal(setup.counts().transactionCalls, 1)
    assert.equal(setup.captured.fence.length, 1)
    assert.equal(setup.counts().ended, 1)
  })

  it('maps an unexpected final error safely and always closes the session', async () => {
    const setup = makeHarness({ writerError: new Error('sensitive internal diagnostic') })
    await assert.rejects(
      setup.service.repairApprovedOrderInventory(request()),
      (error) => {
        assert.equal(error.code, 'INVENTORY_REPAIR_FAILED')
        assert.equal(error.status, 500)
        assert.equal(error.message.includes('internal diagnostic'), false)
        return true
      }
    )
    assert.equal(setup.counts().ended, 1)
  })

  it('maps an unexpected session-open error through the same safe boundary', async () => {
    const setup = makeHarness({ startSessionError: new Error('sensitive internal diagnostic') })
    await assert.rejects(
      setup.service.repairApprovedOrderInventory(request()),
      (error) => {
        assert.equal(error.code, 'INVENTORY_REPAIR_FAILED')
        assert.equal(error.status, 500)
        assert.equal(error.message.includes('internal diagnostic'), false)
        return true
      }
    )
    assert.equal(setup.counts().ended, 0)
  })

  it('converges a same-key duplicate race to replay after session cleanup', async () => {
    const duplicate = Object.assign(new Error('duplicate'), {
      code: 11000,
      keyPattern: { idempotencyKey: 1 },
      keyValue: { idempotencyKey: 'repair:key:000123' }
    })
    const resolution = completedResolution()
    const setup = makeHarness({
      preparedError: duplicate,
      findByKey: (read) => read >= 3 ? [resolution] : []
    })
    const result = await setup.service.repairApprovedOrderInventory(request())
    assert.equal(result.idempotent, true)
    assert.equal(setup.counts().ended, 1)
  })

  it('maps same-key different-request and historical compound duplicates correctly', async () => {
    const duplicate = Object.assign(new Error('duplicate'), {
      code: 11000,
      keyPattern: { orderId: 1, idempotencyKey: 1 },
      keyValue: { orderId: ids.order, idempotencyKey: 'repair:key:000123' }
    })
    const different = completedResolution({ requestHash: 'b'.repeat(64) })
    const setup = makeHarness({
      preparedError: duplicate,
      findByKey: (read) => read >= 3 ? [different] : []
    })
    await assert.rejects(
      setup.service.repairApprovedOrderInventory(request()),
      (error) => error.code === 'IDEMPOTENCY_KEY_REUSED'
    )
    assert.equal(setup.counts().ended, 1)
  })

  it('maps completed Order/action duplicate races to the administrative conflict', async () => {
    const duplicate = Object.assign(new Error('duplicate'), {
      code: 11000,
      keyPattern: { orderId: 1, action: 1 },
      keyValue: { orderId: ids.order, action: 'reassign_inventory' }
    })
    const setup = makeHarness({
      preparedError: duplicate,
      completedByOrder: completedResolution()
    })
    await assert.rejects(
      setup.service.repairApprovedOrderInventory(request()),
      (error) => error.code === 'ATTENTION_INVENTORY_REPAIR_ALREADY_COMPLETED'
    )
    assert.equal(setup.counts().ended, 1)
  })

  it('maps an unclassified duplicate safely without relying on the message', async () => {
    const duplicate = Object.assign(new Error('idempotencyKey in message only'), {
      code: 11000,
      keyPattern: { unknown: 1 },
      keyValue: { unknown: 'x' }
    })
    const setup = makeHarness({ preparedError: duplicate })
    await assert.rejects(
      setup.service.repairApprovedOrderInventory(request()),
      (error) => error.code === 'INVENTORY_REPAIR_FAILED' && error.status === 500
    )
  })

  it('does not return before withTransaction resolves', async () => {
    let release
    const gate = new Promise((resolve) => { release = resolve })
    const setup = makeHarness()
    const originalStartSession = setup.service.mongoose.startSession
    setup.service.mongoose.startSession = async () => {
      const session = await originalStartSession()
      const original = session.withTransaction
      session.withTransaction = async (...args) => {
        const result = await original.apply(session, args)
        await gate
        return result
      }
      return session
    }
    let settled = false
    const promise = setup.service.repairApprovedOrderInventory(request())
      .then((value) => { settled = true; return value })
    await new Promise((resolve) => setImmediate(resolve))
    assert.equal(settled, false)
    release()
    await promise
    assert.equal(settled, true)
  })
})
