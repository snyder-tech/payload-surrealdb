import type {
  FieldAffectingData,
  FlattenedField,
  SelectIncludeType,
  SelectMode,
  SelectType,
} from 'payload'

import {
  deepCopyObjectSimple,
  fieldAffectsData,
  fieldShouldBeLocalized,
  getSelectMode,
} from 'payload/shared'

import type { SurrealDBAdapter } from '../index.js'

import { escapeIdent } from '../queries/sql.js'

type PathNode = {
  /** The whole value at this path is selected, whatever it holds. */
  all: boolean
  children: Map<string, PathNode>
}

const createNode = (): PathNode => ({ all: false, children: new Map() })

/**
 * The paths a `select` keeps. SurrealDB projects a path inside an array as an object of arrays
 * (`SELECT arr.x` returns `{ arr: { x: [1, 2] } }`, not `arr: [{ x: 1 }, { x: 2 }]`), so only the
 * top-level keys go into the query and `applyProjection` trims the nested paths on the rows.
 */
export type Projection = {
  root: PathNode
}

const addPath = (root: PathNode, path: string): void => {
  let node = root

  for (const segment of path.split('.')) {
    let child = node.children.get(segment)

    if (!child) {
      child = createNode()
      node.children.set(segment, child)
    }

    node = child
  }

  node.all = true
}

const addFieldToProjection = ({
  adapter,
  databaseSchemaPath,
  field,
  parentIsLocalized,
  projection,
}: {
  adapter: SurrealDBAdapter
  databaseSchemaPath: string
  field: FieldAffectingData
  parentIsLocalized: boolean
  projection: Projection
}) => {
  const { config } = adapter.payload

  if (parentIsLocalized && config.localization) {
    for (const locale of config.localization.localeCodes) {
      const localeDatabaseSchemaPath = databaseSchemaPath.replace('<locale>', locale)
      addPath(projection.root, `${localeDatabaseSchemaPath}${field.name}`)
    }
  } else {
    addPath(projection.root, `${databaseSchemaPath}${field.name}`)
  }
}

const traverseFields = ({
  adapter,
  databaseSchemaPath = '',
  fields,
  parentIsLocalized = false,
  projection,
  select,
  selectAllOnCurrentLevel = false,
  selectMode,
}: {
  adapter: SurrealDBAdapter
  databaseSchemaPath?: string
  fields: FlattenedField[]
  parentIsLocalized?: boolean
  projection: Projection
  select: SelectType
  selectAllOnCurrentLevel?: boolean
  selectMode: SelectMode
}) => {
  for (const field of fields) {
    if (fieldAffectsData(field)) {
      if (selectMode === 'include') {
        if (select[field.name] === true || selectAllOnCurrentLevel) {
          addFieldToProjection({
            adapter,
            databaseSchemaPath,
            field,
            parentIsLocalized,
            projection,
          })
          continue
        }

        if (!select[field.name]) {
          continue
        }
      }

      if (selectMode === 'exclude') {
        if (typeof select[field.name] === 'undefined') {
          addFieldToProjection({
            adapter,
            databaseSchemaPath,
            field,
            parentIsLocalized,
            projection,
          })
          continue
        }

        if (select[field.name] === false) {
          continue
        }
      }
    }

    let fieldDatabaseSchemaPath = databaseSchemaPath

    if (fieldAffectsData(field)) {
      fieldDatabaseSchemaPath = `${databaseSchemaPath}${field.name}.`

      if (fieldShouldBeLocalized({ field, parentIsLocalized })) {
        fieldDatabaseSchemaPath = `${fieldDatabaseSchemaPath}<locale>.`
      }
    }

    switch (field.type) {
      case 'array':
      case 'group':
      case 'tab': {
        const fieldSelect = select[field.name] as SelectType

        if (field.type === 'array' && selectMode === 'include') {
          fieldSelect['id'] = true
        }

        traverseFields({
          adapter,
          databaseSchemaPath: fieldDatabaseSchemaPath,
          fields: field.flattenedFields,
          parentIsLocalized: parentIsLocalized || field.localized === true,
          projection,
          select: fieldSelect,
          selectMode,
        })

        break
      }
      case 'blocks': {
        const blocksSelect = select[field.name] as SelectType

        // A row cannot be read back without its type, and it is not one of the block's own fields
        addFieldToProjection({
          adapter,
          databaseSchemaPath: fieldDatabaseSchemaPath,
          field: { name: 'blockType', type: 'text' },
          parentIsLocalized: parentIsLocalized || field.localized === true,
          projection,
        })

        for (const blockOrSlug of field.blocks) {
          const block =
            typeof blockOrSlug === 'string' ? adapter.payload.blocks[blockOrSlug] : blockOrSlug

          if (!block) {
            continue
          }

          if (
            (selectMode === 'include' && blocksSelect[block.slug] === true) ||
            (selectMode === 'exclude' && typeof blocksSelect[block.slug] === 'undefined')
          ) {
            traverseFields({
              adapter,
              databaseSchemaPath: fieldDatabaseSchemaPath,
              fields: block.flattenedFields,
              parentIsLocalized: parentIsLocalized || field.localized === true,
              projection,
              select: {},
              selectAllOnCurrentLevel: true,
              selectMode: 'include',
            })
            continue
          }

          let blockSelectMode = selectMode

          if (selectMode === 'exclude' && blocksSelect[block.slug] === false) {
            blockSelectMode = 'include'
          }

          if (typeof blocksSelect[block.slug] !== 'object') {
            blocksSelect[block.slug] = {}
          }

          if (blockSelectMode === 'include' && typeof blocksSelect[block.slug] === 'object') {
            const blockSelect = blocksSelect[block.slug] as SelectIncludeType
            blockSelect['id'] = true
            blockSelect['blockType'] = true
          }

          traverseFields({
            adapter,
            databaseSchemaPath: fieldDatabaseSchemaPath,
            fields: block.flattenedFields,
            parentIsLocalized: parentIsLocalized || field.localized === true,
            projection,
            select: blocksSelect[block.slug] as SelectType,
            selectMode: blockSelectMode,
          })
        }

        break
      }

      case 'relationship':
      case 'upload': {
        // A relationship selected with nested fields (for population) still needs its raw value,
        // because population reads it. The nested select is handled by the population logic.
        addFieldToProjection({
          adapter,
          databaseSchemaPath,
          field,
          parentIsLocalized,
          projection,
        })
        break
      }

      default:
        break
    }
  }
}

