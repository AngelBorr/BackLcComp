/* eslint-env mocha */
import assert from 'node:assert/strict'
import mongoose from 'mongoose'
import { MongoReplicaSetHarness } from '../helpers/mongoReplicaSet.js'

const GLOBAL_INDEX = 'uniq_attention_resolution_idempotency_key'
const COMPLETED_INDEX = 'uniq_completed_reassign_inventory_per_order'

describe('P1C-B0B OrderAttentionResolution index convergence', function () {
  const harness = new MongoReplicaSetHarness()
  let OrderAttentionResolutionModel

  const resolutionData = ({
    orderId = new mongoose.Types.ObjectId(),
    idempotencyKey,
    action = 'complete_existing_reservation_sale',
    status = 'prepared'
  }) => ({
    orderId,
    paymentId: new mongoose.Types.ObjectId(),
    idempotencyKey,
    action,
    originalAttentionReason: 'RESERVATION_EXPIRED',
    actorUserId: new mongoose.Types.ObjectId(),
    actorRole: 'ADMIN',
    requestedAt: new Date('2026-11-18T12:00:00.000Z'),
    status
  })

  const rejectsOnIndex = (indexName) => (error) => (
    error?.code === 11000 && String(error.message).includes(indexName)
  )

  before(async function () {
    await harness.start()
    const resolutionModule = await import(
      '../../../src/dao/models/orderAttentionResolution.model.js'
    )
    OrderAttentionResolutionModel = resolutionModule.default
    await OrderAttentionResolutionModel.init()
  })

  afterEach(async function () {
    await harness.cleanupCollections()
  })

  after(async function () {
    await harness.stop()
  })

  it('materializes the historical and both critical unique indexes exactly', async function () {
    const indexes = await OrderAttentionResolutionModel.collection.indexes()
    const historical = indexes.find((index) => (
      index.key?.orderId === 1 &&
      index.key?.idempotencyKey === 1 &&
      Object.keys(index.key).length === 2
    ))
    const globalIdempotency = indexes.find((index) => index.name === GLOBAL_INDEX)
    const completed = indexes.find((index) => index.name === COMPLETED_INDEX)

    assert.ok(historical)
    assert.equal(historical.unique, true)
    assert.deepEqual(globalIdempotency?.key, { idempotencyKey: 1 })
    assert.equal(globalIdempotency?.unique, true)
    assert.deepEqual(globalIdempotency?.partialFilterExpression, {
      idempotencyKey: {
        $type: 'string',
        $gt: ''
      }
    })
    assert.deepEqual(completed?.key, { orderId: 1, action: 1 })
    assert.equal(completed?.unique, true)
    assert.deepEqual(completed?.partialFilterExpression, {
      status: 'completed',
      action: 'reassign_inventory'
    })
  })

  it('rejects the same idempotency key across different Orders', async function () {
    const idempotencyKey = 'global-resolution-key-0001'
    await OrderAttentionResolutionModel.create(resolutionData({ idempotencyKey }))

    await assert.rejects(
      OrderAttentionResolutionModel.create(resolutionData({ idempotencyKey })),
      rejectsOnIndex(GLOBAL_INDEX)
    )
  })

  it('rejects two completed inventory repairs for one Order with different keys', async function () {
    const orderId = new mongoose.Types.ObjectId()
    await OrderAttentionResolutionModel.create(resolutionData({
      orderId,
      idempotencyKey: 'completed-repair-key-0001',
      action: 'reassign_inventory',
      status: 'completed'
    }))

    await assert.rejects(
      OrderAttentionResolutionModel.create(resolutionData({
        orderId,
        idempotencyKey: 'completed-repair-key-0002',
        action: 'reassign_inventory',
        status: 'completed'
      })),
      rejectsOnIndex(COMPLETED_INDEX)
    )
  })

  it('keeps missing, null, empty and non-string keys outside the global partial index', async function () {
    const rawDocuments = [
      {},
      {},
      { idempotencyKey: null },
      { idempotencyKey: null },
      { idempotencyKey: '' },
      { idempotencyKey: '' },
      { idempotencyKey: 10 },
      { idempotencyKey: 10 }
    ].map((value) => ({
      _id: new mongoose.Types.ObjectId(),
      orderId: new mongoose.Types.ObjectId(),
      marker: 'raw-partial-index-fixture',
      ...value
    }))

    const result = await OrderAttentionResolutionModel.collection.insertMany(rawDocuments)

    assert.equal(result.insertedCount, rawDocuments.length)
    assert.equal(
      await OrderAttentionResolutionModel.collection.countDocuments({
        marker: 'raw-partial-index-fixture'
      }),
      rawDocuments.length
    )
  })
})
