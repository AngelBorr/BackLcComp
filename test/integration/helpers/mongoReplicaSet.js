import { randomUUID } from 'node:crypto'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import mongoose from 'mongoose'
import { MongoMemoryReplSet } from 'mongodb-memory-server-core'

const MONGO_BINARY_VERSION = '7.0.24'
const DATABASE_PREFIX = 'lccomp_integration_'
const QUARANTINED_MONGO_URI = 'mongodb://127.0.0.1:1/lccomp_external_mongo_quarantine?serverSelectionTimeoutMS=25'
const EXTERNAL_MONGO_ENVIRONMENT_KEYS = [
  'MONGO_URI',
  'MONGODB_URI',
  'MONGO_URL',
  'DB_URI',
  'USER_MONGO',
  'PASS_MONGO',
  'DB_CLUSTER',
  'DB_NAME'
]

const repositoryRoot = fileURLToPath(new URL('../../../', import.meta.url))
const cacheDirectory = path.resolve(repositoryRoot, '.cache', 'mongodb-binaries')

const isLoopbackHost = (hostname) => hostname === '127.0.0.1' || hostname === 'localhost' || hostname === '::1'

const validateEphemeralUri = ({ uri, expectedUri, expectedDatabase }) => {
  if (typeof uri !== 'string' || uri !== expectedUri) {
    throw new Error('Refusing Mongo operation: URI is not the active ephemeral replica set URI')
  }

  if (!uri.startsWith('mongodb://') || uri.toLowerCase().includes('mongodb.net')) {
    throw new Error('Refusing Mongo operation: only a local mongodb:// URI is allowed')
  }

  const parsed = new URL(uri)
  const databaseName = decodeURIComponent(parsed.pathname.slice(1))

  if (!isLoopbackHost(parsed.hostname) || parsed.username || parsed.password) {
    throw new Error('Refusing Mongo operation: host or credentials are not ephemeral-local')
  }

  if (databaseName !== expectedDatabase || !databaseName.startsWith(DATABASE_PREFIX)) {
    throw new Error('Refusing Mongo operation: database name is outside the integration namespace')
  }

  if (!parsed.searchParams.get('replicaSet')) {
    throw new Error('Refusing Mongo operation: replicaSet is required')
  }

  return {
    protocol: parsed.protocol,
    hostname: parsed.hostname,
    hasCredentials: Boolean(parsed.username || parsed.password),
    hasReplicaSet: Boolean(parsed.searchParams.get('replicaSet')),
    databaseName
  }
}

export class MongoReplicaSetHarness {
  #replicaSet = null
  #uri = null
  #databaseName = null
  #sessions = new Set()
  #originalEnvironment = new Map()

  constructor () {
    this.inheritedMongoEnvironmentKeys = EXTERNAL_MONGO_ENVIRONMENT_KEYS.filter((key) => Boolean(process.env[key]))
  }

  get metadata () {
    return {
      binaryVersion: MONGO_BINARY_VERSION,
      cacheDirectory,
      databaseName: this.#databaseName,
      inheritedMongoEnvironmentKeys: [...this.inheritedMongoEnvironmentKeys]
    }
  }

  async start () {
    if (mongoose.connection.readyState !== 0) {
      throw new Error('Refusing to start: Mongoose already has an active connection')
    }

    this.#quarantineExternalMongoEnvironment()
    this.#databaseName = `${DATABASE_PREFIX}${process.pid}_${randomUUID().replaceAll('-', '')}`

    try {
      this.#replicaSet = await MongoMemoryReplSet.create({
        binary: {
          version: MONGO_BINARY_VERSION,
          downloadDir: cacheDirectory,
          checkMD5: true
        },
        replSet: {
          count: 1,
          storageEngine: 'wiredTiger'
        }
      })

      this.#uri = this.#replicaSet.getUri(this.#databaseName)
      this.#assertSafeTarget()

