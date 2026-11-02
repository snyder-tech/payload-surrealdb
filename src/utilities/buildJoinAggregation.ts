import type { FlattenedField, JoinQuery, SanitizedCollectionConfig, Where } from 'payload'

import {
  APIError,
  appendVersionToQueryKey,
  buildVersionCollectionFields,
  combineQueries,
  createArrayFromCommaDelineated,
  getFieldByPath,
  getQueryDraftsSort,
} from 'payload'
import { fieldShouldBeLocalized, hasDraftsEnabled } from 'payload/shared'

import type { SurrealDBAdapter } from '../index.js'
import type { SortArgs } from '../queries/buildSortParam.js'
import type { Fragment, ParamBag } from '../queries/sql.js'
import type { Projection } from './buildProjectionFromSelect.js'

import { analyzePath } from '../queries/analyzePath.js'
import { buildQuery } from '../queries/buildQuery.js'
import { buildSortParam, sortKeyProjection, toOrderByClause } from '../queries/buildSortParam.js'
import { leafValues } from '../queries/leafValues.js'
import { and, escapeIdent, toIdiom, whereClause } from '../queries/sql.js'
import { getCollection } from './getEntity.js'
import { fromRecordId, isRecordId } from './recordId.js'

type Row = Record<string, unknown>

/**
 * The columns that read the joins of each parent row, and the means to move what they return
 * onto the rows once they are read back.
 */
export type JoinSelection = {
  /** `, (subquery) AS alias` entries to put at the end of the `SELECT` list. */
  columns: string
  /**
   * Takes the join columns off `rows` and returns the function that puts the finished join values
   * on them. The two steps are apart because a `select` trims the keys it does not know, which the
   * join columns are, between them.
   */
  collect: (rows: Row[]) => () => void
}

type JoinColumn = {
  alias: string
  count: boolean
  /** The `limit` of the join, where 0 means no limit. */
  limit: number
  polymorphic: boolean
  /** Where on the parent row the join value goes, as a dotted path. */
  placement: string
}

const isRow = (value: unknown): value is Row =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

const toKey = (value: unknown): unknown => (isRecordId(value) ? fromRecordId(value) : value)

const setPath = (row: Row, path: string, value: unknown): void => {
  const segments = path.split('.')
  const key = segments.pop()

  if (key === undefined) {
    return
  }

  let ref = row

  for (const segment of segments) {
    const next = ref[segment]

    if (isRow(next)) {
      ref = next
    } else {
      const created: Row = {}
      ref[segment] = created
      ref = created
    }
  }

  ref[key] = value
}

/** Whether `select` keeps the value at `path`. */
const isProjected = (projection: Projection | undefined, path: string): boolean => {
  if (!projection) {
    return true
  }

  let node = projection.root

  for (const segment of path.split('.')) {
    if (node.all) {
      return true
    }

    const child = node.children.get(segment)

    if (!child) {
      return false
    }

    node = child
  }

  return true
}

const aliasEverything = (sort: SortArgs): SortArgs => sort.map((key) => ({ ...key, aliased: true }))

type RelationToOperator = 'equals' | 'in' | 'not_equals' | 'not_in'

const matchesRelationTo = (operator: string, value: unknown, slug: string): boolean => {
  const list = (): unknown[] =>
    typeof value === 'string'
      ? createArrayFromCommaDelineated(value)
      : Array.isArray(value)
        ? value
        : [value]

  switch (operator as RelationToOperator) {
    case 'equals':
      return value === slug
    case 'in':
      return list().includes(slug)
    case 'not_equals':
      return value !== slug
    case 'not_in':
      return !list().includes(slug)
    default:
      throw new APIError(`The operator "${operator}" is not supported on "relationTo".`, 400)
  }
}

const NEVER: Where = { id: { in: [] } }

/**
 * A polymorphic join reads one table per collection, and `relationTo` is not a column of any of
 * them but the name of the table being read. So the conditions on it are settled here, for the
 * collection that is read, and left out of the query as always true or always false.
 */
const pinRelationTo = (where: Where, slug: string): Where => {
  const pinned: Where = {}
  const always: Where[] = []

  for (const [key, condition] of Object.entries(where)) {
    const lowerKey = key.toLowerCase()

    if ((lowerKey === 'and' || lowerKey === 'or') && Array.isArray(condition)) {
      pinned[lowerKey] = condition.map((each: Where) => pinRelationTo(each, slug))
    } else if (key === 'relationTo' && isRow(condition)) {
      const holds = Object.entries(condition).every(([operator, value]) =>
        matchesRelationTo(operator, value, slug),
      )

      if (!holds) {
        always.push(NEVER)
      }
    } else {
      pinned[key] = condition
    }
  }

  if (always.length > 0) {
    const existing = Array.isArray(pinned['and']) ? pinned['and'] : []
    pinned['and'] = [...existing, ...always]
  }

  return pinned
}

