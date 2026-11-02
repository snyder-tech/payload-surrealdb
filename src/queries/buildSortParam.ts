import { type FlattenedField, getFieldByPath, type SanitizedConfig, type Sort } from 'payload'

import type { SurrealDBAdapter } from '../index.js'

import { getCollection } from '../utilities/getEntity.js'
import { analyzePath } from './analyzePath.js'
import { getLocalizedSortProperty } from './getLocalizedSortProperty.js'
import { dateSortKey } from './datetime.js'
import { toIdiom } from './sql.js'

type Args = {
  adapter: SurrealDBAdapter
  config: SanitizedConfig
  fields: FlattenedField[]
  locale?: string | undefined
  parentIsLocalized?: boolean
  sort?: Sort | undefined
  timestamps: boolean
}

export type SortDirection = 'asc' | 'desc'

export type SortArgs = {
  /** `' COLLATE'` or `' COLLATE NUMERIC'` when the adapter has a `collation`, otherwise empty. */
  collate: string
  direction: SortDirection
  /** What the rows are ordered by, as SurrealQL. */
  expression: string
  /**
   * The expression has to be selected under an alias, because `ORDER BY` cannot use it as it is:
   * a path through a relationship is silently ignored, a list has no order, and a date column
   * would sort by an index that orders mixed precisions wrongly (see `dateSortKey`).
   */
  aliased: boolean
}[]

export type ResolvedPath = {
  /**
   * The path in pieces, localized: one piece up to and including each relationship that is
   * followed, then the rest. `author.name` is `author` with the hop to `users`, and `name.en`.
   */
  pieces: {
    /** Set on a piece that ends on a relationship that is followed into another collection. */
    hop?: {
      isList: boolean
      /** The names of the fields that lead to the relationship, which is how access is keyed. */
      namePath: string
      slug: string
    }
    path: string
  }[]
  /** A relationship was followed. */
  followed: boolean
  /** Some field on the way holds a list of values: a hasMany field or relationship. */
  hasManyValue: boolean
  /** The path reaches a list of values, through an array, blocks, json or a hasMany field. */
  isList: boolean
  isDate: boolean
}

/**
 * Follows a path through the field config, into the related collection at each relationship, and
 * localizes each piece as `getLocalizedSortProperty` does.
 */
export const resolveFieldPath = ({
  adapter,
  config,
  fields,
  locale,
  parentIsLocalized,
  property,
}: {
  adapter: SurrealDBAdapter
  config: SanitizedConfig
  fields: FlattenedField[]
  locale: string | undefined
  parentIsLocalized: boolean
  property: string
}): ResolvedPath => {
  const resolved: ResolvedPath = {
    followed: false,
    hasManyValue: false,
    isDate: false,
    isList: false,
    pieces: [],
  }
  let segments = property.split('.')
  let currentFields = fields
  let currentIsLocalized = parentIsLocalized
  const hopNames: string[] = []

  while (segments.length > 0) {
    const { arrayLevels, crossed, inJson, last } = analyzePath({
      adapter,
      fields: currentFields,
      parentIsLocalized: currentIsLocalized,
      path: segments.join('.'),
    })
    const slug =
      crossed && 'relationTo' in crossed.field && typeof crossed.field.relationTo === 'string'
        ? crossed.field.relationTo
        : undefined

    // A polymorphic relationship has no single collection to follow into: its path is read as it is
    if (!crossed || !slug) {
      resolved.pieces.push({
        path: getLocalizedSortProperty({
          config,
          fields: currentFields,
          locale,
          parentIsLocalized: currentIsLocalized,
          segments,
        }),
      })

      const hasMany = Boolean(last && 'hasMany' in last && last.hasMany)

      resolved.hasManyValue ||= hasMany
      resolved.isList ||= arrayLevels > 0 || inJson || hasMany
      resolved.isDate = !resolved.followed && !resolved.isList && last?.type === 'date'
      break
    }

    const hasMany = 'hasMany' in crossed.field && Boolean(crossed.field.hasMany)

    hopNames.push(crossed.path)
    resolved.pieces.push({
      hop: { isList: hasMany, namePath: hopNames.join('.'), slug },
      path: getLocalizedSortProperty({
        config,
        fields: currentFields,
        locale,
        parentIsLocalized: currentIsLocalized,
        segments: segments.slice(0, crossed.segments),
      }),
    })
    resolved.hasManyValue ||= hasMany
    resolved.isList ||= arrayLevels > 0 || hasMany
    resolved.followed = true
    currentFields = getCollection({ adapter, collectionSlug: slug }).collectionConfig
      .flattenedFields
    currentIsLocalized = false
    segments = segments.slice(crossed.segments)
  }

  return resolved
}

