import type { Payload } from 'payload'

import { buildConfig } from 'payload'
import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'vitest'

import { surrealdbAdapter } from '../src/index.js'
import { bootPayload, connectionArgs } from './helpers/payload.js'

const config = buildConfig({
  collections: [
    { slug: 'categories', fields: [{ name: 'title', type: 'text' }], versions: false },
    { slug: 'simple', fields: [{ name: 'title', type: 'text' }], versions: false },
    {
      slug: 'posts',
      fields: [
        {
          name: 'nested',
          type: 'group',
          fields: [
            {
              name: 'localizedRelations',
              type: 'relationship',
              hasMany: true,
              localized: true,
              relationTo: ['categories', 'simple'],
            },
            { name: 'relations', type: 'relationship', hasMany: true, relationTo: 'categories' },
            { name: 'count', type: 'number' },
            { name: 'note', type: 'text' },
            { name: 'rows', type: 'array', fields: [{ name: 'label', type: 'text' }] },
          ],
        },
      ],
      versions: false,
    },
  ],
  db: surrealdbAdapter(connectionArgs('atomicpaths')),
  localization: { defaultLocale: 'en', locales: ['en', 'es'] },
  secret: 'test-secret',
  telemetry: false,
  typescript: { autoGenerate: false },
})

let payload: Payload

const category = async (title: string) =>
  (
    await payload.create({
      collection: 'categories',
      data: { title },
      depth: 0,
      overrideAccess: true,
    })
  ).id

const relation = (value: number | string) => ({ relationTo: 'categories', value })

const update = (id: number | string, data: Record<string, unknown>) =>
  payload.db.updateOne({ id, collection: 'posts', data })

const nestedOf = async (id: number | string, locale: 'en' | 'es' = 'en') => {
  const post = await payload.findByID({
    id,
    collection: 'posts',
    depth: 0,
    locale,
    overrideAccess: true,
  })

  return post['nested']
}

beforeAll(async () => {
  payload = await bootPayload(config, 'atomicpaths')
})

beforeEach(async () => {
  await payload.db.deleteMany({ collection: 'posts', where: {} })
})

afterAll(async () => {
  await payload.destroy()
})

describe('an atomic operation under a dotted key', () => {
  test('$push on a nested localized polymorphic relationship', async () => {
    const first = await category('first')
    const second = await category('second')
    const post = await payload.create({
      collection: 'posts',
      data: { nested: { localizedRelations: [{ relationTo: 'categories', value: first }] } },
      locale: 'en',
      overrideAccess: true,
    })

    await update(post.id, {
      'nested.localizedRelations': {
        en: { $push: [{ relationTo: 'categories', value: second }] },
      },
    })

    expect(await nestedOf(post.id)).toMatchObject({
      localizedRelations: [
        { relationTo: 'categories', value: first },
        { relationTo: 'categories', value: second },
      ],
    })
  })

  test('$remove on a nested localized polymorphic relationship, keeping the other locale', async () => {
    const first = await category('first')
    const second = await category('second')
    const third = await category('third')
    const post = await payload.create({
      collection: 'posts',
      data: {
        nested: { localizedRelations: [relation(first), relation(second), relation(third)] },
      },
      locale: 'en',
      overrideAccess: true,
    })

    await payload.update({
      id: post.id,
      collection: 'posts',
      data: { nested: { localizedRelations: [relation(third)] } },
      locale: 'es',
      overrideAccess: true,
    })
    await update(post.id, {
      'nested.localizedRelations': { en: { $remove: [relation(first), relation(third)] } },
    })

    expect(await nestedOf(post.id)).toMatchObject({ localizedRelations: [relation(second)] })
    expect(await nestedOf(post.id, 'es')).toMatchObject({ localizedRelations: [relation(third)] })
  })

  test('$push on a non-localized nested relationship does not repeat an ID', async () => {
    const first = await category('first')
    const second = await category('second')
    const post = await payload.create({
      collection: 'posts',
      data: { nested: { relations: [first] } },
      overrideAccess: true,
    })

    await update(post.id, { 'nested.relations': { $push: [first, second] } })

    expect(await nestedOf(post.id)).toMatchObject({ relations: [first, second] })
  })

  test('$push on a nested array and $inc on a nested number', async () => {
    const post = await payload.create({
      collection: 'posts',
      data: { nested: { count: 1, rows: [{ label: 'a' }] } },
      overrideAccess: true,
    })

    await update(post.id, {
      'nested.count': { $inc: 4 },
      'nested.rows': { $push: { label: 'b' } },
    })

    expect(await nestedOf(post.id)).toMatchObject({
      count: 5,
      rows: [{ label: 'a' }, { label: 'b' }],
    })
  })

  test('leaves the siblings of the group alone', async () => {
    const first = await category('first')
    const post = await payload.create({
      collection: 'posts',
      data: { nested: { note: 'kept', relations: [] } },
      overrideAccess: true,
    })

    await update(post.id, { 'nested.relations': { $push: [first] } })

    expect(await nestedOf(post.id)).toMatchObject({ note: 'kept', relations: [first] })
  })

  test('is not written as a field of its own', async () => {
    const first = await category('first')
    const post = await payload.create({
      collection: 'posts',
      data: { nested: { relations: [] } },
      overrideAccess: true,
    })

    await update(post.id, { 'nested.relations': { $push: [first] } })

    const [rows] = (await payload.db.connection?.query<[Record<string, unknown>[]]>(
      'SELECT * FROM posts',
    )) ?? [[]]

    expect(Object.keys(rows?.[0] ?? {}).filter((key) => key.includes('.'))).toEqual([])
  })
})