/** The condition that a row of the joined collection points back to the parent row. */
const pointsToParent = ({
  adapter,
  fields,
  on,
  parent,
  path,
  prefix,
}: {
  adapter: SurrealDBAdapter
  /** The joined collection's own fields, which `on` is a path in. */
  fields: FlattenedField[]
  /** The `on` path of the join field. */
  on: string
  parent: string
  /** `on`, with the locale in it when the relationship is localized. */
  path: string
  /** `version.` when the rows read are versions. */
  prefix: string
}): Fragment => {
  const target = getFieldByPath({ fields, path: on })?.field

  if (!target || (target.type !== 'relationship' && target.type !== 'upload')) {
    throw new APIError(`The join field's "on" path "${on}" is not a relationship field.`)
  }

  // A polymorphic link holds the ID in `value`, and the ID names its table, so it needs no `relationTo` check
  const idiom = toIdiom(`${prefix}${path}${Array.isArray(target.relationTo) ? '.value' : ''}`)
  const values = leafValues({
    analysis: analyzePath({ adapter, fields, parentIsLocalized: false, path }),
    idiom,
    isList: Boolean(target.hasMany),
  })

  return values ? `${values} CONTAINS ${parent}` : `${idiom} = ${parent}`
}

/**
 * Reads the join fields of a collection for every parent row in the same request: one correlated
 * subquery per join, paged per parent, so no extra round trip is made and each parent gets its own
 * page (Mongo's `buildJoinAggregation` does the same with `$lookup`). A subquery sees the parent
 * as `$parent`.
 */
