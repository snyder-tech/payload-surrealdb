import type { Field, FlattenedField, PayloadRequest, SelectType, Where } from 'payload'

import { deepCopyObject } from 'payload'

import type { SurrealDBAdapter } from '../index.js'

import { buildQuery } from '../queries/buildQuery.js'
import { ParamBag, escapeIdent, runQuery, whereClause } from '../queries/sql.js'
import {
  applyProjection,
  buildProjectionFromSelect,
  returnClause,
} from './buildProjectionFromSelect.js'
import { buildSetClauses } from './buildSetClauses.js'
import { getSession } from './getSession.js'
import { createAtomicOperations, transform } from './transform.js'

/**
 * Replaces the top-level keys of one version row and returns it in Payload's shape, or null when no
 * row matches. Shared by the collection and the global version methods, which differ only in the table and the fields.
 */
export const updateVersionRow = async ({
  adapter,
  fields,
  flattenedFields,
  locale,
  req,
  returning,
  select,
  table,
  versionData,
  where,
}: {
  adapter: SurrealDBAdapter
  /** The version fields, as Payload declares them, which the transforms walk. */
  fields: Field[]
  /** The same fields, flattened, which the query and the projection resolve paths against. */
  flattenedFields: FlattenedField[]
  locale?: string | undefined
  req?: Partial<PayloadRequest> | undefined
  returning?: boolean | undefined
  select?: SelectType | undefined
  table: string
  versionData: Record<string, unknown>
  where: Where
}): Promise<null | Record<string, unknown>> => {
  const row = deepCopyObject(versionData)

  transform({ adapter, data: row, fields, operation: 'write' })

  const params = new ParamBag()
  const condition = buildQuery({
    adapter,
    fields: flattenedFields,
    idTable: table,
    locale,
    params,
    where,
  })
  const sets = buildSetClauses({ atomic: createAtomicOperations(), params, row })
  const projection = buildProjectionFromSelect({ adapter, fields: flattenedFields, select })

  const db = await getSession(adapter, req)
  const [docs] = await runQuery<[Record<string, unknown>[]]>(
    db,
    params,
    `UPDATE (SELECT VALUE id FROM ${escapeIdent(table)}${whereClause(condition)} LIMIT 1) SET ${sets.join(', ')} RETURN ${
      returning === false ? 'NONE' : returnClause(projection)
    }`,
  )

  applyProjection(docs, projection)
  const [doc] = docs

  if (returning === false || !doc) {
    return null
  }

  transform({ adapter, data: doc, fields, operation: 'read' })

  return doc
}
