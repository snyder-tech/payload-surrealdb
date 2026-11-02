import type { FindGlobalArgs } from 'payload'

import type { SurrealDBAdapter } from './index.js'

import { buildQuery } from './queries/buildQuery.js'
import { ParamBag, runQuery, whereClause } from './queries/sql.js'
import {
  applyProjection,
  buildProjectionFromSelect,
  selectClause,
} from './utilities/buildProjectionFromSelect.js'
import { getGlobal, globalRecordId } from './utilities/getEntity.js'
import { getSession } from './utilities/getSession.js'
import { transform } from './utilities/transform.js'

// Payload types the result as never null, but it is null when the global has not been created yet, as in Mongo's adapter.
export function findGlobal<T extends Record<string, unknown>>(
  this: SurrealDBAdapter,
  args: FindGlobalArgs,
): Promise<T>
export async function findGlobal(
  this: SurrealDBAdapter,
  { slug: globalSlug, locale, req, select, where = {} }: FindGlobalArgs,
): Promise<null | Record<string, unknown>> {
  const { globalConfig, table } = getGlobal({ adapter: this, globalSlug })

  const params = new ParamBag()
  const condition = buildQuery({
    adapter: this,
    fields: globalConfig.flattenedFields,
    globalSlug,
    locale,
    params,
    where,
  })
  const projection = buildProjectionFromSelect({
    adapter: this,
    fields: globalConfig.flattenedFields,
    select,
  })

  const db = await getSession(this, req)
  const [docs] = await runQuery<[Record<string, unknown>[]]>(
    db,
    params,
    `SELECT ${selectClause(projection)} FROM ${params.add(globalRecordId(table))}${whereClause(condition)}`,
  )

  applyProjection(docs, projection)
  const [doc] = docs

  if (!doc) {
    return null
  }

  transform({ adapter: this, data: doc, fields: globalConfig.fields, operation: 'read' })

  return doc
}
