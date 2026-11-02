import type { UpdateMany } from 'payload'

import { deepCopyObject } from 'payload'

import type { SurrealDBAdapter } from './index.js'

import { buildNearSort } from './queries/buildNearSort.js'
import { buildQueryTarget } from './queries/buildQueryTarget.js'
import {
  buildSortParam,
  removeSortKeys,
  sortKeyProjection,
  toOrderByClause,
} from './queries/buildSortParam.js'
import { ParamBag, runQuery, whereClause } from './queries/sql.js'
import {
  applyProjection,
  buildProjectionFromSelect,
  selectClause,
} from './utilities/buildProjectionFromSelect.js'
import { buildSetClauses } from './utilities/buildSetClauses.js'
import { getCollection } from './utilities/getEntity.js'
import { getSession } from './utilities/getSession.js'
import { handleError } from './utilities/handleError.js'
import { createAtomicOperations, transform } from './utilities/transform.js'

export const updateMany: UpdateMany = async function updateMany(
  this: SurrealDBAdapter,
  {
    collection: collectionSlug,
    data,
    limit,
    locale,
    options = {},
    req,
    returning,
    select,
    sort: sortArg,
    where,
  },
) {
  const { collectionConfig } = getCollection({ adapter: this, collectionSlug })

  const params = new ParamBag()
  const sort =
    buildNearSort({
      adapter: this,
      collectionSlug,
      fields: collectionConfig.flattenedFields,
      locale,
      params,
      where,
    }) ??
    buildSortParam({
      adapter: this,
      config: this.payload.config,
      fields: collectionConfig.flattenedFields,
      locale,
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

  const { condition, from, ids } = buildQueryTarget({
    adapter: this,
    collectionSlug,
    fields: collectionConfig.flattenedFields,
    locale,
    params,
    where,
  })
  const sets = buildSetClauses({ atomic, params, row })
  const limited = typeof limit === 'number' && limit > 0
  const projection = buildProjectionFromSelect({
    adapter: this,
    fields: collectionConfig.flattenedFields,
    select,
  })

  // A limit picks the rows in sort order first, and `UPDATE ... ORDER BY ... LIMIT` is not valid.
  // Records the `where` names need no picking when the limit leaves them all.
  const picked = limited && !(ids !== undefined && ids.length <= limit)
  const target = picked
    ? `(SELECT *${sortKeyProjection(sort)} FROM ${from}${whereClause(condition)}${toOrderByClause(sort)} LIMIT ${params.add(limit)}).id`
    : from
  const update = `UPDATE ${target}${sets.length > 0 ? ` SET ${sets.join(', ')}` : ''}${picked ? '' : whereClause(condition)}`

  // `UPDATE` returns rows in no particular order, while Payload expects them in `sort` order.
  const sql =
    returning === false
      ? `${update} RETURN NONE`
      : `LET $ids = (${update} RETURN VALUE id);
         SELECT ${selectClause(projection)}${sortKeyProjection(sort)} FROM $ids${toOrderByClause(sort)}`

  const db = await getSession(this, req)
  const results = await runQuery<[null, Record<string, unknown>[]] | [Record<string, unknown>[]]>(
    db,
    params,
    sql,
    { retry: options['atomic'] === true },
  ).catch((error: unknown) =>
    handleError({ adapter: this, collection: collectionSlug, error, req }),
  )
  const docs = returning === false ? [] : results[1]

  // Mongo reports "nothing to update" as null when a limit selected no rows.
  if (returning === false || (limited && (docs?.length ?? 0) === 0)) {
    return null
  }

  removeSortKeys(docs ?? [])
  applyProjection(docs ?? [], projection)

  transform({
    adapter: this,
    data: docs ?? [],
    fields: collectionConfig.fields,
    operation: 'read',
  })

  return docs ?? []
}
