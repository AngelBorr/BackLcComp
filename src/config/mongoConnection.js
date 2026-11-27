import mongoose from 'mongoose'
import env, { validateCriticalEnvironment } from '../config.js'

const resolveMongoUri = (environment = process.env, configuration = env) => {
  const validation = validateCriticalEnvironment(environment)

  if (validation.nodeEnvironment === 'production') {
    return environment.MONGO_URI.trim()
  }

  return environment.MONGO_URI ||
    `mongodb+srv://${configuration.userMongo}:${configuration.passMongo}@${configuration.dbCluster}/${configuration.dbColecction}?retryWrites=true&w=majority`
}

const connectMongo = ({
  mongooseInstance = mongoose,
  environment = process.env,
  configuration = env
} = {}) => mongooseInstance.connect(resolveMongoUri(environment, configuration))

export { connectMongo, resolveMongoUri }
