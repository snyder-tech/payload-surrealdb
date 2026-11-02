import type { Payload, ValidationError, Where } from 'payload'

import { buildConfig } from 'payload'
import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'vitest'

import type { SurrealDBAdapter } from '../src/index.js'

import { surrealdbAdapter } from '../src/index.js'
import { handleError } from '../src/utilities/handleError.js'
import { bootPayload, connectionArgs } from './helpers/payload.js'

const collection = 'uniques'

// Payload 4 turns `versions` on for every collection; these tests do not use versions, so they are off.
const config = buildConfig({
  collections: [
    { slug: 'users', auth: true, fields: [], versions: false },
    {
      slug: collection,
      fields: [
        { name: 'slug', type: 'text', unique: true },
        { name: 'title', type: 'text', localized: true, unique: true },
        { name: 'meta', type: 'group', fields: [{ name: 'code', type: 'text', unique: true }] },
        { name: 'a', type: 'text' },
        { name: 'b', type: 'text' },
        { name: 'note', type: 'text' },
        { name: 'owner', type: 'relationship', relationTo: ['users', 'uniques'], unique: true },
        { name: 'items', type: 'array', fields: [{ name: 'sku', type: 'text', unique: true }] },
        { name: 'editors', type: 'relationship', hasMany: true, relationTo: 'users', unique: true },
        {
          name: 'sponsors',
          type: 'relationship',
          hasMany: true,
          relationTo: ['users', 'uniques'],
          unique: true,
        },
      ],
      indexes: [{ fields: ['a', 'b'], unique: true }],
      versions: false,
    },
  ],
  db: surrealdbAdapter(connectionArgs('unique')),
  localization: { defaultLocale: 'en', locales: ['en', 'pt-BR'] },
  secret: 'test-secret',
  telemetry: false,
  typescript: { autoGenerate: false },
})

let payload: Payload

const create = (data: Record<string, unknown>) => payload.db.create({ collection, data })

const sponsor = (value: string) => ({ relationTo: 'users', value })

const violation = async (promise: Promise<unknown>) => {
  const error = (await promise.then(
    () => undefined,
    (caught: unknown) => caught,
  )) as ValidationError | undefined

  expect(error).toBeDefined()
  expect(error).toHaveProperty('name', 'ValidationError')

  return error!
}

beforeAll(async () => {
  payload = await bootPayload(config, 'unique')
})

beforeEach(async () => {
  await payload.db.deleteMany({ collection, where: {} })
  await payload.db.deleteMany({ collection: 'users', where: {} })
})

afterAll(async () => {
  await payload.destroy()
})

