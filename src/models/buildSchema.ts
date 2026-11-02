import type { FlattenedBlock, FlattenedField, Payload } from 'payload'

import { APIError } from 'payload'
import { fieldIsVirtual, fieldShouldBeLocalized } from 'payload/shared'

import { escapeIdent } from '../queries/sql.js'

/**
 * One `DEFINE INDEX`. Tables are SCHEMALESS, so Mongo's mongoose schema becomes this list: the
 * only thing a Payload field config still tells the database is which paths to index.
 */
export type IndexDefinition = {
  /** The Payload path of the field a unique violation is reported on, which can differ from `paths` (a polymorphic link indexes `value`). Empty for a `count` index. */
  fieldPath: string
  kind: 'count' | 'index' | 'unique'
  /**
   * Set for a `unique` hasMany relationship, whose one path is the list itself. The index then holds the
   * stored links (a polymorphic link's `value`), with a repeat inside one document counted once.
   */
  links?: 'plain' | 'polymorphic'
  name: string
  /** Dotted paths, `*` standing for every element of an array. Empty for a `count` index. */
  paths: string[]
  table: string
}

/** The part of Payload's `SanitizedCompoundIndex` that index generation reads. */
export type CompoundIndex = {
  fields: { localizedPath: string; path: string; pathHasLocalized: boolean }[]
  unique: boolean
}

type Candidate = {
  fieldPath: string
  links?: 'plain' | 'polymorphic'
  paths: string[]
  unique: boolean
}

const segmentName = (path: string): string =>
  path
    .split('.')
    .map((segment) => (segment === '*' ? 'each' : segment.replaceAll(/\W+/g, '_')))
    .join('_')

/**
 * Deterministic, so the name can be rebuilt without the config. The unique variant has its own
 * name: a field that becomes `unique` later gets a new index, because `IF NOT EXISTS` would
 * leave the old non-unique one in place.
 */
const indexName = ({ paths, unique }: Candidate, table: string): string =>
  `${table}__${paths.map(segmentName).join('__')}${unique ? '__unique' : ''}`

/** The `::` cannot come out of `indexName`, which only joins word characters, so no field can take this name. */
const buildCountIndex = (table: string): IndexDefinition => ({
  fieldPath: '',
  kind: 'count',
  name: `${table}::count`,
  paths: [],
  table,
})

const localeCodes = (payload: Payload): string[] =>
  payload.config.localization ? payload.config.localization.localeCodes : []

const resolveBlock = (block: FlattenedBlock | string, payload: Payload): FlattenedBlock => {
  if (typeof block !== 'string') {
    return block
  }

  const referenced = payload.blocks[block]

  if (!referenced) {
    throw new APIError(`Cannot build indexes: block "${block}" is referenced but not defined.`)
  }

  return referenced
}

type WalkArgs = {
  disableUnique: boolean
  fields: FlattenedField[]
  indexSortableFields: boolean
  /** True below an array or blocks field: SurrealDB enforces `UNIQUE` per element across records there. */
  inArray: boolean
  locales: string[]
  parentIsLocalized: boolean
  payload: Payload
  prefix: string[]
}

const walkFields = (args: WalkArgs): Candidate[] => {
  const {
    disableUnique,
    fields,
    inArray,
    indexSortableFields,
    locales,
    parentIsLocalized,
    payload,
    prefix,
  } = args
  const candidates: Candidate[] = []

  for (const field of fields) {
    // A virtual field is never stored, and a join is resolved at read time.
    if (
      fieldIsVirtual(field) ||
      field.type === 'join' ||
      (prefix.length === 0 && field.name === 'id')
    ) {
      continue
    }

    const localized = locales.length > 0 && fieldShouldBeLocalized({ field, parentIsLocalized })
    const bases = localized
      ? locales.map((locale) => [...prefix, field.name, locale])
      : [[...prefix, field.name]]
    const nested = { ...args, parentIsLocalized: parentIsLocalized || localized }

    for (const base of bases) {
      switch (field.type) {
        case 'group':
        case 'tab':
          candidates.push(...walkFields({ ...nested, fields: field.flattenedFields, prefix: base }))
          break

        case 'array':
          candidates.push(
            ...walkFields({
              ...nested,
              fields: field.flattenedFields,
              inArray: true,
              prefix: [...base, '*'],
            }),
          )
          break

        case 'blocks':
          for (const block of field.blocks) {
            candidates.push(
              ...walkFields({
                ...nested,
                fields: resolveBlock(block, payload).flattenedFields,
                inArray: true,
                prefix: [...base, '*'],
              }),
            )
          }
          break

        default: {
          const hasMany = 'hasMany' in field && Boolean(field.hasMany)
          const isLink = field.type === 'relationship' || field.type === 'upload'
          const polymorphic = isLink && Array.isArray(field.relationTo)
          const unique = Boolean(field.unique) && !disableUnique

          // An index on `f.*` makes `CONTAINS` return nothing on 3.3.2, so a list of links is indexed only to
          // enforce `unique`, by an expression over the list that `CONTAINS` does not use (see `toDefineIndex`).
          if (isLink && hasMany && !(unique && !inArray)) {
            break
          }

          const sortable = indexSortableFields && prefix.length === 0

          // SurrealDB 3.3 has no spatial index, so a point is scanned. Only `unique` needs an index, and it compares exact coordinates.
          const indexed = field.type === 'point' ? unique : field.index || unique || sortable

          if (!indexed) {
            break
          }

          if (isLink && hasMany) {
            candidates.push({
              fieldPath: base.join('.'),
              links: polymorphic ? 'polymorphic' : 'plain',
              paths: [base.join('.')],
              unique: true,
            })
            break
          }

          // `f.*` indexes every element of a scalar hasMany, which is not made `UNIQUE`. A polymorphic link is
          // stored as `{ relationTo, value }`, and the value is what gets filtered on.
          const elements = hasMany ? [...base, '*'] : base
          const path = polymorphic ? [...elements, 'value'] : elements

          candidates.push({
            fieldPath: base.join('.'),
            paths: [path.join('.')],
            unique: unique && !inArray && !hasMany,
          })
        }
      }
    }
  }

  return candidates
}

