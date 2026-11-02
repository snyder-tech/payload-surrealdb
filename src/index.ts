import type { BaseDatabaseAdapter, DatabaseAdapterObj, Payload } from 'payload'

import { createDatabaseAdapter, findMigrationDir } from 'payload'

import type { ClientArgs } from './connection/createClient.js'
import type { SurrealPool } from './connection/pool.js'
import type { IndexDefinition } from './models/buildSchema.js'
import type { SurrealDBMigration, TableMeta } from './types.js'

import { clearDatabase } from './clearDatabase.js'
import { connect } from './connect.js'
import { count } from './count.js'
import { countGlobalVersions } from './countGlobalVersions.js'
import { countVersions } from './countVersions.js'
import { create } from './create.js'
import { createGlobal } from './createGlobal.js'
import { createGlobalVersion } from './createGlobalVersion.js'
import { createMigration } from './createMigration.js'
import { createVersion } from './createVersion.js'
import { deleteMany } from './deleteMany.js'
import { deleteOne } from './deleteOne.js'
import { deleteVersions } from './deleteVersions.js'
import { destroy } from './destroy.js'
import { find } from './find.js'
import { findDistinct } from './findDistinct.js'
import { findGlobal } from './findGlobal.js'
import { findGlobalVersions } from './findGlobalVersions.js'
import { findOne } from './findOne.js'
import { findVersions } from './findVersions.js'
import { init } from './init.js'
import { migrateFresh } from './migrateFresh.js'
import { queryDrafts } from './queryDrafts.js'
import { beginTransaction } from './transactions/beginTransaction.js'
import { commitTransaction } from './transactions/commitTransaction.js'
import { rollbackTransaction } from './transactions/rollbackTransaction.js'
import { transactionSessions } from './transactions/transactionSessions.js'
import { updateGlobal } from './updateGlobal.js'
import { updateGlobalVersion } from './updateGlobalVersion.js'
import { updateJobs } from './updateJobs.js'
import { updateMany } from './updateMany.js'
import { updateOne } from './updateOne.js'
import { updateVersion } from './updateVersion.js'
import { upsert } from './upsert.js'

export type { MigrateDownArgs, MigrateUpArgs } from './types.js'

export interface Args {
  /**
   * By default, Payload strips all additional keys from the data that don't exist in the Payload
   * schema. If you have some data that you want to include in the result but it doesn't exist in
   * Payload, you can enable this flag
   * @default false
   */
  allowAdditionalKeys?: boolean
  /**
   * Lets create operations carry their own ID in `data`. A string stays a string key and a safe
   * integer stays a number key, and the ID is returned as it was given.
   * @default true
   */
  allowIDOnCreate?: boolean
  /** Credentials, for example `{ username: 'root', password: '...' }`. */
  auth: ClientArgs['auth']
  /**
   * When true, bulk operations will process documents one at a time
   * in separate transactions instead of all at once in a single transaction.
   *
   * @default false
   */
  bulkOperationsSingleTransaction?: boolean
  /**
   * Sort strings with SurrealDB's `COLLATE`, which orders letters alphabetically instead of by byte
   * value (`a, á, B, b` rather than `B, a, b, á`). `{ numericOrdering: true }` adds `NUMERIC`, so
   * that `Post 2` sorts before `Post 10`. It applies to the sorts the adapter builds, not to
   * filters. SurrealDB's collation is not per locale and has none of Mongo's other options
   * (`strength`, `caseFirst` and so on).
   *
   * Defaults to disabled, which sorts by byte value as Mongo does without a collation.
   */
  collation?: boolean | { numericOrdering?: boolean } | undefined
  database: string
  /**
   * We add a secondary sort based on `createdAt` to ensure that results are always returned in the same order when sorting by a non-unique field.
   * Set to `true` to disable this behaviour.
   */
  disableFallbackSort?: boolean
  /**
   * Define the indexes generated from the field config on connect (`IF NOT EXISTS`, so existing
   * ones are left alone). Turn off when a migration owns them.
   * @default true
   */
  ensureIndexes?: boolean
  migrationDir?: string
  namespace: string
  /** Connections that queries and transactions are spread over. */
  pool?: {
    /**
     * WebSocket connections, from 2 to 4. An HTTP URL always uses one.
     * @default 2
     */
    size?: number
  }
  prodMigrations?: SurrealDBMigration[] | undefined
  /**
   * Define the namespace and database on connect. Turn off for a database-scoped user, which is
   * not allowed to define the database it belongs to.
   * @default true
   */
  provisionDatabase?: boolean
  /**
   * How long a query may run before it fails, in milliseconds. Without a limit the SDK would wait
   * forever on a query the server never answers.
   * @default 30000
   */
  requestTimeout?: number
  /**
   * Payload runs every write operation in a transaction. `false` turns that off, and an HTTP URL
   * cannot hold interactive transactions anyway.
   */
  transactionOptions?:
    | false
    | {
        /**
         * How long a transaction waits for a free slot when every session is at its limit before it fails.
         * @default 30000
         */
        acquireTimeoutMs?: number
        /**
         * How long a transaction may stay open before it is cancelled, because the server never times one out.
         * @default 30000
         */
        timeoutMs?: number
      }
  /** The URL of the SurrealDB RPC endpoint, `ws://host:8000/rpc`, or false to start payload and prevent connecting */
  url: false | string
}

