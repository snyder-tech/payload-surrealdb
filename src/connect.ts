import type { Connect, Migration } from 'payload'

import type { SurrealDBAdapter } from './index.js'
import type { MigrateDownArgs, MigrateUpArgs } from './types.js'

import { SurrealPool } from './connection/pool.js'
import { escapeIdent } from './queries/sql.js'
import { defineSchema, dropAllTables } from './utilities/schema.js'

/** Each session carries its own budget of 64 open transactions; this stays well below it. */
const MAX_TRANSACTIONS_PER_SESSION = 60
const SESSIONS_PER_CONNECTION = 4

export const connect: Connect = async function connect(
  this: SurrealDBAdapter,
  options = {
    hotReload: false,
  },
) {
  const { hotReload } = options

  if (this.url === false) {
    return
  }

  if (typeof this.url !== 'string') {
    throw new Error('Error: missing SurrealDB connection URL.')
  }

  try {
    this.connection ??= await SurrealPool.create({
      client: {
        auth: this.auth,
        database: this.database,
        namespace: this.namespace,
        requestTimeout: this.requestTimeout,
        url: this.url,
      },
      size: this.poolSize,
      transactions:
        this.transactionOptions === false
          ? false
          : {
              ...this.transactionOptions,
              maxPerSession: MAX_TRANSACTIONS_PER_SESSION,
              sessionsPerConnection: SESSIONS_PER_CONNECTION,
            },
      warn: (msg, err) => this.payload.logger.warn({ err, msg }),
    })

    // A database-scoped user cannot define the database it belongs to, so provisioning is opt-out.
    if (this.provisionDatabase) {
      await this.connection.query(
        `DEFINE NAMESPACE IF NOT EXISTS ${escapeIdent(this.namespace)};
         DEFINE DATABASE IF NOT EXISTS ${escapeIdent(this.database)};`,
      )
    }

    if (!hotReload) {
      if (process.env['PAYLOAD_DROP_DATABASE'] === 'true') {
        this.payload.logger.info('---- DROPPING DATABASE ----')
        await dropAllTables(this)

        this.payload.logger.info('---- DROPPED DATABASE ----')
      }
    }

    await defineSchema(this)

    if (process.env['NODE_ENV'] === 'production' && this.prodMigrations) {
      // `migrate` hands migrations an untyped argument, ours expect the adapter's own argument types.
      const migrations: Migration[] = this.prodMigrations.map((migration) => ({
        ...migration,
        down: (args: unknown) => migration.down(args as MigrateDownArgs),
        up: (args: unknown) => migration.up(args as MigrateUpArgs),
      }))

      await this.migrate({ migrations })
    }
  } catch (err) {
    let msg = `Error: cannot connect to SurrealDB.`

    if (typeof err === 'object' && err && 'message' in err && typeof err.message === 'string') {
      msg = `${msg} Details: ${err.message}`
    }

    this.payload.logger.error({
      err,
      msg,
    })
    throw new Error(msg, { cause: err })
  }
}
