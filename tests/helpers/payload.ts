import type { Payload, SanitizedConfig } from 'payload'

import { getPayload } from 'payload'

// CI points this at its own container; local runs use the server on port 8123.
export const SURREAL_URL = process.env['SURREAL_TEST_URL'] ?? 'ws://127.0.0.1:8123/rpc'

export const connectionArgs = (database: string) => ({
  auth: { password: 'root', username: 'root' },
  database,
  namespace: 'm6',
  url: SURREAL_URL,
})

/**
 * Boots Payload against a fresh database: `PAYLOAD_DROP_DATABASE` makes `connect` drop every
 * table first. Each test file passes its own `key`, so the instances do not share state.
 */
export const bootPayload = async (
  config: Promise<SanitizedConfig>,
  key: string,
): Promise<Payload> => {
  process.env['PAYLOAD_DROP_DATABASE'] = 'true'
  process.env['DISABLE_LOGGING'] = 'true'

  return getPayload({ config, cron: false, key })
}

/** The ID of a new transaction; a null means the adapter has none, which these tests never expect. */
export const beginTransaction = async (payload: Payload): Promise<number | string> => {
  const id = await payload.db.beginTransaction()

  if (id === null) {
    throw new Error('beginTransaction returned null, so the adapter has no transactions.')
  }

  return id
}
