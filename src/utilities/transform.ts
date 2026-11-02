import type {
  DateField,
  Field,
  FieldAffectingData,
  FlattenedBlock,
  FlattenedField,
  NumberField,
  PointField,
  RelationshipField,
  SanitizedConfig,
  TraverseFieldsCallback,
  UploadField,
} from 'payload'

import { APIError, flattenAllFields, traverseFields } from 'payload'
import { fieldAffectsData, fieldShouldBeLocalized } from 'payload/shared'
import { GeometryPoint } from 'surrealdb'

import type { SurrealDBAdapter } from '../index.js'

import { fromRecordId, isRecordId, toRecordId } from './recordId.js'

type Row = Record<string, unknown>

const isRow = (value: unknown): value is Row =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

interface RelationObject {
  relationTo: string
  value: unknown
}

const isValidRelationObject = (value: unknown): value is RelationObject =>
  isRow(value) &&
  'relationTo' in value &&
  'value' in value &&
  typeof value['relationTo'] === 'string'

/**
 * Atomic changes pulled out of the data on write. Each key is a dotted field path (localized
 * fields get a trailing locale segment) and `updateOne` turns them into `+=`, `array::concat`,
 * `array::union` and `array::complement` clauses.
 */
export type AtomicOperations = {
  $addToSet: Record<string, unknown[]>
  $inc: Record<string, number>
  $pull: Record<string, unknown[]>
  $push: Record<string, unknown[]>
}

export const createAtomicOperations = (): AtomicOperations => ({
  $addToSet: {},
  $inc: {},
  $pull: {},
  $push: {},
})

type Args = {
  /** Collects atomic changes when `operation` is `write` and the caller can apply them. */
  atomic?: AtomicOperations | undefined
  /** instance of the adapter */
  adapter: SurrealDBAdapter
  /** data to transform in place, can be an array of documents or a single document */
  data: Row | Row[]
  /** fields associated with the data */
  fields: Field[]
  /** The slug of the global the data belongs to. A global's row carries it as `globalType`, which Payload reads back. */
  globalSlug?: string | undefined
  /**
   * Type of the operation
   * read - turns RecordIds into bare IDs and dates into ISO strings.
   * write - turns ISO strings into dates, IDs into RecordIds, and drops keys Payload does not know.
   */
  operation: 'read' | 'write'
  parentIsLocalized?: boolean | undefined
  /**
   * Throw errors on invalid relationships
   * @default true
   */
  validateRelationships?: boolean
}

const convertRelationshipValue = ({
  adapter,
  operation,
  relationTo,
  validateRelationships,
  value,
}: {
  adapter: SurrealDBAdapter
  operation: Args['operation']
  relationTo: string
  validateRelationships: boolean
  value: unknown
}): unknown => {
  if (operation === 'read') {
    return isRecordId(value) ? fromRecordId(value) : value
  }

  if (typeof value !== 'string' && typeof value !== 'number') {
    return value
  }

  const meta = adapter.collections[relationTo]

  if (!meta) {
    return value
  }

  const recordId = toRecordId(
    meta.table,
    value,
    adapter.payload.collections[relationTo]?.customIDType,
  )

  if (!recordId) {
    if (validateRelationships) {
      throw new APIError(
        `Invalid ID ${JSON.stringify(value)} for relationship to "${relationTo}".`,
        400,
      )
    }

    return value
  }

  return recordId
}

