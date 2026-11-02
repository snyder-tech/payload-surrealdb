import type {
  FlattenedField,
  HasManyRelationshipOperator,
  Operator,
  PathToQuery,
  Where,
} from 'payload'

import { APIError, getFieldByPath } from 'payload'

import type { SurrealDBAdapter } from '../index.js'
import type { Fragment, ParamBag } from './sql.js'

import { getCollection } from '../utilities/getEntity.js'
import { analyzePath } from './analyzePath.js'
import { buildQuery } from './buildQuery.js'
import { buildSearchParam } from './buildSearchParams.js'
import { leafValues } from './leafValues.js'
import { escapeIdent, toIdiom, whereClause } from './sql.js'

/**
 * A link to one document is checked against the IDs of the related documents that match, which the
 * request resolves first as a `LET`. Following the link in the `WHERE` (`author.name != 'x'`) would
 * also match documents that have no author. The `LET` is a statement of the same request, so it
 * reads what the request's transaction wrote, which Mongo's separate lookups cannot; without a
 * transaction it is not atomic with the statement that uses it.
 *
 * A list of links is filtered where it is instead: checking each link against a list of the
 * matching IDs takes time in proportion to the product of the two, and the list is every readable
 * document when the filter leaves most of them in.
 */

/** The condition that `where` puts on the documents of another collection. */
const nestedCondition = ({
  adapter,
  collectionSlug,
  locale,
  params,
  where,
}: {
  adapter: SurrealDBAdapter
  collectionSlug: string
  locale: string | undefined
  params: ParamBag
  where: Where
}): Fragment | null =>
  buildQuery({
    adapter,
    collectionSlug,
    fields: getCollection({ adapter, collectionSlug }).collectionConfig.flattenedFields,
    locale,
    params,
    where,
  })

/** The `$name` that holds the IDs of the documents of `collectionSlug` that match `condition`. */
const matchingIDs = ({
  adapter,
  collectionSlug,
  condition,
  params,
}: {
  adapter: SurrealDBAdapter
  collectionSlug: string
  condition: Fragment | null
  params: ParamBag
}): string =>
  params.define(
    `SELECT VALUE id FROM ${escapeIdent(getCollection({ adapter, collectionSlug }).table)}${whereClause(condition)}`,
  )

/**
 * The links of `values` that point to an existing document that satisfies `condition`. The
 * condition is read through each link. A link whose document is gone reads as `NONE`, which a
 * negative condition would match, so it is left out first.
 */
const matchingLinks = (values: string, condition: Fragment | null): string =>
  `(${values})[WHERE id != NONE${condition ? ` AND (${condition})` : ''}]`

/**
 * The `$name` that holds the documents a join field points back to: the values of the `on`
 * relationship of every joined document that matches `condition`.
 */
const matchingJoinParents = ({
  adapter,
  condition,
  field,
  locale,
  params,
}: {
  adapter: SurrealDBAdapter
  condition: Fragment | null
  field: { collection: string | string[]; on: string }
  locale: string | undefined
  params: ParamBag
}): string => {
  if (typeof field.collection !== 'string') {
    throw new APIError('Querying through a join to several collections is not supported.')
  }

  const { collectionConfig, table } = getCollection({ adapter, collectionSlug: field.collection })
  const on = getFieldByPath({ fields: collectionConfig.flattenedFields, path: field.on })

  if (!on) {
    throw new APIError('Relationship field was not found')
  }

  const { localization } = adapter.payload.config
  let path = on.localizedPath

  if (on.pathHasLocalized && localization) {
    path = path.replace(
      '<locale>',
      locale && locale !== 'all' ? locale : localization.defaultLocale,
    )
  }

  const idiom = toIdiom(path)
  const values = leafValues({
    analysis: analyzePath({
      adapter,
      fields: collectionConfig.flattenedFields,
      parentIsLocalized: false,
      path,
    }),
    idiom,
    isList: 'hasMany' in on.field && Boolean(on.field.hasMany),
  })
  const from = `FROM ${escapeIdent(table)}${whereClause(condition)}`

  // A hasMany `on` selects a list per joined document, and the parents are the elements of them all
  return params.define(
    values ? `array::flatten((SELECT VALUE ${values} ${from}))` : `SELECT VALUE ${idiom} ${from}`,
  )
}

/**
 * A path through relationships, such as `author.manager.name`: each hop becomes the IDs of the
 * documents that match the hop after it, from the last field back to this collection.
 */
