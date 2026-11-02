import type { Find, FindArgs, PaginatedDocs, TypeWithID } from 'payload'

import type { SurrealDBAdapter } from './index.js'

import { buildNearSort } from './queries/buildNearSort.js'
import { buildQueryTarget } from './queries/buildQueryTarget.js'
import { buildSortParam } from './queries/buildSortParam.js'
import { ParamBag } from './queries/sql.js'
import { buildJoinSelection } from './utilities/buildJoinAggregation.js'
import { buildProjectionFromSelect } from './utilities/buildProjectionFromSelect.js'
import { getCollection } from './utilities/getEntity.js'
import { getSession } from './utilities/getSession.js'
import { paginate } from './utilities/paginate.js'
import { transform } from './utilities/transform.js'

export const find: Find = async function find<T = TypeWithID>(
  this: SurrealDBAdapter,
  {
    collection: collectionSlug,
    draftsEnabled,
    joins = {},
    limit = 0,
    locale,
    page,
    pagination,
    req,
    select,
    sort: sortArg,
    where = {},
  }: FindArgs,
): Promise<PaginatedDocs<T>> {
  const { collectionConfig } = getCollection({ adapter: this, collectionSlug })

  const params = new ParamBag()
  const sort =
    buildNearSort({
      adapter: this,
      collectionSlug,
      fields: collectionConfig.flattenedFields,
      locale,
      params,
      where,
    }) ??
    buildSortParam({
      adapter: this,
      config: this.payload.config,
      fields: collectionConfig.flattenedFields,
      locale,
      sort: sortArg || collectionConfig.defaultSort,
      timestamps: collectionConfig.timestamps || false,
    })
  const { condition, from } = buildQueryTarget({
    adapter: this,
    collectionSlug,
    fields: collectionConfig.flattenedFields,
    locale,
    params,
    where,
  })

  const projection = buildProjectionFromSelect({
    adapter: this,
    fields: collectionConfig.flattenedFields,
    select,
  })

  const result = await paginate({
    db: await getSession(this, req),
    joins: buildJoinSelection({
      adapter: this,
      collectionConfig,
      draftsEnabled,
      joins,
      locale,
      params,
      projection,
    }),
    limit,
    page,
    // A limit of 0 means "no limit", which is also what turns paging off
    pagination: limit === 0 ? false : pagination,
    params,
    projection,
    sort,
    source: from,
    where: condition,
  })

  transform({
    adapter: this,
    data: result.docs as Record<string, unknown>[],
    fields: collectionConfig.fields,
    operation: 'read',
  })

  // The rows are typed by the caller, as with every driver that does not know the schema
  return result as PaginatedDocs<T>
}
