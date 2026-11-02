import type { Operator } from 'payload'

import { APIError } from 'payload'
import { Geometry } from 'surrealdb'

import type { Fragment, ParamBag } from './sql.js'

import { dateCompare } from './datetime.js'
import { isNearValue, mongoDistance } from './geoValues.js'
import { and, or } from './sql.js'

export type OperatorContext = {
  /** `contains` matches whole values (relationship IDs, hasMany select) instead of substrings. */
  exactContains: boolean
  /** The field is an array: hasMany text/number/select/relationship/upload, or a polymorphic `.value` of one. */
  hasMany: boolean
  /** The escaped path of the field, or the list of every value the path reaches when `leaves` is set. */
  idiom: string
  /** `id` is a record ID, not a field: it is never missing, and `like` needs its key as a string. */
  isID: boolean
  /**
   * The `idiom` is the flat list of every leaf value of a path through arrays or json. A value
   * that is missing everywhere is an empty list, not a NONE.
   */
  leaves: boolean
  params: ParamBag
  /** Whether the empty string counts as a missing value for `exists`. */
  treatEmptyString: boolean
  val: unknown
}

type OperatorBuilder = (context: OperatorContext) => Fragment

// A path through arrays lists NONE for every element that lacks the value, which is not a value.
const leafCount = (values: string): string =>
  `array::len(array::filter(${values}, |$x| $x != NONE AND $x != NULL))`

// `f = NONE` alone would miss rows that hold NULL, and `f IS NONE` would miss NULL rows too.
const missing = ({ idiom, leaves }: Pick<OperatorContext, 'idiom' | 'leaves'>): Fragment =>
  leaves ? `${leafCount(idiom)} = 0` : `(${idiom} = NONE OR ${idiom} = NULL)`
const present = ({ idiom, leaves }: Pick<OperatorContext, 'idiom' | 'leaves'>): Fragment =>
  leaves ? `${leafCount(idiom)} > 0` : `(${idiom} != NONE AND ${idiom} != NULL)`

const toArray = (val: unknown): unknown[] => (Array.isArray(val) ? val : [val])

/** The SurrealQL type test that stands in for Mongo's type bracketing, chosen from the bound value. */
const typeGuard = (val: unknown): string => {
  if (typeof val === 'number') {
    return 'number'
  }
  if (typeof val === 'string') {
    return 'string'
  }
  if (typeof val === 'boolean') {
    return 'bool'
  }
  if (val instanceof Date) {
    return 'datetime'
  }
  if (typeof val === 'object' && val !== null && 'table' in val) {
    return 'record'
  }

  throw new APIError('Comparison operators need a number, string, boolean, date or ID value.', 400)
}

/**
 * Comparisons are guarded because SurrealDB orders NONE and NULL below every value, so a bare
 * `f < $v` would match missing fields, which Mongo's type bracketing does not.
 */
const comparison =
  (symbol: '<' | '<=' | '>' | '>='): OperatorBuilder =>
  ({ hasMany, idiom, isID, params, val }) => {
    // Mongo's `$gt: null` and `$lt: null` match nothing
    if (val === null && (symbol === '>' || symbol === '<')) {
      return 'false'
    }

    const guard = typeGuard(val)
    const bound = params.add(val)
    // A date is compared as nanoseconds, which the guard has already made safe
    const compare = (left: string): string =>
      val instanceof Date ? dateCompare(left, symbol, bound) : `${left} ${symbol} ${bound}`

    if (hasMany) {
      return `(${idiom} ?? []).any(|$x| type::is_${guard}($x) AND ${compare('$x')})`
    }

    // An ID is never missing, and its type is already fixed
    return isID ? compare(idiom) : `type::is_${guard}(${idiom}) AND ${compare(idiom)}`
  }

// Functions are guarded against NONE: `string::lowercase(NONE)` throws and one row would fail the query.
const containsWord = (
  { hasMany, idiom, isID, params }: OperatorContext,
  word: string,
): Fragment => {
  const bound = params.add(word.toLowerCase())

  if (isID) {
    return `string::contains(string::lowercase(<string> record::id(${idiom})), ${bound})`
  }

  if (hasMany) {
    return `(${idiom} ?? []).any(|$x| type::is_string($x) AND string::contains(string::lowercase($x), ${bound}))`
  }

  return `(type::is_string(${idiom}) AND string::contains(string::lowercase(${idiom}), ${bound}))`
}

/**
 * A geometry test on a point field. Through an array the field is a list of points, and a row
 * matches when any of them does. `INSIDE` and `INTERSECTS` are false for a missing value, but
 * `geo::distance` throws on one, so `near` guards with `type::is_point`.
 */
const geoMatch = ({ hasMany, idiom }: OperatorContext, test: (point: string) => Fragment) =>
  hasMany ? `(${idiom} ?? []).any(|$x| ${test('$x')})` : test(idiom)

