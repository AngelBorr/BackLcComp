import mongoose from 'mongoose'
import env from '../config.js'

const resolveMongoUri = (environment = process.env, configuration = env) => (
  environment.MONGO_URI ||
  `mongodb+srv://${configuration.userMongo}:${configuration.passMongo}@${configuration.dbCluster}/${configuration.dbColecction}?retryWrites=true&w=majority`
)

const connectMongo = ({
  mongooseInstance = mongoose,
  environment = process.env,
  configuration = env
} = {}) => mongooseInstance.connect(resolveMongoUri(environment, configuration))

export { connectMongo, resolveMongoUri }
