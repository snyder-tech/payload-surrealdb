import type { MigrationResult, Payload } from 'payload'

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { buildConfig } from 'payload'
import ts from 'typescript'
import { afterAll, beforeAll, beforeEach, describe, expect, test, vi } from 'vitest'

import type { SurrealDBAdapter } from '../src/index.js'

import { surrealdbAdapter } from '../src/index.js'
import { bootPayload, connectionArgs } from './helpers/payload.js'

/** What the answer to the prompt is, `null` for a terminal that is closed without one. */
const prompt = vi.hoisted(() => ({ answer: null as null | string, asked: 0 }))

vi.mock('node:readline/promises', () => ({
  createInterface: () => {
    let onClose: (() => void) | undefined

    return {
      close: () => onClose?.(),
      once: (_event: string, listener: () => void) => {
        onClose = listener
      },
      question: (): Promise<string> => {
        prompt.asked++

        if (prompt.answer === null) {
          setTimeout(() => onClose?.(), 0)

          return new Promise(() => undefined)
        }

        return Promise.resolve(prompt.answer)
      },
    }
  },
}))

const migrationDir = fs.mkdtempSync(path.join(os.tmpdir(), 'surreal-migrations-'))

const config = buildConfig({
  collections: [
    { slug: 'users', auth: true, fields: [], versions: false },
    {
      slug: 'notes',
      fields: [
        { name: 'title', type: 'text' },
        { name: 'slug', type: 'text', unique: true },
      ],
      versions: false,
    },
  ],
  db: surrealdbAdapter({ ...connectionArgs('migrations'), migrationDir }),
  secret: 'test-secret',
  telemetry: false,
  typescript: { autoGenerate: false },
})

let payload: Payload
let adapter: SurrealDBAdapter
let counter = 0

/**
 * Creates a migration with `createMigration` and fills in its body. The name is unique, because
 * Node caches a migration file it has imported once.
 */
const addMigration = async (label: string, { down, up }: { down?: string; up?: string } = {}) => {
  const migrationName = `${label}${counter++}`
  const result = await payload.db.createMigration({
    forceAcceptWarning: true,
    migrationName,
    payload,
  })

  if (!result?.created || !result.path) {
    throw new Error('createMigration did not create a file')
  }

  fs.writeFileSync(
    result.path,
    `import type { MigrateDownArgs, MigrateUpArgs } from '@snyder-tech/payload-surrealdb'

export async function up({ payload, req, session }: MigrateUpArgs): Promise<void> {
  await payload.create({ collection: 'notes', data: { title: '${migrationName}' }, overrideAccess: true, req })
  await session?.query("CREATE raw_marker SET name = '${migrationName}'").collect()
${up ?? ''}
}

export async function down({ payload, req, session }: MigrateDownArgs): Promise<void> {
  if (!session) {
    throw new Error('the migration got no session')
  }
  await payload.delete({ collection: 'notes', overrideAccess: true, req, where: { title: { equals: '${migrationName}' } } })
  await session.query("DELETE raw_marker WHERE name = '${migrationName}'").collect()
${down ?? ''}
}
`,
  )

  return { name: path.basename(result.path, '.ts'), path: result.path, title: migrationName }
}

/** Payload types the result of a migration command as possibly void, for adapters that return nothing. */
const resultOf = async (run: Promise<MigrationResult | void>): Promise<MigrationResult> => {
  const result = await run

  if (!result) {
    throw new Error('The migration command returned no result')
  }

  return result
}

const titles = async (): Promise<string[]> => {
  const { docs } = await payload.db.find<{ title: string }>({
    collection: 'notes',
    limit: 0,
    sort: 'title',
  })

  return docs.map(({ title }) => title)
}

const markers = async (): Promise<string[]> => {
  const [rows] = await adapter.connection!.query<[{ name: string }[]]>(
    'SELECT * FROM raw_marker ORDER BY name',
  )

  return rows.map(({ name }) => name)
}

const migrationRows = async () => {
  const { docs } = await payload.db.find<{ batch: number; name: string }>({
    collection: 'payload-migrations',
    limit: 0,
    sort: 'name',
  })

  return docs.map(({ batch, name }) => ({ batch, name }))
}

beforeAll(async () => {
  payload = await bootPayload(config, 'migrations')
  adapter = payload.db as SurrealDBAdapter
})

