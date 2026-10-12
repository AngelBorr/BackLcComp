import mongoose from 'mongoose'
import { fileURLToPath } from 'node:url'
import { resolve } from 'node:path'
import { connectMongo } from '../src/config/mongoConnection.js'
import runPaymentReconciliationJob from '../src/jobs/paymentReconciliation.job.js'
import logger from '../src/utils/logger.js'

const runPaymentReconciliationEntrypoint = async ({
  mongooseInstance = mongoose,
  connect = () => connectMongo({ mongooseInstance }),
  runJob = runPaymentReconciliationJob,
  log = (message, metadata) => logger.info(`${message} ${JSON.stringify(metadata)}`),
  logError = (message, metadata) => logger.error(`${message} ${JSON.stringify(metadata)}`)
} = {}) => {
  let connected = false
  let result = null
  let primaryError = null
  let cleanupError = null

  try {
    await connect()
    connected = true
    log('payment_reconciliation_mongo_connected', { connected: true })
    result = await runJob()
  } catch (error) {
    primaryError = error
    logError('payment_reconciliation_job_failed', {
      code: error?.code || 'PAYMENT_RECONCILIATION_JOB_FAILED',
      name: error?.name || 'Error',
      phase: connected ? 'job' : 'connect'
    })
  }

  if (connected) {
    try {
      await mongooseInstance.disconnect()
    } catch (error) {
      logError('payment_reconciliation_mongo_disconnect_failed', {
        code: error?.code || 'PAYMENT_RECONCILIATION_MONGO_DISCONNECT_FAILED',
        name: error?.name || 'Error',
        secondary: Boolean(primaryError)
      })
      if (primaryError) cleanupError = error
      else primaryError = error
    }
  }

  if (primaryError) {
    return {
      exitCode: 1,
      error: primaryError,
      ...(cleanupError ? { cleanupError } : {})
    }
  }
  return { exitCode: 0, result }
}

const isMain = process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url))
if (isMain) {
  runPaymentReconciliationEntrypoint().then(({ exitCode }) => {
    process.exitCode = exitCode
  }).catch(() => {
    process.exitCode = 1
  })
}

export { runPaymentReconciliationEntrypoint }
