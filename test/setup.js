import mongoose from 'mongoose'
import userAdminModel from '../src/dao/models/userAdmin.model.js'
import {
  assertAllowedTestDatabaseUri,
  isAllowedTestDatabaseName
} from './helpers/testDatabaseSafety.js'

const createTestDatabaseLifecycle = ({
  mongooseInstance,
  userModel,
  environment
}) => {
  let authorizedDatabaseName = null

  const connectTestDB = async () => {
    const uri = environment.MONGO_URI
    const expectedDatabaseName = assertAllowedTestDatabaseUri(uri)

    if (mongooseInstance.connection.readyState !== 1) {
      await mongooseInstance.connect(uri)
    }

    const connectedDatabaseName = mongooseInstance.connection.name

    if (
      connectedDatabaseName !== expectedDatabaseName ||
      !isAllowedTestDatabaseName(connectedDatabaseName)
    ) {
      authorizedDatabaseName = null
      throw new Error('Connected database does not match the authorized test database')
    }

    authorizedDatabaseName = expectedDatabaseName
  }

  const clearUsersCollection = async () => {
    const connectedDatabaseName = mongooseInstance.connection.name

    if (
      mongooseInstance.connection.readyState !== 1 ||
      !authorizedDatabaseName ||
      connectedDatabaseName !== authorizedDatabaseName ||
      !isAllowedTestDatabaseName(connectedDatabaseName)
    ) {
      throw new Error('Unsafe test database configuration')
    }

    await userModel.deleteMany({})
  }

  const disconnectTestDB = async () => {
    authorizedDatabaseName = null

    if (mongooseInstance.connection.readyState !== 0) {
      await mongooseInstance.disconnect()
    }
  }

  return {
    clearUsersCollection,
    connectTestDB,
    disconnectTestDB
  }
}

const defaultLifecycle = createTestDatabaseLifecycle({
  mongooseInstance: mongoose,
  userModel: userAdminModel,
  environment: process.env
})

const { clearUsersCollection, connectTestDB, disconnectTestDB } = defaultLifecycle

export {
  clearUsersCollection,
  connectTestDB,
  createTestDatabaseLifecycle,
  disconnectTestDB
}