beforeEach(async () => {
  fs.rmSync(migrationDir, { force: true, recursive: true })
  await adapter.connection!.query('REMOVE TABLE IF EXISTS raw_marker')
  await adapter.clearDatabase()
  prompt.answer = null
  prompt.asked = 0
})

afterAll(async () => {
  await payload.destroy()
  fs.rmSync(migrationDir, { force: true, recursive: true })
})

describe('createMigration', () => {
  test('writes a dated file, creates the directory and keeps the index in step', async () => {
    const { name, path: file } = await addMigration('first')

    expect(name).toMatch(/^\d{8}_\d{6}_first\d+$/)
    expect(path.dirname(file)).toBe(migrationDir)

    const index = fs.readFileSync(path.join(migrationDir, 'index.ts'), 'utf8')
    expect(index).toContain(`migration_${name} from './${name}`)
    expect(index).toContain(`name: '${name}'`)
  })

  test('the template is typed with the adapter arguments', async () => {
    const result = await payload.db.createMigration({
      forceAcceptWarning: true,
      migrationName: 'blank name!',
      payload,
    })
    const content = fs.readFileSync(result?.path ?? '', 'utf8')

    expect(result?.path).toMatch(/_blank_name_\.ts$/)
    expect(content).toContain(
      "import type { MigrateDownArgs, MigrateUpArgs } from '@snyder-tech/payload-surrealdb'",
    )
    expect(content).toContain(
      'export async function up({ payload, req, session }: MigrateUpArgs): Promise<void> {',
    )
    expect(content).toContain(
      'export async function down({ payload, req, session }: MigrateDownArgs): Promise<void> {',
    )
  })

  test('without a name the file is called migration', async () => {
    const result = await payload.db.createMigration({ forceAcceptWarning: true, payload })

    expect(result?.path).toMatch(/_\d{6}_migration\.ts$/)
  })

  test('skipEmpty writes nothing', async () => {
    const result = await payload.db.createMigration({
      forceAcceptWarning: true,
      migrationName: 'skipped',
      payload,
      skipEmpty: true,
    })

    expect(result).toEqual({ created: false })
    expect(fs.existsSync(migrationDir)).toBe(true)
    expect(fs.readdirSync(migrationDir)).toEqual([])
  })

  test('a file from another package is used as the body', async () => {
    const source = path.join(migrationDir, '..', `predefined-${counter++}.ts`)
    fs.mkdirSync(migrationDir, { recursive: true })
    fs.writeFileSync(
      source,
      "export const upSQL = '  // predefined up'\nexport const downSQL = '  // predefined down'\n",
    )

    try {
      const result = await payload.db.createMigration({
        file: source,
        forceAcceptWarning: true,
        payload,
      })
      const content = fs.readFileSync(result?.path ?? '', 'utf8')

      expect(content).toContain('// predefined up')
      expect(content).toContain('// predefined down')
    } finally {
      fs.rmSync(source)
    }
  })
})

