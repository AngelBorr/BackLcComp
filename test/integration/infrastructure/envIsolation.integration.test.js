/* eslint-env mocha */
import assert from 'node:assert/strict'
import { existsSync } from 'node:fs'
import path from 'node:path'
import dotenv from 'dotenv'

const AUDIT_SYMBOL = Symbol.for('lccomp.integration.dotenvPathAudit')

describe('integration environment-file isolation', function () {
  before(async function () {
    await import('../../../src/services/checkout.service.js')
  })

  it('loads production services only after the runner activated the dotenv path guard', function () {
    const audit = globalThis[AUDIT_SYMBOL]

    assert.equal(audit?.guardActive, true)
    assert.ok(Array.isArray(audit.calls))
    assert.ok(audit.calls.length > 0)
  })

  it('runs outside the repository without an environment file in the isolated cwd', function () {
    const audit = globalThis[AUDIT_SYMBOL]
    const relative = path.relative(audit.repositoryRoot, audit.initialCwd)

    assert.notEqual(relative, '')
    assert.equal(relative.startsWith('..') || path.isAbsolute(relative), true)
    assert.equal(existsSync(path.join(audit.initialCwd, '.env')), false)
    assert.equal(existsSync(path.join(audit.initialCwd, '.env.test')), false)
  })

  it('never resolves dotenv to a project environment file', function () {
    const audit = globalThis[AUDIT_SYMBOL]
    const expectedDefaultPath = path.resolve(audit.initialCwd, '.env')

    assert.equal(
      audit.calls.some((entry) => entry.resolvedPath === expectedDefaultPath),
      true
    )
    assert.equal(
      audit.calls.some((entry) => entry.isProjectEnvironmentFile),
      false
    )
  })

  it('fails closed before dotenv can read the project .env or .env.test', function () {
    const audit = globalThis[AUDIT_SYMBOL]

    for (const filename of ['.env', '.env.test']) {
      assert.throws(
        () => dotenv.config({ path: path.join(audit.repositoryRoot, filename) }),
        (error) => error?.code === 'INTEGRATION_PROJECT_ENV_FORBIDDEN'
      )
    }
  })

  it('rejects project environment filenames independently of casing', function () {
    const audit = globalThis[AUDIT_SYMBOL]
    const filenames = [
      '.ENV',
      '.Env',
      '.eNv',
      '.ENV.TEST',
      '.Env.Test',
      '.ENV.LOCAL',
      '.Env.Local',
      '.ENV.PRODUCTION'
    ]

    for (const filename of filenames) {
      assert.throws(
        () => dotenv.config({ path: path.join(audit.repositoryRoot, filename) }),
        (error) => error?.code === 'INTEGRATION_PROJECT_ENV_FORBIDDEN'
      )
    }

    if (process.platform === 'win32') {
      assert.throws(
        () => dotenv.config({
          path: path.join(audit.repositoryRoot.toUpperCase(), '.EnV.LoCaL')
        }),
        (error) => error?.code === 'INTEGRATION_PROJECT_ENV_FORBIDDEN'
      )
    }
  })
})
