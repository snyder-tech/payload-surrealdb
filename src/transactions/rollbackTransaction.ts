import type { RollbackTransaction } from 'payload'

import type { SurrealDBAdapter } from '../index.js'

export const rollbackTransaction: RollbackTransaction = async function rollbackTransaction(
  this: SurrealDBAdapter,
  incomingID = '',
) {
  const transactionID = incomingID instanceof Promise ? await incomingID : incomingID

  // Several operations can share one transaction: the first rollback cancels it and the rest find nothing.
  await this.connection?.rollback(String(transactionID))
}
