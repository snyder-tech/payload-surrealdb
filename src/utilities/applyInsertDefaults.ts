import type { Block, BlocksField, Field, SanitizedLocalizationConfig } from 'payload'

import { deepCopyObject } from 'payload'
import {
  fieldAffectsData,
  fieldIsVirtual,
  fieldShouldBeLocalized,
  tabHasName,
} from 'payload/shared'

import type { SurrealDBAdapter } from '../index.js'

type Row = Record<string, unknown>

const isRow = (value: unknown): value is Row =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

type Context = {
  blocks: Record<string, Block>
  localization: false | SanitizedLocalizationConfig
}

/** A copy of the field's `defaultValue`; a function is dynamic and is left to Payload, as in Mongo's schema. */
const staticDefault = (field: Field): unknown => {
  const value: unknown = 'defaultValue' in field ? field.defaultValue : undefined

  return typeof value === 'function' ? undefined : deepCopyObject(value)
}

/** The value a missing field starts with. `undefined` means it stays missing. */
const initialValue = (field: Field): unknown => {
  const value = staticDefault(field)

  if (field.type === 'point') {
    return value === undefined ? undefined : { type: 'Point', coordinates: value }
  }

  // Mongoose gives a hasMany select an empty array whatever its default; the default is kept when there is one.
  if (field.type === 'select' && field.hasMany) {
    return value ?? []
  }

  return value
}

const findBlock = ({
  ctx,
  field,
  slug,
}: {
  ctx: Context
  field: BlocksField
  slug: unknown
}): Block | undefined => {
  for (const block of field.blocks) {
    if (typeof block === 'string') {
      if (block === slug) {
        return ctx.blocks[block]
      }
    } else if (block.slug === slug) {
      return block
    }
  }

  return undefined
}

const fillFields = ({
  ctx,
  data,
  fields,
  parentIsLocalized,
}: {
  ctx: Context
  data: Row
  fields: Field[]
  parentIsLocalized: boolean
}): void => {
  for (const field of fields) {
    if (fieldIsVirtual(field)) {
      continue
    }

    switch (field.type) {
      case 'collapsible':
      case 'row':
        fillFields({ ctx, data, fields: field.fields, parentIsLocalized })
        break

      case 'tabs':
        for (const tab of field.tabs) {
          if (fieldIsVirtual(tab)) {
            continue
          }

          if (tabHasName(tab)) {
            fillSlots({
              ctx,
              data,
              fillChildren: (value) => {
                if (isRow(value)) {
                  fillFields({
                    ctx,
                    data: value,
                    fields: tab.fields,
                    parentIsLocalized: parentIsLocalized || Boolean(tab.localized),
                  })
                }
              },
              initial: undefined,
              localized: fieldShouldBeLocalized({ field: tab, parentIsLocalized }),
              name: tab.name,
            })
          } else {
            fillFields({
              ctx,
              data,
              fields: tab.fields,
              parentIsLocalized: parentIsLocalized || Boolean(tab.localized),
            })
          }
        }
        break

      case 'ui':
        break

      default:
        if (!fieldAffectsData(field)) {
          // An unnamed group stores its fields in its parent
          if (field.type === 'group') {
            fillFields({
              ctx,
              data,
              fields: field.fields,
              parentIsLocalized: parentIsLocalized || Boolean(field.localized),
            })
          }
          break
        }

        fillSlots({
          ctx,
          data,
          fillChildren: (value) => {
            const childIsLocalized = parentIsLocalized || Boolean(field.localized)

            if (field.type === 'group' && isRow(value)) {
              fillFields({
                ctx,
                data: value,
                fields: field.fields,
                parentIsLocalized: childIsLocalized,
              })
            } else if (field.type === 'array' && Array.isArray(value)) {
              for (const row of value) {
                if (isRow(row)) {
                  fillFields({
                    ctx,
                    data: row,
                    fields: field.fields,
                    parentIsLocalized: childIsLocalized,
                  })
                }
              }
            } else if (field.type === 'blocks' && Array.isArray(value)) {
              for (const row of value) {
                const block = isRow(row)
                  ? findBlock({ ctx, field, slug: row['blockType'] })
                  : undefined

                if (isRow(row) && block) {
                  fillFields({
                    ctx,
                    data: row,
                    fields: block.fields,
                    parentIsLocalized: childIsLocalized,
                  })
                }
              }
            }
          },
          initial: initialValue(field),
          localized: fieldShouldBeLocalized({ field, parentIsLocalized }),
          name: field.name,
        })
    }
  }
}

/**
 * Fills one field of `data`. A localized field is a `{ [locale]: value }` object: when it is there,
 * every configured locale is filled; when it is missing it stays missing, as with Mongoose.
 */
const fillSlots = ({
  ctx,
  data,
  fillChildren,
  initial,
  localized,
  name,
}: {
  ctx: Context
  data: Row
  fillChildren: (value: unknown) => void
  initial: unknown
  localized: boolean
  name: string
}): void => {
  const fillSlot = (parent: Row, key: string, start: unknown): void => {
    if (parent[key] === undefined && start !== undefined) {
      // Each slot gets its own copy: the write transform changes the data in place.
      parent[key] = deepCopyObject(start)
    }

    fillChildren(parent[key])
  }

  if (ctx.localization && localized) {
    const container = data[name]

    if (isRow(container)) {
      for (const code of ctx.localization.localeCodes) {
        fillSlot(container, code, initial)
      }
    }

    return
  }

  fillSlot(data, name, initial)
}

/**
 * Fills the fields a new row is missing with their static `defaultValue`, the way Mongoose does on
 * insert, in place. It runs on Payload-shaped data, before the write transform, so a default goes
 * through the same conversions as a given value. Updates never call it.
 *
 * Payload sets `_status` only for the locale being saved and relies on the database to default the
 * others: without it a draft is readable in a locale that has no status.
 */
export const applyInsertDefaults = ({
  adapter,
  data,
  fields,
}: {
  adapter: SurrealDBAdapter
  data: Row
  fields: Field[]
}): void => {
  fillFields({
    ctx: { blocks: adapter.payload.blocks, localization: adapter.payload.config.localization },
    data,
    fields,
    parentIsLocalized: false,
  })
}
