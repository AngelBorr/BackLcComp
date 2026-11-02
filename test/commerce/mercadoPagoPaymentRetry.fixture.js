import { normalizeProviderOrder } from '../../src/providers/mercadoPago.provider.js'

const RETRY_ORDER_NUMBER = 'LC-2026-000010'
const RETRY_PROVIDER_ORDER_ID = 'ORDTST01M641C6WAC9WRXYKDEAZ9FR2N'
const FAILED_PROVIDER_PAYMENT_ID = 'PAY01M643N3X3VENNZ4ZQYQQMYCG2'
const APPROVED_PROVIDER_PAYMENT_ID = 'PAY01M6447752H79ZCQPFN827HMR8'
const RETRY_TOTAL_ARS = '20763.60'

const failedAttempt = () => ({
  id: FAILED_PROVIDER_PAYMENT_ID,
  amount: '20763.6',
  reference_id: '185634649051',
  status: 'failed',
  status_detail: 'rejected_by_issuer',
  attempt_number: 1
})

const approvedAttempt = () => ({
  id: APPROVED_PROVIDER_PAYMENT_ID,
  amount: '20763.6',
  paid_amount: '20763.6',
  reference_id: '186685075992',
  status: 'processed',
  status_detail: 'accredited',
  attempt_number: 2
})

const retryableProviderPayload = () => ({
  id: RETRY_PROVIDER_ORDER_ID,
  status: 'action_required',
  status_detail: 'waiting_retry',
  external_reference: RETRY_ORDER_NUMBER,
  total_amount: RETRY_TOTAL_ARS,
  currency: 'ARS',
  transactions: { payments: [failedAttempt()] }
})

const approvedProviderPayload = () => ({
  id: RETRY_PROVIDER_ORDER_ID,
  status: 'processed',
  status_detail: 'accredited',
  external_reference: RETRY_ORDER_NUMBER,
  total_amount: RETRY_TOTAL_ARS,
  total_paid_amount: RETRY_TOTAL_ARS,
  currency: 'ARS',
  transactions: { payments: [failedAttempt(), approvedAttempt()] }
})

const normalizeRetryPayload = (payload) => normalizeProviderOrder(
  structuredClone(payload),
  { includeReconciliation: true }
)

export {
  APPROVED_PROVIDER_PAYMENT_ID,
  FAILED_PROVIDER_PAYMENT_ID,
  RETRY_ORDER_NUMBER,
  RETRY_PROVIDER_ORDER_ID,
  RETRY_TOTAL_ARS,
  approvedProviderPayload,
  normalizeRetryPayload,
  retryableProviderPayload
}
