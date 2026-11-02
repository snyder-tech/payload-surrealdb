import type { FlattenedField, Where } from 'payload'

import { getLocalizedPaths } from 'payload'

import type { SurrealDBAdapter } from '../index.js'
import type { SortArgs } from './buildSortParam.js'
import type { ParamBag } from './sql.js'

import { analyzePath } from './analyzePath.js'
import { mongoDistance, parseNear } from './geoValues.js'
import { toIdiom } from './sql.js'

/** The first `near` condition of `where`, at its top level or inside `and` and `or` at any depth. */
const findNear = (where: Where): { path: string; val: unknown } | undefined => {
  for (const [key, value] of Object.entries(where)) {
    if (Array.isArray(value) && ['and', 'or'].includes(key.toLowerCase())) {
      for (const nested of value) {
        const found = findNear(nested)

        if (found) {
          return found
        }
      }
    } else if (typeof value === 'object' && value !== null && 'near' in value) {
      return { path: key, val: value.near }
    }
  }

  return undefined
}

/**
 * The nearest-first order that Mongo's `$near` gives a query: it replaces any other sort, so
 * `sort` and a collection's `defaultSort` do not apply to a query with a `near` condition. Undefined
 * when `where` has none, or when the distance cannot be taken from the document itself: a point
 * on a related document, or inside an array.
 */
export const buildNearSort = ({
  adapter,
  collectionSlug,
  fields,
  locale,
  params,
  where,
}: {
  adapter: SurrealDBAdapter
  collectionSlug?: string | undefined
  fields: FlattenedField[]
  locale?: string | undefined
  params: ParamBag
  where: Where
}): SortArgs | undefined => {
  const near = findNear(where)
  const nearValue = near ? parseNear(near.val) : undefined

  if (!near || !nearValue) {
    return undefined
  }

  // The GraphQL spelling of a nested path
  const incomingPath = near.path.replace(/__/g, '.')
  const paths = getLocalizedPaths({
    ...(collectionSlug ? { collectionSlug } : {}),
    fields,
    incomingPath,
    ...(locale ? { locale } : {}),
    parentIsLocalized: false,
    payload: adapter.payload,
  })
  const [resolved] = paths

  if (paths.length !== 1 || resolved?.field?.type !== 'point') {
    return undefined
  }

  const { arrayLevels } = analyzePath({
    adapter,
    fields,
    parentIsLocalized: false,
    path: incomingPath,
  })

  if (arrayLevels > 0) {
    return undefined
  }

  const idiom = toIdiom(resolved.path)
  // A row without a point can only get here through an `or`, and sorts after every row with one
  const distance = `IF type::is_point(${idiom}) { ${mongoDistance(idiom, params.add(nearValue.point))} } ELSE { math::inf }`

  return [
    { aliased: true, collate: '', direction: 'asc', expression: distance },
    { aliased: false, collate: '', direction: 'asc', expression: toIdiom('id') },
  ]
}
