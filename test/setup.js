import mongoose from 'mongoose'
import userAdminModel from '../src/dao/models/userAdmin.model.js'

const isTestDb = (uri) =>
  typeof uri === 'string' && (uri.includes('lccomp_test') || uri.toLowerCase().includes('test'))

export const connectTestDB = async () => {
  const uri = process.env.MONGO_URI

  if (!uri) {
    throw new Error(
      '❌ MONGO_URI no está definido. Cargá .env.test o configurá la variable de entorno.'
    )
  }

  // 🛡️ Guardia para no correr tests contra DB real
  if (!isTestDb(uri)) {
    throw new Error(
      `🚨 MONGO_URI no parece ser una base de test.\nURI actual: ${uri}\n` +
        `Asegurate de usar lccomp_test (ej: mongodb://localhost:27017/lccomp_test).`
    )
  }

  // Evitar reconexiones si ya está conectado
  if (mongoose.connection.readyState === 1) return

  await mongoose.connect(uri)

  // Log opcional (debug)
  // eslint-disable-next-line no-console
  console.log('🧪 Conectado a DB de test:', mongoose.connection.name)
}

export const clearUsersCollection = async () => {
  // Limpia SOLO la colección users
  await userAdminModel.deleteMany({})
}

export const disconnectTestDB = async () => {
  if (mongoose.connection.readyState !== 0) {
    await mongoose.disconnect()
    // eslint-disable-next-line no-console
    console.log('🧪 DB de test desconectada')
  }
}
