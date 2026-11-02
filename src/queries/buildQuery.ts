import type { FlattenedField, Where } from 'payload'

import type { SurrealDBAdapter } from '../index.js'
import type { Fragment, ParamBag } from './sql.js'

import { parseParams } from './parseParams.js'

/** Returns the WHERE condition for `where`, or null when it does not filter anything. */
export const buildQuery = ({
  adapter,
  collectionSlug,
  fields,
  globalSlug,
  idTable,
  locale,
  params,
  where,
}: {
  adapter: SurrealDBAdapter
  collectionSlug?: string | undefined
  fields: FlattenedField[]
  globalSlug?: string | undefined
  /** The table `id` conditions refer to, for rows that are not the collection's own, such as versions. */
  idTable?: string | undefined
  locale?: string | undefined
  params: ParamBag
  where: Where
}): Fragment | null =>
  parseParams({
    adapter,
    collectionSlug,
    fields,
    globalSlug,
    idTable,
    locale,
    params,
    parentIsLocalized: false,
    where,
  })
