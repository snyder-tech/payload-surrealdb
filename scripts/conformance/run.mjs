// Runs Payload's own int suites against this adapter. See scripts/conformance/README.md.
// Usage: node scripts/conformance/run.mjs <group>... | all
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import net from 'node:net'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { evaluate } from './evaluate.mjs'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const REPO = path.resolve(HERE, '../..')
const TESTS_DIR = path.join(REPO, 'tests/conformance')
const WORK_DIR = path.resolve(process.env.CONFORMANCE_DIR ?? path.join(REPO, '.conformance'))
const SURREALDB_VERSION = process.env.SURREALDB_VERSION ?? '3.3.2'
const PAYLOAD_REPO = 'https://github.com/payloadcms/payload.git'
const ADAPTER_PACKAGE = '@snyder-tech/payload-surrealdb'
const DB_ADAPTERS_ANCHOR = '} as const satisfies Record<string, DbAdapter>'
const READY_TIMEOUT_MS = 60_000

const readJson = (file) => JSON.parse(fs.readFileSync(file, 'utf8'))

/** Runs a command with inherited output and throws if it fails. */
function run(command, args, { cwd, env } = {}) {
  const result = spawnSync(command, args, {
    cwd,
    env: { ...process.env, ...env },
    stdio: 'inherit',
  })
  if (result.error) throw result.error
  if (result.status !== 0) {
    throw new Error(`${command} ${args.join(' ')} exited with ${result.status ?? result.signal}`)
  }
}

/** Runs a command, returns its exit status and does not throw on a non-zero one. */
function status(command, args, options = {}) {
  const result = spawnSync(command, args, { ...options, stdio: 'ignore' })
  if (result.error) throw result.error
  return result.status
}

function freePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer()
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address()
      server.close(() => resolve(port))
    })
  })
}

function prepareCheckout(tag) {
  const checkout = path.join(WORK_DIR, `payload-${tag}`)
  if (fs.existsSync(path.join(checkout, '.git'))) {
    // Suites rewrite tracked fixtures (test/database/migrate-to-blocks-as-json), and earlier
    // runs left a linked package and patches behind. Ignored node_modules stay.
    run('git', ['reset', '--hard', '--quiet'], { cwd: checkout })
    run('git', ['clean', '-fdq'], { cwd: checkout })
  } else {
    fs.mkdirSync(WORK_DIR, { recursive: true })
    run('git', ['clone', '--quiet', '--depth', '1', '--branch', tag, PAYLOAD_REPO, checkout])
  }
  return checkout
}

/**
 * Copies the adapter source into the checkout as a workspace package. Every dependency that is a
 * package of the checkout (`payload`, `@payloadcms/*`) resolves to the checkout's copy: two copies
 * of `payload` break instanceof and config checks.
 */
function linkAdapter(checkout) {
  const dest = path.join(checkout, 'packages/payload-surrealdb')
  fs.rmSync(dest, { force: true, recursive: true })
  fs.mkdirSync(dest, { recursive: true })
  fs.cpSync(path.join(REPO, 'src'), path.join(dest, 'src'), { recursive: true })

  const workspaceNames = new Set(
    fs
      .readdirSync(path.join(checkout, 'packages'))
      .map((dir) => path.join(checkout, 'packages', dir, 'package.json'))
      .filter((file) => fs.existsSync(file))
      .map((file) => readJson(file).name),
  )

  const pkg = readJson(path.join(REPO, 'package.json'))
  for (const field of ['dependencies', 'devDependencies', 'peerDependencies']) {
    for (const name of Object.keys(pkg[field] ?? {})) {
      if (workspaceNames.has(name)) pkg[field][name] = 'workspace:*'
    }
  }
  // Runs from TypeScript source, like Payload's own adapters do inside their monorepo.
  pkg.exports = {
    '.': { import: './src/index.ts', types: './src/index.ts', default: './src/index.ts' },
  }
  delete pkg.scripts
  delete pkg.packageManager
  fs.writeFileSync(path.join(dest, 'package.json'), `${JSON.stringify(pkg, null, 2)}\n`)
}

/** Registers a `surrealdb` entry in Payload's test/dbAdapters.ts. Throws if the anchor moved. */
function injectAdapter(checkout) {
  const dbAdaptersPath = path.join(checkout, 'test/dbAdapters.ts')
  const source = fs.readFileSync(dbAdaptersPath, 'utf8')
  if (source.split(DB_ADAPTERS_ANCHOR).length !== 2) {
    throw new Error(
      `Expected the anchor "${DB_ADAPTERS_ANCHOR}" exactly once in ${dbAdaptersPath}. ` +
        'Payload changed test/dbAdapters.ts: update scripts/conformance/run.mjs, or the run would test another adapter.',
    )
  }
  const entry = `  surrealdb: {
    envVar: 'SURREALDB_URL',
    host: '127.0.0.1',
    port: 8000,
    label: 'SurrealDB',
    source: \`
  import { surrealdbAdapter } from '${ADAPTER_PACKAGE}'

  export const databaseAdapter = surrealdbAdapter({
    url: process.env.SURREALDB_URL,
    namespace: process.env.SURREALDB_NAMESPACE,
    database: process.env.SURREALDB_DATABASE,
    auth: {
      username: 'root',
      password: 'root',
    },
  })\`,
  },
`
  fs.writeFileSync(dbAdaptersPath, source.replace(DB_ADAPTERS_ANCHOR, entry + DB_ADAPTERS_ANCHOR))

  const testPkgPath = path.join(checkout, 'test/package.json')
  const testPkg = readJson(testPkgPath)
  testPkg.devDependencies ??= {}
  testPkg.devDependencies[ADAPTER_PACKAGE] = 'workspace:*'
  fs.writeFileSync(testPkgPath, `${JSON.stringify(testPkg, null, 2)}\n`)
}

