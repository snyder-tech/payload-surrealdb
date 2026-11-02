import type { FlattenedField, Where } from 'payload'
import type { RecordId } from 'surrealdb'

import type { SurrealDBAdapter } from '../index.js'
import type { Fragment, ParamBag } from './sql.js'

import { getCollection } from '../utilities/getEntity.js'
import { isRecordId } from '../utilities/recordId.js'
import { buildQuery } from './buildQuery.js'
import { sanitizeQueryValue } from './sanitizeQueryValue.js'
import { escapeIdent } from './sql.js'

const isObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

type IDCondition = { operator: 'equals' | 'in'; val: unknown }

/**
 * Takes the first `id equals` or `id in` out of a copy of `where`, from its top level or from
 * inside an `and` at any depth, and gives back what it listed. An `or`, and every other condition,
 * stays: an ID condition anywhere else still filters the rows once they are selected.
 */
const takeIDCondition = (where: Where): { rest: Where; taken: IDCondition | undefined } => {
  const found: IDCondition[] = []

  const strip = (node: Where): Where => {
    const rest: Where = {}

    for (const [key, value] of Object.entries(node)) {
      if (Array.isArray(value) && key.toLowerCase() === 'and') {
        rest[key] = value.map(strip)
      } else if (key === 'id' && isObject(value)) {
        const operators = Object.entries(value).filter(([operator, val]) => {
          const takes =
            found.length === 0 && val !== undefined && (operator === 'equals' || operator === 'in')

          if (takes) {
            found.push({ operator, val })
          }

          return !takes
        })

        if (operators.length > 0) {
          rest[key] = Object.fromEntries(operators)
        }
      } else {
        rest[key] = value
      }
    }

    return rest
  }

  const rest = strip(where)

  return { rest, taken: found[0] }
}

/**
 * Where to select the rows from, and the condition they still have to meet.
 *
 * Payload reads relationships with `find where id in [...]`, and most single-document calls
 * pass `id equals`. Filtering the table with `id IN [...]` reads every row of it, while naming
 * the records reads only those. So when `where` pins the ID, the records are selected directly
 * and the rest of `where` becomes the condition. The IDs are read exactly as the `id` condition
 * reads them, so one that cannot be a key of this collection is left out, and a record that does
 * not exist is simply not found.
 */
export type QueryTarget = {
  condition: Fragment | null
  /** Table (escaped) or the bound list of record IDs, for a `FROM` or an `UPDATE`/`DELETE` target. */
  from: string
  /** The records `where` pins, once each, when it pins them. */
  ids: RecordId[] | undefined
}

export const buildQueryTarget = ({
  adapter,
  collectionSlug,
  fields,
  locale,
  params,
  where,
}: {
  adapter: SurrealDBAdapter
  collectionSlug: string
  fields: FlattenedField[]
  locale?: string | undefined
  params: ParamBag
  where: Where
}): QueryTarget => {
  const { customIDType, table } = getCollection({ adapter, collectionSlug })
  const { rest, taken } = takeIDCondition(where)

  if (!taken) {
    return {
      condition: buildQuery({ adapter, collectionSlug, fields, locale, params, where }),
      from: escapeIdent(table),
      ids: undefined,
    }
  }

  const sanitized = sanitizeQueryValue({
    adapter,
    operator: taken.operator,
    target: { customIDType, kind: 'id', table },
    val: taken.val,
  })
  const listed = sanitized?.operator === 'equals' ? [sanitized.val] : sanitized?.val
  const unique = new Map<string, RecordId>()

  for (const id of Array.isArray(listed) ? listed : []) {
    if (isRecordId(id)) {
      unique.set(id.toString(), id)
    }
  }

  const ids = [...unique.values()]
  const condition = buildQuery({ adapter, collectionSlug, fields, locale, params, where: rest })

  return {
    // `SELECT count() FROM <records> GROUP ALL` fails on SurrealDB 3.3.2 unless the select has a `WHERE`
    condition: condition ?? 'true',
    from: params.add(ids),
    ids,
  }
}
