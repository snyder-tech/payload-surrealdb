import type { Payload } from 'payload'

import { buildConfig } from 'payload'
import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'vitest'

import { surrealdbAdapter } from '../src/index.js'
import { beginTransaction, bootPayload, connectionArgs } from './helpers/payload.js'

const collection = 'tasks'

// Payload 4 turns `versions` on for every collection; these tests do not use versions, so they are off.
const config = buildConfig({
  collections: [
    { slug: 'users', auth: true, fields: [], versions: false },
    {
      slug: collection,
      fields: [
        { name: 'title', type: 'text' },
        { name: 'rank', type: 'number' },
        { name: 'point', type: 'point' },
        { name: 'status', type: 'select', options: ['open', 'done'] },
        { name: 'log', type: 'array', fields: [{ name: 'entry', type: 'text' }] },
        { name: 'meta', type: 'group', fields: [{ name: 'label', type: 'text' }] },
      ],
      versions: false,
    },
  ],
  db: surrealdbAdapter(connectionArgs('updatemany')),
  secret: 'test-secret',
  telemetry: false,
  typescript: { autoGenerate: false },
})

let payload: Payload

type Task = { id: string; meta?: { label?: string }; rank: number; status?: string; title: string }

const seed = async () => {
  for (const [title, rank, status] of [
    ['a', 3, 'open'],
    ['b', 1, 'open'],
    ['c', 4, 'open'],
    ['d', 2, 'done'],
    ['e', 5, 'done'],
  ] as const) {
    await payload.db.create({ collection, data: { rank, status, title } })
  }
}

const rows = async () => {
  const { docs } = await payload.db.find<Task>({ collection, limit: 0, sort: 'rank' })

  return docs.map(({ rank, status, title }) => `${title}:${rank}:${status}`)
}

beforeAll(async () => {
  payload = await bootPayload(config, 'updatemany')
})

beforeEach(async () => {
  await payload.db.deleteMany({ collection, where: {} })
  await seed()
})

afterAll(async () => {
  await payload.destroy()
})

describe('updateMany', () => {
  test('updates every row that matches where and returns them in sort order', async () => {
    const updated = await payload.db.updateMany({
      collection,
      data: { status: 'done' },
      sort: '-rank',
      where: { status: { equals: 'open' } },
    })

    expect(updated?.map((doc) => doc['title'])).toEqual(['c', 'a', 'b'])
    expect(updated?.every((doc) => doc['status'] === 'done')).toBe(true)
    expect(await rows()).toEqual(['b:1:done', 'd:2:done', 'a:3:done', 'c:4:done', 'e:5:done'])
  })

  test('a limit updates only the first rows in sort order', async () => {
    const updated = await payload.db.updateMany({
      collection,
      data: { status: 'done' },
      limit: 2,
      sort: 'rank',
      where: { status: { equals: 'open' } },
    })

    expect(updated?.map((doc) => doc['title'])).toEqual(['b', 'a'])
    expect(await rows()).toEqual(['b:1:done', 'd:2:done', 'a:3:done', 'c:4:open', 'e:5:done'])
  })

  test('a limit with near updates the nearest row, not the newest', async () => {
    await payload.db.deleteMany({ collection, where: {} })

    // The nearest is created first and the farthest last, so a default sort by creation would pick the wrong one.
    for (const [title, longitude] of [
      ['nearest', 0.001],
      ['middle', 0.01],
      ['farthest', 0.05],
    ] as const) {
      await payload.db.create({
        collection,
        data: { point: { type: 'Point', coordinates: [longitude, 0] }, title },
      })
    }

    const updated = await payload.db.updateMany({
      collection,
      data: { status: 'done' },
      limit: 1,
      where: { point: { near: '0, 0, 100000' } },
    })

    expect(updated?.map((doc) => doc['title'])).toEqual(['nearest'])

    const { docs } = await payload.db.find<Task>({ collection, limit: 0, sort: 'title' })

    expect(docs.map(({ status, title }) => `${title}:${status}`)).toEqual([
      'farthest:undefined',
      'middle:undefined',
      'nearest:done',
    ])
  })

  test('a limit with a descending sort picks the other end', async () => {
    const updated = await payload.db.updateMany({
      collection,
      data: { status: 'done' },
      limit: 1,
      sort: '-rank',
      where: { status: { equals: 'open' } },
    })

    expect(updated?.map((doc) => doc['title'])).toEqual(['c'])
  })

  test('returns null when a limit finds nothing to update', async () => {
    await expect(
      payload.db.updateMany({
        collection,
        data: { status: 'done' },
        limit: 3,
        where: { title: { equals: 'missing' } },
      }),
    ).resolves.toBeNull()
  })

  test('returns an empty list when no limit is given and nothing matches', async () => {
    await expect(
      payload.db.updateMany({
        collection,
        data: { status: 'done' },
        where: { title: { equals: 'missing' } },
      }),
    ).resolves.toEqual([])
  })

  test('returning: false updates without reading the rows back', async () => {
    const result = await payload.db.updateMany({
      collection,
      data: { status: 'open' },
      returning: false,
      where: { status: { equals: 'done' } },
    })

    expect(result).toBeNull()
    expect(await rows()).toEqual(['b:1:open', 'd:2:open', 'a:3:open', 'c:4:open', 'e:5:open'])
  })

  test('sets one top-level key at a time and keeps the others', async () => {
    await payload.db.updateMany({
      collection,
      data: { meta: { label: 'x' } },
      where: { title: { equals: 'a' } },
    })
    const [doc] = (await payload.db.find<Task>({ collection, where: { title: { equals: 'a' } } }))
      .docs

    expect(doc).toMatchObject({ meta: { label: 'x' }, rank: 3, status: 'open' })
  })

  test('applies $inc and $push', async () => {
    await payload.db.updateMany({
      collection,
      data: { log: { $push: { entry: 'new' } }, rank: { $inc: 10 } },
      where: { status: { equals: 'done' } },
    })

    const { docs } = await payload.db.find<Task & { log: { entry: string }[] }>({
      collection,
      sort: 'title',
      where: { status: { equals: 'done' } },
    })

    expect(docs.map((doc) => [doc.rank, doc.log.map((row) => row.entry)])).toEqual([
      [12, ['new']],
      [15, ['new']],
    ])
  })

  test('runs inside the transaction of the request and is discarded with it', async () => {
    const id = await beginTransaction(payload)

    await payload.db.updateMany({
      collection,
      data: { status: 'done' },
      req: { transactionID: id },
      where: { status: { equals: 'open' } },
    })
    await payload.db.rollbackTransaction(id)

    expect(await rows()).toEqual(['b:1:open', 'd:2:done', 'a:3:open', 'c:4:open', 'e:5:done'])
  })
})
