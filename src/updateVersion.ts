import type { JsonObject, TypeWithVersion, UpdateVersionArgs } from 'payload'

import { buildVersionCollectionFields } from 'payload'

import type { SurrealDBAdapter } from './index.js'

import { getCollection } from './utilities/getEntity.js'
import { updateVersionRow } from './utilities/updateVersionRow.js'

// Payload types the result as never null, but it is null when `returning` is false or no row matches, as in Mongo's adapter.
export function updateVersion<T extends JsonObject = JsonObject>(
  this: SurrealDBAdapter,
  args: UpdateVersionArgs<T>,
): Promise<TypeWithVersion<T>>
export function updateVersion(
  this: SurrealDBAdapter,
  {
    id,
    collection: collectionSlug,
    locale,
    req,
    returning,
    select,
    versionData,
    where,
  }: UpdateVersionArgs,
): Promise<null | Record<string, unknown>> {
  const { collectionConfig, table } = getCollection({
    adapter: this,
    collectionSlug,
    versions: true,
  })

  return updateVersionRow({
    adapter: this,
    fields: buildVersionCollectionFields(this.payload.config, collectionConfig),
    flattenedFields: buildVersionCollectionFields(this.payload.config, collectionConfig, true),
    locale,
    req,
    returning,
    select,
    table,
    versionData,
    where: where || { id: { equals: id } },
  })
}