/** The projection of `select` over `fields`, or undefined when there is no `select`. `id` is always kept. */
export const buildProjectionFromSelect = ({
  adapter,
  fields,
  select,
}: {
  adapter: SurrealDBAdapter
  fields: FlattenedField[]
  select?: SelectType | undefined
}): Projection | undefined => {
  if (!select) {
    return undefined
  }

  const projection: Projection = { root: createNode() }

  addPath(projection.root, 'id')

  traverseFields({
    adapter,
    fields,
    projection,
    // Clone to safely mutate it later
    select: deepCopyObjectSimple(select),
    selectMode: getSelectMode(select),
  })

  return projection
}

/** What goes after `SELECT`: the top-level keys of the projection, or every field without one. */
export const selectClause = (projection: Projection | undefined): string =>
  projection ? [...projection.root.children.keys()].map(escapeIdent).join(', ') : '*'

/** What goes after `RETURN` for a write: the projected top-level keys, or the whole row. */
export const returnClause = (projection: Projection | undefined): string =>
  projection ? selectClause(projection) : 'AFTER'

const isPlainObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && Object.getPrototypeOf(value) === Object.prototype

/**
 * Keeps what `node` selects of `value`. Arrays are walked element by element. A value that cannot
 * hold the selected keys (a scalar where a group was expected) is dropped, which is what a
 * projection on a missing path does.
 */
const prune = (value: unknown, node: PathNode): unknown => {
  if (node.all) {
    return value
  }

  if (Array.isArray(value)) {
    return value.map((item) => prune(item, node)).filter((item) => item !== undefined)
  }

  if (!isPlainObject(value)) {
    return undefined
  }

  const kept: Record<string, unknown> = {}

  for (const [key, child] of node.children) {
    if (key in value) {
      const pruned = prune(value[key], child)

      if (pruned !== undefined) {
        kept[key] = pruned
      }
    }
  }

  return kept
}

/** Trims `rows` (the raw rows of a query that selected the top-level keys) down to the projected paths. */
export const applyProjection = (
  rows: Record<string, unknown>[],
  projection: Projection | undefined,
): void => {
  if (!projection) {
    return
  }

  for (const row of rows) {
    for (const key of Object.keys(row)) {
      const node = projection.root.children.get(key)

      if (!node) {
        delete row[key]
        continue
      }

      const pruned = prune(row[key], node)

      if (pruned === undefined) {
        delete row[key]
      } else {
        row[key] = pruned
      }
    }
  }
}
