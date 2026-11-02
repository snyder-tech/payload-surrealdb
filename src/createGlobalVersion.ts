import type { CreateGlobalVersionArgs, JsonObject, TypeWithVersion } from 'payload'

import { buildVersionGlobalFields, deepCopyObject } from 'payload'

import type { SurrealDBAdapter } from './index.js'

import { ParamBag, escapeIdent } from './queries/sql.js'
import { applyInsertDefaults } from './utilities/applyInsertDefaults.js'
import { getGlobal } from './utilities/getEntity.js'
import { getSession } from './utilities/getSession.js'
import { VERSION_LOCK_TABLE } from './utilities/getTables.js'
import { transform } from './utilities/transform.js'

// Payload types the result as never null, but with `returning: false` there is no row to give back, as in Mongo's adapter.
export function createGlobalVersion<T extends JsonObject = JsonObject>(
  this: SurrealDBAdapter,
  args: CreateGlobalVersionArgs<T>,
): Promise<Omit<TypeWithVersion<T>, 'parent'>>
export async function createGlobalVersion(
  this: SurrealDBAdapter,
  {
    autosave,
    createdAt,
    globalSlug,
    publishedLocale,
    req,
    returning,
    snapshot,
    updatedAt,
    versionData,
  }: CreateGlobalVersionArgs,
): Promise<null | Record<string, unknown>> {
  const { globalConfig, table } = getGlobal({ adapter: this, globalSlug, versions: true })

  const data: Record<string, unknown> = {
    autosave,
    createdAt: createdAt || new Date().toISOString(),
    latest: true,
    publishedLocale,
    snapshot,
    updatedAt,
    version: deepCopyObject(versionData),
  }

  const fields = buildVersionGlobalFields(this.payload.config, globalConfig)

  applyInsertDefaults({ adapter: this, data, fields })
  transform({ adapter: this, data, fields, operation: 'write' })

  const params = new ParamBag()
  const versions = escapeIdent(table)
  // The table holds the versions of one global, so every older latest row is unset, whatever its time.
  // The lock write is what makes two concurrent saves of the global conflict: each would otherwise unset only the rows it can see.
  const statements = `LET $created = (CREATE ONLY ${versions}:ulid() CONTENT ${params.add(data)} RETURN AFTER);
    UPSERT ${escapeIdent(VERSION_LOCK_TABLE)}:[${params.add(table)}] SET at = time::now() RETURN NONE;
    UPDATE ${versions} SET latest = NONE WHERE latest = true AND id != $created.id RETURN NONE;
    RETURN $created;`

  const db = await getSession(this, req)
  // An open transaction already makes the statements one unit, and `BEGIN` cannot nest inside it.
  // `LET`, `UPSERT` and `UPDATE` each take a slot in the response, and so do `BEGIN` and `COMMIT`; the row is the final `RETURN`.
  const sql = db.inTransaction ? statements : `BEGIN;\n${statements}\nCOMMIT;`
  const docSlot = db.inTransaction ? 3 : 4
  // Two saves of the global conflict on the lock record, and the retry sees the winner's row.
  const result = await db.query<(null | Record<string, unknown>)[]>(sql, params.vars, {
    retry: true,
  })
  const doc = result[docSlot]

  if (returning === false || !doc) {
    return null
  }

  transform({ adapter: this, data: doc, fields, operation: 'read' })

  return doc
}
