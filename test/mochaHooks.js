import { connectTestDB, clearUsersCollection, disconnectTestDB } from './setup.js'

before(async () => {
  await connectTestDB()
})

beforeEach(async () => {
  await clearUsersCollection()
})

after(async () => {
  await disconnectTestDB()
})
