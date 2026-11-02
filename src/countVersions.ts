import type { CountVersions } from 'payload'

import { buildVersionCollectionFields } from 'payload'

import type { SurrealDBAdapter } from './index.js'

import { buildQuery } from './queries/buildQuery.js'
import { ParamBag, escapeIdent, runQuery, whereClause } from './queries/sql.js'
import { getCollection } from './utilities/getEntity.js'
import { getSession } from './utilities/getSession.js'

export const countVersions: CountVersions = async function countVersions(
  this: SurrealDBAdapter,
  { collection: collectionSlug, locale, req, where = {} },
) {
  const { collectionConfig, table } = getCollection({
    adapter: this,
    collectionSlug,
    versions: true,
  })

  const params = new ParamBag()
  const condition = buildQuery({
    adapter: this,
    fields: buildVersionCollectionFields(this.payload.config, collectionConfig, true),
    idTable: table,
    locale,
    params,
    where,
  })

  const db = await getSession(this, req)
  const [rows] = await runQuery<[{ count: number }[]]>(
    db,
    params,
    `SELECT count() FROM ${escapeIdent(table)}${whereClause(condition)} GROUP ALL`,
  )

  // An empty match returns no row at all
  return { totalDocs: rows[0]?.count ?? 0 }
}
