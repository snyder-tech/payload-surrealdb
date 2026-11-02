import type { CountGlobalVersions } from 'payload'

import { buildVersionGlobalFields } from 'payload'

import type { SurrealDBAdapter } from './index.js'

import { buildQuery } from './queries/buildQuery.js'
import { ParamBag, escapeIdent, runQuery, whereClause } from './queries/sql.js'
import { getGlobal } from './utilities/getEntity.js'
import { getSession } from './utilities/getSession.js'

export const countGlobalVersions: CountGlobalVersions = async function countGlobalVersions(
  this: SurrealDBAdapter,
  { global: globalSlug, locale, req, where = {} },
) {
  const { globalConfig, table } = getGlobal({ adapter: this, globalSlug, versions: true })

  const params = new ParamBag()
  const condition = buildQuery({
    adapter: this,
    fields: buildVersionGlobalFields(this.payload.config, globalConfig, true),
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
