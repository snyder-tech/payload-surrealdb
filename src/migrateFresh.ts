import type { MigrationResult, PayloadRequest } from 'payload'

import { commitTransaction, initTransaction, killTransaction, readMigrationFiles } from 'payload'

import type { SurrealDBAdapter } from './index.js'

import { defineSchema, dropAllTables } from './utilities/schema.js'

const WARNING =
  'WARNING: This will drop your database and run all migrations. Are you sure you want to proceed? (y/N) '

/**
 * Asks on the terminal. Anything but a yes, including a closed input, is a no. `node:readline` is
 * loaded here because the adapter's entry point is bundled for Cloudflare Workers.
 */
const confirm = async (): Promise<boolean> => {
  const { createInterface } = await import('node:readline/promises')
  const rl = createInterface({ input: process.stdin, output: process.stdout })
  const closed = new Promise<string>((resolve) => rl.once('close', () => resolve('')))

  try {
    const answer = await Promise.race([rl.question(WARNING), closed])

    return /^y(es)?$/i.test(answer.trim())
  } finally {
    rl.close()
  }
}

/**
 * Drop every table of the current database, define them again and run every migration's `up`.
 */
export async function migrateFresh(
  this: SurrealDBAdapter,
  {
    forceAcceptWarning = false,
    shouldPrompt = true,
  }: { forceAcceptWarning?: boolean; shouldPrompt?: boolean },
): Promise<MigrationResult> {
  const { payload } = this

  if (!forceAcceptWarning) {
    if (!shouldPrompt || !(await confirm())) {
      return { cancelled: true, migrated: [], rolledBack: [] }
    }
  }

  payload.logger.info({
    msg: `Dropping database.`,
  })

  await dropAllTables(this)
  await defineSchema(this)

  const migrationFiles = await readMigrationFiles({ payload })
  payload.logger.debug({
    msg: `Found ${migrationFiles.length} migration files.`,
  })

  const req: Pick<PayloadRequest, 'payload' | 'transactionID'> = { payload }
  const migrated: string[] = []

  // Run all migrate up
  for (const migration of migrationFiles) {
    payload.logger.info({ msg: `Migrating: ${migration.name}` })
    try {
      const start = Date.now()
      await initTransaction(req)
      const session = this.connection?.sessions.get(String(await req.transactionID))?.tx
      await migration.up({ payload, req, session })
      await payload.create({
        collection: 'payload-migrations',
        data: {
          name: migration.name,
          batch: 1,
        },
        overrideAccess: true,
        req,
      })

      await commitTransaction(req)
      migrated.push(migration.name)

      payload.logger.info({ msg: `Migrated:  ${migration.name} (${Date.now() - start}ms)` })
    } catch (err: unknown) {
      await killTransaction(req)
      payload.logger.error({
        err,
        msg: `Error running migration ${migration.name}. Rolling back.`,
      })
      throw err
    }
  }

  return { batch: 1, migrated, rolledBack: [] }
}
