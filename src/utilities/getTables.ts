import type { SurrealDBAdapter } from '../index.js'

/**
 * Holds one record per versioned parent, written by every version save of that parent. Two
 * transactions that save versions of one parent otherwise touch different rows and both commit,
 * leaving two `latest` rows; the shared record makes the second one conflict. The records are one
 * small row per parent, so `deleteVersions` leaves them in place.
 */
export const VERSION_LOCK_TABLE = '__version_locks'

/** Every table the adapter owns: collections, version histories, globals, global histories and the version locks. */
export const getTables = (adapter: SurrealDBAdapter): string[] =>
  [
    ...Object.values(adapter.collections),
    ...Object.values(adapter.versions),
    ...Object.values(adapter.globals),
    ...Object.values(adapter.globalVersions),
  ]
    .map(({ table }) => table)
    .concat(VERSION_LOCK_TABLE)