function applyPatches(checkout) {
  const patchDir = path.join(HERE, 'patches')
  for (const name of fs
    .readdirSync(patchDir)
    .filter((f) => f.endsWith('.patch'))
    .toSorted()) {
    console.log(`applying patch ${name}`)
    run('git', ['apply', path.join(patchDir, name)], { cwd: checkout })
  }
}

async function startSurreal(port) {
  const name = `payload-surrealdb-conformance-${port}`
  run('docker', [
    'run',
    '-d',
    '--rm',
    '--name',
    name,
    '-p',
    `127.0.0.1:${port}:8000`,
    `surrealdb/surrealdb:v${SURREALDB_VERSION}`,
    'start',
    '--user',
    'root',
    '--pass',
    'root',
    'memory',
  ])
  const stop = () => spawnSync('docker', ['rm', '-f', name], { stdio: 'ignore' })

  const deadline = Date.now() + READY_TIMEOUT_MS
  while (
    status('docker', [
      'exec',
      name,
      '/surreal',
      'is-ready',
      '--endpoint',
      'http://127.0.0.1:8000',
    ]) !== 0
  ) {
    if (Date.now() > deadline) {
      spawnSync('docker', ['logs', name], { stdio: 'inherit' })
      stop()
      throw new Error(
        `SurrealDB ${SURREALDB_VERSION} was not ready after ${READY_TIMEOUT_MS / 1000}s`,
      )
    }
    await new Promise((resolve) => setTimeout(resolve, 1000))
  }
  return stop
}

const escapeRegex = (text) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

/** `-t` filter that excludes every skip-listed test (a negative lookahead on the full test name). */
function skipRegex(skipped) {
  if (skipped.length === 0) return '.*'
  return `^(?!.*(?:${skipped.map((s) => escapeRegex(s.test)).join('|')})).*$`
}

async function main() {
  const groups = readJson(path.join(HERE, 'groups.json'))
  const requested = process.argv.slice(2)
  if (requested.length === 0) {
    throw new Error(`Name a group (${Object.keys(groups).join(', ')}) or "all".`)
  }
  const names = requested.includes('all') ? Object.keys(groups) : requested
  for (const name of names) {
    if (!groups[name])
      throw new Error(`Unknown group "${name}". Known: ${Object.keys(groups).join(', ')}`)
  }

  const peer = readJson(path.join(REPO, 'package.json')).peerDependencies.payload
  const tag = process.env.PAYLOAD_TAG || `v${peer}`
  console.log(`Payload ${tag}, SurrealDB ${SURREALDB_VERSION}, groups: ${names.join(', ')}`)

  const expected = readJson(path.join(TESTS_DIR, 'expected-failures.json'))
  const skipped = readJson(path.join(TESTS_DIR, 'skip-list.json'))

  const checkout = prepareCheckout(tag)
  linkAdapter(checkout)
  injectAdapter(checkout)
  applyPatches(checkout)
  run('pnpm', ['install', '--no-frozen-lockfile', '--reporter=silent'], { cwd: checkout })

  const port = Number(process.env.SURREALDB_PORT) || (await freePort())
  const stopSurreal = await startSurreal(port)
  console.log(`SurrealDB ${SURREALDB_VERSION} ready on port ${port}`)
  const onSignal = () => {
    stopSurreal()
    process.exit(130)
  }
  process.once('SIGINT', onSignal)
  process.once('SIGTERM', onSignal)

  const resultsDir = path.join(WORK_DIR, 'results')
  fs.mkdirSync(resultsDir, { recursive: true })
  const failedGroups = []
  try {
    for (const name of names) {
      const resultsFile = path.join(resultsDir, `${name}.json`)
      fs.rmSync(resultsFile, { force: true })

      // The suites' own exit code is ignored on purpose: failures that are on the expected list
      // make vitest exit 1. The evaluator is the verdict.
      spawnSync(
        'pnpm',
        [
          'test:int',
          ...groups[name],
          '--retry=0',
          '--testTimeout=20000',
          '--hookTimeout=40000',
          '--reporter=dot',
          '--reporter=json',
          `--outputFile.json=${resultsFile}`,
          '-t',
          skipRegex(skipped),
        ],
        {
          cwd: checkout,
          stdio: 'inherit',
          env: {
            ...process.env,
            PAYLOAD_DATABASE: 'surrealdb',
            SURREALDB_URL: `ws://127.0.0.1:${port}/rpc`,
            SURREALDB_NAMESPACE: 'conformance',
            SURREALDB_DATABASE: name.replaceAll('-', '_'),
          },
        },
      )

      console.log(`\n== evaluating ${name} ==`)
      if (!fs.existsSync(resultsFile)) {
        console.log(`NO REPORT: vitest wrote no ${resultsFile}`)
        failedGroups.push(name)
        continue
      }
      const { failed, passed, problems } = evaluate({
        results: readJson(resultsFile),
        root: checkout,
        expected,
        skipped,
      })
      console.log(`passed=${passed} failed=${failed} expected-failures=${expected.length}`)
      for (const problem of problems) console.log(problem)
      if (problems.length > 0) failedGroups.push(name)
    }
  } finally {
    stopSurreal()
  }

  if (failedGroups.length > 0) {
    console.error(`\nConformance FAILED: ${failedGroups.join(', ')}`)
    process.exit(1)
  }
  console.log('\nConformance OK')
}

main().catch((error) => {
  console.error(error)
  process.exit(1)
})
