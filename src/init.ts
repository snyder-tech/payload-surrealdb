import type { Init } from 'payload'

import type { SurrealDBAdapter } from './index.js'

import { buildCollectionSchema } from './models/buildCollectionSchema.js'
import { buildGlobalSchema } from './models/buildGlobalSchema.js'
import { getDBName } from './utilities/getDBName.js'

// Pure bookkeeping: no I/O happens here, `connect` creates the tables and indexes.
export const init: Init = function init(this: SurrealDBAdapter) {
  for (const collection of this.payload.config.collections) {
    const table = getDBName({ config: collection })
    const versionsTable = collection.versions
      ? getDBName({ config: collection, versions: true })
      : undefined

    this.collections[collection.slug] = { table }

    if (versionsTable) {
      this.versions[collection.slug] = { table: versionsTable }
    }

    this.indexes.push(
      ...buildCollectionSchema({ collection, payload: this.payload, table, versionsTable }),
    )
  }

  // The `_global_` prefix cannot clash with a collection table because Payload slugs cannot start with `_`.
  for (const global of this.payload.config.globals) {
    const table = `_global_${getDBName({ config: global })}`
    const versionsTable = global.versions ? `${table}_versions` : undefined

    this.globals[global.slug] = { table }

    if (versionsTable) {
      this.globalVersions[global.slug] = { table: versionsTable }
    }

    this.indexes.push(...buildGlobalSchema({ global, payload: this.payload, table, versionsTable }))
  }

  for (const { fieldPath, kind, name } of this.indexes) {
    if (kind === 'unique') {
      this.uniqueIndexPaths.set(name, fieldPath)
    }
  }
}
