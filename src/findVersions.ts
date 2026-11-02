import type { FindVersionsArgs, JsonObject, PaginatedDocs, TypeWithVersion } from 'payload'

import { buildVersionCollectionFields } from 'payload'

import type { SurrealDBAdapter } from './index.js'

import { getCollection } from './utilities/getEntity.js'
import { queryVersionRows } from './utilities/queryVersionRows.js'

export async function findVersions<T = JsonObject>(
  this: SurrealDBAdapter,
  {
    collection: collectionSlug,
    limit,
    locale,
    page,
    pagination,
    req,
    select,
    sort,
    where = {},
  }: FindVersionsArgs,
): Promise<PaginatedDocs<TypeWithVersion<T>>> {
  const { collectionConfig, table } = getCollection({
    adapter: this,
    collectionSlug,
    versions: true,
  })

  const result = await queryVersionRows({
    adapter: this,
    fields: buildVersionCollectionFields(this.payload.config, collectionConfig),
    flattenedFields: buildVersionCollectionFields(this.payload.config, collectionConfig, true),
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