describe('migrate', () => {
  test('runs a created migration in its own transaction, with the session', async () => {
    const { name, title } = await addMigration('run')

    const result = await resultOf(payload.db.migrate())

    expect(result).toEqual({ batch: 1, migrated: [name], rolledBack: [] })
    expect(await titles()).toEqual([title])
    expect(await markers()).toEqual([title])
    expect(await migrationRows()).toEqual([{ batch: 1, name }])
  })

  test('runs the file as createMigration wrote it, with no edit, and rolls it back', async () => {
    const created = await payload.db.createMigration({
      forceAcceptWarning: true,
      migrationName: 'unedited',
      payload,
    })
    const file = created?.path ?? ''
    const name = path.basename(file, '.ts')

    expect(fs.readFileSync(file, 'utf8').match(/\/\/ Migration code/g)).toHaveLength(2)
    expect(await resultOf(payload.db.migrate())).toEqual({
      batch: 1,
      migrated: [name],
      rolledBack: [],
    })
    expect(await migrationRows()).toEqual([{ batch: 1, name }])
    expect(await resultOf(payload.db.migrateDown())).toMatchObject({ rolledBack: [name] })
    expect(await migrationRows()).toEqual([])
  })

  test('the file createMigration writes compiles against the adapter types', async () => {
    const created = await payload.db.createMigration({
      forceAcceptWarning: true,
      migrationName: 'compiles',
      payload,
    })
    const file = created?.path ?? ''
    const root = path.resolve(import.meta.dirname, '..')
    const program = ts.createProgram([file], {
      baseUrl: root,
      isolatedModules: true,
      module: ts.ModuleKind.NodeNext,
      moduleResolution: ts.ModuleResolutionKind.NodeNext,
      noEmit: true,
      paths: { '@snyder-tech/payload-surrealdb': ['src/index.ts'] },
      skipLibCheck: true,
      strict: true,
      target: ts.ScriptTarget.ES2023,
      types: [],
    })
    const source = program.getSourceFile(file)

    expect(source).toBeDefined()
    expect(
      [...program.getSyntacticDiagnostics(source), ...program.getSemanticDiagnostics(source)].map(
        ({ messageText }) => ts.flattenDiagnosticMessageText(messageText, '\n'),
      ),
    ).toEqual([])
  }, 120_000)

  test('runs each migration once, and each new batch after the last', async () => {
    const first = await addMigration('batch')
    await payload.db.migrate()

    expect(await resultOf(payload.db.migrate())).toEqual({ migrated: [], rolledBack: [] })

    const second = await addMigration('batch')
    const third = await addMigration('batch')
    const result = await resultOf(payload.db.migrate())

    expect(result).toEqual({ batch: 2, migrated: [second.name, third.name], rolledBack: [] })
    expect(await migrationRows()).toEqual([
      { batch: 1, name: first.name },
      { batch: 2, name: second.name },
      { batch: 2, name: third.name },
    ])
  })

  test('a migration that fails is rolled back with everything it wrote', async () => {
    const good = await addMigration('a_good')
    const bad = await addMigration('b_bad', { up: "  throw new Error('migration failed')" })

    await expect(payload.db.migrate()).rejects.toThrow('migration failed')

    // The first one stays, the failing one leaves neither its note, its raw record nor its row
    expect(await migrationRows()).toEqual([{ batch: 1, name: good.name }])
    expect(await titles()).toEqual([good.title])
    expect(await markers()).toEqual([good.title])
    expect(bad.name).not.toBe(good.name)
  })

  test('migrateStatus tells which have run', async () => {
    const first = await addMigration('status')
    await payload.db.migrate()
    const second = await addMigration('status')

    expect(await payload.db.migrateStatus()).toEqual([
      { name: first.name, batch: 1, ran: true },
      { name: second.name, ran: false },
    ])
  })
})

describe('migrateDown, migrateRefresh and migrateReset', () => {
  test('migrateDown rolls back the last batch only', async () => {
    const first = await addMigration('down')
    await payload.db.migrate()
    const second = await addMigration('down')
    const third = await addMigration('down')
    await payload.db.migrate()

    const result = await resultOf(payload.db.migrateDown())

    expect(result.rolledBack.toSorted()).toEqual([second.name, third.name].toSorted())
    expect(result.batch).toBe(2)
    expect(await titles()).toEqual([first.title])
    expect(await markers()).toEqual([first.title])
    expect(await migrationRows()).toEqual([{ batch: 1, name: first.name }])
  })

  test('migrateRefresh rolls everything back and runs it again', async () => {
    const first = await addMigration('refresh')
    const second = await addMigration('refresh')
    await payload.db.migrate()

    const result = await resultOf(payload.db.migrateRefresh())

    expect(result.rolledBack.toSorted()).toEqual([first.name, second.name].toSorted())
    expect(result.migrated).toEqual([first.name, second.name])
    expect(await titles()).toEqual([first.title, second.title])
    expect((await migrationRows()).map(({ name }) => name)).toEqual([first.name, second.name])
    // Payload hands `migrateRefresh` no session to the `up` of a migration, so no raw record is written
    expect(await markers()).toEqual([])
  })

  test('migrateReset rolls everything back', async () => {
    await addMigration('reset')
    await addMigration('reset')
    await payload.db.migrate()

    const result = await resultOf(payload.db.migrateReset())

    expect(result.rolledBack).toHaveLength(2)
    expect(await titles()).toEqual([])
    expect(await markers()).toEqual([])
    expect(await migrationRows()).toEqual([])
  })
})

const addStrayData = async () => {
  await payload.db.create({ collection: 'notes', data: { slug: 'stray', title: 'stray' } })
  await adapter.connection!.query("CREATE not_payload SET name = 'stray'")
}

