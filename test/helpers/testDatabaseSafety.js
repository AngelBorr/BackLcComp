const ALLOWED_TEST_DATABASE_NAME = /^(?:test|test[_-][a-z0-9][a-z0-9_-]*|[a-z0-9][a-z0-9_-]*[_-]test)$/i

class TestDatabaseSafetyError extends Error {
  constructor(message) {
    super(message)
    this.name = 'TestDatabaseSafetyError'
  }
}

const parseMongoDatabaseName = (uri) => {
  if (typeof uri !== 'string' || uri.trim() === '') {
    throw new TestDatabaseSafetyError('Unable to determine test database name')
  }

  let parsed

  try {
    parsed = new URL(uri)
  } catch {
    throw new TestDatabaseSafetyError('Unable to determine test database name')
  }

  if (!['mongodb:', 'mongodb+srv:'].includes(parsed.protocol) || !parsed.hostname) {
    throw new TestDatabaseSafetyError('Unable to determine test database name')
  }

  const encodedDatabaseName = parsed.pathname.startsWith('/')
    ? parsed.pathname.slice(1)
    : ''

  if (!encodedDatabaseName || encodedDatabaseName.includes('/')) {
    throw new TestDatabaseSafetyError('Unable to determine test database name')
  }

  let databaseName

  try {
    databaseName = decodeURIComponent(encodedDatabaseName)
  } catch {
    throw new TestDatabaseSafetyError('Unable to determine test database name')
  }

  if (!databaseName || databaseName.includes('/')) {
    throw new TestDatabaseSafetyError('Unable to determine test database name')
  }

  return databaseName
}

const isAllowedTestDatabaseName = (databaseName) =>
  typeof databaseName === 'string' && ALLOWED_TEST_DATABASE_NAME.test(databaseName)

const assertAllowedTestDatabaseUri = (uri) => {
  const databaseName = parseMongoDatabaseName(uri)

  if (!isAllowedTestDatabaseName(databaseName)) {
    throw new TestDatabaseSafetyError('Test database name is not allowed')
  }

  return databaseName
}

export {
  TestDatabaseSafetyError,
  assertAllowedTestDatabaseUri,
  isAllowedTestDatabaseName,
  parseMongoDatabaseName
}
