import type { UpdateGlobalArgs } from 'payload'

import { deepCopyObject } from 'payload'

import type { SurrealDBAdapter } from './index.js'

import { ParamBag } from './queries/sql.js'
import { buildSetClauses } from './utilities/buildSetClauses.js'
import { getGlobal, globalRecordId } from './utilities/getEntity.js'
import { getSession } from './utilities/getSession.js'
import { handleError } from './utilities/handleError.js'
import { createAtomicOperations, transform } from './utilities/transform.js'

// Payload types the result as never null, but it is null when `returning` is false or the global does not exist, as in Mongo's adapter.
// `select` is ignored: Payload builds the global's version from this return value, so a trimmed row would be stored as a cut-down
// version. Payload trims the response itself afterwards.
export function updateGlobal<T extends Record<string, unknown>>(
  this: SurrealDBAdapter,
  args: UpdateGlobalArgs<T>,
): Promise<T>
export async function updateGlobal(
  this: SurrealDBAdapter,
  { slug: globalSlug, data, req, returning }: UpdateGlobalArgs,
): Promise<null | Record<string, unknown>> {
  const { globalConfig, table } = getGlobal({ adapter: this, globalSlug })

  const row = deepCopyObject(data)

  transform({
    adapter: this,
    data: row,
    fields: globalConfig.fields,
    globalSlug,
    operation: 'write',
  })

  const params = new ParamBag()
  const sets = buildSetClauses({ atomic: createAtomicOperations(), params, row })

  // Updating a record that does not exist would create it, and `createGlobal` is the call that does that.
  const sql = `UPDATE (SELECT VALUE id FROM ${params.add(globalRecordId(table))}) SET ${sets.join(', ')} RETURN ${
    returning === false ? 'NONE' : 'AFTER'
  }`

  const db = await getSession(this, req)
  const [docs] = await db
    .query<[Record<string, unknown>[]]>(sql, params.vars)
    .catch((error: unknown) => handleError({ adapter: this, error, global: globalSlug, req }))

  const [doc] = docs

  if (returning === false || !doc) {
    return null
  }

  transform({ adapter: this, data: doc, fields: globalConfig.fields, operation: 'read' })

  return doc
}
