import type { JsonObject, TypeWithVersion, UpdateGlobalVersionArgs } from 'payload'

import { buildVersionGlobalFields } from 'payload'

import type { SurrealDBAdapter } from './index.js'

import { getGlobal } from './utilities/getEntity.js'
import { updateVersionRow } from './utilities/updateVersionRow.js'

// Payload types the result as never null, but it is null when `returning` is false or no row matches, as in Mongo's adapter.
export function updateGlobalVersion<T extends JsonObject = JsonObject>(
  this: SurrealDBAdapter,
  args: UpdateGlobalVersionArgs<T>,
): Promise<TypeWithVersion<T>>
export function updateGlobalVersion(
  this: SurrealDBAdapter,
  {
    id,
    global: globalSlug,
    locale,
    req,
    returning,
    select,
    versionData,
    where,
  }: UpdateGlobalVersionArgs,
): Promise<null | Record<string, unknown>> {
  const { globalConfig, table } = getGlobal({ adapter: this, globalSlug, versions: true })

  return updateVersionRow({
    adapter: this,
    fields: buildVersionGlobalFields(this.payload.config, globalConfig),
    flattenedFields: buildVersionGlobalFields(this.payload.config, globalConfig, true),
    locale,
    req,
    returning,
    select,
    table,
    versionData,
    where: where || { id: { equals: id } },
  })
}
