import type { BeginTransaction } from 'payload'

import { APIError } from 'payload'

import type { SurrealDBAdapter } from '../index.js'

/**
 * Returns null, which makes Payload run without interactive transactions, when they are turned
 * off or the engine cannot hold one (HTTP).
 */
export const beginTransaction: BeginTransaction = async function beginTransaction(
  this: SurrealDBAdapter,
) {
  if (!this.connection) {
    throw new APIError('beginTransaction called while no connection to the database exists')
  }

  if (!this.connection.supportsTransactions) {
    return null
  }

  return await this.connection.begin()
}
