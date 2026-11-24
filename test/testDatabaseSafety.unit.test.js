import assert from 'node:assert/strict'
import { describe, it } from 'mocha'
import { createTestDatabaseLifecycle } from './setup.js'
import {
  assertAllowedTestDatabaseUri,
  isAllowedTestDatabaseName,
  parseMongoDatabaseName
} from './helpers/testDatabaseSafety.js'

const createMongooseStub = ({ connectedDatabaseName = null } = {}) => {
  const calls = {
    connect: 0,
    disconnect: 0
  }
  const connection = {
    name: connectedDatabaseName,
    readyState: connectedDatabaseName ? 1 : 0
  }

  return {
    calls,
    connection,
    async connect(uri) {
      calls.connect += 1
      connection.readyState = 1
      connection.name = parseMongoDatabaseName(uri)
    },
    async disconnect() {
      calls.disconnect += 1
      connection.readyState = 0
      connection.name = null
    }
  }
}

const createUserModelStub = () => {
  const calls = { deleteMany: 0 }

  return {
    calls,
    async deleteMany() {
      calls.deleteMany += 1
    }
  }
}

describe('test database safety', () => {
  describe('Mongo database name parsing', () => {
    it('accepts the repository local test database convention', () => {
      assert.equal(
        assertAllowedTestDatabaseUri('mongodb://localhost/lccomp_test'),
        'lccomp_test'
      )
    })

    it('accepts explicit test database name variants only', () => {
      const allowed = [
        'test',
        'test_inventory',
        'test-inventory',
        'inventory_test',
        'inventory-test'
      ]

      for (const databaseName of allowed) {
        assert.equal(isAllowedTestDatabaseName(databaseName), true)
      }

      for (const databaseName of ['testing', 'contest', 'LcCompWeb', 'production']) {
        assert.equal(isAllowedTestDatabaseName(databaseName), false)
      }
    })

    it('rejects test only in the username', () => {
      assert.throws(
        () => assertAllowedTestDatabaseUri('mongodb://test-user:secret@host/LcCompWeb'),
        /Test database name is not allowed/
      )
    })

    it('rejects test only in the password', () => {
      assert.throws(
        () => assertAllowedTestDatabaseUri('mongodb://user:test-secret@host/LcCompWeb'),
        /Test database name is not allowed/
      )
    })

    it('rejects test only in the hostname', () => {
      assert.throws(
        () => assertAllowedTestDatabaseUri('mongodb://user:secret@test-host/LcCompWeb'),
        /Test database name is not allowed/
      )
    })

    it('rejects test only in the query string', () => {
      assert.throws(
        () => assertAllowedTestDatabaseUri('mongodb://user:secret@host/LcCompWeb?appName=test'),
        /Test database name is not allowed/
      )
    })

    it('supports mongodb+srv without DNS or network access', () => {
      assert.equal(
        assertAllowedTestDatabaseUri('mongodb+srv://user:secret@example.invalid/lccomp_test'),
        'lccomp_test'
      )
    })

    it('rejects mongodb+srv when test appears only outside the database name', () => {
      assert.throws(
        () => assertAllowedTestDatabaseUri('mongodb+srv://test-user:secret@test-cluster/LcCompWeb'),
        /Test database name is not allowed/
      )
    })

    it('rejects a Mongo URI without a database name', () => {
      assert.throws(
        () => assertAllowedTestDatabaseUri('mongodb://user:secret@host'),
        /Unable to determine test database name/
      )
    })

    it('rejects an invalid URI', () => {
      assert.throws(
        () => assertAllowedTestDatabaseUri('not-a-mongo-uri'),
        /Unable to determine test database name/
      )
    })

    it('never includes credentials or the complete URI in errors', () => {
      const username = 'recognizable-test-username'
      const password = 'recognizable-test-password'
      const uri = `mongodb://${username}:${password}@example.invalid/LcCompWeb`

      assert.throws(
        () => assertAllowedTestDatabaseUri(uri),
        (error) => {
          assert.equal(error.message.includes(username), false)
          assert.equal(error.message.includes(password), false)
          assert.equal(error.message.includes(uri), false)
          return true
        }
      )
    })
  })

  describe('users collection cleanup guard', () => {
    it('does not connect or clear users for an unsafe URI', async () => {
      const mongooseInstance = createMongooseStub()
      const userModel = createUserModelStub()
      const lifecycle = createTestDatabaseLifecycle({
        mongooseInstance,
        userModel,
        environment: {
          MONGO_URI: 'mongodb://test-user:test-password@test-host/LcCompWeb?appName=test'
        }
      })

      await assert.rejects(() => lifecycle.connectTestDB(), /Test database name is not allowed/)
      await assert.rejects(() => lifecycle.clearUsersCollection(), /Unsafe test database configuration/)
      assert.equal(mongooseInstance.calls.connect, 0)
      assert.equal(userModel.calls.deleteMany, 0)
    })

    it('allows cleanup only after connecting to the validated database', async () => {
      const mongooseInstance = createMongooseStub()
      const userModel = createUserModelStub()
      const lifecycle = createTestDatabaseLifecycle({
        mongooseInstance,
        userModel,
        environment: { MONGO_URI: 'mongodb://localhost/lccomp_test' }
      })

      await assert.rejects(() => lifecycle.clearUsersCollection(), /Unsafe test database configuration/)
      await lifecycle.connectTestDB()
      await lifecycle.clearUsersCollection()

      assert.equal(mongooseInstance.calls.connect, 1)
      assert.equal(userModel.calls.deleteMany, 1)
    })

    it('rejects an existing connection to a different database', async () => {
      const mongooseInstance = createMongooseStub({ connectedDatabaseName: 'production' })
      const userModel = createUserModelStub()
      const lifecycle = createTestDatabaseLifecycle({
        mongooseInstance,
        userModel,
        environment: { MONGO_URI: 'mongodb://localhost/lccomp_test' }
      })

      await assert.rejects(
        () => lifecycle.connectTestDB(),
        /Connected database does not match the authorized test database/
      )
      await assert.rejects(() => lifecycle.clearUsersCollection(), /Unsafe test database configuration/)
      assert.equal(mongooseInstance.calls.connect, 0)
      assert.equal(userModel.calls.deleteMany, 0)
    })
  })
})