/**
 * The SurrealQL for one sort key. A relationship is followed into the related collection, and a
 * path that holds several values sorts by its smallest value ascending and its largest descending,
 * as Mongo does.
 */
const resolveSortKey = ({
  direction,
  ...args
}: {
  adapter: SurrealDBAdapter
  config: SanitizedConfig
  direction: SortDirection
  fields: FlattenedField[]
  locale: string | undefined
  parentIsLocalized: boolean
  property: string
}): { aliased: boolean; expression: string; path: string } => {
  const { followed, isDate, isList, pieces } = resolveFieldPath(args)
  const path = pieces.map((piece) => piece.path).join('.')
  const idiom = toIdiom(path)

  if (isList) {
    // `fn::pvals` drops the elements that lack the value, which would otherwise sort first
    const pick = direction === 'asc' ? 'array::min' : 'array::max'

    return { aliased: true, expression: `${pick}(fn::pvals(${idiom}))`, path }
  }

  if (isDate) {
    return { aliased: true, expression: dateSortKey(idiom), path }
  }

  return { aliased: followed, expression: idiom, path }
}

const collateClause = (collation: SurrealDBAdapter['collation']): string => {
  if (!collation) {
    return ''
  }

  return collation === true || !collation.numericOrdering ? ' COLLATE' : ' COLLATE NUMERIC'
}

export const buildSortParam = ({
  adapter,
  config,
  fields,
  locale,
  parentIsLocalized = false,
  sort: sortArg,
  timestamps,
}: Args): SortArgs => {
  const sort =
    typeof sortArg === 'string'
      ? [sortArg]
      : sortArg
        ? [...sortArg]
        : [timestamps ? '-createdAt' : '-id']

  // We use this flag to determine if the sort is unique or not to decide whether to add a fallback sort.
  const isUniqueSort = sort.some((item) => {
    const field = getFieldByPath({ fields, path: item })
    return field?.field?.unique
  })

  // When sorting by a field that is not unique, the order of equal rows is not guaranteed.
  // So we add a fallback sort to ensure that the results are always in the same order.
  const fallbackSort = timestamps ? '-createdAt' : '-id'

  const includeFallbackSort =
    !adapter.disableFallbackSort &&
    !isUniqueSort &&
    !(sort.includes(fallbackSort) || sort.includes(fallbackSort.replace('-', '')))

  if (includeFallbackSort) {
    sort.push(fallbackSort)
  }

  const collate = collateClause(adapter.collation)

  // A repeated property keeps its first position but takes the last direction, like an object key.
  const sorting = new Map<string, SortArgs[number]>()

  for (const item of sort) {
    const direction: SortDirection = item.startsWith('-') ? 'desc' : 'asc'
    const sortProperty = item.startsWith('-') ? item.substring(1) : item

    if (sortProperty === 'id') {
      sorting.set('id', { aliased: false, collate, direction, expression: toIdiom('id') })
      continue
    }

    const { aliased, expression, path } = resolveSortKey({
      adapter,
      config,
      direction,
      fields,
      locale,
      parentIsLocalized,
      property: sortProperty,
    })
    sorting.set(path, { aliased, collate, direction, expression })
  }

  const result: SortArgs = [...sorting.values()]

  // `id` always ends the sort so that paging is deterministic even when createdAt ties. Its
  // direction follows the last key, so the default `-createdAt` reads newest first.
  const last = result.at(-1)

  if (last && !sorting.has('id')) {
    result.push({ aliased: false, collate, direction: last.direction, expression: toIdiom('id') })
  }

  return result
}

const SORT_KEY_PREFIX = '__sort'

const sortKeyName = (index: number): string => `${SORT_KEY_PREFIX}${index}`

/** The columns to add to the `SELECT` list, one alias per aliased sort key, so that `ORDER BY` can name them. */
export const sortKeyProjection = (sort: SortArgs): string =>
  sort
    .flatMap(({ aliased, expression }, index) =>
      aliased ? [`${expression} AS ${sortKeyName(index)}`] : [],
    )
    .map((column) => `, ${column}`)
    .join('')

/** Drops the aliases `sortKeyProjection` added from rows read back. */
export const removeSortKeys = (rows: Record<string, unknown>[]): void => {
  for (const row of rows) {
    for (const key of Object.keys(row)) {
      if (key.startsWith(SORT_KEY_PREFIX)) {
        delete row[key]
      }
    }
  }
}

/** The `ORDER BY`, which needs `sortKeyProjection` in the `SELECT` list it belongs to. */
export const toOrderByClause = (sort: SortArgs): string =>
  sort.length === 0
    ? ''
    : ` ORDER BY ${sort.map(({ aliased, collate, direction, expression }, index) => `${aliased ? sortKeyName(index) : expression}${collate} ${direction === 'asc' ? 'ASC' : 'DESC'}`).join(', ')}`
