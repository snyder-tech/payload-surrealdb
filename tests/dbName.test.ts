import type { Payload } from 'payload'

import { buildConfig } from 'payload'
import { afterAll, beforeAll, describe, expect, test } from 'vitest'

import type { SurrealDBAdapter } from '../src/index.js'

import { surrealdbAdapter } from '../src/index.js'
import { bootPayload, connectionArgs } from './helpers/payload.js'

const allowAll = {
  create: () => true,
  read: () => true,
  readVersions: () => true,
  update: () => true,
}

const config = buildConfig({
  collections: [
    {
      slug: 'custom-schema',
      access: allowAll,
      dbName: 'customs',
      fields: [{ name: 'text', type: 'text' }],
      versions: true,
    },
  ],
  db: surrealdbAdapter(connectionArgs('dbname')),
  globals: [
    {
      slug: 'site',
      access: allowAll,
      dbName: 'customSite',
      fields: [{ name: 'text', type: 'text' }],
      versions: true,
    },
  ],
  secret: 'test-secret',
  telemetry: false,
  typescript: { autoGenerate: false },
})

let payload: Payload

const count = async (table: string) => {
  if (!payload.db.connection) {
    throw new Error('The adapter is not connected.')
  }

  const [rows] = await payload.db.connection.query<[{ count: number }[]]>(
    `SELECT count() FROM \`${table}\` GROUP ALL`,
  )

  return rows[0]?.count ?? 0
}

beforeAll(async () => {
  payload = await bootPayload(config, 'dbname')
})

afterAll(async () => {
  await payload.destroy()
})

describe('dbName names the table', () => {
  test('of a collection and of its versions', async () => {
    const adapter = payload.db as SurrealDBAdapter

    expect(adapter.collections['custom-schema']).toEqual({ table: 'customs' })
    expect(adapter.versions['custom-schema']).toEqual({ table: '_customs_versions' })

    await payload.create({
      collection: 'custom-schema',
      data: { text: 'stored' },
      overrideAccess: true,
    })

    expect(await count('customs')).toBe(1)
    expect(await count('_customs_versions')).toBe(1)
  })

  test('of a global and of its versions', async () => {
    const adapter = payload.db as SurrealDBAdapter

    expect(adapter.globals['site']).toEqual({ table: '_global_customSite' })
    expect(adapter.globalVersions['site']).toEqual({ table: '_global_customSite_versions' })

    await payload.updateGlobal({ slug: 'site', data: { text: 'stored' }, overrideAccess: true })

    expect(await count('_global_customSite')).toBe(1)
    expect(await count('_global_customSite_versions')).toBe(1)
  })
})
