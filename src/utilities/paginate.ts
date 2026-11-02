import type { PaginatedDocs } from 'payload'

import type { Executor } from '../connection/executor.js'
import type { SortArgs } from '../queries/buildSortParam.js'
import type { Fragment, ParamBag } from '../queries/sql.js'
import type { Projection } from './buildProjectionFromSelect.js'
import type { JoinSelection } from './buildJoinAggregation.js'

import { removeSortKeys, sortKeyProjection, toOrderByClause } from '../queries/buildSortParam.js'
import { runQuery, whereClause } from '../queries/sql.js'
import { applyProjection, selectClause } from './buildProjectionFromSelect.js'

type Row = Record<string, unknown>

type Args = {
  db: Executor
  /** The join fields to read for every row. */
  joins?: JoinSelection | undefined
  /** `0` means no limit. */
  limit: number
  /** Skip the pages before `page` even when `pagination` is false, which the version methods do. */
  offsetWithoutPagination?: boolean
  page?: number | undefined
  /** `false` skips the page offset and the count: the limit alone is applied. */
  pagination?: boolean | undefined
  /** The top-level keys to select and the nested paths to keep, or every field without one. */
  projection?: Projection | undefined
  /** The bag the `where` fragment was built with: the page and count are bound in the same request. */
  params: ParamBag
  sort: SortArgs
  /** What to select from: an escaped table, or the bound list of record IDs. */
  source: string
  where: Fragment | null
}

/**
 * Fetches one page and its total in a single request, and builds the paging metadata the way
 * `mongoose-paginate-v2` does, because Payload's tests were written against that.
 */
export async function paginate({
  db,
  joins,
  limit,
  offsetWithoutPagination = false,
  page: pageArg,
  pagination,
  params,
  projection,
  sort,
  source,
  where,
}: Args): Promise<PaginatedDocs<Row>> {
  const limited = limit > 0
  const paginating = pagination !== false && limited
  const page = pageArg && pageArg > 0 ? Math.floor(pageArg) : 1
  const from = `FROM ${source}${whereClause(where)}`

  // Payload's bulk update asks for `pagination: false` together with a limit and expects the limit
  // to hold, so only the page offset and the total depend on `pagination`.
  const rows = `SELECT ${selectClause(projection)}${sortKeyProjection(sort)}${joins?.columns ?? ''} ${from}${toOrderByClause(sort)}${limited ? ` LIMIT ${params.add(limit)}` : ''}${
    paginating || (offsetWithoutPagination && limited && page > 1)
      ? ` START ${params.add((page - 1) * limit)}`
      : ''
  };`
  const select = paginating ? `${rows}\nSELECT count() ${from} GROUP ALL;` : rows

  const [docs, counts] = await runQuery<[Row[], { count: number }[]?]>(db, params, select)
  const putJoins = joins?.collect(docs)

  removeSortKeys(docs)
  applyProjection(docs, projection)
  putJoins?.()

  if (!paginating) {
    return {
      docs,
      hasNextPage: false,
      hasPrevPage: false,
      limit: docs.length,
      nextPage: null,
      page: 1,
      pagingCounter: 1,
      prevPage: null,
      totalDocs: docs.length,
      totalPages: 1,
    }
  }

  const totalDocs = counts?.[0]?.count ?? 0
  const totalPages = Math.ceil(totalDocs / limit) || 1
  const hasPrevPage = page > 1
  const hasNextPage = page < totalPages

  return {
    docs,
    hasNextPage,
    hasPrevPage,
    limit,
    nextPage: hasNextPage ? page + 1 : null,
    page,
    pagingCounter: (page - 1) * limit + 1,
    prevPage: hasPrevPage ? page - 1 : null,
    totalDocs,
    totalPages,
  }
}