export const buildJoinSelection = ({
  adapter,
  collectionConfig,
  draftsEnabled,
  joins,
  locale,
  params,
  projection,
  versions = false,
}: {
  adapter: SurrealDBAdapter
  collectionConfig: SanitizedCollectionConfig
  draftsEnabled?: boolean | undefined
  joins?: JoinQuery | undefined
  locale?: string | undefined
  params: ParamBag
  projection?: Projection | undefined
  /** The parent rows are versions, as for a draft query: they point to their document with `parent`. */
  versions?: boolean | undefined
}): JoinSelection | undefined => {
  if (
    joins === false ||
    (Object.keys(collectionConfig.joins).length === 0 &&
      collectionConfig.polymorphicJoins.length === 0)
  ) {
    return undefined
  }

  const { localization } = adapter.payload.config
  const parent = versions ? '$parent.parent' : '$parent.id'
  const prefix = versions ? 'version.' : ''
  const entries: string[] = []
  const columns: JoinColumn[] = []

  const requested = (joinPath: string) => {
    const request = joins?.[joinPath]

    return request === false || !isProjected(projection, `${prefix}${joinPath}`)
      ? undefined
      : (request ?? {})
  }

  for (const join of collectionConfig.polymorphicJoins) {
    const request = requested(join.joinPath)

    if (!request) {
      continue
    }

    if (!Array.isArray(join.field.collection)) {
      throw new APIError(`The join "${join.joinPath}" is not polymorphic.`)
    }

    const {
      count = false,
      limit = join.field.defaultLimit ?? 10,
      page,
      sort: sortJoin = join.field.defaultSort || collectionConfig.defaultSort,
      where = {},
    } = request
    const offset = page ? (page - 1) * limit : 0
    const members = join.field.collection.map((slug) =>
      getCollection({ adapter, collectionSlug: slug }),
    )

    // Rows of different collections are ordered by one sort, over the fields they have in common
    const fields: FlattenedField[] = []

    for (const { collectionConfig: member } of members) {
      for (const field of member.flattenedFields) {
        if (!fields.some((each) => each.name === field.name)) {
          fields.push(field)
        }
      }
    }

    const sort = aliasEverything(
      buildSortParam({
        adapter,
        config: adapter.payload.config,
        fields,
        locale,
        sort: sortJoin,
        timestamps: true,
      }),
    )
    // Each table only has to supply the rows that can reach the requested page
    const reach = limit > 0 ? ` LIMIT ${params.add(offset + limit + 1)}` : ''
    const selects: string[] = []
    const counts: string[] = []

    for (const { collectionConfig: member, table } of members) {
      const condition = and(
        [
          pointsToParent({
            adapter,
            fields: member.flattenedFields,
            on: join.field.on,
            parent,
            path: join.field.on,
            prefix: '',
          }),
          buildQuery({
            adapter,
            collectionSlug: member.slug,
            fields,
            locale,
            params,
            where: pinRelationTo(where, member.slug),
          }),
        ].filter((each) => each !== null),
      )
      const from = `FROM ${escapeIdent(table)}${whereClause(condition)}`

      selects.push(
        `(SELECT ${params.add(member.slug)} AS relationTo, id AS value${sortKeyProjection(sort)} ${from}${toOrderByClause(sort)}${reach})`,
      )
      counts.push(`((SELECT count() ${from} GROUP ALL)[0].count ?? 0)`)
    }

    const alias = `__join${columns.length}`

    entries.push(
      `(SELECT * FROM array::flatten([${selects.join(', ')}])${toOrderByClause(sort)}${limit > 0 ? ` LIMIT ${params.add(limit + 1)}` : ''}${offset > 0 ? ` START ${params.add(offset)}` : ''}) AS ${alias}`,
    )

    if (count) {
      entries.push(`${counts.join(' + ')} AS ${alias}_total`)
    }

    columns.push({
      alias,
      count,
      limit,
      placement: `${prefix}${join.joinPath}`,
      polymorphic: true,
    })
  }

  for (const joinsList of Object.values(collectionConfig.joins)) {
    for (const join of joinsList) {
      const request = requested(join.joinPath)

      if (!request) {
        continue
      }

      if (typeof join.field.collection !== 'string') {
        throw new APIError(`The join "${join.joinPath}" must target a single collection.`)
      }

      const { collectionConfig: joined } = getCollection({
        adapter,
        collectionSlug: join.field.collection,
      })
      const useDrafts = (draftsEnabled || versions) && hasDraftsEnabled(joined)
      const { table } = getCollection({
        adapter,
        collectionSlug: joined.slug,
        versions: Boolean(useDrafts),
      })
      const {
        count = false,
        limit = join.field.defaultLimit ?? 10,
        page,
        sort: sortJoin = join.field.defaultSort || joined.defaultSort,
        where = {},
      } = request
      const offset = page ? (page - 1) * limit : 0
      const fields = useDrafts
        ? buildVersionCollectionFields(adapter.payload.config, joined, true)
        : joined.flattenedFields
      const sort = buildSortParam({
        adapter,
        config: adapter.payload.config,
        fields,
        locale,
        sort: useDrafts
          ? getQueryDraftsSort({
              collectionConfig: joined,
              ...(sortJoin ? { sort: sortJoin } : {}),
            })
          : sortJoin,
        timestamps: true,
      })
      const condition = buildQuery({
        adapter,
        collectionSlug: joined.slug,
        fields,
        idTable: useDrafts ? table : undefined,
        locale,
        params,
        where: useDrafts
          ? combineQueries(appendVersionToQueryKey(where), { latest: { equals: true } })
          : where,
      })

      const localized =
        Boolean(localization) &&
        fieldShouldBeLocalized({ field: join.field, parentIsLocalized: join.parentIsLocalized })
      // A localized join holds one page per locale, and `locale: 'all'` reads them all
      const localeCodes =
        localized && localization && locale === 'all' ? localization.localeCodes : [locale]

      for (const code of localeCodes) {
        // `all` has no path of its own: a join that is not localized reads the default locale's
        const foreignLocale =
          code && code !== 'all' ? code : localization ? localization.defaultLocale : undefined
        const path = join.getForeignPath
          ? join.getForeignPath(foreignLocale ? { locale: foreignLocale } : {})
          : join.field.on
        const joinCondition = and(
          [
            pointsToParent({
              adapter,
              fields: joined.flattenedFields,
              on: join.field.on,
              parent,
              path,
              prefix: useDrafts ? 'version.' : '',
            }),
            condition,
          ].filter((each) => each !== null),
        )
        const from = `FROM ${escapeIdent(table)}${whereClause(joinCondition)}`
        const alias = `__join${columns.length}`

        // The join holds the IDs of its documents, or of their parents for a draft
        entries.push(
          `(SELECT ${useDrafts ? 'parent' : 'id'} AS __value${sortKeyProjection(sort)} ${from}${toOrderByClause(sort)}${limit > 0 ? ` LIMIT ${params.add(limit + 1)}` : ''}${offset > 0 ? ` START ${params.add(offset)}` : ''}).__value AS ${alias}`,
        )

        if (count) {
          entries.push(`(SELECT count() ${from} GROUP ALL)[0].count ?? 0 AS ${alias}_total`)
        }

        columns.push({
          alias,
          count,
          limit,
          placement: `${prefix}${join.joinPath}${localized && code ? `.${code}` : ''}`,
          polymorphic: false,
        })
      }
    }
  }

  if (columns.length === 0) {
    return undefined
  }

  return {
    columns: entries.map((entry) => `, ${entry}`).join(''),
    collect: (rows) => {
      const joined: { row: Row; column: JoinColumn; value: Row }[] = []

      for (const row of rows) {
        for (const column of columns) {
          const raw = row[column.alias]
          const total = row[`${column.alias}_total`]
          const found: unknown[] = Array.isArray(raw) ? raw : []

          delete row[column.alias]
          delete row[`${column.alias}_total`]

          const docs = column.limit > 0 ? found.slice(0, column.limit) : found
          const value: Row = {
            docs: docs.map((doc) =>
              column.polymorphic && isRow(doc)
                ? { relationTo: doc['relationTo'], value: toKey(doc['value']) }
                : toKey(doc),
            ),
            hasNextPage: column.limit > 0 && found.length > column.limit,
          }

          if (column.count) {
            value['totalDocs'] = typeof total === 'number' ? total : 0
          }

          joined.push({ column, row, value })
        }
      }

      return () => {
        for (const { column, row, value } of joined) {
          setPath(row, column.placement, value)
        }
      }
    },
  }
}
