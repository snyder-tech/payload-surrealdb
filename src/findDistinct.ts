import type { FindDistinct } from 'payload'

import type { SurrealDBAdapter } from './index.js'

import { buildQuery } from './queries/buildQuery.js'
import { buildSortParam, resolveFieldPath } from './queries/buildSortParam.js'
import { ParamBag, and, escapeIdent, runQuery, toIdiom, whereClause } from './queries/sql.js'
import { getCollection } from './utilities/getEntity.js'
import { getSession } from './utilities/getSession.js'
import { fromRecordId, isRecordId } from './utilities/recordId.js'

/** A value as Mongo's `JSON.parse(JSON.stringify(value))` returns it: dates as ISO strings, links as their keys. */
const toJSONValue = (value: unknown): unknown => {
  if (isRecordId(value)) {
    return fromRecordId(value)
  }

  if (value instanceof Date) {
    return value.toISOString()
  }

  if (Array.isArray(value)) {
    return value.map(toJSONValue)
  }

  if (typeof value === 'object' && value !== null) {
    return Object.fromEntries(Object.entries(value).map(([key, each]) => [key, toJSONValue(each)]))
  }

  return value
}

export const findDistinct: FindDistinct = async function (this: SurrealDBAdapter, args) {
  const { collectionConfig, table } = getCollection({
    adapter: this,
    collectionSlug: args.collection,
  })
  const { where = {} } = args
  const params = new ParamBag()
  const fields = collectionConfig.flattenedFields

  const [sort] = buildSortParam({
    adapter: this,
    config: this.payload.config,
    fields,
    locale: args.locale,
    sort: args.sort ?? args.field,
    timestamps: true,
  })

  if (!sort) {
    throw new Error('buildSortParam always returns at least one sort key.')
  }

  const condition = buildQuery({
    adapter: this,
    collectionSlug: args.collection,
    fields,
    locale: args.locale,
    params,
    where,
  })

  const { hasManyValue, pieces } = resolveFieldPath({
    adapter: this,
    config: this.payload.config,
    fields,
    locale: args.locale,
    parentIsLocalized: false,
    property: args.field,
  })

  // The value is read through the links of the document, and a hop that has an access constraint
  // keeps only the related documents the constraint allows, which a hasMany relationship can mix.
  let expression = ''
  const hops: string[] = []
  let filtered = false

  for (const { hop, path } of pieces) {
    const idiom = toIdiom(path)

    expression = expression ? `(${expression}).${idiom}` : idiom

    if (!hop) {
      continue
    }

    hops.push(`array::len(fn::pvals(${expression})) > 0`)

    const access = args.relatedAccess?.[hop.namePath]

    if (access) {
      const { collectionConfig: related, table: relatedTable } = getCollection({
        adapter: this,
        collectionSlug: hop.slug,
      })
      const allowed = params.define(
        `SELECT VALUE id FROM ${escapeIdent(relatedTable)}${whereClause(
          buildQuery({
            adapter: this,
            collectionSlug: hop.slug,
            fields: related.flattenedFields,
            locale: args.locale,
            params,
            where: access,
          }),
        )}`,
      )

      expression = `array::filter(fn::pvals(${expression}), |$r| $r IN ${allowed})`
      filtered = true
    }
  }

  // A document without the related document is not a value of it, which is what Mongo's inner `$unwind` drops
  const rows = and(condition ? [condition, ...hops] : hops)
  // `SPLIT` needs a field of the rows it splits, so it reads the aliases of the query inside
  const splits = hasManyValue || filtered
  const sortsByValue = sort.expression === expression
  const direction = sort.direction === 'asc' ? 'ASC' : 'DESC'

  const read = `SELECT ${expression} AS v${sortsByValue ? '' : `, ${sort.expression} AS s`} FROM ${escapeIdent(table)}${whereClause(rows)}`
  const normalized = `SELECT ${splits ? '(IF type::is_array(v) { NONE } ELSE { v ?? NONE })' : '(v ?? NONE)'} AS v${sortsByValue ? '' : ', s'} FROM ${splits ? `(SELECT v${sortsByValue ? '' : ', s'} FROM (${read}) SPLIT v)` : `(${read})`}`
  // Mongo takes the largest sort value of each group, whatever its direction
  const grouped = sortsByValue
    ? `SELECT v FROM (${normalized}) GROUP BY v`
    : `SELECT v, array::max(ss) AS s FROM (SELECT v, array::group(s) AS ss FROM (${normalized}) GROUP BY v)`
  const ordered = `${grouped} ORDER BY ${sortsByValue ? `v ${direction}` : `s ${direction}, v ASC`}`

  const page = args.page || 1
  const limit = args.limit ?? 0
  const db = await getSession(this, args.req)
  const [valueRows, counts] = await runQuery<[{ v?: unknown }[], { count: number }[]?]>(
    db,
    params,
    limit > 0
      ? `${ordered} LIMIT ${params.add(limit)} START ${params.add((page - 1) * limit)};
         SELECT count() FROM (SELECT v FROM (${normalized}) GROUP BY v) GROUP ALL;`
      : `${ordered};`,
  )
  const values = valueRows.map((row) => ({ [args.field]: toJSONValue(row.v ?? null) }))

  if (limit === 0) {
    return {
      hasNextPage: false,
      hasPrevPage: false,
      limit: 0,
      page: 1,
      pagingCounter: 1,
      totalDocs: values.length,
      totalPages: 1,
      values,
    }
  }

  const totalDocs = counts?.[0]?.count ?? 0
  const totalPages = Math.ceil(totalDocs / limit)
  const hasPrevPage = page > 1
  const hasNextPage = totalPages > page

  return {
    hasNextPage,
    hasPrevPage,
    limit,
    nextPage: hasNextPage ? page + 1 : null,
    page,
    pagingCounter: (page - 1) * limit + 1,
    prevPage: hasPrevPage ? page - 1 : null,
    totalDocs,
    totalPages,
    values,
  }
}
