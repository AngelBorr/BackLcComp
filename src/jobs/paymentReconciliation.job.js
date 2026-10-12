import { randomUUID } from 'node:crypto'
import PaymentReconciliationWorker from '../services/paymentReconciliationWorker.service.js'
import logger from '../utils/logger.js'

const runPaymentReconciliationJob = async ({
  worker = PaymentReconciliationWorker,
  runId = randomUUID(),
  now = new Date(),
  log = (message, metadata) => logger.info(`${message} ${JSON.stringify(metadata)}`)
} = {}) => {
  const result = await worker.run({ runId, now })
  log('payment_reconciliation_job_completed', {
    runId: result.runId,
    durationMs: result.durationMs,
    processed: result.processed,
    paid: result.paid,
    requiresAttention: result.requiresAttention,
    stillPending: result.stillPending,
    providerUnavailable: result.providerUnavailable,
    errors: result.errors
  })
  return result
}

export { runPaymentReconciliationJob }
export default runPaymentReconciliationJob
