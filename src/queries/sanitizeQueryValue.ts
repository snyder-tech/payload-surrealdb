import type { FlattenedField, Operator, RelationshipField, UploadField } from 'payload'

import { APIError, createArrayFromCommaDelineated } from 'payload'

import type { SurrealDBAdapter } from '../index.js'
import type { IDType } from '../utilities/recordId.js'

import { toRecordId } from '../utilities/recordId.js'
import { parseGeometry, parseNear } from './geoValues.js'

export type QueryTarget =
  | { customIDType: IDType | undefined; kind: 'id'; table: string }
  | { field: FlattenedField; kind: 'field'; path: string }

type SanitizeQueryValueArgs = {
  adapter: SurrealDBAdapter
  operator: Operator
  target: QueryTarget
  val: unknown
}

export type SanitizedQueryValue = {
  operator: Operator
  /** Typed for binding: Date, RecordId, Geometry, number, boolean, string, or arrays and objects of them. A `near` is a `NearValue`, whose parts are bound separately. */
  val: unknown
}

const listOperators: Operator[] = ['all', 'in', 'not_in']

const toList = (val: unknown): unknown[] => {
  if (typeof val === 'string') {
    return createArrayFromCommaDelineated(val)
  }

  return Array.isArray(val) ? val : [val]
}

// A value that can never be a valid ID matches nothing, which `in []` / `not_in []` express exactly.
const noMatch = (operator: Operator): SanitizedQueryValue =>
  operator === 'not_equals' ? { operator: 'not_in', val: [] } : { operator: 'in', val: [] }

const sanitizeIDValue = ({
  customIDType,
  operator,
  table,
  val,
}: {
  customIDType: IDType | undefined
  operator: Operator
  table: string
  val: unknown
}): SanitizedQueryValue => {
  if (listOperators.includes(operator)) {
    const ids = toList(val).flatMap((each) => toRecordId(table, each, customIDType) ?? [])

    return { operator, val: ids }
  }

  // Substring matching works on the key as text, and `exists` on the row itself.
  if (operator === 'like' || operator === 'not_like' || operator === 'contains') {
    return { operator, val }
  }

  if (operator === 'exists') {
    return { operator, val: val === true || val === 'true' }
  }

  const recordId = toRecordId(table, val, customIDType)

  return recordId ? { operator, val: recordId } : noMatch(operator)
}

