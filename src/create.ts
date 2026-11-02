import type { Create } from 'payload'

import { deepCopyObject } from 'payload'

import type { SurrealDBAdapter } from './index.js'

import { ParamBag, escapeIdent } from './queries/sql.js'
import { applyInsertDefaults } from './utilities/applyInsertDefaults.js'
import { getCollection } from './utilities/getEntity.js'
import { getSession } from './utilities/getSession.js'
import { handleError } from './utilities/handleError.js'
import { toRecordIdOrThrow } from './utilities/recordId.js'
import { transform } from './utilities/transform.js'

export const create: Create = async function create(
  this: SurrealDBAdapter,
  { collection: collectionSlug, customID, data, req, returning },
) {
  const { collectionConfig, customIDType, table } = getCollection({ adapter: this, collectionSlug })

  const row = deepCopyObject(data)

  if (!row['createdAt']) {
    row['createdAt'] = new Date().toISOString()
  }

  // A custom ID type means `data.id` is the key. Otherwise the key is the `customID` argument, or
  // `data.id` when the adapter allows it, and without either the server generates a ULID so that
  // sorting by `id` follows insertion order.
  const key = customIDType
    ? data['id']
    : (customID ?? (this.allowIDOnCreate && data['id'] ? data['id'] : undefined))

  applyInsertDefaults({ adapter: this, data: row, fields: collectionConfig.fields })
  transform({ adapter: this, data: row, fields: collectionConfig.fields, operation: 'write' })

  const params = new ParamBag()
  const target =
    key === undefined
      ? `${escapeIdent(table)}:ulid()`
      : params.add(toRecordIdOrThrow(table, key, customIDType))
  const sql = `CREATE ONLY ${target} CONTENT ${params.add(row)} RETURN ${returning === false ? 'NONE' : 'AFTER'}`

  const db = await getSession(this, req)
  const [doc] = await db
    .query<[Record<string, unknown>]>(sql, params.vars)
    .catch((error: unknown) =>
      handleError({ adapter: this, collection: collectionSlug, error, req }),
    )

  if (returning === false) {
    return null
  }

  transform({ adapter: this, data: doc, fields: collectionConfig.fields, operation: 'read' })

  return doc
}
