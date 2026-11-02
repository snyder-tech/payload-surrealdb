import type { Payload, SanitizedGlobalConfig } from 'payload'

import { buildVersionGlobalFields } from 'payload'

import type { IndexDefinition } from './buildSchema.js'

import { buildSchema } from './buildSchema.js'

/** The indexes of a global's table and, when it has versions, of its version table. */
export const buildGlobalSchema = ({
  global,
  payload,
  table,
  versionsTable,
}: {
  global: SanitizedGlobalConfig
  payload: Payload
  table: string
  versionsTable: string | undefined
}): IndexDefinition[] => {
  const definitions = [...buildSchema({ fields: global.flattenedFields, payload, table })]

  if (versionsTable) {
    definitions.push(
      ...buildSchema({
        disableUnique: true,
        fields: buildVersionGlobalFields(payload.config, global, true),
        payload,
        table: versionsTable,
      }),
    )
  }

  return definitions
}
