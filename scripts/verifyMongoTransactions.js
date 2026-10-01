import { randomUUID } from 'node:crypto'
import mongoose from 'mongoose'
import env from '../src/config.js'

const testId = randomUUID()
const collectionName = `__lccomp_transaction_test_${testId.replaceAll('-', '')}`
const rollbackDocumentId = `rollback_${testId}`
const commitDocumentId = `commit_${testId}`

let rollbackSession
let commitSession
let collection
let collectionCreatedByThisRun = false

const results = {
  connection: false,
  session: false,
  rollback: false,
  commit: false,
  cleanup: false
}

const redact = (value) => {
  let message = String(value || 'Unknown error')

  const sensitiveValues = [
    process.env.MONGO_URI,
    env.userMongo,
    env.passMongo,
    env.dbCluster,
    env.dbColecction
  ].filter(Boolean)

  for (const sensitiveValue of sensitiveValues) {
    message = message.split(String(sensitiveValue)).join('[REDACTED]')
  }

  return message
    .replace(/mongodb(?:\+srv)?:\/\/[^\s]+/gi, '[REDACTED_URI]')
    .replace(/[a-z0-9.-]+\.mongodb\.net(?::\d+)?/gi, '[REDACTED_HOST]')
    .replace(/\b(?:\d{1,3}\.){3}\d{1,3}(?::\d+)?\b/g, '[REDACTED_IP]')
}

const collectionExists = async () => {
  return mongoose.connection.db
    .listCollections({ name: collectionName }, { nameOnly: true })
    .hasNext()
}

const abortIfActive = async (session) => {
  if (session?.inTransaction()) {
    await session.abortTransaction()
  }
}

const closeSession = async (session) => {
  if (session) {
    await session.endSession()
  }
}

const printResults = (hasError) => {
  console.log(`Mongo connection: ${results.connection ? 'OK' : 'FAIL'}`)
  console.log(`Session: ${results.session ? 'OK' : 'FAIL'}`)
  console.log(`Transaction rollback: ${results.rollback ? 'PASS' : 'FAIL'}`)
  console.log(`Transaction commit: ${results.commit ? 'PASS' : 'FAIL'}`)
  console.log(`Cleanup: ${results.cleanup ? 'PASS' : 'FAIL'}`)
  console.log('')
  console.log(
    !hasError &&
      results.connection &&
      results.session &&
      results.rollback &&
      results.commit &&
      results.cleanup
      ? 'FINAL RESULT: TRANSACTIONS SUPPORTED'
      : 'FINAL RESULT: TRANSACTIONS NOT VERIFIED'
  )
}

const verifyTransactions = async () => {
  let testError

  try {
    const mongoUri =
      process.env.MONGO_URI ||
      `mongodb+srv://${env.userMongo}:${env.passMongo}@${env.dbCluster}/${env.dbColecction}?retryWrites=true&w=majority`

    await mongoose.connect(mongoUri)
    results.connection = true

    if (await collectionExists()) {
      throw new Error('The uniquely named temporary collection already exists')
    }

    await mongoose.connection.db.createCollection(collectionName)
    collectionCreatedByThisRun = true
    collection = mongoose.connection.db.collection(collectionName)

    rollbackSession = await mongoose.startSession()
    results.session = true
    rollbackSession.startTransaction()

    await collection.insertOne(
      {
        _id: rollbackDocumentId,
        testId,
        phase: 'rollback',
        createdAt: new Date()
      },
      { session: rollbackSession }
    )

    const visibleInsideRollbackTransaction = await collection.findOne(
      { _id: rollbackDocumentId },
      { session: rollbackSession }
    )

    if (!visibleInsideRollbackTransaction) {
      throw new Error('Rollback document was not visible inside its transaction')
    }

    await rollbackSession.abortTransaction()

    const visibleAfterAbort = await collection.findOne({ _id: rollbackDocumentId })
    if (visibleAfterAbort) {
      throw new Error('Rollback document still exists after abortTransaction')
    }
    results.rollback = true

    commitSession = await mongoose.startSession()
    commitSession.startTransaction()

    await collection.insertOne(
      {
        _id: commitDocumentId,
        testId,
        phase: 'commit',
        createdAt: new Date()
      },
      { session: commitSession }
    )

    await commitSession.commitTransaction()

    const visibleAfterCommit = await collection.findOne({ _id: commitDocumentId })
    if (!visibleAfterCommit) {
      throw new Error('Committed document was not found outside the transaction')
    }
    results.commit = true
  } catch (error) {
    testError = error
  } finally {
    try {
      await abortIfActive(rollbackSession)
      await abortIfActive(commitSession)
      await closeSession(rollbackSession)
      await closeSession(commitSession)

      if (mongoose.connection.readyState === 1 && collectionCreatedByThisRun) {
        collection ||= mongoose.connection.db.collection(collectionName)
        await collection.deleteOne({ _id: rollbackDocumentId, testId })
        await collection.deleteOne({ _id: commitDocumentId, testId })

        if (await collectionExists()) {
          await collection.drop()
        }

        results.cleanup = !(await collectionExists())
      }
    } catch (cleanupError) {
      testError ||= cleanupError
      results.cleanup = false
    }

    try {
      await mongoose.disconnect()
    } catch (disconnectError) {
      testError ||= disconnectError
    }
  }

  if (testError) {
    console.error(`Error: ${redact(testError.message)}`)
  }

  printResults(Boolean(testError))

  if (
    !results.connection ||
    !results.session ||
    !results.rollback ||
    !results.commit ||
    !results.cleanup
  ) {
    process.exitCode = 1
  }
}

await verifyTransactions()