/** Expands a compound index per locale, so uniqueness holds within one locale as in Mongo's single-locale queries. */
const compoundCandidates = (
  indexes: CompoundIndex[],
  locales: string[],
  disableUnique: boolean,
): Candidate[] =>
  indexes.flatMap((index) => {
    const unique = index.unique && !disableUnique
    const variants =
      index.fields.some((field) => field.pathHasLocalized) && locales.length > 0
        ? locales
        : [undefined]

    return variants.map((locale) => {
      const paths = index.fields.map((field) =>
        field.pathHasLocalized && locale
          ? field.localizedPath.replaceAll('<locale>', locale)
          : field.path,
      )

      return { fieldPath: paths[0] ?? '', paths, unique }
    })
  })

/**
 * The indexes one table needs, from its flattened fields: the `count` index, `index`, `unique` (one per locale for a
 * localized field), the compound `indexes` of the collection, and `indexSortableFields`.
 * `disableUnique` is for version tables, where the same value legitimately appears many times.
 */
export const buildSchema = ({
  compoundIndexes = [],
  disableUnique = false,
  fields,
  payload,
  table,
}: {
  compoundIndexes?: CompoundIndex[]
  disableUnique?: boolean
  fields: FlattenedField[]
  payload: Payload
  table: string
}): IndexDefinition[] => {
  const locales = localeCodes(payload)
  const candidates = [
    ...walkFields({
      disableUnique,
      fields,
      indexSortableFields: Boolean(payload.config.indexSortableFields),
      inArray: false,
      locales,
      parentIsLocalized: false,
      payload,
      prefix: [],
    }),
    ...compoundCandidates(compoundIndexes, locales, disableUnique),
  ]

  const definitions = new Map<string, IndexDefinition>()
  const all: IndexDefinition[] = [
    buildCountIndex(table),
    ...candidates.map((candidate) => ({
      fieldPath: candidate.fieldPath,
      kind: candidate.unique ? ('unique' as const) : ('index' as const),
      ...(candidate.links && { links: candidate.links }),
      name: indexName(candidate, table),
      paths: candidate.paths,
      table,
    })),
  ]

  for (const definition of all) {
    const existing = definitions.get(definition.name)

    // The same path appears once per block that declares it; one index serves them all.
    if (existing && existing.paths.join() !== definition.paths.join()) {
      throw new APIError(
        `Cannot build indexes: "${definition.name}" would index both ${existing.paths.join(', ')} and ${definition.paths.join(', ')}.`,
      )
    }

    definitions.set(definition.name, definition)
  }

  return [...definitions.values()]
}

/** `rows.*.id` becomes `` `rows`.*.`id` ``: every segment is escaped except the array wildcard. */
const toIndexIdiom = (path: string): string =>
  path
    .split('.')
    .map((segment) => (segment === '*' ? segment : escapeIdent(segment)))
    .join('.')

/**
 * A unique list of links is indexed through `chain`, the one method that also runs on a missing or null
 * list (`distinct` alone makes the write, or the index build over older rows, fail). The links are
 * compared as stored: an index on `f.*.id` follows each link, so it would stop enforcing once a target
 * is deleted. `array::distinct` keeps one document linking a target twice from clashing with itself,
 * as Mongo's multikey index allows.
 */
const toLinksIdiom = (path: string, links: 'plain' | 'polymorphic'): string => {
  const list = links === 'polymorphic' ? `($v ?? []).map(|$link| $link.value)` : `$v ?? []`

  return `${toIndexIdiom(path)}.chain(|$v| array::distinct(${list}))`
}

export const toDefineIndex = ({ kind, links, name, paths, table }: IndexDefinition): string => {
  const target = `DEFINE INDEX IF NOT EXISTS ${escapeIdent(name)} ON ${escapeIdent(table)}`

  if (kind === 'count') {
    return `${target} COUNT`
  }

  const [path] = paths
  const fields = links && path ? toLinksIdiom(path, links) : paths.map(toIndexIdiom).join(', ')

  return `${target} FIELDS ${fields}${kind === 'unique' ? ' UNIQUE' : ''}`
}
