import type { CommitTransaction } from 'payload'

import { APIError } from 'payload'

import type { SurrealDBAdapter } from '../index.js'

export const commitTransaction: CommitTransaction = async function commitTransaction(
  this: SurrealDBAdapter,
  incomingID = '',
) {
  const transactionID = incomingID instanceof Promise ? await incomingID : incomingID

  // Payload commits whatever `req.transactionID` holds, which is empty when no transaction began.
  if (transactionID === '') {
    return
  }

  if (!this.connection) {
    throw new APIError('commitTransaction called while no connection to the database exists')
  }

  await this.connection.commit(String(transactionID))
}
