/* eslint-env mocha */
import assert from 'node:assert/strict'
import {
  ORIGINAL_UNIT_CLASSIFICATIONS as C,
  PLAN_OUTCOMES,
  buildInventoryRepairPlan,
  evaluateInventoryRepairEligibility
} from '../../src/services/orderInventoryRepairPlanner.service.js'

const ids = {
  order: '507f1f77bcf86cd799439001',
  otherOrder: '507f1f77bcf86cd799439002',
  payment: '507f1f77bcf86cd799439003',
  product: '507f1f77bcf86cd799439004',
  otherProduct: '507f1f77bcf86cd799439005',
  item: '507f1f77bcf86cd799439006',
  otherItem: '507f1f77bcf86cd799439007',
  unit: '507f1f77bcf86cd799439008',
  unit2: '507f1f77bcf86cd799439009',
  unit3: '507f1f77bcf86cd79943900a',
  unit4: '507f1f77bcf86cd79943900b',
  refund: '507f1f77bcf86cd79943900c',
  product2: '507f1f77bcf86cd79943900d',
  item2: '507f1f77bcf86cd79943900e',
  unit5: '507f1f77bcf86cd79943900f',
  thirdOrder: '507f1f77bcf86cd799439010'
}

const order = (overrides = {}) => ({
  _id: ids.order,
  status: 'requires_attention',
  fulfillmentStatus: 'pending',
  attentionReason: 'RESERVATION_QUANTITY_MISMATCH',
  activeRefundId: null,
  orderNumber: 'LC-2026-000001',
  paymentCurrency: 'ARS',
  totals: { totalArs: '1000.00' },
  ...overrides
})

const payment = (overrides = {}) => ({
  _id: ids.payment,
  orderId: ids.order,
  normalizedStatus: 'approved',
  provider: 'mercado_pago',
  providerOrderId: 'ORDER-MP-1',
  providerPaymentId: 'PAY-APPROVED-1',
  approvedAt: '2026-11-10T12:00:00.000Z',
  amountArs: '1000.00',
  currency: 'ARS',
  externalReference: 'LC-2026-000001',
  ...overrides
})

const ledgerUnit = (productUnitId = ids.unit, serial = 'SERIAL-001') => ({
  productUnitId,
  serial
})

const item = (overrides = {}) => ({
  _id: ids.item,
  orderId: ids.order,
  productId: ids.product,
  quantity: 1,
  originalReservation: {
    capturedAt: '2026-11-10T11:00:00.000Z',
    units: [ledgerUnit()]
  },
  ...overrides
})

const cleanAvailable = (overrides = {}) => ({
  _id: ids.unit,
  productId: ids.product,
  serialNumber: 'SERIAL-001',
  status: 'available',
  isDeleted: false,
  orderId: null,
  orderItemId: null,
  reservedByOrderId: null,
  reservedAt: null,
  reservationExpiresAt: null,
  soldByOrderId: null,
  soldAt: null,
  ...overrides
})

const validReserved = (overrides = {}) => cleanAvailable({
  status: 'reserved',
  orderId: ids.order,
  orderItemId: ids.item,
  reservedByOrderId: ids.order,
  reservedAt: '2026-11-10T11:00:00.000Z',
  reservationExpiresAt: '2026-11-10T17:00:00.000Z',
  ...overrides
})

const soldByTarget = (overrides = {}) => validReserved({
  status: 'sold',
  soldByOrderId: ids.order,
  soldAt: '2026-11-10T12:00:00.000Z',
  ...overrides
})

const verifiedExternalOrderItems = () => ({
  [ids.otherItem]: {
    _id: ids.otherItem,
    orderId: ids.otherOrder,
    productId: ids.product
  }
})

const objectIdLike = (id) => ({
  toHexString: () => id,
  toString: () => id
})

const plan = ({
  orderValue = order(),
  paymentValue = payment(),
  items = [item()],
  units = [validReserved()],
  currentUnits = units,
  externalOrderItemsById = verifiedExternalOrderItems()
} = {}) => buildInventoryRepairPlan({
  order: orderValue,
  payment: paymentValue,
  orderItems: items,
  originalProductUnits: units,
  currentProductUnits: currentUnits,
  externalOrderItemsById
})

const onlyClassification = (result) => {
  const itemPlan = result.items[0]
  const entries = [
    ...itemPlan.preserveReserved,
    ...itemPlan.reclaimAvailableOriginals,
    ...itemPlan.alreadySold,
    ...itemPlan.replaceableDeficitOriginals,
    ...itemPlan.blocked.filter((entry) => entry.productUnitId)
  ]
  assert.equal(entries.length, 1)
  return entries[0]
}

const deepFreeze = (value) => {
  if (!value || typeof value !== 'object' || Object.isFrozen(value)) return value
  Object.freeze(value)
  for (const nested of Object.values(value)) deepFreeze(nested)
  return value
}

