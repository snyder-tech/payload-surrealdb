import type { FindOne, FindOneArgs, TypeWithID } from 'payload'

import type { SurrealDBAdapter } from './index.js'

import { buildQueryTarget } from './queries/buildQueryTarget.js'
import { ParamBag, runQuery, whereClause } from './queries/sql.js'
import { buildJoinSelection } from './utilities/buildJoinAggregation.js'
import {
  applyProjection,
  buildProjectionFromSelect,
  selectClause,
} from './utilities/buildProjectionFromSelect.js'
import { getCollection } from './utilities/getEntity.js'
import { getSession } from './utilities/getSession.js'
import { transform } from './utilities/transform.js'

export const findOne: FindOne = async function findOne<T extends TypeWithID>(
  this: SurrealDBAdapter,
  {
    collection: collectionSlug,
    draftsEnabled,
    joins,
    locale,
    req,
    select,
    where = {},
  }: FindOneArgs,
): Promise<null | T> {
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

  const projection = buildProjectionFromSelect({
    adapter: this,
    fields: collectionConfig.flattenedFields,
    select,
  })

  const joinSelection = buildJoinSelection({
    adapter: this,
    collectionConfig,
    draftsEnabled,
    joins,
    locale,
    params,
    projection,
  })

  const db = await getSession(this, req)
  const [docs] = await runQuery<[Record<string, unknown>[]]>(
    db,
    params,
    `SELECT ${selectClause(projection)}${joinSelection?.columns ?? ''} FROM ${from}${whereClause(condition)} LIMIT 1`,
  )
  const putJoins = joinSelection?.collect(docs)
  applyProjection(docs, projection)
  putJoins?.()
  const [doc] = docs

  if (!doc) {
    return null
  }

  transform({ adapter: this, data: doc, fields: collectionConfig.fields, operation: 'read' })

  // The row is typed by the caller, as with every driver that does not know the schema
  return doc as T
}