export const buildRelationshipPathSearchParam = ({
  adapter,
  fields,
  locale,
  operator,
  params,
  parentIsLocalized,
  paths,
  val,
}: {
  adapter: SurrealDBAdapter
  fields: FlattenedField[]
  locale: string | undefined
  operator: Operator
  params: ParamBag
  parentIsLocalized: boolean
  paths: PathToQuery[]
  val: unknown
}): Fragment | undefined => {
  const leaf = paths.at(-1)

  if (!leaf?.collectionSlug) {
    throw new APIError('Collection with the slug of the queried relationship was not found.')
  }

  let condition = buildSearchParam({
    adapter,
    collectionSlug: leaf.collectionSlug,
    fields: getCollection({ adapter, collectionSlug: leaf.collectionSlug }).collectionConfig
      .flattenedFields,
    incomingPath: leaf.path,
    locale,
    operator,
    params,
    parentIsLocalized: false,
    val,
  })

  for (let i = paths.length - 2; i >= 0; i--) {
    const hop = paths[i]
    const next = paths[i + 1]

    // The last field cannot be built, for an invalid date for instance, which drops the condition
    if (condition === undefined) {
      return undefined
    }

    if (!hop || !next?.collectionSlug) {
      throw new APIError('Collection with the slug of the queried relationship was not found.')
    }

    if (hop.field.type === 'join') {
      const parents = matchingJoinParents({
        adapter,
        condition,
        field: hop.field,
        locale,
        params,
      })

      condition = `id IN ${parents}`
      continue
    }

    const hopFields =
      i === 0 || !hop.collectionSlug
        ? fields
        : getCollection({ adapter, collectionSlug: hop.collectionSlug }).collectionConfig
            .flattenedFields
    const idiom = toIdiom(hop.path)
    const values = leafValues({
      analysis: analyzePath({
        adapter,
        fields: hopFields,
        parentIsLocalized: i === 0 ? parentIsLocalized : false,
        path: hop.path,
      }),
      idiom,
      isList: 'hasMany' in hop.field && Boolean(hop.field.hasMany),
    })

    condition = values
      ? `array::len(${matchingLinks(values, condition)}) > 0`
      : `${idiom} IN ${matchingIDs({ adapter, collectionSlug: next.collectionSlug, condition, params })}`
  }

  return condition
}

/**
 * `contains`, `equals` and `not_equals` on a hasMany relationship with a nested `where` as the
 * value, which is how access control filters a list of related documents.
 */
export const buildHasManyRelationshipSearchParam = ({
  adapter,
  field,
  locale,
  nestedWhere,
  operator,
  params,
  path,
  values,
}: {
  adapter: SurrealDBAdapter
  field: { relationTo: string | string[] }
  locale: string | undefined
  nestedWhere: Where
  operator: HasManyRelationshipOperator
  params: ParamBag
  path: string
  /** The list of the related IDs of the document, however deep in arrays the field sits. */
  values: string
}): Fragment => {
  if (typeof field.relationTo !== 'string') {
    throw new APIError('Nested queries need a relationship to a single collection.')
  }

  const pathLocale = adapter.payload.config.localization
    ? adapter.payload.config.localization.localeCodes.find(
        (localeCode) => path.split('.').at(-1) === localeCode,
      )
    : undefined
  const condition = nestedCondition({
    adapter,
    collectionSlug: field.relationTo,
    locale: pathLocale ?? locale,
    params,
    where: nestedWhere,
  })

  // Every related document satisfies an empty nested query
  if (operator === 'equals' && condition === null) {
    return 'true'
  }

  const matching = `array::len(${matchingLinks(values, condition)})`

  switch (operator) {
    case 'contains':
      return `${matching} > 0`
    case 'equals':
      // Every link matches, which an empty list or a missing one does too
      return `${matching} = array::len(${values})`
    case 'not_equals':
      return `${matching} = 0`
  }
}

/**
 * `contains` on a join field with a nested `where`: the documents that a joined document, one that
 * satisfies both the user's filter and any access constraint, points back to.
 */
export const buildJoinContainsSearchParam = ({
  adapter,
  field,
  locale,
  nestedWhere,
  params,
}: {
  adapter: SurrealDBAdapter
  field: { collection: string | string[]; on: string }
  locale: string | undefined
  nestedWhere: Where
  params: ParamBag
}): Fragment => {
  if (typeof field.collection !== 'string') {
    throw new APIError('Querying through a join to several collections is not supported.')
  }

  const condition = nestedCondition({
    adapter,
    collectionSlug: field.collection,
    locale,
    params,
    where: nestedWhere,
  })

  return `id IN ${matchingJoinParents({ adapter, condition, field, locale, params })}`
}