describe('P1C-B0B inventory repair planner (pure unit tests)', () => {
  it('classifies a correct reserved original as VALID_ORIGINAL', () => {
    assert.equal(onlyClassification(plan()).category, C.VALID_ORIGINAL)
  })

  it('keeps an expired but still coherently owned reservation as VALID_ORIGINAL', () => {
    const result = plan({
      units: [validReserved({ reservationExpiresAt: '2020-01-01T00:00:00.000Z' })]
    })
    assert.equal(onlyClassification(result).category, C.VALID_ORIGINAL)
  })

  it('requires valid reservation timestamps for VALID_ORIGINAL', () => {
    const result = plan({ units: [validReserved({ reservedAt: null })] })
    assert.equal(onlyClassification(result).category, C.DATA_CORRUPTION)
  })

  it('rejects boolean reservedAt metadata', () => {
    const result = plan({ units: [validReserved({ reservedAt: false })] })
    assert.equal(onlyClassification(result).category, C.DATA_CORRUPTION)
    assert.equal(onlyClassification(result).reason, 'RESERVED_ORIGINAL_INVALID_TIMESTAMPS')
  })

  it('rejects reservedAt="0" and reservationExpiresAt="1"', () => {
    for (const unit of [
      validReserved({ reservedAt: '0' }),
      validReserved({ reservationExpiresAt: '1' })
    ]) {
      const result = plan({ units: [unit] })
      assert.equal(onlyClassification(result).category, C.DATA_CORRUPTION)
      assert.notEqual(result.outcome, PLAN_OUTCOMES.READY)
    }
  })

  it('classifies a completely clean available original as RECLAIMABLE_ORIGINAL', () => {
    assert.equal(onlyClassification(plan({ units: [cleanAvailable()] })).category, C.RECLAIMABLE_ORIGINAL)
  })

  it('rejects an available original with residual orderId as HARD_CONFLICT', () => {
    const result = plan({ units: [cleanAvailable({ orderId: ids.order })] })
    assert.equal(onlyClassification(result).category, C.HARD_CONFLICT)
  })

  it('rejects an available original with residual soldAt as DATA_CORRUPTION', () => {
    const result = plan({ units: [cleanAvailable({ soldAt: '2026-11-10T12:00:00.000Z' })] })
    assert.equal(onlyClassification(result).category, C.DATA_CORRUPTION)
  })

  it('classifies a correct sale by the same Order and Item as ALREADY_SATISFIED', () => {
    assert.equal(onlyClassification(plan({ units: [soldByTarget()] })).category, C.ALREADY_SATISFIED)
  })

  it('rejects boolean soldAt metadata', () => {
    const result = plan({ units: [soldByTarget({ soldAt: false })] })
    assert.equal(onlyClassification(result).category, C.DATA_CORRUPTION)
    assert.equal(onlyClassification(result).reason, 'SOLD_ORIGINAL_INVALID_TIMESTAMP')
  })

  it('rejects soldAt="0"', () => {
    const result = plan({ units: [soldByTarget({ soldAt: '0' })] })
    assert.equal(onlyClassification(result).category, C.DATA_CORRUPTION)
    assert.notEqual(result.outcome, PLAN_OUTCOMES.READY)
  })

  it('classifies a coherent reservation by another Order as REPLACEABLE_DEFICIT', () => {
    const result = plan({
      units: [validReserved({
        orderId: ids.otherOrder,
        orderItemId: ids.otherItem,
        reservedByOrderId: ids.otherOrder
      })]
    })
    assert.equal(onlyClassification(result).category, C.REPLACEABLE_DEFICIT)
    assert.equal(result.outcome, PLAN_OUTCOMES.READY)
    assert.equal(result.repairable, true)
  })

  it('classifies a coherent sale by another Order as REPLACEABLE_DEFICIT', () => {
    const result = plan({
      units: [soldByTarget({
        orderId: ids.otherOrder,
        orderItemId: ids.otherItem,
        reservedByOrderId: ids.otherOrder,
        soldByOrderId: ids.otherOrder
      })]
    })
    assert.equal(onlyClassification(result).category, C.REPLACEABLE_DEFICIT)
  })

  it('rejects another Order reservation without external OrderItem evidence', () => {
    const result = plan({
      units: [validReserved({
        orderId: ids.otherOrder,
        orderItemId: ids.otherItem,
        reservedByOrderId: ids.otherOrder
      })],
      externalOrderItemsById: {}
    })

    assert.equal(onlyClassification(result).category, C.HARD_CONFLICT)
    assert.equal(onlyClassification(result).reason, 'EXTERNAL_ORDER_ITEM_OWNERSHIP_UNVERIFIED')
  })

  it('rejects external OrderItem evidence that belongs to a third Order', () => {
    const result = plan({
      units: [validReserved({
        orderId: ids.otherOrder,
        orderItemId: ids.otherItem,
        reservedByOrderId: ids.otherOrder
      })],
      externalOrderItemsById: {
        [ids.otherItem]: { _id: ids.otherItem, orderId: ids.thirdOrder }
      }
    })

    assert.equal(onlyClassification(result).category, C.HARD_CONFLICT)
    assert.equal(onlyClassification(result).reason, 'EXTERNAL_ORDER_ITEM_OWNERSHIP_MISMATCH')
  })

  it('rejects external OrderItem evidence for a different product', () => {
    const result = plan({
      units: [validReserved({
        orderId: ids.otherOrder,
        orderItemId: ids.otherItem,
        reservedByOrderId: ids.otherOrder
      })],
      externalOrderItemsById: {
        [ids.otherItem]: {
          _id: ids.otherItem,
          orderId: ids.otherOrder,
          productId: ids.otherProduct
        }
      }
    })

    assert.equal(onlyClassification(result).category, C.HARD_CONFLICT)
    assert.equal(onlyClassification(result).reason, 'EXTERNAL_ORDER_ITEM_PRODUCT_MISMATCH')
    assert.notEqual(result.outcome, PLAN_OUTCOMES.READY)
  })

  it('rejects external OrderItem evidence without productId', () => {
    const result = plan({
      units: [validReserved({
        orderId: ids.otherOrder,
        orderItemId: ids.otherItem,
        reservedByOrderId: ids.otherOrder
      })],
      externalOrderItemsById: {
        [ids.otherItem]: { _id: ids.otherItem, orderId: ids.otherOrder }
      }
    })

    assert.equal(onlyClassification(result).category, C.HARD_CONFLICT)
    assert.equal(onlyClassification(result).reason, 'EXTERNAL_ORDER_ITEM_PRODUCT_MISMATCH')
  })

  it('resolves external ownership from a Map with a string key', () => {
    const result = plan({
      units: [validReserved({
        orderId: ids.otherOrder,
        orderItemId: ids.otherItem,
        reservedByOrderId: ids.otherOrder
      })],
      externalOrderItemsById: new Map([[
        ids.otherItem,
        { _id: ids.otherItem, orderId: ids.otherOrder, productId: ids.product }
      ]])
    })

    assert.equal(onlyClassification(result).category, C.REPLACEABLE_DEFICIT)
  })

  it('resolves external ownership from a Map with an ObjectId-like key', () => {
    const result = plan({
      units: [validReserved({
        orderId: ids.otherOrder,
        orderItemId: objectIdLike(ids.otherItem),
        reservedByOrderId: ids.otherOrder
      })],
      externalOrderItemsById: new Map([[
        objectIdLike(ids.otherItem),
        {
          _id: objectIdLike(ids.otherItem),
          orderId: objectIdLike(ids.otherOrder),
          productId: objectIdLike(ids.product)
        }
      ]])
    })

    assert.equal(onlyClassification(result).category, C.REPLACEABLE_DEFICIT)
  })

  for (const [label, externalItem, expectedReason] of [
    [
      'different value ID',
      { _id: ids.item2, orderId: ids.otherOrder, productId: ids.product },
      'EXTERNAL_ORDER_ITEM_OWNERSHIP_MISMATCH'
    ],
    [
      'different value Order',
      { _id: ids.otherItem, orderId: ids.thirdOrder, productId: ids.product },
      'EXTERNAL_ORDER_ITEM_OWNERSHIP_MISMATCH'
    ],
    [
      'different value Product',
      { _id: ids.otherItem, orderId: ids.otherOrder, productId: ids.otherProduct },
      'EXTERNAL_ORDER_ITEM_PRODUCT_MISMATCH'
    ]
  ]) {
    it(`rejects a Map with ${label}`, () => {
      const result = plan({
        units: [validReserved({
          orderId: ids.otherOrder,
          orderItemId: ids.otherItem,
          reservedByOrderId: ids.otherOrder
        })],
        externalOrderItemsById: new Map([[ids.otherItem, externalItem]])
      })

      assert.equal(onlyClassification(result).category, C.HARD_CONFLICT)
      assert.equal(onlyClassification(result).reason, expectedReason)
    })
  }

  it('rejects contradictory Map keys that normalize to the same OrderItem ID', () => {
    const result = plan({
      units: [validReserved({
        orderId: ids.otherOrder,
        orderItemId: ids.otherItem,
        reservedByOrderId: ids.otherOrder
      })],
      externalOrderItemsById: new Map([
        [ids.otherItem, {
          _id: ids.otherItem,
          orderId: ids.otherOrder,
          productId: ids.product
        }],
        [objectIdLike(ids.otherItem), {
          _id: ids.otherItem,
          orderId: ids.thirdOrder,
          productId: ids.product
        }]
      ])
    })

    assert.equal(onlyClassification(result).category, C.HARD_CONFLICT)
    assert.equal(onlyClassification(result).reason, 'EXTERNAL_ORDER_ITEM_OWNERSHIP_AMBIGUOUS')
  })

  it('rejects a nonexistent external OrderItem ID as unverified ownership', () => {
    const result = plan({
      units: [validReserved({
        orderId: ids.otherOrder,
        orderItemId: ids.unit5,
        reservedByOrderId: ids.otherOrder
      })]
    })

    assert.equal(onlyClassification(result).category, C.HARD_CONFLICT)
    assert.equal(onlyClassification(result).reason, 'EXTERNAL_ORDER_ITEM_OWNERSHIP_UNVERIFIED')
  })

  it('classifies cross-Order reservation references as HARD_CONFLICT', () => {
    const result = plan({
      units: [validReserved({ orderId: ids.otherOrder, reservedByOrderId: ids.order })]
    })
    assert.equal(onlyClassification(result).category, C.HARD_CONFLICT)
  })

  it('classifies another Order reusing the target orderItemId as HARD_CONFLICT', () => {
    const result = plan({
      units: [validReserved({
        orderId: ids.otherOrder,
        reservedByOrderId: ids.otherOrder,
        orderItemId: ids.item
      })]
    })
    assert.equal(onlyClassification(result).category, C.HARD_CONFLICT)
  })

  it('classifies an undefined isDeleted state as DATA_CORRUPTION', () => {
    const unit = validReserved()
    delete unit.isDeleted
    const result = plan({ units: [unit] })

    assert.equal(onlyClassification(result).category, C.DATA_CORRUPTION)
    assert.equal(onlyClassification(result).reason, 'ORIGINAL_DELETION_STATE_INVALID')
  })

  for (const malformedStatus of [' RESERVED ', 'Available', 'SOLD ']) {
    it(`rejects noncanonical status ${JSON.stringify(malformedStatus)}`, () => {
      const result = plan({ units: [validReserved({ status: malformedStatus })] })
      assert.equal(onlyClassification(result).category, C.DATA_CORRUPTION)
      assert.equal(onlyClassification(result).reason, 'ORIGINAL_STATUS_INVALID')
    })
  }

  it('classifies a product mismatch as DATA_CORRUPTION', () => {
    const result = plan({ units: [validReserved({ productId: ids.otherProduct })] })
    assert.equal(onlyClassification(result).category, C.DATA_CORRUPTION)
  })

  it('classifies a normalized serial mismatch as DATA_CORRUPTION', () => {
    const result = plan({ units: [validReserved({ serialNumber: 'OTHER-SERIAL' })] })
    assert.equal(onlyClassification(result).category, C.DATA_CORRUPTION)
  })

  it('accepts serial casing and whitespace after productive normalization', () => {
    const result = plan({ units: [validReserved({ serialNumber: '  serial-001  ' })] })
    assert.equal(onlyClassification(result).category, C.VALID_ORIGINAL)
  })

  for (const [label, serialNumber] of [
    ['number', 123],
    ['object', {}],
    ['null', null],
    ['whitespace-only string', '   ']
  ]) {
    it(`rejects a ${label} ProductUnit serial as DATA_CORRUPTION`, () => {
      const result = plan({ units: [validReserved({ serialNumber })] })
      assert.equal(onlyClassification(result).category, C.DATA_CORRUPTION)
      assert.equal(onlyClassification(result).reason, 'ORIGINAL_SERIAL_INVALID')
    })
  }

  for (const [label, serial] of [
    ['number', 123],
    ['object', {}],
    ['null', null],
    ['whitespace-only string', '   ']
  ]) {
    it(`rejects a ${label} historical ledger serial as DATA_CORRUPTION`, () => {
      const invalidItem = item({
        originalReservation: {
          capturedAt: '2026-11-10T11:00:00.000Z',
          units: [ledgerUnit(ids.unit, serial)]
        }
      })
      const result = plan({ items: [invalidItem] })

      assert.equal(result.outcome, PLAN_OUTCOMES.BLOCKED)
      assert(result.blocked.some((entry) => (
        entry.category === C.DATA_CORRUPTION &&
        entry.reason === 'ORIGINAL_RESERVATION_UNIT_INVALID'
      )))
    })
  }

  it('classifies a clean soft-deleted original as REPLACEABLE_DEFICIT', () => {
    const result = plan({ units: [cleanAvailable({ isDeleted: true })] })
    assert.equal(onlyClassification(result).category, C.REPLACEABLE_DEFICIT)
  })

  it('classifies a soft-deleted original with ownership as DATA_CORRUPTION', () => {
    const result = plan({
      units: [cleanAvailable({ isDeleted: true, orderId: ids.order })]
    })
    assert.equal(onlyClassification(result).category, C.DATA_CORRUPTION)
  })

  it('classifies a missing original ProductUnit as DATA_CORRUPTION', () => {
    const result = plan({ units: [], currentUnits: [] })
    assert.equal(onlyClassification(result).category, C.DATA_CORRUPTION)
    assert.equal(result.repairable, false)
  })

  it('blocks a ledger quantity mismatch as DATA_CORRUPTION', () => {
    const result = plan({ items: [item({ quantity: 2 })] })
    assert.equal(result.outcome, PLAN_OUTCOMES.BLOCKED)
    assert.equal(result.items[0].blocked[0].reason, 'ORIGINAL_RESERVATION_QUANTITY_MISMATCH')
  })

  for (const [label, quantity] of [
    ['true', true],
    ['false', false],
    ['string one', '1'],
    ['fraction', 1.5],
    ['zero', 0],
    ['negative', -1],
    ['NaN', Number.NaN],
    ['Infinity', Number.POSITIVE_INFINITY],
    ['object', {}],
    ['array', []],
    ['null', null],
    ['undefined', undefined]
  ]) {
    it(`blocks noncanonical quantity ${label}`, () => {
      const result = plan({ items: [item({ quantity })] })

      assert.equal(result.outcome, PLAN_OUTCOMES.BLOCKED)
      assert(result.blocked.some((entry) => entry.reason === 'ORDER_ITEM_STRUCTURE_INVALID'))
    })
  }

  it('accepts canonical numeric quantities one and two', () => {
    assert.equal(plan({ items: [item({ quantity: 1 })] }).outcome, PLAN_OUTCOMES.READY)

    const quantityTwoItem = item({
      quantity: 2,
      originalReservation: {
        capturedAt: '2026-11-10T11:00:00.000Z',
        units: [
          ledgerUnit(ids.unit, 'SERIAL-001'),
          ledgerUnit(ids.unit2, 'SERIAL-002')
        ]
      }
    })
    const result = plan({
      items: [quantityTwoItem],
      units: [
        validReserved(),
        validReserved({ _id: ids.unit2, serialNumber: 'SERIAL-002' })
      ]
    })

    assert.equal(result.outcome, PLAN_OUTCOMES.READY)
    assert.equal(result.items[0].quantity, 2)
    assert.equal(result.replacementCount, 0)
  })

  it('blocks an invalid originalReservation capturedAt', () => {
    const invalid = item({
      originalReservation: {
        capturedAt: 'invalid-date',
        units: [ledgerUnit()]
      }
    })
    const result = plan({ items: [invalid] })
    assert.equal(result.repairable, false)
    assert(result.blocked.some((entry) => (
      entry.reason === 'ORIGINAL_RESERVATION_CAPTURED_AT_INVALID'
    )))
  })

  it('blocks boolean originalReservation capturedAt', () => {
    const invalid = item({
      originalReservation: {
        capturedAt: false,
        units: [ledgerUnit()]
      }
    })
    const result = plan({ items: [invalid] })

    assert.equal(result.repairable, false)
    assert(result.blocked.some((entry) => (
      entry.reason === 'ORIGINAL_RESERVATION_CAPTURED_AT_INVALID'
    )))
  })

  for (const capturedAt of ['0', '1']) {
    it(`blocks originalReservation capturedAt=${JSON.stringify(capturedAt)}`, () => {
      const invalid = item({
        originalReservation: {
          capturedAt,
          units: [ledgerUnit()]
        }
      })
      const result = plan({ items: [invalid] })

      assert.equal(result.outcome, PLAN_OUTCOMES.BLOCKED)
      assert(result.blocked.some((entry) => (
        entry.reason === 'ORIGINAL_RESERVATION_CAPTURED_AT_INVALID'
      )))
    })
  }

  it('accepts Date instances and canonical ISO strings used by productive callers', () => {
    const dateResult = plan({
      paymentValue: payment({ approvedAt: new Date('2026-11-10T12:00:00.000Z') }),
      items: [item({
        originalReservation: {
          capturedAt: new Date('2026-11-10T11:00:00.000Z'),
          units: [ledgerUnit()]
        }
      })],
      units: [validReserved({
        reservedAt: new Date('2026-11-10T11:00:00.000Z'),
        reservationExpiresAt: new Date('2026-11-10T17:00:00.000Z')
      })]
    })
    const isoResult = plan()

    assert.equal(dateResult.outcome, PLAN_OUTCOMES.READY)
    assert.equal(isoResult.outcome, PLAN_OUTCOMES.READY)
  })

  it('blocks a target OrderItem that belongs to another Order', () => {
    const result = plan({ items: [item({ orderId: ids.otherOrder })] })

    assert.equal(result.outcome, PLAN_OUTCOMES.BLOCKED)
    assert(result.blocked.some((entry) => entry.reason === 'ORDER_ITEM_ORDER_MISMATCH'))
  })

  it('blocks a duplicate ProductUnit ID inside one ledger', () => {
    const duplicated = item({
      quantity: 2,
      originalReservation: {
        capturedAt: '2026-11-10T11:00:00.000Z',
        units: [ledgerUnit(), ledgerUnit()]
      }
    })
    const result = plan({ items: [duplicated] })
    assert.equal(result.repairable, false)
    assert(result.blocked.some((entry) => entry.reason === 'ORIGINAL_RESERVATION_DUPLICATE_ID'))
  })

  it('blocks one historical ProductUnit shared between two OrderItems', () => {
    const second = item({
      _id: ids.otherItem,
      originalReservation: {
        capturedAt: '2026-11-10T11:00:00.000Z',
        units: [ledgerUnit()]
      }
    })
    const result = plan({ items: [item(), second] })
    assert.equal(result.repairable, false)
    assert.equal(
      result.blocked.filter((entry) => entry.reason === 'ORIGINAL_PRODUCT_UNIT_SHARED_BETWEEN_ITEMS').length,
      2
    )
  })

  it('blocks duplicate OrderItem IDs before classifying ProductUnits', () => {
    const result = plan({ items: [item(), item()] })
    assert.equal(result.repairable, false)
    assert(result.blocked.some((entry) => entry.reason === 'DUPLICATE_ORDER_ITEM_ID'))
  })

  it('blocks an Order without OrderItems', () => {
    const result = plan({ items: [], units: [], currentUnits: [] })
    assert.equal(result.repairable, false)
    assert(result.blocked.some((entry) => entry.reason === 'ORDER_ITEMS_MISSING'))
  })

  it('fails closed for an absent legacy originalReservation', () => {
    const legacy = item()
    delete legacy.originalReservation
    const result = plan({ items: [legacy] })
    assert.equal(result.repairable, false)
    assert.equal(result.items[0].blocked[0].reason, 'ORIGINAL_RESERVATION_ABSENT')
  })

  it('fails closed for a null legacy originalReservation', () => {
    const result = plan({ items: [item({ originalReservation: null })] })
    assert.equal(result.repairable, false)
    assert.equal(result.items[0].blocked[0].reason, 'ORIGINAL_RESERVATION_NULL')
  })

  it('builds healthy independent plans for multiple OrderItems', () => {
    const second = item({
      _id: ids.otherItem,
      originalReservation: {
        capturedAt: '2026-11-10T11:00:00.000Z',
        units: [ledgerUnit(ids.unit2, 'SERIAL-002')]
      }
    })
    const result = plan({
      items: [item(), second],
      units: [
        validReserved(),
        validReserved({ _id: ids.unit2, orderItemId: ids.otherItem, serialNumber: 'SERIAL-002' })
      ]
    })
    assert.equal(result.repairable, true)
    assert.equal(result.items.length, 2)
    assert.equal(result.replacementCount, 0)
  })

  it('makes the complete multi-item Order non-repairable when one item is corrupt', () => {
    const second = item({
      _id: ids.otherItem,
      originalReservation: {
        capturedAt: '2026-11-10T11:00:00.000Z',
        units: [ledgerUnit(ids.unit2, 'SERIAL-002')]
      }
    })
    const result = plan({
      items: [item(), second],
      units: [validReserved()]
    })
    assert.equal(result.repairable, false)
    assert(result.blocked.some((entry) => entry.reason === 'ORIGINAL_PRODUCT_UNIT_MISSING'))
  })

  it('produces replacementCount zero when every original is valid', () => {
    const result = plan()
    assert.equal(result.items[0].replacementCount, 0)
    assert.equal(result.replacementCount, 0)
  })

  it('calculates an exact mixed valid, sold, reclaim and deficit plan', () => {
    const mixedItem = item({
      quantity: 4,
      originalReservation: {
        capturedAt: '2026-11-10T11:00:00.000Z',
        units: [
          ledgerUnit(ids.unit, 'SERIAL-001'),
          ledgerUnit(ids.unit2, 'SERIAL-002'),
          ledgerUnit(ids.unit3, 'SERIAL-003'),
          ledgerUnit(ids.unit4, 'SERIAL-004')
        ]
      }
    })
    const units = [
      validReserved(),
      soldByTarget({ _id: ids.unit2, serialNumber: 'SERIAL-002' }),
      cleanAvailable({ _id: ids.unit3, serialNumber: 'SERIAL-003' }),
      validReserved({
        _id: ids.unit4,
        serialNumber: 'SERIAL-004',
        orderId: ids.otherOrder,
        orderItemId: ids.otherItem,
        reservedByOrderId: ids.otherOrder
      })
    ]
    const result = plan({ items: [mixedItem], units })
    const itemPlan = result.items[0]
    assert.equal(itemPlan.preserveReserved.length, 1)
    assert.equal(itemPlan.alreadySold.length, 1)
    assert.equal(itemPlan.reclaimAvailableOriginals.length, 1)
    assert.equal(itemPlan.replaceableDeficitOriginals.length, 1)
    assert.equal(itemPlan.replacementCount, 1)
  })

  it('keeps independent deficits and exclusions for two different products', () => {
    const firstItem = item()
    const secondItem = item({
      _id: ids.item2,
      productId: ids.product2,
      originalReservation: {
        capturedAt: '2026-11-10T11:00:00.000Z',
        units: [ledgerUnit(ids.unit5, 'SERIAL-005')]
      }
    })
    const units = [
      cleanAvailable({ isDeleted: true }),
      cleanAvailable({
        _id: ids.unit5,
        productId: ids.product2,
        serialNumber: 'SERIAL-005',
        isDeleted: true
      })
    ]

    const result = plan({ items: [firstItem, secondItem], units })

    assert.equal(result.outcome, PLAN_OUTCOMES.READY)
    assert.equal(result.items[0].productId, ids.product)
    assert.equal(result.items[0].replacementCount, 1)
    assert.equal(result.items[0].replaceableDeficitOriginals[0].productUnitId, ids.unit)
    assert.equal(result.items[1].productId, ids.product2)
    assert.equal(result.items[1].replacementCount, 1)
    assert.equal(result.items[1].replaceableDeficitOriginals[0].productUnitId, ids.unit5)
    assert.equal(result.replacementCount, 2)
    assert.deepEqual(result.globalExcludedProductUnitIds, [ids.unit, ids.unit5].sort())
  })

  it('produces deep-equal plans for equivalent repeated executions', () => {
    const input = {
      order: order(),
      payment: payment(),
      orderItems: [item()],
      originalProductUnits: [validReserved()],
      currentProductUnits: [validReserved()],
      externalOrderItemsById: verifiedExternalOrderItems()
    }

    const first = buildInventoryRepairPlan(structuredClone(input))
    const second = buildInventoryRepairPlan(structuredClone(input))

    assert.deepEqual(first, second)
  })

  it('does not mutate any Order, Payment, OrderItem, ledger or ProductUnit input', () => {
    const input = {
      order: order(),
      payment: payment(),
      orderItems: [item()],
      originalProductUnits: [validReserved()],
      currentProductUnits: [validReserved()],
      externalOrderItemsById: verifiedExternalOrderItems()
    }
    const before = structuredClone(input)
    deepFreeze(input)
    buildInventoryRepairPlan(input)
    assert.deepEqual(input, before)
  })

  it('does not mutate externalOrderItemsById when supplied as a Map', () => {
    const key = objectIdLike(ids.otherItem)
    const value = Object.freeze({
      _id: objectIdLike(ids.otherItem),
      orderId: objectIdLike(ids.otherOrder),
      productId: objectIdLike(ids.product)
    })
    const evidence = new Map([[key, value]])
    const before = [...evidence.entries()].map(([entryKey, entryValue]) => ({
      key: entryKey.toHexString(),
      value: {
        _id: entryValue._id.toHexString(),
        orderId: entryValue.orderId.toHexString(),
        productId: entryValue.productId.toHexString()
      }
    }))

    const result = plan({
      units: [validReserved({
        orderId: ids.otherOrder,
        orderItemId: ids.otherItem,
        reservedByOrderId: ids.otherOrder
      })],
      externalOrderItemsById: evidence
    })

    assert.equal(result.outcome, PLAN_OUTCOMES.READY)
    assert.equal(evidence.size, 1)
    assert.equal(evidence.has(key), true)
    assert.equal(evidence.get(key), value)
    assert.deepEqual(
      [...evidence.entries()].map(([entryKey, entryValue]) => ({
        key: entryKey.toHexString(),
        value: {
          _id: entryValue._id.toHexString(),
          orderId: entryValue.orderId.toHexString(),
          productId: entryValue.productId.toHexString()
        }
      })),
      before
    )
  })

  it('allows only the productive requires_attention + approved + pending matrix', () => {
    const result = evaluateInventoryRepairEligibility({ order: order(), payment: payment() })
    assert.equal(result.allowed, true)
    assert.equal(result.outcome, 'ELIGIBLE')
  })

  it('returns NOT_ALLOWED when Payment is not approved', () => {
    const result = evaluateInventoryRepairEligibility({
      order: order(),
      payment: payment({ normalizedStatus: 'pending', providerPaymentId: null, approvedAt: null })
    })
    assert.equal(result.outcome, PLAN_OUTCOMES.NOT_ALLOWED)
    assert(result.blockers.includes('PAYMENT_NOT_APPROVED'))
  })

  it('returns NOT_ALLOWED when an active refund exists', () => {
    const result = evaluateInventoryRepairEligibility({
      order: order({ activeRefundId: ids.refund }),
      payment: payment()
    })
    assert.equal(result.allowed, false)
    assert(result.blockers.includes('ACTIVE_REFUND_PRESENT'))
  })

  it('returns NOT_ALLOWED for an attention reason outside approved inventory', () => {
    const result = evaluateInventoryRepairEligibility({
      order: order({ attentionReason: 'TOTAL_AMOUNT_MISMATCH' }),
      payment: payment()
    })
    assert.equal(result.allowed, false)
    assert(result.blockers.includes('ATTENTION_CATEGORY_NOT_APPROVED_INVENTORY'))
  })

  it('returns NOT_ALLOWED when fulfillment is no longer pending', () => {
    const result = evaluateInventoryRepairEligibility({
      order: order({ fulfillmentStatus: 'preparing' }),
      payment: payment()
    })
    assert.equal(result.allowed, false)
    assert(result.blockers.includes('FULFILLMENT_NOT_PENDING'))
  })

  it('returns NOT_ALLOWED when the approved Payment belongs to another Order', () => {
    const result = evaluateInventoryRepairEligibility({
      order: order(),
      payment: payment({ orderId: ids.otherOrder })
    })
    assert.equal(result.allowed, false)
    assert(result.blockers.includes('PAYMENT_ORDER_MISMATCH'))
  })

  it('returns NOT_ALLOWED for an unexpected Payment provider', () => {
    const result = evaluateInventoryRepairEligibility({
      order: order(),
      payment: payment({ provider: 'other_provider' })
    })

    assert.equal(result.outcome, PLAN_OUTCOMES.NOT_ALLOWED)
    assert(result.blockers.includes('PAYMENT_PROVIDER_MISMATCH'))
  })

  for (const providerOrderId of [null, '   ']) {
    it(`returns NOT_ALLOWED for providerOrderId ${JSON.stringify(providerOrderId)}`, () => {
      const result = evaluateInventoryRepairEligibility({
        order: order(),
        payment: payment({ providerOrderId })
      })

      assert.equal(result.outcome, PLAN_OUTCOMES.NOT_ALLOWED)
      assert(result.blockers.includes('PROVIDER_ORDER_ID_REQUIRED'))
    })
  }

  it('returns NOT_ALLOWED when the approved amount differs from the Order total', () => {
    const result = evaluateInventoryRepairEligibility({
      order: order(),
      payment: payment({ amountArs: '999.99' })
    })

    assert.equal(result.outcome, PLAN_OUTCOMES.NOT_ALLOWED)
    assert(result.blockers.includes('PAYMENT_AMOUNT_MISMATCH'))
  })

  it('returns NOT_ALLOWED when the Payment currency differs from the Order', () => {
    const result = evaluateInventoryRepairEligibility({
      order: order(),
      payment: payment({ currency: 'USD' })
    })

    assert.equal(result.outcome, PLAN_OUTCOMES.NOT_ALLOWED)
    assert(result.blockers.includes('PAYMENT_CURRENCY_MISMATCH'))
  })

  it('returns NOT_ALLOWED when externalReference differs from the Order number', () => {
    const result = evaluateInventoryRepairEligibility({
      order: order(),
      payment: payment({ externalReference: 'LC-2026-999999' })
    })

    assert.equal(result.outcome, PLAN_OUTCOMES.NOT_ALLOWED)
    assert(result.blockers.includes('PAYMENT_EXTERNAL_REFERENCE_MISMATCH'))
  })

  it('returns NOT_ALLOWED for boolean approvedAt evidence', () => {
    const result = evaluateInventoryRepairEligibility({
      order: order(),
      payment: payment({ approvedAt: false })
    })

    assert.equal(result.outcome, PLAN_OUTCOMES.NOT_ALLOWED)
    assert(result.blockers.includes('PAYMENT_APPROVED_AT_INVALID'))
  })

  it('returns NOT_ALLOWED for approvedAt="1"', () => {
    const result = evaluateInventoryRepairEligibility({
      order: order(),
      payment: payment({ approvedAt: '1' })
    })

    assert.equal(result.outcome, PLAN_OUTCOMES.NOT_ALLOWED)
    assert(result.blockers.includes('PAYMENT_APPROVED_AT_INVALID'))
  })

  for (const [label, amount] of [
    ['integer number 100', 100],
    ['decimal number 100.0', 100.0],
    ['half-cent number 100.005', 100.005],
    ['string 100', '100']
  ]) {
    it(`accepts equivalent money representation ${label}`, () => {
      const result = evaluateInventoryRepairEligibility({
        order: order({ totals: { totalArs: amount } }),
        payment: payment({ amountArs: amount })
      })

      assert.equal(result.allowed, true)
      assert.equal(result.outcome, 'ELIGIBLE')
    })
  }

  for (const [label, amount] of [
    ['NaN', Number.NaN],
    ['Infinity', Number.POSITIVE_INFINITY],
    ['null', null]
  ]) {
    it(`rejects invalid money representation ${label}`, () => {
      const result = evaluateInventoryRepairEligibility({
        order: order(),
        payment: payment({ amountArs: amount })
      })

      assert.equal(result.outcome, PLAN_OUTCOMES.NOT_ALLOWED)
      assert(result.blockers.includes('PAYMENT_AMOUNT_MISMATCH'))
    })
  }

  it('requires Phase 2 to short-circuit completed repairs before an untracked target unit', () => {
    const result = plan({
      currentUnits: [
        validReserved(),
        soldByTarget({ _id: ids.unit2, serialNumber: 'UNTRACKED' })
      ]
    })
    assert.equal(result.repairable, false)
    assert(result.blocked.some((entry) => entry.reason === 'UNTRACKED_PRODUCT_UNIT_ASSIGNED_TO_ORDER'))
  })

  it('exports exact IDs needed by the future write primitive without selecting replacements', () => {
    const result = plan({ units: [cleanAvailable()] })
    assert.deepEqual(
      result.items[0].reclaimAvailableOriginals.map((entry) => entry.productUnitId),
      [ids.unit]
    )
    assert.equal(result.items[0].replacementCount, 0)
    assert.deepEqual(result.globalExcludedProductUnitIds, [ids.unit])
    assert.equal(Object.hasOwn(result, 'replacementIds'), false)
  })
})
