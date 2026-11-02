import type { Job, UpdateJobs, Where } from 'payload'

import { APIError, deepCopyObject } from 'payload'

import type { SurrealDBAdapter } from './index.js'

import { buildQueryTarget } from './queries/buildQueryTarget.js'
import {
  buildSortParam,
  removeSortKeys,
  sortKeyProjection,
  toOrderByClause,
} from './queries/buildSortParam.js'
import { ParamBag, whereClause } from './queries/sql.js'
import { buildSetClauses } from './utilities/buildSetClauses.js'
import { getCollection } from './utilities/getEntity.js'
import { handleError } from './utilities/handleError.js'
import { createAtomicOperations, transform } from './utilities/transform.js'

const JOBS_COLLECTION = 'payload-jobs'

/**
 * Workers that pick the same jobs conflict, and the default delays (200 ms and up) let a worker that
 * keeps winning drain the queue before the ones it beat come back. Retrying within milliseconds
 * keeps them taking turns, and the attempts outlast a long run of conflicts.
 */
const CLAIM_RETRY = { attempts: 30, retryDelay: 5, retryDelayMax: 100 }

/**
 * Claims and updates jobs, one atomic request per call.
 *
 * A claim picks the first `limit` jobs in `sort` order that match `where`, and sets the claim
 * (`processingToken`, `processingUntil`) on them. Two workers that pick the same jobs both try to
 * write them, the server lets one commit and rejects the other with a write conflict, and the
 * rejected request is sent again. It then picks from what the winner left, so no job is ever
 * claimed twice, across connections and processes alike. The condition is repeated on the
 * `UPDATE` itself so that a row that stopped matching between the pick and the write is skipped.
 *
 * Calls never run inside `req.transactionID`. Payload opens a transaction around every job
 * update, and a conflict inside an interactive transaction only shows when it commits, after the
 * adapter has returned the claimed jobs and with no way to send the request again: the worker
 * that lost would fail instead of claiming other jobs. Payload's transaction holds nothing but
 * this one call, so running it on its own request, which commits at once and can be retried, gives
 * the same result.
 */
export const updateJobs: UpdateJobs = async function updateJobs(
  this: SurrealDBAdapter,
  { id, data, limit, returning, sort: sortArg, where: whereArg },
) {
  const { connection } = this

  if (!connection) {
    throw new APIError('The SurrealDB adapter is not connected. Was `connect` called?')
  }

  const { collectionConfig } = getCollection({
    adapter: this,
    collectionSlug: JOBS_COLLECTION,
  })

  const log = data['log']
  const logPush = typeof log === 'object' && log !== null && '$push' in log

  // An empty log is not written, as an empty array would replace the entries already there.
  if (!(Array.isArray(log) && log.length > 0) && !logPush) {
    delete data['log']
  }

  const where: Where | undefined = id ? { id: { equals: id } } : whereArg

  // Without a condition every job would be updated, which no caller means.
  if (!where) {
    throw new APIError('updateJobs needs an id or a where.')
  }

  const sort = buildSortParam({
    adapter: this,
    config: this.payload.config,
    fields: collectionConfig.flattenedFields,
    sort: sortArg || collectionConfig.defaultSort,
    timestamps: true,
  })

  const row = deepCopyObject(data)
  const atomic = createAtomicOperations()

  transform({
    adapter: this,
    atomic,
    data: row,
    fields: collectionConfig.fields,
    operation: 'write',
  })

  const params = new ParamBag()
  const { condition, from, ids } = buildQueryTarget({
    adapter: this,
    collectionSlug: JOBS_COLLECTION,
    fields: collectionConfig.flattenedFields,
    params,
    where,
  })
  const sets = buildSetClauses({ atomic, params, row })
  const rowLimit = id ? 1 : typeof limit === 'number' && limit > 0 ? limit : undefined
  const setClause = sets.length > 0 ? ` SET ${sets.join(', ')}` : ''
  // Records the `where` names need no picking when the limit leaves them all.
  const picked = rowLimit !== undefined && !(ids !== undefined && ids.length <= rowLimit)

  // Each step reads only the rows it needs: a subquery written inside the target of an `UPDATE`
  // makes the server work in proportion to the size of the table, and so does filtering a table by
  // `id IN`, while a `LET` that holds the picked IDs and a `FROM` that names records do not.
  // The request is one unit: the rows read back are the rows this call wrote, in `sort` order, which
  // `UPDATE` does not return.
  const returned = returning !== false
  const statements = [
    ...(picked
      ? [
          `LET $targets = (SELECT *${sortKeyProjection(sort)} FROM ${from}${whereClause(condition)}${toOrderByClause(sort)} LIMIT ${params.add(rowLimit)}).id;`,
        ]
      : []),
    `LET $ids = (UPDATE ${picked ? '$targets' : from}${setClause}${whereClause(condition)} RETURN VALUE id);`,
    ...(returned ? [`SELECT *${sortKeyProjection(sort)} FROM $ids${toOrderByClause(sort)};`] : []),
  ]
  const body = [params.prelude, ...statements].filter(Boolean).join('\n')

  // `BEGIN` takes the first slot of the response, then come the `LET`s of the condition and the
  // statements above, ending with the read-back.
  const docsSlot = 1 + params.preludeLength + statements.length - 1
  const results = await connection
    .query<unknown[]>(`BEGIN;\n${body}\nCOMMIT;`, params.vars, { retry: CLAIM_RETRY })
    .catch((error: unknown) => handleError({ adapter: this, collection: JOBS_COLLECTION, error }))

  if (!returned) {
    return null
  }

  const docs = results[docsSlot]

  if (!Array.isArray(docs)) {
    throw new APIError('SurrealDB did not return the updated jobs.')
  }

  removeSortKeys(docs)
  transform({ adapter: this, data: docs, fields: collectionConfig.fields, operation: 'read' })

  return docs as Job[]
}
