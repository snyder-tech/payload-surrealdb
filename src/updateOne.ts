import type { UpdateOne } from 'payload'

import { deepCopyObject } from 'payload'

import type { SurrealDBAdapter } from './index.js'

import { buildQueryTarget } from './queries/buildQueryTarget.js'
import { ParamBag, runQuery, whereClause } from './queries/sql.js'
import { buildSetClauses } from './utilities/buildSetClauses.js'
import { getCollection } from './utilities/getEntity.js'
import { getSession } from './utilities/getSession.js'
import { handleError } from './utilities/handleError.js'
import { createAtomicOperations, transform } from './utilities/transform.js'

// `select` is ignored: Payload builds a restored collection version from this return value, so a trimmed row would be stored
// as a cut-down version. Payload trims the response itself afterwards.
export const updateOne: UpdateOne = async function updateOne(
  this: SurrealDBAdapter,
  {
    id,
    collection: collectionSlug,
    data,
    locale,
    options = {},
    req,
    returning,
    where: whereArg = {},
  },
) {
  const { collectionConfig } = getCollection({ adapter: this, collectionSlug })
  const where = id ? { id: { equals: id } } : whereArg

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
    collectionSlug,
    fields: collectionConfig.flattenedFields,
    locale,
    params,
    where,
  })
  const sets = buildSetClauses({ atomic, params, row })

  // `atomic` repeats the condition on the UPDATE itself: the statement then claims the row and
  // checks it in one step, so of several concurrent callers only one still matches.
  const isAtomic = options['atomic'] === true
  // A record the `where` names is updated as it is, and the condition is checked on the update itself
  const named = ids !== undefined && ids.length <= 1
  const target = named ? from : `(SELECT VALUE id FROM ${from}${whereClause(condition)} LIMIT 1)`
  const sql = `UPDATE ${target}${
    sets.length > 0 ? ` SET ${sets.join(', ')}` : ''
  }${isAtomic || named ? whereClause(condition) : ''} RETURN ${returning === false ? 'NONE' : 'AFTER'}`

  const db = await getSession(this, req)
  // Losing a write conflict means the row changed under us, so the condition has to be checked again.
  const [docs] = await runQuery<[Record<string, unknown>[]]>(db, params, sql, {
    retry: isAtomic,
  }).catch((error: unknown) =>
    handleError({ adapter: this, collection: collectionSlug, error, req }),
  )
  const [doc] = docs

  if (returning === false || !doc) {
    return null
  }

  transform({ adapter: this, data: doc, fields: collectionConfig.fields, operation: 'read' })

  return doc
}
