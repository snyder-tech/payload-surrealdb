import type { SurrealDBAdapter } from './index.js'

import { escapeIdent } from './queries/sql.js'
import { getSession } from './utilities/getSession.js'
import { getTables } from './utilities/getTables.js'

/**
 * Deletes every record but keeps the tables. Payload's own test helpers call this between tests
 * for adapters that are neither Mongo nor Drizzle.
 */
export async function clearDatabase(this: SurrealDBAdapter): Promise<void> {
  const statements = getTables(this).map((table) => `DELETE ${escapeIdent(table)};`)

  if (statements.length === 0) {
    return
  }

  const db = await getSession(this)
  await db.query(statements.join('\n'))
}
