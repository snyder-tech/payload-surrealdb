import type { Payload, SanitizedCollectionConfig } from 'payload'

import { buildVersionCollectionFields, buildVersionCompoundIndexes } from 'payload'

import type { CompoundIndex, IndexDefinition } from './buildSchema.js'

import { buildSchema } from './buildSchema.js'

/** The indexes of a collection's table and, when it has versions, of its version table. */
export const buildCollectionSchema = ({
  collection,
  payload,
  table,
  versionsTable,
}: {
  collection: SanitizedCollectionConfig
  payload: Payload
  table: string
  versionsTable: string | undefined
}): IndexDefinition[] => {
  const compoundIndexes: CompoundIndex[] = [...collection.sanitizedIndexes]

  if (Array.isArray(collection.upload.filenameCompoundIndex)) {
    compoundIndexes.push({
      fields: collection.upload.filenameCompoundIndex.map((name) => ({
        localizedPath: name,
        path: name,
        pathHasLocalized: false,
      })),
      unique: true,
    })
  }

  const definitions = [
    ...buildSchema({ compoundIndexes, fields: collection.flattenedFields, payload, table }),
  ]

  if (versionsTable) {
    definitions.push(
      ...buildSchema({
        compoundIndexes: buildVersionCompoundIndexes({ indexes: collection.sanitizedIndexes }),
        disableUnique: true,
        fields: buildVersionCollectionFields(payload.config, collection, true),
        payload,
        table: versionsTable,
      }),
    )
  }

  return definitions
}
