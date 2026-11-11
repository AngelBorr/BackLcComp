import { spawn } from 'node:child_process'
import { mkdtemp, readdir, realpath, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const TEMPORARY_DIRECTORY_PREFIX = 'lccomp-mongo-integration-'
const repositoryRoot = fileURLToPath(new URL('../../', import.meta.url))
const integrationRoot = path.join(repositoryRoot, 'test', 'integration')
const mochaCli = path.join(repositoryRoot, 'node_modules', 'mocha', 'bin', 'mocha.js')
const dotenvGuard = path.join(integrationRoot, 'helpers', 'dotenvPathGuard.cjs')

const findIntegrationTests = async (directory) => {
  const entries = await readdir(directory, { withFileTypes: true })
  const files = []

  for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
    const absolutePath = path.join(directory, entry.name)
    if (entry.isDirectory()) files.push(...await findIntegrationTests(absolutePath))
    else if (entry.isFile() && entry.name.endsWith('.integration.test.js')) files.push(absolutePath)
  }

  return files
}

const assertSafeTemporaryDirectory = async (directory) => {
  const resolvedTemporaryRoot = await realpath(os.tmpdir())
  const resolvedDirectory = await realpath(directory)

  if (
    path.dirname(resolvedDirectory) !== resolvedTemporaryRoot ||
    !path.basename(resolvedDirectory).startsWith(TEMPORARY_DIRECTORY_PREFIX)
  ) {
    throw new Error('Refusing integration cleanup outside the controlled temporary directory')
  }
}

const run = async () => {
  const temporaryRoot = await realpath(os.tmpdir())
  const isolatedCwd = await mkdtemp(path.join(temporaryRoot, TEMPORARY_DIRECTORY_PREFIX))
  let exitCode = 1

  try {
    const testFiles = await findIntegrationTests(integrationRoot)
    if (!testFiles.length) throw new Error('No Mongo integration tests were found')

    exitCode = await new Promise((resolve, reject) => {
      const child = spawn(
        process.execPath,
        [
          '--require',
          dotenvGuard,
          mochaCli,
          '--timeout',
          '180000',
          ...testFiles
        ],
        {
          cwd: isolatedCwd,
          env: { ...process.env, NODE_OPTIONS: '' },
          stdio: 'inherit',
          windowsHide: true
        }
      )

      child.once('error', reject)
      child.once('exit', (code, signal) => {
        if (signal) return reject(new Error(`Integration process terminated by ${signal}`))
        resolve(code ?? 1)
      })
    })
  } finally {
    await assertSafeTemporaryDirectory(isolatedCwd)
    await rm(isolatedCwd, { recursive: true, force: true })
  }

  process.exitCode = exitCode
}

run().catch((error) => {
  process.stderr.write(`Mongo integration runner failed: ${error.message}\n`)
  process.exitCode = 1
})
