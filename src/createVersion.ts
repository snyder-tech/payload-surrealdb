import type { CreateVersionArgs, JsonObject, TypeWithVersion } from 'payload'

import { buildVersionCollectionFields, deepCopyObject } from 'payload'

import type { SurrealDBAdapter } from './index.js'

import { dateCompare } from './queries/datetime.js'
import { ParamBag, escapeIdent } from './queries/sql.js'
import { applyInsertDefaults } from './utilities/applyInsertDefaults.js'
import { getCollection } from './utilities/getEntity.js'
import { getSession } from './utilities/getSession.js'
import { VERSION_LOCK_TABLE } from './utilities/getTables.js'
import { transform } from './utilities/transform.js'

// Payload types the result as never null, but with `returning: false` there is no row to give back, as in Mongo's adapter.
export function createVersion<T extends JsonObject = JsonObject>(
  this: SurrealDBAdapter,
  args: CreateVersionArgs<T>,
): Promise<TypeWithVersion<T>>
export async function createVersion(
  this: SurrealDBAdapter,
  {
    autosave,
    collectionSlug,
    createdAt,
    parent,
    publishedLocale,
    req,
    returning,
    snapshot,
    updatedAt,
    versionData,
  }: CreateVersionArgs,
): Promise<null | Record<string, unknown>> {
  const { collectionConfig, table } = getCollection({
    adapter: this,
    collectionSlug,
    versions: true,
  })

  const data: Record<string, unknown> = {
    autosave,
    createdAt: createdAt || new Date().toISOString(),
    latest: true,
    parent,
    publishedLocale,
    snapshot,
    updatedAt,
    version: deepCopyObject(versionData),
  }

  const fields = buildVersionCollectionFields(this.payload.config, collectionConfig)

  applyInsertDefaults({ adapter: this, data, fields })
  transform({ adapter: this, data, fields, operation: 'write' })

  const params = new ParamBag()
  const versions = escapeIdent(table)
  // The created row carries the parent and the time the older rows are compared with, so they are read from it.
  // Rows with the same `updatedAt` both stay latest, as they do in Mongo.
  // A range scan over the `updatedAt` index skips a time with no fraction of a second, which would leave that row latest forever (see `dateCompare`).
  // The lock write is what makes two concurrent saves of one parent conflict: each would otherwise unset only the rows it can see.
  const statements = `LET $created = (CREATE ONLY ${versions}:ulid() CONTENT ${params.add(data)} RETURN AFTER);
    UPSERT ${escapeIdent(VERSION_LOCK_TABLE)}:[${params.add(table)}, $created.parent] SET at = time::now() RETURN NONE;
    UPDATE ${versions} SET latest = NONE
      WHERE parent = $created.parent AND latest = true AND id != $created.id AND ${dateCompare('updatedAt', '<', '$created.updatedAt')}
      RETURN NONE;
    RETURN $created;`

  const db = await getSession(this, req)
  // An open transaction already makes the statements one unit, and `BEGIN` cannot nest inside it.
  // `LET`, `UPSERT` and `UPDATE` each take a slot in the response, and so do `BEGIN` and `COMMIT`; the row is the final `RETURN`.
  const sql = db.inTransaction ? statements : `BEGIN;\n${statements}\nCOMMIT;`
  const docSlot = db.inTransaction ? 3 : 4
  // Two saves of one parent conflict on the lock record, and the retry sees the winner's row.
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