const geoValue = <T>(isValue: (val: unknown) => val is T, name: string, val: unknown): T => {
  if (!isValue(val)) {
    throw new APIError(`The "${name}" operator was given a value it cannot use.`, 500)
  }

  return val
}

const isGeometry = (val: unknown): val is Geometry => val instanceof Geometry

const words = (val: unknown): string[] => String(val).split(' ')

export const operatorMap: Record<Operator, OperatorBuilder> = {
  all: ({ hasMany, idiom, params, val }) => {
    const bound = params.add(toArray(val))

    // `CONTAINSALL` on a string is substring matching. Mongo's `$all` on a scalar means every
    // listed value equals it, and an empty list matches nothing.
    return hasMany
      ? `${idiom} CONTAINSALL ${bound}`
      : `array::len(array::distinct(${bound})) = 1 AND ${idiom} IN ${bound}`
  },

  contains: (context) => {
    const { exactContains, hasMany, idiom, params, val } = context

    // Relationship IDs and hasMany select values are matched exactly, an array of them is ORed.
    if (exactContains) {
      if (hasMany) {
        return Array.isArray(val)
          ? `${idiom} CONTAINSANY ${params.add(val)}`
          : `${idiom} CONTAINS ${params.add(val)}`
      }

      return `${idiom} = ${params.add(val)}`
    }

    // Anything else is a substring: of any element for hasMany text/number, of the value otherwise.
    return or(toArray(val).map((each) => containsWord(context, String(each)))) ?? 'false'
  },

  equals: (context) => {
    const { hasMany, idiom, params, val } = context

    if (val === null) {
      return missing(context)
    }

    // An array value compares the whole array, a single value any element.
    return hasMany && !Array.isArray(val)
      ? `${idiom} CONTAINS ${params.add(val)}`
      : `${idiom} = ${params.add(val)}`
  },

  exists: (context) => {
    const { idiom, isID, treatEmptyString, val } = context

    if (isID) {
      return val ? `${idiom} != NONE` : `${idiom} = NONE`
    }

    return val
      ? `${present(context)}${treatEmptyString ? ` AND ${idiom} != ''` : ''}`
      : `${missing(context)}${treatEmptyString ? ` OR ${idiom} = ''` : ''}`
  },

  greater_than: comparison('>'),

  greater_than_equal: comparison('>='),

  in: (context) => {
    const { hasMany, idiom, params, val } = context
    const list = toArray(val)
    const rest = list.filter((each) => each !== null)
    const matches = hasMany
      ? `${idiom} CONTAINSANY ${params.add(rest)}`
      : `${idiom} IN ${params.add(rest)}`

    // `null` in the list means missing values match too
    return rest.length === list.length ? matches : `(${matches}) OR ${missing(context)}`
  },

  intersects: (context) => {
    const geometry = context.params.add(geoValue(isGeometry, 'intersects', context.val))

    return geoMatch(context, (point) => `${point} INTERSECTS ${geometry}`)
  },

  less_than: comparison('<'),

  less_than_equal: comparison('<='),

  like: (context) => and(words(context.val).map((word) => containsWord(context, word))) ?? 'true',

  near: (context) => {
    const { max, min, point } = geoValue(isNearValue, 'near', context.val)
    const bound = context.params.add(point)

    return geoMatch(context, (each) => {
      const distance = mongoDistance(each, bound)

      return [
        `type::is_point(${each})`,
        ...(max === undefined ? [] : [`${distance} <= ${context.params.add(max)}`]),
        ...(min === undefined ? [] : [`${distance} >= ${context.params.add(min)}`]),
      ].join(' AND ')
    })
  },

  // Plain `!=` keeps documents where the field is missing, as Mongo and Payload's tests expect.
  not_equals: (context) => {
    const { hasMany, idiom, params, val } = context

    if (val === null) {
      return present(context)
    }

    if (hasMany) {
      return Array.isArray(val)
        ? `${idiom} != ${params.add(val)}`
        : `${idiom} CONTAINSNOT ${params.add(val)}`
    }

    return Array.isArray(val)
      ? `${idiom} NOT IN ${params.add(val)}`
      : `${idiom} != ${params.add(val)}`
  },

  not_in: (context) => {
    const { hasMany, idiom, params, val } = context
    const list = toArray(val)
    const rest = list.filter((each) => each !== null)
    const matches = hasMany
      ? `${idiom} CONTAINSNONE ${params.add(rest)}`
      : `${idiom} NOT IN ${params.add(rest)}`

    return rest.length === list.length ? matches : `(${matches}) AND ${present(context)}`
  },

  // A missing field has no word in it, so it is not "like" anything.
  not_like: (context) =>
    and(words(context.val).map((word) => `!${containsWord(context, word)}`)) ?? 'true',

  within: (context) => {
    const geometry = context.params.add(geoValue(isGeometry, 'within', context.val))

    return geoMatch(context, (point) => `${point} INSIDE ${geometry}`)
  },
}
