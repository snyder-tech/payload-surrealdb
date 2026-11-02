import type { Payload } from 'payload'

import { buildConfig } from 'payload'
import { afterAll, beforeAll, describe, expect, test, vi } from 'vitest'

import type { SurrealDBAdapter } from '../src/index.js'

import { surrealdbAdapter } from '../src/index.js'
import { bootPayload, connectionArgs } from './helpers/payload.js'

const config = buildConfig({
  collections: [
    { slug: 'users', auth: true, fields: [], versions: false },
    {
      slug: 'docs',
      fields: [
        { name: 'slug', type: 'text', unique: true },
        { name: 'later', type: 'text', unique: true },
      ],
      versions: false,
    },
  ],
  db: surrealdbAdapter(connectionArgs('connect')),
  secret: 'test-secret',
  telemetry: false,
  typescript: { autoGenerate: false },
})

let payload: Payload
let adapter: SurrealDBAdapter

const indexNames = async (): Promise<string[]> => {
  const [info] = await adapter.connection!.query<[{ indexes: { name: string }[] }]>(
    'INFO FOR TABLE docs STRUCTURE',
  )

  return info.indexes.map(({ name }) => name)
}

beforeAll(async () => {
  payload = await bootPayload(config, 'connect')
  adapter = payload.db as SurrealDBAdapter
})

afterAll(async () => {
  await payload.destroy()
})

describe('defining the indexes on connect', () => {
  test('a unique index over existing duplicates is logged and skipped, and the rest are defined', async () => {
    await adapter.connection!.query(
      'REMOVE INDEX docs__slug__unique ON docs; REMOVE INDEX docs__later__unique ON docs; CREATE docs SET slug = "dup"; CREATE docs SET slug = "dup";',
    )
    const logged = vi.spyOn(payload.logger, 'error').mockImplementation(() => undefined)

    try {
      await adapter.connect!({ hotReload: true })

      expect(logged).toHaveBeenCalledTimes(1)
      const [entry] = logged.mock.calls[0] ?? []
      expect(entry).toEqual({
        err: expect.any(Error),
        msg: expect.stringMatching(
          /unique index docs__slug__unique on docs for the field slug.*Reason: Database index `docs__slug__unique` already contains/,
        ),
      })
    } finally {
      logged.mockRestore()
    }

    const names = await indexNames()
    expect(names).not.toContain('docs__slug__unique')
    // Defined after the one that failed
    expect(names).toContain('docs__later__unique')
  })

  test('any other failure still stops connect', async () => {
    const logged = vi.spyOn(payload.logger, 'error').mockImplementation(() => undefined)
    const real = adapter.connection!.query.bind(adapter.connection)
    const spy = vi
      .spyOn(adapter.connection!, 'query')
      .mockImplementation((sql, vars, options) =>
        sql.startsWith('DEFINE INDEX')
          ? Promise.reject(new Error('index build failed'))
          : real(sql, vars, options),
      )

    try {
      await expect(adapter.connect!({ hotReload: true })).rejects.toThrow(
        'Error: cannot connect to SurrealDB. Details: index build failed',
      )
    } finally {
      spy.mockRestore()
      logged.mockRestore()
    }
  })

  test('an index build gets a longer timeout than a plain query', async () => {
    const logged = vi.spyOn(payload.logger, 'error').mockImplementation(() => undefined)
    const spy = vi.spyOn(adapter.connection!, 'query')

    try {
      await adapter.connect!({ hotReload: true })

      const builds = spy.mock.calls.filter(([sql]) => sql.startsWith('DEFINE INDEX'))
      expect(builds.length).toBeGreaterThan(0)
      for (const [, , options] of builds) {
        expect(options?.requestTimeout).toBeGreaterThan(adapter.requestTimeout)
      }
    } finally {
      spy.mockRestore()
      logged.mockRestore()
    }
  })
})