describe('migrateFresh', () => {
  test('drops what was there, defines the tables and indexes again and runs every migration', async () => {
    const first = await addMigration('fresh')
    const second = await addMigration('fresh')
    await addStrayData()

    const result = await resultOf(payload.db.migrateFresh({ forceAcceptWarning: true }))

    expect(result).toEqual({ batch: 1, migrated: [first.name, second.name], rolledBack: [] })
    expect(await titles()).toEqual([first.title, second.title])
    expect(await migrationRows()).toEqual([
      { batch: 1, name: first.name },
      { batch: 1, name: second.name },
    ])
    // Every table is gone, not only the Payload ones
    const [info] =
      await adapter.connection!.query<[{ tables: Record<string, string> }]>('INFO FOR DB')
    expect(Object.keys(info.tables)).not.toContain('not_payload')

    // The unique index is defined again, so it still rejects a duplicate
    await payload.db.create({ collection: 'notes', data: { slug: 'same', title: 'one' } })
    await expect(
      payload.db.create({ collection: 'notes', data: { slug: 'same', title: 'two' } }),
    ).rejects.toThrow()
  })

  test('a failure while dropping leaves every table in place', async () => {
    await addMigration('droperror')
    await addStrayData()
    await adapter.connection!.query('DEFINE TABLE IF NOT EXISTS zz_last SCHEMALESS')

    const tableNames = async () => {
      const [info] =
        await adapter.connection!.query<[{ tables: Record<string, string> }]>('INFO FOR DB')

      return Object.keys(info.tables).toSorted()
    }
    const before = await tableNames()
    const query = adapter.connection!.query.bind(adapter.connection)
    // The statement that fails comes after every `REMOVE TABLE`, where the request would commit
    const spy = vi
      .spyOn(adapter.connection!, 'query')
      .mockImplementation((sql, vars, options) =>
        query(
          sql.includes('REMOVE TABLE')
            ? sql.includes('COMMIT;')
              ? sql.replace('COMMIT;', "THROW 'forced failure';\nCOMMIT;")
              : `${sql}\nTHROW 'forced failure';`
            : sql,
          vars,
          options,
        ),
      )

    try {
      await expect(payload.db.migrateFresh({ forceAcceptWarning: true })).rejects.toThrow(
        /forced failure/,
      )
    } finally {
      spy.mockRestore()
    }

    expect(before).toContain('not_payload')
    expect(await tableNames()).toEqual(before)
    expect(await titles()).toEqual(['stray'])
    const [strays] = await adapter.connection!.query<[unknown[]]>('SELECT * FROM not_payload')
    expect(strays).toHaveLength(1)
  })

  test('does not drop anything unless the warning is accepted', async () => {
    await addMigration('cancelled')
    await addStrayData()

    expect(await resultOf(payload.db.migrateFresh({ shouldPrompt: false }))).toEqual({
      cancelled: true,
      migrated: [],
      rolledBack: [],
    })
    expect(prompt.asked).toBe(0)
    expect(await titles()).toEqual(['stray'])
  })

  test('asks first, and a yes drops the database', async () => {
    const { name, title } = await addMigration('asked')
    await addStrayData()
    prompt.answer = 'y'

    const result = await resultOf(payload.db.migrateFresh({}))

    expect(prompt.asked).toBe(1)
    expect(result.migrated).toEqual([name])
    expect(await titles()).toEqual([title])
  })

  test.each(['n', '', 'maybe'])('asks first, and %j keeps the database', async (answer) => {
    await addStrayData()
    prompt.answer = answer

    expect(await resultOf(payload.db.migrateFresh({}))).toEqual({
      cancelled: true,
      migrated: [],
      rolledBack: [],
    })
    expect(await titles()).toEqual(['stray'])
  })

  test('a closed terminal is a no', async () => {
    await addStrayData()
    prompt.answer = null

    expect(await resultOf(payload.db.migrateFresh({}))).toEqual({
      cancelled: true,
      migrated: [],
      rolledBack: [],
    })
    expect(await titles()).toEqual(['stray'])
  })

  test('a migration that fails stops it and is rolled back', async () => {
    await addMigration('a_freshgood')
    await addMigration('b_freshbad', { up: "  throw new Error('fresh failed')" })

    await expect(payload.db.migrateFresh({ forceAcceptWarning: true })).rejects.toThrow(
      'fresh failed',
    )
    expect((await migrationRows()).length).toBe(1)
  })
})
