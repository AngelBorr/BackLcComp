/* eslint-env mocha */
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { resolvePaymentReconciliationConfig } from '../../src/config.js'
import { resolveMongoUri } from '../../src/config/mongoConnection.js'
import { runPaymentReconciliationJob } from '../../src/jobs/paymentReconciliation.job.js'
import { runPaymentReconciliationEntrypoint } from '../../scripts/runPaymentReconciliation.js'

const workerSummary = {
  runId: 'run-job',
  durationMs: 25,
  processed: 1,
  paid: 1,
  requiresAttention: 0,
  stillPending: 0,
  providerUnavailable: 0,
  errors: 0
}

describe('P1B.2 job and entrypoint (isolated)', () => {
  it('runs exactly one bounded worker execution and returns its summary', async () => {
    let calls = 0
    const worker = {
      async run(input) {
        calls += 1
        assert.equal(input.runId, 'run-job')
        return workerSummary
      }
    }
    const result = await runPaymentReconciliationJob({
      worker,
      runId: 'run-job',
      now: new Date('2026-10-10T12:00:00.000Z'),
      log() {}
    })
    assert.equal(calls, 1)
    assert.equal(result, workerSummary)
  })

  it('uses safe reconciliation defaults and validates explicit overrides', () => {
    assert.deepEqual(resolvePaymentReconciliationConfig({}), {
      batchSize: 20,
      maxOrdersPerRun: 100,
      concurrency: 2
    })
    assert.deepEqual(resolvePaymentReconciliationConfig({
      PAYMENT_RECONCILIATION_BATCH_SIZE: '7',
      PAYMENT_RECONCILIATION_MAX_PER_RUN: '9',
      PAYMENT_RECONCILIATION_CONCURRENCY: '1'
    }), {
      batchSize: 7,
      maxOrdersPerRun: 9,
      concurrency: 1
    })
  })

  it('shares MONGO_URI resolution without logging or changing it', () => {
    const uri = 'mongodb://example.invalid/lccomp'
    assert.equal(resolveMongoUri({ MONGO_URI: uri }), uri)
  })

  it('preserves the legacy Mongo URI fallback exactly without connecting', () => {
    assert.equal(
      resolveMongoUri({}, {
        userMongo: 'test-user',
        passMongo: 'test-pass',
        dbCluster: 'test-cluster',
        dbColecction: 'test-database'
      }),
      'mongodb+srv://test-user:test-pass@test-cluster/test-database?retryWrites=true&w=majority'
    )
  })

  it('closes Mongo after a successful job', async () => {
    const state = { connected: 0, ran: 0, disconnected: 0 }
    const result = await runPaymentReconciliationEntrypoint({
      mongooseInstance: {
        async disconnect() { state.disconnected += 1 }
      },
      async connect() { state.connected += 1 },
      async runJob() { state.ran += 1; return workerSummary },
      log() {},
      logError() {}
    })
    assert.deepEqual(state, { connected: 1, ran: 1, disconnected: 1 })
    assert.equal(result.exitCode, 0)
  })

  it('closes Mongo and returns failure when the job fails', async () => {
    const state = { disconnected: 0 }
    const result = await runPaymentReconciliationEntrypoint({
      mongooseInstance: {
        async disconnect() { state.disconnected += 1 }
      },
      async connect() {},
      async runJob() { throw Object.assign(new Error('boom'), { code: 'TEST_FAILURE' }) },
      log() {},
      logError() {}
    })
    assert.equal(state.disconnected, 1)
    assert.equal(result.exitCode, 1)
    assert.equal(result.error.code, 'TEST_FAILURE')
  })

  it('preserves the job error when Mongo disconnect also fails', async () => {
    const jobError = Object.assign(new Error('mongodb+srv://user:secret@example.invalid'), {
      code: 'JOB_FAILED'
    })
    const disconnectError = Object.assign(new Error('Bearer secret-token'), {
      code: 'DISCONNECT_FAILED'
    })
    const errorLogs = []
    const result = await runPaymentReconciliationEntrypoint({
      mongooseInstance: {
        async disconnect() { throw disconnectError }
      },
      async connect() {},
      async runJob() { throw jobError },
      log() {},
      logError(message, metadata) { errorLogs.push({ message, metadata }) }
    })

    assert.equal(result.exitCode, 1)
    assert.equal(result.error, jobError)
    assert.equal(result.cleanupError, disconnectError)
    assert.equal(errorLogs[0].metadata.phase, 'job')
    assert.equal(errorLogs.at(-1).message, 'payment_reconciliation_mongo_disconnect_failed')
    assert.equal(errorLogs.at(-1).metadata.secondary, true)
    assert.equal(JSON.stringify(errorLogs).includes('secret'), false)
  })

  it('treats disconnect failure as primary after a successful job', async () => {
    const disconnectError = Object.assign(new Error('disconnect failed'), {
      code: 'DISCONNECT_FAILED'
    })
    const result = await runPaymentReconciliationEntrypoint({
      mongooseInstance: {
        async disconnect() { throw disconnectError }
      },
      async connect() {},
      async runJob() { return workerSummary },
      log() {},
      logError() {}
    })

    assert.equal(result.exitCode, 1)
    assert.equal(result.error, disconnectError)
    assert.equal(Object.hasOwn(result, 'cleanupError'), false)
  })

  it('does not run the job or disconnect when Mongo connect fails', async () => {
    const connectError = Object.assign(new Error('connect failed'), { code: 'CONNECT_FAILED' })
    const state = { ran: 0, disconnected: 0 }
    const errorLogs = []
    const result = await runPaymentReconciliationEntrypoint({
      mongooseInstance: {
        async disconnect() { state.disconnected += 1 }
      },
      async connect() { throw connectError },
      async runJob() { state.ran += 1 },
      log() {},
      logError(message, metadata) { errorLogs.push({ message, metadata }) }
    })

    assert.equal(result.exitCode, 1)
    assert.equal(result.error, connectError)
    assert.deepEqual(state, { ran: 0, disconnected: 0 })
    assert.equal(errorLogs[0].metadata.phase, 'connect')
  })

  it('does not start or import the worker from app.js', async () => {
    const source = await readFile(new URL('../../src/app.js', import.meta.url), 'utf8')
    assert.equal(source.includes('paymentReconciliation'), false)
    assert.equal(source.includes('setInterval'), false)
  })
})