describe('a unique violation becomes a ValidationError on the field', () => {
  test('top level field', async () => {
    await create({ slug: 'same' })
    const error = await violation(create({ slug: 'same' }))

    expect(error.data.collection).toBe(collection)
    expect(error.data.errors).toEqual([{ message: 'Value must be unique', path: 'slug' }])
    expect(error.message).toBe('The following field is invalid: slug')
  })

  test('field inside a group', async () => {
    await create({ meta: { code: 'x' } })
    const error = await violation(create({ meta: { code: 'x' } }))

    expect(error.data.errors).toEqual([{ message: 'Value must be unique', path: 'meta.code' }])
  })

  test.each(['en', 'pt-BR'])('localized field, in locale %s', async (locale) => {
    await create({ title: { [locale]: 'same' } })
    const error = await violation(create({ title: { [locale]: 'same' } }))

    expect(error.data.errors).toEqual([{ message: 'Value must be unique', path: 'title' }])
  })

  test('the same value in another locale is not a violation', async () => {
    await create({ title: { en: 'same' } })

    await expect(create({ title: { 'pt-BR': 'same' } })).resolves.toBeDefined()
  })

  test('a polymorphic relationship, reported on the field and not on its value', async () => {
    const owner = { relationTo: 'users', value: 'someone' }
    await create({ owner })
    const error = await violation(create({ owner }))

    expect(error.data.errors).toEqual([{ message: 'Value must be unique', path: 'owner' }])
  })

  test('a hasMany relationship, per related document across rows', async () => {
    const [a, b] = await Promise.all(
      ['a', 'b'].map((name) =>
        payload.db.create({ collection: 'users', data: { email: `${name}@example.com` } }),
      ),
    )

    await create({ editors: [a?.id, b?.id] })
    await create({ editors: [] })
    await create({ editors: [] })

    const error = await violation(create({ editors: [b?.id] }))

    expect(error.data.errors).toEqual([{ message: 'Value must be unique', path: 'editors' }])
  })

  test('a polymorphic hasMany relationship, per related document across rows', async () => {
    await create({ sponsors: [sponsor('x'), sponsor('y')] })
    await create({ sponsors: [] })
    await create({ sponsors: [] })

    const error = await violation(create({ sponsors: [sponsor('y'), sponsor('z')] }))

    expect(error.data.errors).toEqual([{ message: 'Value must be unique', path: 'sponsors' }])
  })

  test('compound index, reported on its first field', async () => {
    await create({ a: '1', b: '2' })
    await create({ a: '1', b: '3' })
    const error = await violation(create({ a: '1', b: '2' }))

    expect(error.data.errors).toEqual([{ message: 'Value must be unique', path: 'a' }])
  })

  test('an update that collides', async () => {
    await create({ slug: 'taken' })
    const { id } = await create({ slug: 'free' })
    const error = await violation(payload.db.updateOne({ id, collection, data: { slug: 'taken' } }))

    expect(error.data.errors).toEqual([{ message: 'Value must be unique', path: 'slug' }])
  })

  test('an updateMany that collides', async () => {
    await create({ note: 'n', slug: 'one' })
    await create({ note: 'n', slug: 'two' })
    const error = await violation(
      payload.db.updateMany({
        collection,
        data: { slug: 'both' },
        where: { note: { equals: 'n' } },
      }),
    )

    expect(error.data.errors).toEqual([{ message: 'Value must be unique', path: 'slug' }])
  })

  test('an upsert that creates a colliding record', async () => {
    await create({ meta: { code: 'x' } })
    const error = await violation(
      payload.db.upsert({
        collection,
        data: { meta: { code: 'x' }, slug: 'fresh' },
        where: { slug: { equals: 'fresh' } },
      }),
    )

    expect(error.data.errors).toEqual([{ message: 'Value must be unique', path: 'meta.code' }])
  })

  test('a record ID that is already taken', async () => {
    await payload.db.create({ collection, customID: 'taken', data: {} })
    const error = await violation(payload.db.create({ collection, customID: 'taken', data: {} }))

    expect(error.data.errors).toEqual([{ message: 'Value must be unique', path: 'id' }])
  })

  test('a missing value never collides', async () => {
    await create({ note: 'one' })

    await expect(create({ note: 'two' })).resolves.toBeDefined()
  })

  test('a field inside an array is not unique across records', async () => {
    await create({ items: [{ sku: 'same' }] })

    await expect(create({ items: [{ sku: 'same' }] })).resolves.toBeDefined()
  })
})

