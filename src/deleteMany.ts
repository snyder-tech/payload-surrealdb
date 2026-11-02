import type { DeleteMany } from 'payload'

import type { SurrealDBAdapter } from './index.js'

import { buildQueryTarget } from './queries/buildQueryTarget.js'
import { ParamBag, runQuery, whereClause } from './queries/sql.js'
import { getCollection } from './utilities/getEntity.js'
import { getSession } from './utilities/getSession.js'

export const deleteMany: DeleteMany = async function deleteMany(
  this: SurrealDBAdapter,
  { collection: collectionSlug, req, where },
) {
  const { collectionConfig } = getCollection({ adapter: this, collectionSlug })

  const params = new ParamBag()
  const { condition, from } = buildQueryTarget({
    adapter: this,
    collectionSlug,
    fields: collectionConfig.flattenedFields,
    params,
    where,
  })

  const db = await getSession(this, req)
  await runQuery(db, params, `DELETE ${from}${whereClause(condition)} RETURN NONE`)
}
