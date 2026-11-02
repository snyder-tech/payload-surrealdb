import type { DeleteOne } from 'payload'

import type { SurrealDBAdapter } from './index.js'

import { buildQueryTarget } from './queries/buildQueryTarget.js'
import { ParamBag, runQuery, whereClause } from './queries/sql.js'
import { getCollection } from './utilities/getEntity.js'
import { getSession } from './utilities/getSession.js'
import { transform } from './utilities/transform.js'

export const deleteOne: DeleteOne = async function deleteOne(
  this: SurrealDBAdapter,
  { collection: collectionSlug, req, returning, where },
) {
  const { collectionConfig } = getCollection({ adapter: this, collectionSlug })

  const params = new ParamBag()
  const { condition, from, ids } = buildQueryTarget({
    adapter: this,
    collectionSlug,
    fields: collectionConfig.flattenedFields,
    params,
    where,
  })

  // A record the `where` names is deleted as it is, with the condition checked on the delete itself
  const named = ids !== undefined && ids.length <= 1
  const target = named ? from : `(SELECT VALUE id FROM ${from}${whereClause(condition)} LIMIT 1)`
  const filter = named ? whereClause(condition) : ''

  const db = await getSession(this, req)
  const [docs] = await runQuery<[Record<string, unknown>[]]>(
    db,
    params,
    `DELETE ${target}${filter} RETURN ${returning === false ? 'NONE' : 'BEFORE'}`,
  )
  const [doc] = docs

  if (returning === false || !doc) {
    return null
  }

  transform({ adapter: this, data: doc, fields: collectionConfig.fields, operation: 'read' })

  return doc
}