/** Converts a relationship or upload value: single, hasMany, polymorphic, or a mix of them. */
const sanitizeRelationship = ({
  adapter,
  field,
  operation,
  validateRelationships,
  value,
}: {
  adapter: SurrealDBAdapter
  field: RelationshipField | UploadField
  operation: Args['operation']
  validateRelationships: boolean
  value: unknown
}): unknown => {
  const convert = (item: unknown): unknown => {
    // Skip null/undefined entries so a stray null in a hasMany relationship array isn't coerced.
    if (item === null || typeof item === 'undefined') {
      return item
    }

    if (isValidRelationObject(item)) {
      return {
        relationTo: item.relationTo,
        value: convertRelationshipValue({
          adapter,
          operation,
          relationTo: item.relationTo,
          validateRelationships,
          value: item.value,
        }),
      }
    }

    if (typeof field.relationTo === 'string') {
      return convertRelationshipValue({
        adapter,
        operation,
        relationTo: field.relationTo,
        validateRelationships,
        value: item,
      })
    }

    return item
  }

  if (Array.isArray(value)) {
    return value.map(convert)
  }

  // A single ID or `{ relationTo, value }` given for a hasMany field is stored as a list of one, as Mongoose casts it
  if (field.hasMany && operation === 'write' && value !== null && value !== undefined) {
    return [convert(value)]
  }

  return convert(value)
}

const convertDate = ({
  field,
  operation,
  value,
}: {
  field: DateField
  operation: Args['operation']
  value: unknown
}): unknown => {
  if (operation === 'read') {
    return value instanceof Date ? value.toISOString() : value
  }

  // An ISO string or a Unix timestamp in milliseconds
  if (typeof value !== 'string' && typeof value !== 'number') {
    return value
  }

  const date = new Date(value)

  if (Number.isNaN(date.getTime())) {
    throw new APIError(`Invalid date ${JSON.stringify(value)} for field "${field.name}".`, 400)
  }

  return date
}

/**
 * Payload's `beforeChange` hands over a point as GeoJSON, and its `afterRead` reads `coordinates`
 * back out of GeoJSON, as stored by Mongo. SurrealDB only treats a geometry value as a point, so
 * it is stored as one and read back as the GeoJSON object.
 */
const convertPoint = ({
  field,
  operation,
  value,
}: {
  field: PointField
  operation: Args['operation']
  value: unknown
}): unknown => {
  if (operation === 'read') {
    return value instanceof GeometryPoint ? value.toJSON() : value
  }

  const coordinates = isRow(value) && value['type'] === 'Point' ? value['coordinates'] : undefined

  if (
    !Array.isArray(coordinates) ||
    coordinates.length !== 2 ||
    !coordinates.every((each) => typeof each === 'number' && Number.isFinite(each))
  ) {
    throw new APIError(
      `Invalid point ${JSON.stringify(value)} for field "${field.name}": expected GeoJSON with a numeric longitude and latitude.`,
      400,
    )
  }

  return new GeometryPoint([coordinates[0], coordinates[1]])
}

// SCHEMALESS tables cast nothing, so the casts Mongoose did for Mongo happen here: Payload hands
// the adapter a number for a text field, or a numeric string for a number field, and expects the
// field's own type back.
const castText = (value: unknown): unknown =>
  typeof value === 'number' || typeof value === 'boolean' ? String(value) : value

const castNumber = ({ field, value }: { field: NumberField; value: unknown }): unknown => {
  if (typeof value !== 'string') {
    return value
  }

  const number = value.trim() === '' ? NaN : Number(value)

  if (Number.isNaN(number)) {
    throw new APIError(
      `Cannot cast ${JSON.stringify(value)} to a number for field "${field.name}".`,
      400,
    )
  }

  return number
}

const textTypes: string[] = ['code', 'email', 'radio', 'select', 'slug', 'text', 'textarea']

