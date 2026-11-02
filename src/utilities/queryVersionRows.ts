import type {
  Field,
  JoinQuery,
  FlattenedField,
  PaginatedDocs,
  PayloadRequest,
  SelectType,
  Sort,
  Where,
} from 'payload'

import type { SurrealDBAdapter } from '../index.js'

import { buildNearSort } from '../queries/buildNearSort.js'
import { buildQuery } from '../queries/buildQuery.js'
import { buildSortParam } from '../queries/buildSortParam.js'
import { ParamBag, escapeIdent } from '../queries/sql.js'
import { buildJoinSelection } from './buildJoinAggregation.js'
import { buildProjectionFromSelect } from './buildProjectionFromSelect.js'
import { getCollection } from './getEntity.js'
import { getSession } from './getSession.js'
import { paginate } from './paginate.js'
import { transform } from './transform.js'

/**
 * One page of rows of a version table, read back into Payload's shape. The collection and global
 * version methods and `queryDrafts` all end here, because they differ only in the table, the field
 * config and the `where` and `sort` they build.
 */
export const queryVersionRows = async ({
  adapter,
  collectionSlug,
  fields,
  flattenedFields,
  joins,
  limit = 0,
  locale,
  offsetWithoutPagination,
  page,
  pagination,
  req,
  select,
  sort,
  table,
  where,
}: {
  adapter: SurrealDBAdapter
  /** The collection the version rows belong to, whose join fields are read when `joins` is given. */
  collectionSlug?: string | undefined
  /** The version fields, as Payload declares them, which the read transform walks. */
  fields: Field[]
  /** The same fields, flattened, which the query, the sort and the projection resolve paths against. */
  flattenedFields: FlattenedField[]
  /** The join fields to read for every version row, which a draft query lists as documents. */
  joins?: JoinQuery | undefined
  limit?: number | undefined
  locale?: string | undefined
  /** Skip the pages before `page` when `pagination` is false: Payload's version cleanup depends on it, a draft query does not. */
  offsetWithoutPagination: boolean
  page?: number | undefined
  pagination?: boolean | undefined
  req?: Partial<PayloadRequest> | undefined
  select?: SelectType | undefined
  sort: Sort
  table: string
  where: Where
}): Promise<PaginatedDocs<Record<string, unknown>>> => {
  const params = new ParamBag()
  const projection = buildProjectionFromSelect({ adapter, fields: flattenedFields, select })
  const result = await paginate({
    db: await getSession(adapter, req),
    joins: collectionSlug
      ? buildJoinSelection({
          adapter,
          collectionConfig: getCollection({ adapter, collectionSlug }).collectionConfig,
          joins,
          locale,
          params,
          projection,
          versions: true,
        })
      : undefined,
    limit,
    offsetWithoutPagination,
    page,
    // A limit of 0 means "no limit", which is also what turns paging off
    pagination: limit === 0 ? false : pagination,
    params,
    projection,
    sort:
      buildNearSort({ adapter, fields: flattenedFields, locale, params, where }) ??
      buildSortParam({
        adapter,
        config: adapter.payload.config,
        fields: flattenedFields,
        locale,
        sort,
        timestamps: true,
      }),
    source: escapeIdent(table),
    where: buildQuery({
      adapter,
      fields: flattenedFields,
      idTable: table,
      locale,
      params,
      where,
    }),
  })

  transform({ adapter, data: result.docs, fields, operation: 'read' })

  return result
}
