import type { DeleteVersions, FlattenedField } from 'payload'

import { APIError, buildVersionCollectionFields, buildVersionGlobalFields } from 'payload'

import type { SurrealDBAdapter } from './index.js'

import { buildQuery } from './queries/buildQuery.js'
import { ParamBag, escapeIdent, runQuery, whereClause } from './queries/sql.js'
import { getCollection, getGlobal } from './utilities/getEntity.js'
import { getSession } from './utilities/getSession.js'

export const deleteVersions: DeleteVersions = async function deleteVersions(
  this: SurrealDBAdapter,
  { collection: collectionSlug, globalSlug, locale, req, where },
) {
  let fields: FlattenedField[]
  let table: string

  if (globalSlug) {
    const global = getGlobal({ adapter: this, globalSlug, versions: true })

    fields = buildVersionGlobalFields(this.payload.config, global.globalConfig, true)
    table = global.table
  } else if (collectionSlug) {
    const collection = getCollection({ adapter: this, collectionSlug, versions: true })

    fields = buildVersionCollectionFields(this.payload.config, collection.collectionConfig, true)
    table = collection.table
  } else {
    throw new APIError('Either collection or globalSlug must be passed.')
  }

  const params = new ParamBag()
  const condition = buildQuery({ adapter: this, fields, idTable: table, locale, params, where })

  const db = await getSession(this, req)
  await runQuery(db, params, `DELETE ${escapeIdent(table)}${whereClause(condition)} RETURN NONE`)
}