describe('a unique hasMany relationship compares the stored links across documents only', () => {
  const user = async (name: string) =>
    (await payload.db.create({ collection: 'users', data: { email: `${name}@example.com` } })).id

  const titles = async (where: Where) => {
    const { docs } = await payload.db.find<{ id: string; slug?: string }>({
      collection,
      limit: 0,
      sort: 'slug',
      where,
    })

    return docs.map(({ slug }) => slug)
  }

  test('one document may link the same target twice', async () => {
    const [a, b] = [await user('a'), await user('b')]

    await expect(create({ editors: [a, a] })).resolves.toBeDefined()
    await expect(
      create({ sponsors: [sponsor('x'), sponsor('x')], slug: 'twice' }),
    ).resolves.toBeDefined()

    const error = await violation(create({ editors: [b, a] }))

    expect(error.data.errors).toEqual([{ message: 'Value must be unique', path: 'editors' }])

    const polymorphic = await violation(create({ sponsors: [sponsor('y'), sponsor('x')] }))

    expect(polymorphic.data.errors).toEqual([{ message: 'Value must be unique', path: 'sponsors' }])
  })

  test('still enforced after the target is deleted, and does not follow the link', async () => {
    const [a, b] = [await user('a'), await user('b')]

    await create({ editors: [b], sponsors: [sponsor('gone')] })
    await payload.db.deleteOne({ collection: 'users', where: { id: { equals: b } } })

    expect((await violation(create({ editors: [b, a] }))).data.errors).toEqual([
      { message: 'Value must be unique', path: 'editors' },
    ])
    await violation(create({ sponsors: [sponsor('gone')] }))
  })

  test('a link to a target that never existed is enforced as well', async () => {
    await create({ editors: ['ghost'] })

    await violation(create({ editors: ['ghost'] }))
  })

  test('a document without the list, or with it null, never clashes', async () => {
    await create({ slug: 'one' })
    await create({ slug: 'two' })
    await payload.db.connection?.query(
      'CREATE type::record($table, "raw1") SET editors = NULL; CREATE type::record($table, "raw2") SET editors = NULL',
      { table: collection },
    )

    await expect(create({ slug: 'three', editors: [] })).resolves.toBeDefined()
  })

  test('the list operators are not affected by the index', async () => {
    const [a, b, c] = [await user('a'), await user('b'), await user('c')]

    await create({ editors: [a, b], slug: 'ab' })
    await create({ editors: [c], slug: 'c' })
    await create({ editors: [], slug: 'none' })

    expect(await titles({ editors: { contains: a } })).toEqual(['ab'])
    expect(await titles({ editors: { equals: c } })).toEqual(['c'])
    expect(await titles({ editors: { in: [a, c] } })).toEqual(['ab', 'c'])
    expect(await titles({ editors: { all: [a, b] } })).toEqual(['ab'])
    expect(await titles({ editors: { not_in: [a] } })).toEqual(['c', 'none'])
    expect(await titles({ editors: { not_equals: a } })).toEqual(['c', 'none'])
    expect(await titles({ editors: { exists: true } })).toEqual(['ab', 'c', 'none'])
  })
})

describe('concurrent upserts of one unique key', () => {
  test('leave one record and none of them fails', async () => {
    const results = await Promise.allSettled(
      Array.from({ length: 20 }, (_, n) =>
        payload.db.upsert({
          collection,
          data: { note: `writer-${n}`, slug: 'contended' },
          where: { slug: { equals: 'contended' } },
        }),
      ),
    )

    expect(results.filter((result) => result.status === 'rejected')).toEqual([])

    const { docs } = await payload.db.find({
      collection,
      limit: 0,
      where: { slug: { equals: 'contended' } },
    })
    expect(docs).toHaveLength(1)
  })
})

describe('concurrent upserts of a key without a unique index', () => {
  // Nothing conflicts, so racing upserts that all find nothing all create, as Mongo's upsert does.
  // Callers that need exactly one row put a unique index on the field.
  test('never fail, and each leaves a record', async () => {
    const results = await Promise.allSettled(
      Array.from({ length: 20 }, (_, n) =>
        payload.db.upsert({
          collection,
          data: { a: 'plain', note: 'contended', b: `writer-${n}` },
          where: { note: { equals: 'contended' } },
        }),
      ),
    )

    expect(results.filter((result) => result.status === 'rejected')).toEqual([])

    const { docs } = await payload.db.find({
      collection,
      limit: 0,
      where: { note: { equals: 'contended' } },
    })
    expect(docs.length).toBeGreaterThanOrEqual(1)
    expect(docs.length).toBeLessThanOrEqual(20)
  })
})

describe('errors that are not unique violations', () => {
  test.each([
    ['a THROW', 'THROW "boom"'],
    ['a parse error', 'SELEC nothing FROM'],
  ])('%s passes through handleError unchanged', async (_name, sql) => {
    const error = await payload.db.connection!.query(sql).then(
      () => undefined,
      (caught: unknown) => caught,
    )
    expect(error).toBeInstanceOf(Error)

    expect(() => handleError({ adapter: payload.db as SurrealDBAdapter, error })).toThrow(
      error as Error,
    )
    try {
      handleError({ adapter: payload.db as SurrealDBAdapter, error })
    } catch (rethrown) {
      expect(rethrown).toBe(error)
    }
  })
})
