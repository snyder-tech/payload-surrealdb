import type { Collection, SanitizedCollectionConfig, SanitizedGlobalConfig } from 'payload'

import { APIError } from 'payload'
import { RecordId } from 'surrealdb'

import type { SurrealDBAdapter } from '../index.js'

export const getCollection = ({
  adapter,
  collectionSlug,
  versions = false,
}: {
  adapter: SurrealDBAdapter
  collectionSlug: string
  versions?: boolean
}): {
  collectionConfig: SanitizedCollectionConfig
  customIDType: Collection['customIDType']
  table: string
} => {
  const collection = adapter.payload.collections[collectionSlug]

  if (!collection) {
    throw new APIError(
      `ERROR: Failed to retrieve collection with the slug "${collectionSlug}". Does not exist.`,
    )
  }

  const meta = versions ? adapter.versions[collectionSlug] : adapter.collections[collectionSlug]

  if (!meta) {
    throw new APIError(
      `ERROR: Failed to retrieve collection ${versions ? 'version table' : 'table'} with the slug "${collectionSlug}". Does not exist.`,
    )
  }

  return {
    collectionConfig: collection.config,
    customIDType: collection.customIDType,
    table: meta.table,
  }
}

/** The one record of a global's table, which holds the global itself. A global's version table has many records. */
export const globalRecordId = (table: string): RecordId => new RecordId(table, 'singleton')

export const getGlobal = ({
  adapter,
  globalSlug,
  versions = false,
}: {
  adapter: SurrealDBAdapter
  globalSlug: string
  versions?: boolean
}): {
  globalConfig: SanitizedGlobalConfig
  table: string
} => {
  const globalConfig = adapter.payload.config.globals.find((each) => each.slug === globalSlug)

  if (!globalConfig) {
    throw new APIError(
      `ERROR: Failed to retrieve global with the slug "${globalSlug}". Does not exist.`,
    )
  }

  const meta = versions ? adapter.globalVersions[globalSlug] : adapter.globals[globalSlug]

  if (!meta) {
    throw new APIError(
      `ERROR: Failed to retrieve global ${versions ? 'version table' : 'table'} with the slug "${globalSlug}". Does not exist.`,
    )
  }

  return { globalConfig, table: meta.table }
}
