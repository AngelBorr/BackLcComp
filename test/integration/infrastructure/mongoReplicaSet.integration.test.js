/* eslint-env mocha */
import assert from 'node:assert/strict'
import mongoose from 'mongoose'
import { MongoReplicaSetHarness, mongoReplicaSetConstants } from '../helpers/mongoReplicaSet.js'

describe('isolated MongoDB replica set infrastructure', function () {
  const harness = new MongoReplicaSetHarness()
  let startupMetadata
  let SmokeDocument

  before(async function () {
    startupMetadata = await harness.start()
    const schema = new mongoose.Schema({
      key: { type: String, required: true, unique: true },
      value: { type: Number, required: true }
    })
    SmokeDocument = mongoose.model('MongoReplicaSetSmokeDocument', schema, 'mongo_replica_set_smoke_documents')
    await SmokeDocument.init()
  })

  afterEach(async function () {
    await harness.cleanupCollections()
  })

  after(async function () {
    await harness.stop()
  })

  it('starts the exact MongoDB binary as a writable single-node replica set', function () {
    assert.equal(startupMetadata.version, mongoReplicaSetConstants.binaryVersion)
    assert.equal(startupMetadata.isWritablePrimary, true)
    assert.equal(startupMetadata.mongooseReadyState, 1)
    assert.equal(typeof startupMetadata.replicaSetName, 'string')
    assert.ok(startupMetadata.replicaSetName.length > 0)
    assert.equal(startupMetadata.connection.protocol, 'mongodb:')
    assert.equal(startupMetadata.connection.hostname, '127.0.0.1')
    assert.equal(startupMetadata.connection.hasCredentials, false)
    assert.equal(startupMetadata.connection.hasReplicaSet, true)
    assert.equal(startupMetadata.connection.databaseName, harness.metadata.databaseName)
    assert.ok(harness.metadata.databaseName.startsWith(mongoReplicaSetConstants.databasePrefix))
  })

  it('commits a transaction and exposes the committed document outside the session', async function () {
    const session = await harness.startSession()

    try {
      await session.withTransaction(async () => {
        await SmokeDocument.create([{ key: 'committed', value: 1 }], { session })
      }, {
        readConcern: { level: 'snapshot' },
        writeConcern: { w: 'majority' }
      })
    } finally {
      await harness.endSession(session)
    }

    const persisted = await SmokeDocument.findOne({ key: 'committed' }).lean()
    assert.equal(persisted?.value, 1)
  })

  it('rolls a transaction back without exposing its document', async function () {
    const session = await harness.startSession()
    const rollback = new Error('intentional rollback')

    try {
      await assert.rejects(
        session.withTransaction(async () => {
          await SmokeDocument.create([{ key: 'rolled-back', value: 2 }], { session })
          throw rollback
        }, {
          readConcern: { level: 'snapshot' },
          writeConcern: { w: 'majority' }
        }),
        (error) => error === rollback
      )
    } finally {
      await harness.endSession(session)
    }

    assert.equal(await SmokeDocument.exists({ key: 'rolled-back' }), null)
  })

  it('supports read-own-writes while hiding uncommitted writes from external reads', async function () {
    const session = await harness.startSession()
    session.startTransaction({
      readConcern: { level: 'snapshot' },
      writeConcern: { w: 'majority' }
    })

    try {
      await SmokeDocument.create([{ key: 'visibility', value: 3 }], { session })

      const visibleInside = await SmokeDocument.findOne({ key: 'visibility' }).session(session).lean()
      const hiddenOutside = await SmokeDocument.findOne({ key: 'visibility' }).lean()

      assert.equal(visibleInside?.value, 3)
      assert.equal(hiddenOutside, null)

      await session.commitTransaction()
      const visibleAfterCommit = await SmokeDocument.findOne({ key: 'visibility' }).lean()
      assert.equal(visibleAfterCommit?.value, 3)
    } finally {
      if (session.inTransaction()) await session.abortTransaction()
      await harness.endSession(session)
    }
  })
})
