/* eslint-env mocha */
import assert from 'node:assert/strict'
import mongoose from 'mongoose'
import { MongoReplicaSetHarness } from '../helpers/mongoReplicaSet.js'

describe('ProductUnit active serial unique index', function () {
  const harness = new MongoReplicaSetHarness()
  let ProductUnitModel

  const unitData = ({
    serialNumber,
    status = 'available',
    isDeleted = false,
    productId = new mongoose.Types.ObjectId()
  }) => ({
    productId,
    serialNumber,
    status,
    isDeleted,
    createdBy: new mongoose.Types.ObjectId()
  })

  const isDuplicateKey = (error) => error?.code === 11000 || error?.errorResponse?.code === 11000

  before(async function () {
    await harness.start()
    const productUnitModule = await import('../../../src/dao/models/productUnit.model.js')
    ProductUnitModel = productUnitModule.default
    await ProductUnitModel.init()
  })

  afterEach(async function () {
    await harness.cleanupCollections()
  })

  after(async function () {
    await harness.stop()
  })

  it('initializes the production model on a fresh MongoDB database', function () {
    assert.equal(ProductUnitModel.db.readyState, 1)
    assert.equal(ProductUnitModel.collection.name, 'product_units')
  })

  it('creates exactly one explicitly named active-serial index', async function () {
    const indexes = await ProductUnitModel.collection.indexes()
    const serialIndexes = indexes.filter((index) => (
      Object.keys(index.key).length === 1 && index.key.serialNumber === 1
    ))

    assert.equal(serialIndexes.length, 1)
    assert.deepEqual(serialIndexes[0].key, { serialNumber: 1 })
    assert.equal(serialIndexes[0].name, 'uniq_active_serial_number')
    assert.equal(serialIndexes[0].unique, true)
    assert.deepEqual(serialIndexes[0].partialFilterExpression, { isDeleted: false })
    assert.equal(indexes.some((index) => index.name === 'serialNumber_1'), false)
  })

  it('rejects a duplicate active serial globally across different products', async function () {
    await ProductUnitModel.create(unitData({ serialNumber: 'ABC123' }))

    await assert.rejects(
      ProductUnitModel.create(unitData({
        serialNumber: 'ABC123',
        productId: new mongoose.Types.ObjectId()
      })),
      isDuplicateKey
    )
  })

  it('normalizes serials before the unique index enforces persisted values', async function () {
    const first = await ProductUnitModel.create(unitData({ serialNumber: ' abc123 ' }))
    assert.equal(first.serialNumber, 'ABC123')

    await assert.rejects(
      ProductUnitModel.create(unitData({ serialNumber: 'ABC123' })),
      isDuplicateKey
    )
  })

  it('allows reusing a serial from a soft-deleted ProductUnit', async function () {
    await ProductUnitModel.create(unitData({ serialNumber: 'REUSABLE', isDeleted: true }))
    const active = await ProductUnitModel.create(unitData({ serialNumber: 'REUSABLE' }))

    assert.equal(active.serialNumber, 'REUSABLE')
    assert.equal(active.isDeleted, false)
  })

  it('keeps reserved and sold active units inside the unique constraint', async function () {
    await ProductUnitModel.create(unitData({ serialNumber: 'RESERVED-SERIAL', status: 'reserved' }))
    await ProductUnitModel.create(unitData({ serialNumber: 'SOLD-SERIAL', status: 'sold' }))

    await assert.rejects(
      ProductUnitModel.create(unitData({ serialNumber: 'RESERVED-SERIAL' })),
      isDuplicateKey
    )
    await assert.rejects(
      ProductUnitModel.create(unitData({ serialNumber: 'SOLD-SERIAL' })),
      isDuplicateKey
    )
  })

  it('lets MongoDB choose exactly one winner for concurrent active inserts', async function () {
    const outcomes = await Promise.allSettled([
      ProductUnitModel.create(unitData({ serialNumber: 'CONCURRENT-SERIAL' })),
      ProductUnitModel.create(unitData({ serialNumber: 'CONCURRENT-SERIAL' }))
    ])

    assert.equal(outcomes.filter((outcome) => outcome.status === 'fulfilled').length, 1)
    const rejected = outcomes.filter((outcome) => outcome.status === 'rejected')
    assert.equal(rejected.length, 1)
    assert.equal(isDuplicateKey(rejected[0].reason), true)
    assert.equal(await ProductUnitModel.countDocuments({ serialNumber: 'CONCURRENT-SERIAL' }), 1)
  })
})
