import type { FlattenedField, Where } from 'payload'

import type { SurrealDBAdapter } from '../index.js'
import type { Fragment, ParamBag } from './sql.js'

import { parseParams } from './parseParams.js'

export function buildAndOrConditions({
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
  where: Where[]
}): Fragment[] {
  const completedConditions: Fragment[] = []
  // Loop over all AND / OR operations and add them to the AND / OR query param
  // Operations should come through as an array

  for (const condition of where) {
    // If the operation is properly formatted as an object
    if (typeof condition === 'object') {
      const result = parseParams({
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

      if (result) {
        completedConditions.push(result)
      }
    }
  }

  return completedConditions
}
