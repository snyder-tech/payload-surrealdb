import type { Count } from 'payload'

import type { SurrealDBAdapter } from './index.js'

import { buildQueryTarget } from './queries/buildQueryTarget.js'
import { ParamBag, runQuery, whereClause } from './queries/sql.js'
import { getCollection } from './utilities/getEntity.js'
import { getSession } from './utilities/getSession.js'

export const count: Count = async function count(
  this: SurrealDBAdapter,
  { collection: collectionSlug, locale, req, where = {} },
) {
  const { collectionConfig } = getCollection({ adapter: this, collectionSlug })

  const params = new ParamBag()
  const { condition, from } = buildQueryTarget({
    adapter: this,
    collectionSlug,
    fields: collectionConfig.flattenedFields,
    locale,
    params,
    where,
  })

  const db = await getSession(this, req)
  const [rows] = await runQuery<[{ count: number }[]]>(
    db,
    params,
    `SELECT count() FROM ${from}${whereClause(condition)} GROUP ALL`,
  )

  // An empty match returns no row at all
  return { totalDocs: rows[0]?.count ?? 0 }
}