const stripRows = ({
  config,
  field,
  parentIsLocalized,
  reservedKeys,
  rows,
  stripVirtual,
}: {
  config: SanitizedConfig
  field: FlattenedField & ({ flattenedFields: FlattenedField[] } | { blocks: unknown[] })
  parentIsLocalized: boolean
  reservedKeys: string[]
  rows: unknown[]
  stripVirtual: boolean
}): unknown[] => {
  const kept: unknown[] = []

  for (const row of rows) {
    if (!isRow(row)) {
      continue
    }

    let fields: FlattenedField[] | undefined

    if (field.type === 'array') {
      fields = field.flattenedFields
    } else if (field.type === 'blocks') {
      const blockOrSlug = field.blocks.find((each) => {
        const slug = typeof each === 'string' ? each : each.slug
        return slug === row['blockType']
      })
      const block: FlattenedBlock | undefined =
        typeof blockOrSlug === 'string'
          ? config.blocks?.find((each) => each.slug === blockOrSlug)
          : blockOrSlug

      fields = block?.flattenedFields
    }

    // A row of an unknown block type cannot be read back by Payload, so it is dropped.
    if (!fields) {
      continue
    }

    stripFields({ config, data: row, fields, parentIsLocalized, reservedKeys, stripVirtual })
    kept.push(row)
  }

  return kept
}

const isVirtual = (field: FlattenedField): boolean => 'virtual' in field && Boolean(field.virtual)

/**
 * Removes every key that is not a field of the entity, recursing through groups, arrays and
 * blocks. Virtual fields are computed on read and never stored, so they are dropped on write.
 */
const stripFields = ({
  config,
  data,
  fields,
  parentIsLocalized = false,
  reservedKeys = [],
  stripVirtual = false,
}: {
  config: SanitizedConfig
  data: Row
  fields: FlattenedField[]
  parentIsLocalized?: boolean
  reservedKeys?: string[]
  stripVirtual?: boolean
}): void => {
  for (const key of Object.keys(data)) {
    const known = fields.some((field) => field.name === key && !(stripVirtual && isVirtual(field)))

    if (!known && !reservedKeys.includes(key)) {
      delete data[key]
    }
  }

  for (const field of fields) {
    const fieldData = data[field.name]

    if (!fieldData || typeof fieldData !== 'object') {
      continue
    }

    if (!('flattenedFields' in field) && !('blocks' in field)) {
      continue
    }

    const childReservedKeys = field.type === 'blocks' ? ['blockType'] : []
    const childIsLocalized = parentIsLocalized || Boolean(field.localized)

    const stripValue = (value: unknown): unknown => {
      if (field.type === 'array' || field.type === 'blocks') {
        return Array.isArray(value)
          ? stripRows({
              config,
              field,
              parentIsLocalized: childIsLocalized,
              reservedKeys: childReservedKeys,
              rows: value,
              stripVirtual,
            })
          : value
      }

      if (isRow(value) && 'flattenedFields' in field) {
        stripFields({
          config,
          data: value,
          fields: field.flattenedFields,
          parentIsLocalized: childIsLocalized,
          reservedKeys: childReservedKeys,
          stripVirtual,
        })
      }

      return value
    }

    if (fieldShouldBeLocalized({ field, parentIsLocalized }) && config.localization) {
      const localized = fieldData as Row

      for (const localeKey of Object.keys(localized)) {
        if (!config.localization.localeCodes.some((code) => code === localeKey)) {
          delete localized[localeKey]
          continue
        }

        localized[localeKey] = stripValue(localized[localeKey])
      }

      continue
    }

    data[field.name] = stripValue(fieldData)
  }
}

/** Finds `{ [key]: value }` inside a field's value, or inside each locale of a localized field. */
const findOperations = ({
  config,
  field,
  key,
  name,
  parentIsLocalized,
  ref,
}: {
  config: SanitizedConfig
  field: FieldAffectingData
  key: '$inc' | '$push' | '$remove'
  name: string
  parentIsLocalized: boolean
  ref: Row
}): { locale?: string; value: unknown }[] => {
  const value = ref[name]

  if (!isRow(value)) {
    return []
  }

  if (config.localization && fieldShouldBeLocalized({ field, parentIsLocalized })) {
    return Object.entries(value).flatMap(([locale, localeValue]) =>
      isRow(localeValue) && key in localeValue ? [{ locale, value: localeValue[key] }] : [],
    )
  }

  return key in value ? [{ value: value[key] }] : []
}

