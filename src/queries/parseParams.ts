import type { FlattenedField, Operator, Where } from 'payload'

import { validOperatorSet } from 'payload/shared'

import type { SurrealDBAdapter } from '../index.js'
import type { Fragment, ParamBag } from './sql.js'

import { buildAndOrConditions } from './buildAndOrConditions.js'
import { buildSearchParam } from './buildSearchParams.js'
import { and, or } from './sql.js'

export function parseParams({
  adapter,
  collectionSlug,
  fields,
  globalSlug,
  idTable,
  locale,
  params,
  parentIsLocalized,
  where,
}: {
  adapter: SurrealDBAdapter
  collectionSlug?: string | undefined
  fields: FlattenedField[]
  globalSlug?: string | undefined
  idTable?: string | undefined
  locale?: string | undefined
  params: ParamBag
  parentIsLocalized: boolean
  where: Where
}): Fragment | null {
  const conditions: Fragment[] = []

  if (typeof where === 'object') {
    // We need to determine if the whereKey is an AND, OR, or a schema path
    for (const relationOrPath of Object.keys(where)) {
      const condition = where[relationOrPath]

      if (Array.isArray(condition)) {
        const lowerKey = relationOrPath.toLowerCase()
        const combine = lowerKey === 'and' ? and : lowerKey === 'or' ? or : null
        const builtConditions = buildAndOrConditions({
          adapter,
          collectionSlug,
          fields,
          globalSlug,
          idTable,
          locale,
          params,
          parentIsLocalized,
          where: condition,
        })
        const combined = combine?.(builtConditions)

        // An `or` whose conditions all dropped out is skipped instead of emitting `()`
        if (combined) {
          conditions.push(combined)
        }
      } else {
        // It's a path - and there can be multiple comparisons on a single path.
        // For example - title like 'test' and title not equal to 'tester'
        // So we need to loop on keys again here to handle each operator independently
        const pathOperators = where[relationOrPath]

        if (typeof pathOperators === 'object') {
          const validOperators = Object.keys(pathOperators).filter((operator) =>
            validOperatorSet.has(operator as Operator),
          ) as Operator[]

          for (const operator of validOperators) {
            const searchParam = buildSearchParam({
              adapter,
              collectionSlug,
              fields,
              globalSlug,
              idTable,
              incomingPath: relationOrPath,
              locale,
              operator,
              params,
              parentIsLocalized,
              val: (pathOperators as Record<string, unknown>)[operator],
            })

            if (searchParam) {
              conditions.push(searchParam)
            }
          }
        }
      }
    }
  }

  return and(conditions)
}