const sanitizeRelationshipValue = ({
  adapter,
  field,
  operator,
  path,
  val,
}: {
  adapter: SurrealDBAdapter
  field: RelationshipField | UploadField
  operator: Operator
  path: string
  val: unknown
}): SanitizedQueryValue => {
  const slugs = Array.isArray(field.relationTo) ? field.relationTo : [field.relationTo]
  const isPolymorphic = Array.isArray(field.relationTo)

  // The `relationTo` of a polymorphic relationship is a plain string, not an ID.
  if (isPolymorphic && path.endsWith('.relationTo')) {
    return { operator, val }
  }

  /** One candidate per related collection, because a bare ID does not say which one it belongs to. */
  const toCandidates = (value: unknown) =>
    slugs.flatMap((slug) => {
      const meta = adapter.collections[slug]

      if (!meta) {
        throw new APIError(`Collection with the slug "${slug}" was not found.`)
      }

      return toRecordId(meta.table, value, adapter.payload.collections[slug]?.customIDType) ?? []
    })

  if (listOperators.includes(operator)) {
    // `null` stays in the list: it is what makes `in` and `not_in` look at missing values
    return {
      operator,
      val: toList(val).flatMap((each) => (each === null ? [null] : toCandidates(each))),
    }
  }

  if (
    operator !== 'equals' &&
    operator !== 'not_equals' &&
    operator !== 'contains' &&
    operator !== 'like'
  ) {
    return { operator, val }
  }

  // `{ relationTo, value }`: matched as a whole object, which ignores key order.
  if (isPolymorphic && typeof val === 'object' && val !== null && 'relationTo' in val) {
    const relationTo = val.relationTo
    const value = 'value' in val ? val.value : undefined
    const meta = typeof relationTo === 'string' ? adapter.collections[relationTo] : undefined
    const recordId = meta
      ? toRecordId(meta.table, value, adapter.payload.collections[String(relationTo)]?.customIDType)
      : undefined

    return recordId ? { operator, val: { relationTo, value: recordId } } : noMatch(operator)
  }

  // An array compares the whole hasMany array, in order.
  if (Array.isArray(val)) {
    return {
      operator,
      val: val.map((each) => {
        if (isPolymorphic && typeof each === 'object' && each !== null && 'relationTo' in each) {
          const meta =
            typeof each.relationTo === 'string' ? adapter.collections[each.relationTo] : undefined
          const recordId = meta
            ? toRecordId(
                meta.table,
                'value' in each ? each.value : undefined,
                adapter.payload.collections[String(each.relationTo)]?.customIDType,
              )
            : undefined

          return recordId ? { relationTo: each.relationTo, value: recordId } : each
        }

        return toCandidates(each)[0] ?? each
      }),
    }
  }

  // `null` means "no relationship", which the string 'null' also spells in a REST query.
  if (val === null || val === 'null') {
    return { operator, val: null }
  }

  const candidates = toCandidates(val)

  if (isPolymorphic) {
    return { operator: operator === 'not_equals' ? 'not_in' : 'in', val: candidates }
  }

  const [recordId] = candidates

  // A link is not text, so `like` on one is an exact match of the ID, which is how Mongo reads it too
  return recordId
    ? { operator: operator === 'like' ? 'equals' : operator, val: recordId }
    : noMatch(operator)
}

/**
 * Casts the incoming value to the type the field is stored as, because SurrealDB compares by type:
 * an ISO string never equals a datetime and a bare ID never equals a record link. Returns
 * undefined when the condition cannot be built, in which case it is dropped, as Mongo does.
 */
export const sanitizeQueryValue = ({
  adapter,
  operator,
  target,
  val,
}: SanitizeQueryValueArgs): SanitizedQueryValue | undefined => {
  if (target.kind === 'id') {
    return sanitizeIDValue({
      customIDType: target.customIDType,
      operator,
      table: target.table,
      val,
    })
  }

  const { field, path } = target

  if (operator === 'exists') {
    return { operator, val: val === true || val === 'true' }
  }

  if (operator === 'near') {
    const near = parseNear(val)

    return near ? { operator, val: near } : undefined
  }

  if (operator === 'within' || operator === 'intersects') {
    return { operator, val: parseGeometry(operator, val) }
  }

  if (field.type === 'relationship' || field.type === 'upload') {
    return sanitizeRelationshipValue({ adapter, field, operator, path, val })
  }

  let formattedValue = val

  if (field.type === 'checkbox' && typeof val === 'string') {
    if (val.toLowerCase() === 'true') {
      formattedValue = true
    }
    if (val.toLowerCase() === 'false') {
      formattedValue = false
    }
  }

  if (listOperators.includes(operator) && typeof formattedValue === 'string') {
    formattedValue = createArrayFromCommaDelineated(formattedValue)
  }

  const convert = (each: unknown): unknown => {
    if (field.type === 'number' && typeof each === 'string') {
      return Number(each)
    }

    if (field.type === 'date' && typeof each === 'string') {
      return new Date(each)
    }

    return each
  }

  formattedValue = Array.isArray(formattedValue)
    ? formattedValue.map(convert)
    : convert(formattedValue)

  // An invalid date drops the condition
  const hasInvalidDate = (Array.isArray(formattedValue) ? formattedValue : [formattedValue]).some(
    (each) => each instanceof Date && Number.isNaN(each.getTime()),
  )

  if (hasInvalidDate) {
    return undefined
  }

  return { operator, val: formattedValue }
}
