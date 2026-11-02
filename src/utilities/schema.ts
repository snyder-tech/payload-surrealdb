import type { SurrealDBAdapter } from '../index.js'

import { toDefineIndex } from '../models/buildSchema.js'
import { DEFINE_PVALS } from '../queries/leafValues.js'
import { escapeIdent } from '../queries/sql.js'
import { uniqueIndexName } from './handleError.js'
import { getTables } from './getTables.js'

/** Building an index scans the whole table, which can outlast `requestTimeout` on a large one. */
const INDEX_BUILD_TIMEOUT_MS = 600_000

const getConnection = (adapter: SurrealDBAdapter, action: string) => {
  const { connection } = adapter

  if (!connection) {
    throw new Error(`Cannot ${action} before the connection is open.`)
  }

  return connection
}

/**
 * Defines every table, the helper function and, unless `ensureIndexes` is off, every index.
 * 3.3 throws when selecting from a table that does not exist, so every table is defined up front.
 */
export const defineSchema = async (adapter: SurrealDBAdapter): Promise<void> => {
  const connection = getConnection(adapter, 'define the schema')
  const defineTables = getTables(adapter).map(
    (table) => `DEFINE TABLE IF NOT EXISTS ${escapeIdent(table)} SCHEMALESS;`,
  )

  if (defineTables.length > 0) {
    await connection.query(defineTables.join('\n'))
  }

  // Where and sort on paths through arrays and json call it
  await connection.query(DEFINE_PVALS)

  if (adapter.ensureIndexes) {
    await defineIndexes(adapter)
  }
}

/**
 * One statement per index, so a failure names its index. A unique index over data that already
 * holds duplicates cannot be built: that is logged and skipped, because the application can
 * still run and the data has to be fixed by someone. Any other failure stops the caller.
 */
const defineIndexes = async (adapter: SurrealDBAdapter): Promise<void> => {
  const connection = getConnection(adapter, 'define indexes')

  for (const index of adapter.indexes) {
    try {
      await connection.query(`${toDefineIndex(index)};`, undefined, {
        requestTimeout: Math.max(adapter.requestTimeout, INDEX_BUILD_TIMEOUT_MS),
      })
    } catch (err) {
      if (index.kind !== 'unique' || uniqueIndexName(err) !== index.name) {
        throw err
      }

      const reason = err instanceof Error ? err.message : String(err)

      adapter.payload.logger.error({
        err,
        msg: `Cannot create the unique index ${index.name} on ${index.table} for the field ${index.fieldPath}, so the field is not unique until its duplicates are removed and the index is created. Reason: ${reason}`,
      })
    }
  }
}

/**
 * Removes every table of the database (and with them their indexes) instead of the database,
 * which only a namespace-level user may do. All of them go in one transaction, so a failure part
 * way leaves every table in place instead of some. Dropping a table with a large index can take
 * as long as building one, so it gets the same timeout.
 */
export const dropAllTables = async (adapter: SurrealDBAdapter): Promise<void> => {
  const connection = getConnection(adapter, 'drop tables')
  const [info] = await connection.query<[{ tables: Record<string, string> }]>('INFO FOR DB')
  const statements = Object.keys(info.tables).map(
    (table) => `REMOVE TABLE IF EXISTS ${escapeIdent(table)};`,
  )

  if (statements.length > 0) {
    await connection.query(`BEGIN;\n${statements.join('\n')}\nCOMMIT;`, undefined, {
      requestTimeout: Math.max(adapter.requestTimeout, INDEX_BUILD_TIMEOUT_MS),
    })
  }
}
