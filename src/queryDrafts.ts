import type { PaginatedDocs, QueryDraftsArgs, TypeWithID } from 'payload'

import { buildVersionCollectionFields, combineQueries } from 'payload'

import type { SurrealDBAdapter } from './index.js'

import { getCollection } from './utilities/getEntity.js'
import { queryVersionRows } from './utilities/queryVersionRows.js'

const isRow = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

export async function queryDrafts<T = TypeWithID>(
  this: SurrealDBAdapter,
  {
    collection: collectionSlug,
    joins,
    limit,
    locale,
    page,
    pagination,
    req,
    select,
    sort,
    where = {},
  }: QueryDraftsArgs,
): Promise<PaginatedDocs<T>> {
  const { collectionConfig, table } = getCollection({
    adapter: this,
    collectionSlug,
    versions: true,
  })

  // Core has already prefixed the `where` and the `sort` with `version.`
  const result = await queryVersionRows({
    adapter: this,
    collectionSlug,
    fields: buildVersionCollectionFields(this.payload.config, collectionConfig),
    flattenedFields: buildVersionCollectionFields(this.payload.config, collectionConfig, true),
    joins,
    limit,
    locale,
    // Unlike the version lists, a draft query with pagination off does not skip the earlier pages, as in Mongo
    offsetWithoutPagination: false,
    page,
    pagination,
    req,
    select,
    sort: sort || collectionConfig.defaultSort || '-createdAt',
    table,
    where: combineQueries({ latest: { equals: true } }, where),
  })

  // A draft is listed as its document: the version's fields under the parent's ID
  const docs = result.docs.map((row) => ({
    ...(isRow(row['version']) ? row['version'] : {}),
    id: row['parent'],
  }))

  return { ...result, docs } as PaginatedDocs<T>
}