export type SurrealDBAdapter = {
  clearDatabase: () => Promise<void>
  collections: Record<string, TableMeta>
  globals: Record<string, TableMeta>
  globalVersions: Record<string, TableMeta>
  /** Every index generated from the config, whether or not `ensureIndexes` defines them. */
  indexes: IndexDefinition[]
  /** The open connections, undefined until `connect` has run and after `destroy`. */
  connection: SurrealPool | undefined
  poolSize: number
  provisionDatabase: boolean
  requestTimeout: number
  transactionOptions: false | { acquireTimeoutMs: number; timeoutMs: number }
  /** Index name to the Payload path of the field a unique violation is reported on. */
  uniqueIndexPaths: Map<string, string>
  versions: Record<string, TableMeta>
} & Args &
  BaseDatabaseAdapter

declare module 'payload' {
  export interface DatabaseAdapter {
    /** Deletes every record but keeps the tables. Used between tests. */
    clearDatabase: () => Promise<void>
    /** The SurrealDB connections, for queries Payload's API cannot express. */
    connection: SurrealPool | undefined
  }
}

export function surrealdbAdapter({
  allowAdditionalKeys = false,
  allowIDOnCreate = true,
  auth,
  bulkOperationsSingleTransaction = false,
  collation,
  database,
  disableFallbackSort = false,
  ensureIndexes = true,
  migrationDir: migrationDirArg,
  namespace,
  pool: { size: poolSize = 2 } = {},
  prodMigrations,
  provisionDatabase = true,
  requestTimeout = 30_000,
  transactionOptions: transactionOptionsArg = {},
  url,
}: Args): DatabaseAdapterObj {
  if (!Number.isInteger(poolSize) || poolSize < 2 || poolSize > 4) {
    throw new Error(`pool.size must be a whole number from 2 to 4, got ${poolSize}.`)
  }

  const transactionOptions =
    transactionOptionsArg === false
      ? false
      : {
          acquireTimeoutMs: transactionOptionsArg.acquireTimeoutMs ?? 30_000,
          timeoutMs: transactionOptionsArg.timeoutMs ?? 30_000,
        }

  if (transactionOptions) {
    for (const option of ['acquireTimeoutMs', 'timeoutMs'] as const) {
      const value = transactionOptions[option]

      // The reaper runs on half of `timeoutMs`, and a zero or non-finite value would make it spin or never fire.
      if (!Number.isInteger(value) || value < 1) {
        throw new Error(
          `transactionOptions.${option} must be a positive whole number, got ${value}.`,
        )
      }
    }
  }

  function adapter({ payload }: { payload: Payload }) {
    const migrationDir = findMigrationDir(migrationDirArg)

    const db: SurrealDBAdapter = createDatabaseAdapter<SurrealDBAdapter>({
      name: 'surrealdb',

      // SurrealDB-specific
      auth,
      clearDatabase,
      collation,
      collections: {},
      database,
      ensureIndexes,
      globals: {},
      globalVersions: {},
      indexes: [],
      namespace,
      connection: undefined,
      poolSize,
      provisionDatabase,
      requestTimeout,
      transactionOptions,
      uniqueIndexPaths: new Map(),
      updateMany,
      url,
      versions: {},
      // DatabaseAdapter
      allowAdditionalKeys,
      allowIDOnCreate,
      beginTransaction,
      bulkOperationsSingleTransaction,
      commitTransaction,
      connect,
      count,
      countGlobalVersions,
      countVersions,
      create,
      createGlobal,
      createGlobalVersion,
      createMigration,
      createVersion,
      defaultIDType: 'text',
      deleteMany,
      deleteOne,
      deleteVersions,
      destroy,
      disableFallbackSort,
      find,
      findDistinct,
      findGlobal,
      findGlobalVersions,
      findOne,
      findVersions,
      init,
      migrateFresh,
      migrationDir,
      packageName: '@snyder-tech/payload-surrealdb',
      payload,
      prodMigrations,
      queryDrafts,
      rollbackTransaction,
      sessions: transactionSessions(() => db.connection),
      updateGlobal,
      updateGlobalVersion,
      updateJobs,
      updateOne,
      updateVersion,
      upsert,
    })

    return db
  }

  return {
    name: 'surrealdb',
    allowIDOnCreate,
    defaultIDType: 'text',
    init: adapter,
  }
}