const toItems = (value: unknown): unknown[] => (Array.isArray(value) ? value : [value])

const sanitizeData = ({
  adapter,
  atomic,
  data,
  fields,
  operation,
  parentIsLocalized: rootIsLocalized,
  validateRelationships,
}: Required<Pick<Args, 'adapter' | 'fields' | 'operation' | 'validateRelationships'>> &
  Pick<Args, 'atomic' | 'parentIsLocalized'> & { data: Row }): void => {
  const { config } = adapter.payload

  const sanitize: TraverseFieldsCallback = ({
    field,
    parentIsLocalized,
    parentPath,
    parentRef: incomingParentRef,
    ref: incomingRef,
  }) => {
    if (!isRow(incomingRef) || !fieldAffectsData(field) || !field.name) {
      return
    }

    const { name } = field

    const ref = incomingRef
    const parentRef = isRow(incomingParentRef) ? incomingParentRef : {}
    const isLocalized =
      Boolean(config.localization) && fieldShouldBeLocalized({ field, parentIsLocalized })
    const pathOf = (locale?: string) => `${parentPath}${name}${locale ? `.${locale}` : ''}`

    // Clear empty parent containers by setting them to undefined.
    const clearEmptyContainer = () => {
      if (Object.keys(ref).length > 0) {
        return
      }

      const containerKey = Object.keys(parentRef).find((k) => parentRef[k] === ref)

      if (containerKey) {
        parentRef[containerKey] = undefined
      }
    }

    /** Moves each operation found on the field out of the data and into `take`. */
    const extract = (
      key: '$inc' | '$push' | '$remove',
      take: (path: string, value: unknown) => void,
    ): void => {
      const found = findOperations({ config, field, key, name, parentIsLocalized, ref })

      if (found.length === 0) {
        return
      }

      for (const { locale, value } of found) {
        take(pathOf(locale), value)
      }

      delete ref[name]
      clearEmptyContainer()
    }

    if (atomic && operation === 'write') {
      if (field.type === 'number') {
        extract('$inc', (path, value) => {
          if (typeof value === 'number') {
            atomic.$inc[path] = value
          }
        })
      }

      if (field.type === 'array') {
        extract('$push', (path, value) => {
          const rows = toItems(value)

          for (const row of rows) {
            if (isRow(row)) {
              sanitizeData({
                adapter,
                data: row,
                fields: field.fields,
                operation,
                parentIsLocalized: isLocalized || parentIsLocalized,
                validateRelationships,
              })
            }
          }

          atomic.$push[path] = rows
        })
      }

      if ((field.type === 'relationship' || field.type === 'upload') && field.hasMany) {
        // A relationship `$push` must not add an ID that is already there, so it becomes a union.
        extract('$push', (path, value) => {
          atomic.$addToSet[path] = toItems(
            sanitizeRelationship({
              adapter,
              field,
              operation,
              validateRelationships,
              value: toItems(value),
            }),
          )
        })

        extract('$remove', (path, value) => {
          atomic.$pull[path] = toItems(
            sanitizeRelationship({
              adapter,
              field,
              operation,
              validateRelationships,
              value: toItems(value),
            }),
          )
        })
      }
    }

    const convert = (value: unknown): unknown => {
      if (field.type === 'date') {
        return convertDate({ field, operation, value })
      }

      if (field.type === 'relationship' || field.type === 'upload') {
        return sanitizeRelationship({ adapter, field, operation, validateRelationships, value })
      }

      if (field.type === 'point') {
        return convertPoint({ field, operation, value })
      }

      if (operation === 'read') {
        return value
      }

      // hasMany text, select and number hold arrays
      const castEach = (cast: (each: unknown) => unknown) =>
        Array.isArray(value) ? value.map(cast) : cast(value)

      if (field.type === 'number') {
        return castEach((each) => castNumber({ field, value: each }))
      }

      return textTypes.includes(field.type) ? castEach(castText) : value
    }

    if (!ref[name]) {
      return
    }

    if (isLocalized) {
      const localized = ref[name]

      if (!isRow(localized)) {
        return
      }

      for (const { code } of config.localization ? config.localization.locales : []) {
        if (localized[code]) {
          localized[code] = convert(localized[code])
        }
      }
    } else {
      ref[name] = convert(ref[name])
    }
  }

  traverseFields({
    callback: sanitize,
    config,
    fields,
    fillEmpty: false,
    parentIsLocalized: rootIsLocalized ?? false,
    ref: data,
  })
}

