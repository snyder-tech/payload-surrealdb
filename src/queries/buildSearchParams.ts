import type { FlattenedField, HasManyRelationshipOperator, Operator } from 'payload'

import { APIError, createArrayFromCommaDelineated, getLocalizedPaths } from 'payload'
import {
  fieldShouldBeLocalized,
  hasManyRelationshipOperatorSet,
  isNestedRelationshipQuery,
} from 'payload/shared'

import type { SurrealDBAdapter } from '../index.js'
import type { Fragment, ParamBag } from './sql.js'
import type { IDType } from '../utilities/recordId.js'

import { getCollection } from '../utilities/getEntity.js'
import { analyzePath } from './analyzePath.js'
import {
  buildHasManyRelationshipSearchParam,
  buildJoinContainsSearchParam,
  buildRelationshipPathSearchParam,
} from './buildRelationshipSearchParams.js'
import { leafValues } from './leafValues.js'
import { operatorMap } from './operatorMap.js'
import { sanitizeQueryValue } from './sanitizeQueryValue.js'
import { and, toIdiom } from './sql.js'

/**
 * Convert the Payload key / value / operator into a SurrealQL condition. Returns undefined when
 * the condition cannot be built (an invalid date, for example), in which case it is dropped.
 */
export function buildSearchParam({
  adapter,
  collectionSlug,
  fields,
  globalSlug,
  idTable,
  incomingPath,
  locale,
  operator,
  params,
  parentIsLocalized,
  val,
}: {
  adapter: SurrealDBAdapter
  collectionSlug?: string | undefined
  fields: FlattenedField[]
  globalSlug?: string | undefined
  idTable?: string | undefined
  incomingPath: string
  locale?: string | undefined
  operator: Operator
  params: ParamBag
  parentIsLocalized: boolean
  val: unknown
}): Fragment | undefined {
  // Replace GraphQL nested field double underscore formatting
  const sanitizedPath = incomingPath.replace(/__/g, '.')

  if (typeof val === 'undefined') {
    return undefined
  }

  if (sanitizedPath === 'id') {
    let customIDType: IDType | undefined
    let table: string

    if (idTable) {
      // A row outside the collection's own table, a version, has a generated key and no custom ID type
      table = idTable
    } else if (collectionSlug) {
      ;({ customIDType, table } = getCollection({ adapter, collectionSlug }))
    } else {
      throw new APIError('Querying by "id" needs a collection.')
    }

    const target = { customIDType, kind: 'id', table } as const
    const sanitized = sanitizeQueryValue({ adapter, operator, target, val })

    if (!sanitized) {
      return undefined
    }

    return operatorMap[sanitized.operator]({
      exactContains: false,
      hasMany: false,
      idiom: toIdiom('id'),
      isID: true,
      leaves: false,
      params,
      treatEmptyString: false,
      val: sanitized.val,
    })
  }

  const paths = getLocalizedPaths({
    ...(collectionSlug ? { collectionSlug } : {}),
    fields,
    ...(globalSlug ? { globalSlug } : {}),
    incomingPath: sanitizedPath,
    ...(locale ? { locale } : {}),
    parentIsLocalized,
    payload: adapter.payload,
  })

  if (!paths[0]) {
    return undefined
  }

  if (paths.length > 1) {
    return buildRelationshipPathSearchParam({
      adapter,
      fields,
      locale,
      operator,
      params,
      parentIsLocalized,
      paths,
      val,
    })
  }

  // Unknown paths come back without a field. Payload validates query paths before they get here,
  // but the database adapter can be called directly.
  if (!paths[0].field) {
    throw new APIError(
      `"${incomingPath}" is not a field of "${collectionSlug ?? globalSlug}".`,
      400,
    )
  }

  const [{ field, parentIsLocalized: pathIsLocalized, path: resolvedPath }] = paths
  let path = resolvedPath

  // `getLocalizedPaths` leaves the locale out of polymorphic relationship paths, but the value is
  // stored under it: `poly.value` lives at `poly.en.value`.
  if (
    (field.type === 'relationship' || field.type === 'upload') &&
    Array.isArray(field.relationTo) &&
    locale &&
    adapter.payload.config.localization &&
    fieldShouldBeLocalized({ field, parentIsLocalized: pathIsLocalized })
  ) {
    const segments = path.split('.')
    const suffix = ['relationTo', 'value'].includes(segments.at(-1) ?? '')
      ? segments.pop()
      : undefined

    if (!adapter.payload.config.localization.localeCodes.includes(segments.at(-1) ?? '')) {
      segments.push(locale)
    }

    path = [...segments, ...(suffix ? [suffix] : [])].join('.')
  }

  const analysis = analyzePath({ adapter, fields, parentIsLocalized, path: sanitizedPath })
  const hasMany = 'hasMany' in field && Boolean(field.hasMany)
  const idiom = toIdiom(path)
  // Through an array or into json, the path yields a list of values instead of one value
  const values =
    analysis.arrayLevels > 0 || analysis.inJson
      ? leafValues({ analysis, idiom, isList: hasMany })
      : undefined

  if (field.type === 'join') {
    if (
      operator === 'contains' &&
      typeof field.collection === 'string' &&
      isNestedRelationshipQuery(val)
    ) {
      return buildJoinContainsSearchParam({ adapter, field, locale, nestedWhere: val, params })
    }

    throw new APIError(
      `The join field "${field.name}" can only be queried with "contains" and a nested where.`,
      400,
    )
  }

  if (
    hasManyRelationshipOperatorSet.has(operator as HasManyRelationshipOperator) &&
    (field.type === 'relationship' || field.type === 'upload') &&
    field.hasMany &&
    typeof field.relationTo === 'string' &&
    isNestedRelationshipQuery(val)
  ) {
    return buildHasManyRelationshipSearchParam({
      adapter,
      field,
      locale,
      nestedWhere: val,
      operator: operator as HasManyRelationshipOperator,
      params,
      path,
      values: values ?? `(${idiom} ?? [])`,
    })
  }

  if (
    (operator === 'contains' || operator === 'like' || operator === 'not_like') &&
    (isNestedRelationshipQuery(val) ||
      (Array.isArray(val) && val.some((entry) => isNestedRelationshipQuery(entry))))
  ) {
    throw new APIError(`Invalid value for "${operator}" on path "${path}": expected a string.`, 400)
  }

  const isRelationship = field.type === 'relationship' || field.type === 'upload'

  // Each listed ID must be among the values, and a bare ID does not say which related collection it
  // belongs to, so every ID is its own `in` over that collection's candidates.
  if (operator === 'all' && isRelationship && Array.isArray(field.relationTo)) {
    const ids =
      typeof val === 'string'
        ? createArrayFromCommaDelineated(val)
        : Array.isArray(val)
          ? val
          : [val]
    const each = ids.map((id) =>
      buildSearchParam({
        adapter,
        collectionSlug,
        fields,
        globalSlug,
        idTable,
        incomingPath,
        locale,
        operator: 'in',
        params,
        parentIsLocalized,
        val: [id],
      }),
    )

    // `all` of no values matches nothing, as in Mongo
    return and(each.filter((fragment) => fragment !== undefined)) ?? 'false'
  }

  const sanitized = sanitizeQueryValue({
    adapter,
    operator,
    target: { field, kind: 'field', path },
    val,
  })

  if (!sanitized) {
    return undefined
  }

  return operatorMap[sanitized.operator]({
    // `contains` on a text field is a substring match, on these it is an exact value match
    exactContains: isRelationship || (field.type === 'select' && hasMany),
    hasMany: hasMany || values !== undefined,
    idiom: values ?? idiom,
    isID: false,
    leaves: values !== undefined,
    params,
    // An empty string counts as missing, except for fields that cannot hold one
    treatEmptyString:
      !hasMany &&
      !['array', 'blocks', 'checkbox', 'relationship', 'select', 'upload'].includes(field.type),
    val: sanitized.val,
  })
}
