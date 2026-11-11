const path = require('node:path')

const AUDIT_SYMBOL = Symbol.for('lccomp.integration.dotenvPathAudit')
const repositoryRoot = path.resolve(__dirname, '../../..')
const initialCwd = process.cwd()
const dotenv = require(require.resolve('dotenv', { paths: [repositoryRoot] }))
const originalConfig = dotenv.config.bind(dotenv)

const isInsideDirectory = (candidate, directory) => {
  const relative = path.relative(directory, candidate)
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative))
}

const resolveConfiguredPaths = (options = {}) => {
  const configured = options.path === undefined
    ? [path.resolve(process.cwd(), '.env')]
    : Array.isArray(options.path)
      ? options.path
      : [options.path]

  return configured.map((candidate) => path.resolve(process.cwd(), String(candidate)))
}

const audit = {
  guardActive: true,
  repositoryRoot,
  initialCwd,
  calls: []
}

globalThis[AUDIT_SYMBOL] = audit

dotenv.config = function guardedDotenvConfig (options = {}) {
  const resolvedPaths = resolveConfiguredPaths(options)

  for (const resolvedPath of resolvedPaths) {
    const isProjectEnvironmentFile =
      isInsideDirectory(resolvedPath, repositoryRoot) &&
      /^\.env(?:\.|$)/i.test(path.basename(resolvedPath))

    audit.calls.push({
      resolvedPath,
      isProjectEnvironmentFile
    })

    if (isProjectEnvironmentFile) {
      const error = new Error(
        'Integration isolation refused to load a project environment file'
      )
      error.code = 'INTEGRATION_PROJECT_ENV_FORBIDDEN'
      throw error
    }
  }

  return originalConfig(options)
}
