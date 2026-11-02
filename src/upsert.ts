import type { Upsert } from 'payload'

import { deepCopyObject } from 'payload'

import type { SurrealDBAdapter } from './index.js'

import { buildQuery } from './queries/buildQuery.js'
import { ParamBag, escapeIdent, whereClause } from './queries/sql.js'
import {
  applyProjection,
  buildProjectionFromSelect,
  returnClause,
} from './utilities/buildProjectionFromSelect.js'
import { applyInsertDefaults } from './utilities/applyInsertDefaults.js'
import { buildSetClauses } from './utilities/buildSetClauses.js'
import { getCollection } from './utilities/getEntity.js'
import { getSession } from './utilities/getSession.js'
import { handleError } from './utilities/handleError.js'
import { toRecordIdOrThrow } from './utilities/recordId.js'
import { createAtomicOperations, transform } from './utilities/transform.js'

const isObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

/** The ID an `id equals` condition pins, at the top level of `where` or inside an `and`. */
const idFromWhere = (where: unknown): unknown => {
  if (!isObject(where)) {
    return undefined
  }

  const condition = where['id']

  if (isObject(condition) && condition['equals'] !== undefined) {
    return condition['equals']
  }

  const nested = Array.isArray(where['and']) ? where['and'] : []

  return nested.map(idFromWhere).find((id) => id !== undefined)
}

export const upsert: Upsert = async function upsert(
  this: SurrealDBAdapter,
  { collection: collectionSlug, data, locale, req, returning, select, where },
) {
  const { collectionConfig, customIDType, table } = getCollection({ adapter: this, collectionSlug })

  // Same key rules as `create`, plus the `id equals` of the condition that just found nothing.
  const dataID = customIDType || this.allowIDOnCreate ? data['id'] : undefined
  const key = dataID ?? idFromWhere(where)

  const row = deepCopyObject(data)
  const atomic = createAtomicOperations()

  transform({
    adapter: this,
    atomic,
    data: row,
    fields: collectionConfig.fields,
    operation: 'write',
  })

  // A created row starts with the field defaults, an updated one must not get them, so each branch has its own data.
  const createRow = deepCopyObject(data)
  const createAtomic = createAtomicOperations()

  applyInsertDefaults({ adapter: this, data: createRow, fields: collectionConfig.fields })
  transform({
    adapter: this,
    atomic: createAtomic,
    data: createRow,
    fields: collectionConfig.fields,
    operation: 'write',
  })

  const params = new ParamBag()
  const createTarget =
    key === undefined
      ? `${escapeIdent(table)}:ulid()`
      : params.add(toRecordIdOrThrow(table, key, customIDType))
  const condition = buildQuery({
    adapter: this,
    collectionSlug,
    fields: collectionConfig.flattenedFields,
    locale,
    params,
    where,
  })
  const sets = buildSetClauses({ atomic, params, row })
  const updateSet = sets.length > 0 ? ` SET ${sets.join(', ')}` : ''
  const projection = buildProjectionFromSelect({
    adapter: this,
    fields: collectionConfig.flattenedFields,
    select,
  })
  const returned = returning === false ? 'NONE' : returnClause(projection)

  // Without a given ID a created row gets a time-ordered ULID key, which `UPSERT ... WHERE` cannot do (it makes
  // a random one), so the lookup and the write are separate statements.
  const createSets = buildSetClauses({ atomic: createAtomic, params, row: createRow })
  const createSet =
    collectionConfig.timestamps && createRow['createdAt'] === undefined
      ? [`createdAt = ${params.add(new Date())}`, ...createSets]
      : createSets
  const statements = `LET $found = (SELECT VALUE id FROM ${escapeIdent(table)}${whereClause(condition)} LIMIT 1)[0];
    IF $found != NONE {
      RETURN (UPDATE ONLY $found${updateSet} RETURN ${returned});
    } ELSE {
      RETURN (CREATE ONLY ${createTarget}${createSet.length > 0 ? ` SET ${createSet.join(', ')}` : ''} RETURN ${returned});
    };`

  const db = await getSession(this, req)
  // The `LET`s that resolve the IDs of a relationship condition go inside the unit, after `BEGIN`, so
  // that what they read is what the upsert writes to.
  const body = `${params.prelude}\n${statements}`
  // An open transaction already makes the statements one unit, and `BEGIN` cannot nest inside it.
  // Every `LET` and `IF` takes a slot in the response, and so do `BEGIN` and `COMMIT`; the row is the `IF`.
  const sql = db.inTransaction ? body : `BEGIN;\n${body}\nCOMMIT;`
  const docSlot = params.preludeLength + (db.inTransaction ? 1 : 2)
  // Two concurrent upserts of one key both find nothing and both create. With a unique index on the
  // key the one that loses fails with a conflict, and the retry finds the winner's row and updates it.
  // Without one nothing conflicts and both rows are kept, as with Mongo's `findOneAndUpdate` upsert.
  const result = await db
    .query<(null | Record<string, unknown>)[]>(sql, params.vars, { retry: true })
    .catch((error: unknown) =>
      handleError({ adapter: this, collection: collectionSlug, error, req }),
    )
  const doc = result[docSlot]

  if (returning === false || !doc) {
    return null
  }

  applyProjection([doc], projection)

  transform({ adapter: this, data: doc, fields: collectionConfig.fields, operation: 'read' })

  return doc
}