      await mongoose.connect(this.#uri, {
        serverSelectionTimeoutMS: 10000
      })
      this.#assertSafeConnection()

      const admin = mongoose.connection.db.admin()
      const [buildInfo, hello] = await Promise.all([
        admin.command({ buildInfo: 1 }),
        admin.command({ hello: 1 })
      ])

      if (buildInfo.version !== MONGO_BINARY_VERSION) {
        throw new Error(`Unexpected MongoDB version: ${buildInfo.version}`)
      }

      if (!hello.setName || hello.isWritablePrimary !== true) {
        throw new Error('MongoDB did not start as a writable replica set primary')
      }

      return {
        version: buildInfo.version,
        replicaSetName: hello.setName,
        isWritablePrimary: hello.isWritablePrimary,
        mongooseReadyState: mongoose.connection.readyState,
        connection: validateEphemeralUri({
          uri: this.#uri,
          expectedUri: this.#uri,
          expectedDatabase: this.#databaseName
        })
      }
    } catch (error) {
      const cleanupError = await this.#cleanupAfterStartFailure()
      if (cleanupError) error.cleanupError = cleanupError
      throw error
    }
  }

  async startSession () {
    this.#assertSafeConnection()
    const session = await mongoose.startSession()
    this.#sessions.add(session)
    return session
  }

  async endSession (session) {
    if (!session) return
    try {
      await session.endSession()
    } finally {
      this.#sessions.delete(session)
    }
  }

  async cleanupCollections () {
    this.#assertSafeConnection()
    const collections = await mongoose.connection.db.collections()

    for (const collection of collections) {
      if (collection.collectionName.startsWith('system.')) continue
      this.#assertSafeConnection()
      await collection.deleteMany({})
    }
  }

  async stop () {
    const errors = []

    for (const session of [...this.#sessions]) {
      try {
        await this.endSession(session)
      } catch (error) {
        errors.push(error)
      }
    }

    if (mongoose.connection.readyState !== 0) {
      try {
        this.#assertSafeConnection()
        await mongoose.disconnect()
      } catch (error) {
        errors.push(error)
      }
    }

    if (this.#replicaSet) {
      try {
        await this.#replicaSet.stop({ doCleanup: true, force: true })
      } catch (error) {
        errors.push(error)
      }
    }

    this.#replicaSet = null
    this.#uri = null
    this.#databaseName = null
    this.#restoreExternalMongoEnvironment()

    if (errors.length > 0) {
      throw new AggregateError(errors, 'Mongo replica set cleanup failed')
    }
  }

  #assertSafeTarget () {
    validateEphemeralUri({
      uri: this.#uri,
      expectedUri: this.#uri,
      expectedDatabase: this.#databaseName
    })
  }

  #assertSafeConnection () {
    this.#assertSafeTarget()

    const connection = mongoose.connection
    if (connection.readyState !== 1 || connection.name !== this.#databaseName) {
      throw new Error('Refusing Mongo operation: Mongoose is not connected to the expected ephemeral database')
    }

    if (!isLoopbackHost(connection.host)) {
      throw new Error('Refusing Mongo operation: active Mongoose host is not loopback')
    }
  }

  #quarantineExternalMongoEnvironment () {
    for (const key of EXTERNAL_MONGO_ENVIRONMENT_KEYS) {
      this.#originalEnvironment.set(key, process.env[key])
      process.env[key] = key.includes('URI') || key === 'MONGO_URL' ? QUARANTINED_MONGO_URI : ''
    }
  }

  #restoreExternalMongoEnvironment () {
    for (const [key, value] of this.#originalEnvironment) {
      if (value === undefined) delete process.env[key]
      else process.env[key] = value
    }
    this.#originalEnvironment.clear()
  }

  async #cleanupAfterStartFailure () {
    const errors = []

    try {
      if (mongoose.connection.readyState !== 0) await mongoose.disconnect()
    } catch (error) {
      errors.push(error)
    }

    try {
      if (this.#replicaSet) await this.#replicaSet.stop({ doCleanup: true, force: true })
    } catch (error) {
      errors.push(error)
    }

    this.#replicaSet = null
    this.#uri = null
    this.#databaseName = null
    this.#restoreExternalMongoEnvironment()

    return errors.length > 0 ? new AggregateError(errors, 'Cleanup after startup failure failed') : null
  }
}

export const mongoReplicaSetConstants = Object.freeze({
  binaryVersion: MONGO_BINARY_VERSION,
  databasePrefix: DATABASE_PREFIX,
  cacheDirectory
})
