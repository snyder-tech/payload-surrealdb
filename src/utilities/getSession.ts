import type { PayloadRequest } from 'payload'

import { APIError } from 'payload'

import type { Executor } from '../connection/executor.js'
import type { SurrealDBAdapter } from '../index.js'

/**
 * Returns what queries run on: the open transaction of `req`, otherwise the pool. A transaction
 * that is gone throws instead of falling back to the pool, because running the query outside it
 * would silently break the isolation the caller asked for.
 */
export async function getSession(
  adapter: SurrealDBAdapter,
  req?: Partial<PayloadRequest>,
): Promise<Executor> {
  if (!adapter.connection) {
    throw new APIError('The SurrealDB adapter is not connected. Was `connect` called?')
  }

  // `req.transactionID` is a promise while a transaction is being started, and Payload's dataloader
  // copies it through JSON, leaving `{}`. Only a real ID means a transaction is open.
  const transactionID = await req?.transactionID

  if (typeof transactionID === 'string' || typeof transactionID === 'number') {
    return adapter.connection.transaction(String(transactionID))
  }

  return adapter.connection
}
