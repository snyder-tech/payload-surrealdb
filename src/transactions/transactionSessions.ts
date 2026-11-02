import type { SurrealTransaction } from 'surrealdb'

import type { SurrealPool } from '../connection/pool.js'

/**
 * What `payload.db.sessions` is: the open transactions by ID, read straight from the pool. Payload's
 * migration commands look the transaction up here and hand it to a migration as `session`. Only
 * reading one ID is supported, not listing them.
 */
export const transactionSessions = (
  getPool: () => SurrealPool | undefined,
): Record<string, SurrealTransaction | undefined> =>
  new Proxy<Record<string, SurrealTransaction | undefined>>(
    {},
    {
      get: (_target, id) => (typeof id === 'string' ? getPool()?.sessions.get(id)?.tx : undefined),
    },
  )