/**
 * Payload's low-level update also names a nested field by its dotted path, as in
 * `{ 'group.tags': { $push } }`. The key is read as if the value sat inside its parents, so that
 * the atomic operations are pulled out as for any other field. A value that is left is written
 * back under the key, and a key that held nothing but operations is dropped.
 */
const extractDottedOperations = (
  args: Parameters<typeof sanitizeData>[0] & { atomic: AtomicOperations },
): void => {
  const { data } = args

  for (const key of Object.keys(data)) {
    const segments = key.split('.')
    const leaf = segments.pop()

    if (segments.length === 0 || leaf === undefined) {
      continue
    }

    const nested: Row = {}
    let container = nested

    for (const segment of segments) {
      const child: Row = {}
      container[segment] = child
      container = child
    }

    container[leaf] = data[key]
    sanitizeData({ ...args, data: nested })

    let parent: unknown = nested

    for (const segment of segments) {
      parent = isRow(parent) ? parent[segment] : undefined
    }

    if (isRow(parent) && leaf in parent) {
      data[key] = parent[leaf]
    } else {
      delete data[key]
    }
  }
}

/**
 * A function that transforms Payload <-> SurrealDB data, in place.
 * @internal - this function may be removed or receive breaking changes in minor releases.
 */
export const transform = ({
  adapter,
  atomic,
  data,
  fields,
  globalSlug,
  operation,
  parentIsLocalized = false,
  validateRelationships = true,
}: Args): void => {
  if (Array.isArray(data)) {
    for (const item of data) {
      transform({
        adapter,
        atomic,
        data: item,
        fields,
        globalSlug,
        operation,
        parentIsLocalized,
        validateRelationships,
      })
    }
    return
  }

  const { config } = adapter.payload
  const flattenedFields = flattenAllFields({ cache: true, fields })

  if (operation === 'read') {
    if (isRecordId(data['id'])) {
      data['id'] = fromRecordId(data['id'])
    }

    if (!adapter.allowAdditionalKeys) {
      stripFields({ config, data, fields: flattenedFields, reservedKeys: ['id', 'globalType'] })
    }
  } else {
    // Before the unknown keys are stripped: a dotted path is not a field name
    if (atomic) {
      extractDottedOperations({
        adapter,
        atomic,
        data,
        fields,
        operation,
        parentIsLocalized,
        validateRelationships,
      })
    }

    if (typeof data['updatedAt'] === 'undefined') {
      data['updatedAt'] = new Date().toISOString()
    } else if (data['updatedAt'] === null) {
      // `updatedAt` may be explicitly set to null to keep the stored value: it must not be written as null.
      delete data['updatedAt']
    }

    // Strips `updatedAt`/`createdAt` too when the collection has no timestamps.
    if (!adapter.allowAdditionalKeys) {
      stripFields({ config, data, fields: flattenedFields, stripVirtual: true })
    }

    // `CONTENT { id }` would override the record ID the row is stored under.
    delete data['id']

    if (globalSlug) {
      data['globalType'] = globalSlug
    }
  }

  sanitizeData({
    adapter,
    atomic,
    data,
    fields,
    operation,
    parentIsLocalized,
    validateRelationships,
  })
}
