import type { FlattenedField } from 'payload'

import { fieldShouldBeLocalized } from 'payload/shared'

import type { SurrealDBAdapter } from '../index.js'

export type PathAnalysis = {
  /** How many `array` and `blocks` fields the path passes through. Each one turns the path into a list. */
  arrayLevels: number
  /**
   * The relationship or upload field the path continues past, when the rest of the path is not
   * just `.value` or `.relationTo`. The path then leaves this document for the related one.
   */
  crossed?: {
    field: FlattenedField
    /** The names of the fields that lead to it, itself included and without locales: `group.author`. */
    path: string
    /** How many segments of the path lead up to, and include, the field and its locale. */
    segments: number
  }
  /** The path continues into a json or richText value, whose shape the field config does not describe. */
  inJson: boolean
  /** The field the path ends on, when it could be resolved. */
  last?: FlattenedField
}

/** The fields a path can name inside `field`, which for blocks are those of every block. */
const childFields = (adapter: SurrealDBAdapter, field: FlattenedField): FlattenedField[] => {
  if ('flattenedFields' in field) {
    return field.flattenedFields
  }

  if (field.type === 'blocks') {
    return field.blocks.flatMap((blockOrSlug) => {
      const block =
        typeof blockOrSlug === 'string' ? adapter.payload.blocks[blockOrSlug] : blockOrSlug

      return block ? block.flattenedFields : []
    })
  }

  return []
}

/**
 * Walks `path` through the field tree. In SurrealQL a path through an array yields a list, a
 * relationship is a link to another table and the inside of a json value has no schema, so each of
 * them needs a different expression than the same path on a plain document.
 */
export const analyzePath = ({
  adapter,
  fields,
  parentIsLocalized,
  path,
}: {
  adapter: SurrealDBAdapter
  fields: FlattenedField[]
  parentIsLocalized: boolean
  path: string
}): PathAnalysis => {
  const localeCodes = adapter.payload.config.localization
    ? adapter.payload.config.localization.localeCodes
    : []
  const segments = path.split('.')
  let current: FlattenedField[] = fields
  let parentLocalized = parentIsLocalized
  const analysis: PathAnalysis = { arrayLevels: 0, inJson: false }
  const names: string[] = []

  for (let i = 0; i < segments.length; i++) {
    const field = current.find((each) => each.name === segments[i])

    // A locale code or `blockType`: part of the path, but not a field of its own
    if (!field) {
      continue
    }

    // `title.en`: a locale after a localized field is part of that field, not a deeper path
    const nextSegment = segments[i + 1]
    const hasLocaleSegment =
      nextSegment !== undefined &&
      localeCodes.includes(nextSegment) &&
      fieldShouldBeLocalized({ field, parentIsLocalized: parentLocalized })
    names.push(field.name)

    const consumed = i + 1 + (hasLocaleSegment ? 1 : 0)
    const remaining = segments.length - consumed

    if (remaining <= 0) {
      analysis.last = field
      return analysis
    }

    if (field.type === 'json' || field.type === 'richText') {
      analysis.inJson = true
      return analysis
    }

    if (field.type === 'relationship' || field.type === 'upload') {
      // `poly.value` and `poly.relationTo` read the link itself, anything else reads the related document
      const rest = segments.slice(consumed)
      const readsLink = rest.length === 1 && (rest[0] === 'value' || rest[0] === 'relationTo')

      if (!readsLink) {
        analysis.crossed = { field, path: names.join('.'), segments: consumed }
      }

      analysis.last = field
      return analysis
    }

    if (field.type === 'array' || field.type === 'blocks') {
      analysis.arrayLevels += 1
    }

    current = childFields(adapter, field)
    parentLocalized ||= Boolean(field.localized)
  }

  return analysis
}
