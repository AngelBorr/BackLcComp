/* eslint-env mocha */
import assert from 'node:assert/strict'
import { describe, it } from 'mocha'
import { validateCriticalEnvironment } from '../src/config.js'
import { resolveMongoUri } from '../src/config/mongoConnection.js'

const productionEnvironment = (overrides = {}) => ({
  NODE_ENV: 'production',
  JWT_PRIVATE_KEY: 'unit-test-jwt-key',
  MONGO_URI: 'mongodb://localhost/lccomp',
  ...overrides
})

describe('production critical environment validation', () => {
  it('rejects production without JWT_PRIVATE_KEY', () => {
    const environment = productionEnvironment()
    delete environment.JWT_PRIVATE_KEY

    assert.throws(
      () => validateCriticalEnvironment(environment),
      { message: 'JWT_PRIVATE_KEY is required in production' }
    )
  })

  it('rejects production with an empty JWT_PRIVATE_KEY', () => {
    assert.throws(
      () => validateCriticalEnvironment(productionEnvironment({ JWT_PRIVATE_KEY: '   ' })),
      { message: 'JWT_PRIVATE_KEY is required in production' }
    )
  })

  it('rejects production without MONGO_URI instead of using legacy Mongo fields', () => {
    const environment = productionEnvironment({
      USER_MONGO: 'legacy-user',
      PASS_MONGO: 'legacy-password',
      DB_CLUSTER: 'legacy-cluster',
      DB_NAME: 'legacy-database'
    })
    delete environment.MONGO_URI

    assert.throws(
      () => resolveMongoUri(environment, {
        userMongo: environment.USER_MONGO,
        passMongo: environment.PASS_MONGO,
        dbCluster: environment.DB_CLUSTER,
        dbColecction: environment.DB_NAME
      }),
      { message: 'MONGO_URI is required in production' }
    )
  })

  for (const databaseName of [
    'test',
    'test_inventory',
    'test-inventory',
    'inventory_test',
    'inventory-test',
    'TeSt_InVeNtOrY'
  ]) {
    it(`rejects the production test database name ${databaseName}`, () => {
      assert.throws(
        () => validateCriticalEnvironment(productionEnvironment({
          MONGO_URI: `mongodb://localhost/${databaseName}`
        })),
        { message: 'Production database cannot use a test database name' }
      )
    })
  }

  it('requires an explicit production database name', () => {
    for (const mongoUri of [
      'mongodb://localhost',
      'mongodb://localhost/',
      'mongodb://localhost/first/second',
      'not-a-mongo-uri'
    ]) {
      assert.throws(
        () => validateCriticalEnvironment(productionEnvironment({ MONGO_URI: mongoUri })),
        { message: 'Production MONGO_URI must include an explicit database name' }
      )
    }
  })

  it('accepts a production database outside the test namespace', () => {
    const environment = productionEnvironment({
      MONGO_URI: 'mongodb+srv://user:password@example.invalid/lccomp'
    })

    assert.deepEqual(validateCriticalEnvironment(environment), {
      nodeEnvironment: 'production',
      databaseName: 'lccomp'
    })
    assert.equal(resolveMongoUri(environment), environment.MONGO_URI)
  })

  it('does not expose Mongo credentials or JWT secret in validation errors', () => {
    const secret = 'recognizable-jwt-secret'
    const username = 'recognizable-user'
    const password = 'recognizable-password'
    const host = 'recognizable-host.invalid'
    let error

    try {
      validateCriticalEnvironment(productionEnvironment({
        JWT_PRIVATE_KEY: secret,
        MONGO_URI: `mongodb://${username}:${password}@${host}/test_inventory`
      }))
    } catch (caught) {
      error = caught
    }

    assert.ok(error)
    assert.equal(error.message, 'Production database cannot use a test database name')
    for (const sensitiveValue of [secret, username, password, host]) {
      assert.equal(error.message.includes(sensitiveValue), false)
    }
  })

  it('preserves deliberate test execution with an allowed test database', () => {
    assert.deepEqual(validateCriticalEnvironment({
      NODE_ENV: 'test',
      MONGO_URI: 'mongodb://localhost/lccomp_test'
    }), {
      nodeEnvironment: 'test',
      databaseName: null
    })
  })

  it('preserves development defaults and the legacy Mongo resolver', () => {
    assert.deepEqual(validateCriticalEnvironment({}), {
      nodeEnvironment: 'development',
      databaseName: null
    })
    assert.equal(
      resolveMongoUri({}, {
        userMongo: 'development-user',
        passMongo: 'development-password',
        dbCluster: 'development-cluster',
        dbColecction: 'development-database'
      }),
      'mongodb+srv://development-user:development-password@development-cluster/development-database?retryWrites=true&w=majority'
    )
  })

  it('accepts only the NODE_ENV values used by the project', () => {
    for (const nodeEnvironment of ['development', 'test', 'staging']) {
      assert.equal(
        validateCriticalEnvironment({ NODE_ENV: nodeEnvironment }).nodeEnvironment,
        nodeEnvironment
      )
    }

    assert.throws(
      () => validateCriticalEnvironment({ NODE_ENV: 'qa' }),
      { message: 'NODE_ENV must be development, test, staging, or production' }
    )
  })
})
