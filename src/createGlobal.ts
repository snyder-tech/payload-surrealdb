import type { CreateGlobalArgs } from 'payload'

import { APIError, deepCopyObject } from 'payload'

import type { SurrealDBAdapter } from './index.js'

import { ParamBag } from './queries/sql.js'
import { applyInsertDefaults } from './utilities/applyInsertDefaults.js'
import { getGlobal, globalRecordId } from './utilities/getEntity.js'
import { getSession } from './utilities/getSession.js'
import { handleError } from './utilities/handleError.js'
import { transform } from './utilities/transform.js'

// Payload types the result as never null, but with `returning: false` there is no row to give back, as in Mongo's adapter.
export function createGlobal<T extends Record<string, unknown>>(
  this: SurrealDBAdapter,
  args: CreateGlobalArgs<T>,
): Promise<T>
export async function createGlobal(
  this: SurrealDBAdapter,
  { slug: globalSlug, data, req, returning }: CreateGlobalArgs,
): Promise<null | Record<string, unknown>> {
  const { globalConfig, table } = getGlobal({ adapter: this, globalSlug })

  const row = deepCopyObject(data)

  if (!row['createdAt']) {
    row['createdAt'] = new Date().toISOString()
  }

  applyInsertDefaults({ adapter: this, data: row, fields: globalConfig.fields })
  transform({
    adapter: this,
    data: row,
    fields: globalConfig.fields,
    globalSlug,
    operation: 'write',
  })

  const params = new ParamBag()
  const id = params.add(globalRecordId(table))
  // Mongo stores a second create as another document that nothing reads, because Payload reads the
  // first. A global has one record here. A create with `returning: false` that finds it leaves it
  // as it is, which is what the job scheduler wants when several things find no global at once and
  // each creates it. Any other create asked for what it wrote, and the stored global is not that,
  // so it is a conflict: handing it back would swap what the caller saved for what someone else did.
  const statements = `LET $existing = (SELECT * FROM ONLY ${id});
    IF $existing != NONE {
      RETURN NONE;
    } ELSE {
      RETURN (CREATE ONLY ${id} CONTENT ${params.add(row)} RETURN ${returning === false ? 'NONE' : 'AFTER'});
    };`

  const db = await getSession(this, req)
  // An open transaction already makes the statements one unit, and `BEGIN` cannot nest inside it.
  // `BEGIN`, the `LET` and the `IF` each take a slot in the response, and the row is the `IF`.
  const sql = db.inTransaction ? statements : `BEGIN;\n${statements}\nCOMMIT;`
  // Outside a transaction, two creates that both found nothing conflict at commit and the request is
  // sent again, so the loser finds the winner's record. Inside one, the conflict shows when it commits.
  const result = await db
    .query<(null | Record<string, unknown>)[]>(sql, params.vars, { retry: true })
    .catch((error: unknown) => handleError({ adapter: this, error, global: globalSlug, req }))
  const doc = result[db.inTransaction ? 1 : 2]

  if (returning === false) {
    return null
  }

  if (!doc) {
    throw new APIError(
      `The global "${globalSlug}" already exists, so it was not created. Update it instead.`,
      409,
    )
  }

  transform({ adapter: this, data: doc, fields: globalConfig.fields, operation: 'read' })

  return doc
}
