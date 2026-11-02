import type { SurrealTransaction } from 'surrealdb'
import type { MigrationData, Payload, PayloadRequest } from 'payload'

/** Where a collection, version history or global lives. Filled by `init`, read by every method. */
export type TableMeta = {
  table: string
}

export type MigrateUpArgs = {
  /**
   * The Payload instance that you can use to execute Local API methods.
   * To use the current transaction you must pass `req` to arguments.
   */
  payload: Payload
  /** The `PayloadRequest` object that contains the current transaction. */
  req: PayloadRequest
  /** The SurrealDB transaction that you can use to run queries within the current transaction. */
  session?: SurrealTransaction
}

export type MigrateDownArgs = {
  /**
   * The Payload instance that you can use to execute Local API methods.
   * To use the current transaction you must pass `req` to arguments.
   */
  payload: Payload
  /** The `PayloadRequest` object that contains the current transaction. */
  req: PayloadRequest
  /** The SurrealDB transaction that you can use to run queries within the current transaction. */
  session?: SurrealTransaction
}

export type SurrealDBMigration = {
  down: (args: MigrateDownArgs) => Promise<void>
  up: (args: MigrateUpArgs) => Promise<void>
} & MigrationData
