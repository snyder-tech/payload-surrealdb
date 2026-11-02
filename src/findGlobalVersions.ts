import type { FindGlobalVersionsArgs, JsonObject, PaginatedDocs, TypeWithVersion } from 'payload'

import { buildVersionGlobalFields } from 'payload'

import type { SurrealDBAdapter } from './index.js'

import { getGlobal } from './utilities/getEntity.js'
import { queryVersionRows } from './utilities/queryVersionRows.js'

export async function findGlobalVersions<T = JsonObject>(
  this: SurrealDBAdapter,
  {
    global: globalSlug,
    limit,
    locale,
    page,
    pagination,
    req,
    select,
    sort,
    where = {},
  }: FindGlobalVersionsArgs,
): Promise<PaginatedDocs<TypeWithVersion<T>>> {
  const { globalConfig, table } = getGlobal({ adapter: this, globalSlug, versions: true })

  const result = await queryVersionRows({
    adapter: this,
    fields: buildVersionGlobalFields(this.payload.config, globalConfig),
    flattenedFields: buildVersionGlobalFields(this.payload.config, globalConfig, true),
    limit,
    locale,
    // Payload counts the offset of a page even when it asks for no pagination
    offsetWithoutPagination: true,
    page,
    pagination,
    req,
    select,
    sort: sort || '-updatedAt',
    table,
    where,
  })

  // The rows are typed by the caller, as with every driver that does not know the schema
  return result as PaginatedDocs<TypeWithVersion<T>>
}
