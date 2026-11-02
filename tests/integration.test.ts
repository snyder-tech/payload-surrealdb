import type { Payload, Sort, Where } from 'payload'

import { buildConfig } from 'payload'
import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'vitest'

import { surrealdbAdapter } from '../src/index.js'
import { bootPayload, connectionArgs } from './helpers/payload.js'

// Payload 4 turns `versions` on for every collection; `tests/versions.test.ts` covers them, so they are off here.
const config = buildConfig({
  collections: [
    {
      slug: 'users',
      auth: true,
      fields: [{ name: 'name', type: 'text' }],
      versions: false,
    },
    {
      slug: 'numbered',
      fields: [
        { name: 'id', type: 'number' },
        { name: 'title', type: 'text' },
      ],
      versions: false,
    },
    {
      slug: 'coded',
      fields: [
        { name: 'id', type: 'text' },
        { name: 'title', type: 'text' },
      ],
      versions: false,
    },
    {
      slug: 'posts',
      fields: [
        { name: 'title', type: 'text', required: true },
        { name: 'headline', type: 'text', localized: true },
        { name: 'views', type: 'number' },
        { name: 'publishedAt', type: 'date' },
        { name: 'featured', type: 'checkbox' },
        { name: 'status', type: 'select', options: ['draft', 'published'] },
        {
          name: 'meta',
          type: 'group',
          fields: [
            { name: 'label', type: 'text' },
            { name: 'score', type: 'number' },
          ],
        },
        {
          name: 'tags',
          type: 'array',
          fields: [
            { name: 'label', type: 'text' },
            { name: 'addedAt', type: 'date' },
          ],
        },
        {
          name: 'content',
          type: 'blocks',
          blocks: [{ slug: 'quote', fields: [{ name: 'text', type: 'text' }] }],
        },
        { name: 'author', type: 'relationship', relationTo: 'users' },
        { name: 'editors', type: 'relationship', hasMany: true, relationTo: 'users' },
        { name: 'computed', type: 'text', virtual: true },
      ],
      versions: false,
    },
  ],
  db: surrealdbAdapter(connectionArgs('integration')),
  localization: { defaultLocale: 'en', locales: ['en', 'es'] },
  secret: 'test-secret',
  telemetry: false,
  typescript: { autoGenerate: false },
})

let payload: Payload

const createUser = (email = 'first@example.com') =>
  payload.create({
    collection: 'users',
    data: { name: 'First', email, password: 'correct-horse-battery' },
    overrideAccess: true,
  })

const createPost = (data: Record<string, unknown>) =>
  payload.create({
    collection: 'posts',
    data: { title: 'untitled', ...data },
    overrideAccess: true,
  })

const titles = async (where: Where, sort: Sort = 'title') => {
  const { docs } = await payload.find({
    collection: 'posts',
    limit: 0,
    overrideAccess: true,
    sort,
    where,
  })

  return docs.map((doc) => doc['title'])
}

const connection = () => {
  if (!payload.db.connection) {
    throw new Error('The adapter is not connected.')
  }

  return payload.db.connection
}

const rawRows = async (sql: string) => {
  const [rows] = await connection().query<[Record<string, unknown>[]]>(sql)
  return rows
}

beforeAll(async () => {
  payload = await bootPayload(config, 'integration')
})

beforeEach(async () => {
  await payload.db.clearDatabase()
})

afterAll(async () => {
  await payload.destroy()
})

describe('boot', () => {
  test('defines a table for every collection and the system collections', async () => {
    const [info] = await connection().query<[{ tables: Record<string, string> }]>('INFO FOR DB')

    expect(Object.keys(info.tables)).toEqual(
      expect.arrayContaining([
        'users',
        'posts',
        'payload-kv',
        'payload-locked-documents',
        'payload-migrations',
        'payload-preferences',
      ]),
    )
  })

  test('reports its name and package', () => {
    expect(payload.db.name).toBe('surrealdb')
    expect(payload.db.packageName).toBe('@snyder-tech/payload-surrealdb')
  })
})

describe('users', () => {
  test('creates the first user, logs in and finds the user again', async () => {
    const user = await createUser()

    expect(typeof user.id).toBe('string')
    expect(user['email']).toBe('first@example.com')

    const login = await payload.login({
      collection: 'users',
      data: { email: 'first@example.com', password: 'correct-horse-battery' },
    })

    expect(login.token).toEqual(expect.any(String))
    expect(login.user?.id).toBe(user.id)

    const found = await payload.find({
      collection: 'users',
      overrideAccess: true,
      where: { email: { equals: 'first@example.com' } },
    })

    expect(found.docs.map((doc) => doc.id)).toEqual([user.id])
  })

  test('rejects a wrong password and counts the failed attempt', async () => {
    const user = await createUser()

    await expect(
      payload.login({
        collection: 'users',
        data: { email: 'first@example.com', password: 'wrong' },
      }),
    ).rejects.toThrow()

    const stored = await payload.findByID({
      id: user.id,
      collection: 'users',
      overrideAccess: true,
      showHiddenFields: true,
    })

    expect(stored['loginAttempts']).toBe(1)
  })

  test('resets a password through the atomic update', async () => {
    await createUser()

    const token = await payload.forgotPassword({
      collection: 'users',
      data: { email: 'first@example.com' },
      disableEmail: true,
    })

    await payload.resetPassword({
      collection: 'users',
      data: { password: 'a-brand-new-password', token },
      overrideAccess: true,
    })

    const login = await payload.login({
      collection: 'users',
      data: { email: 'first@example.com', password: 'a-brand-new-password' },
    })

    expect(login.token).toEqual(expect.any(String))
  })
})

describe('posts', () => {
  test('round-trips every field type, with dates and relationship ids intact', async () => {
    const user = await createUser()
    const publishedAt = '2025-03-01T10:20:30.456Z'

    const created = await createPost({
      author: user.id,
      content: [{ blockType: 'quote', text: 'to be' }],
      featured: true,
      headline: 'Hello',
      meta: { label: 'm', score: 7 },
      publishedAt,
      status: 'published',
      tags: [{ addedAt: '2024-01-02T03:04:05.000Z', label: 'one' }, { label: 'two' }],
      title: 'First post',
      views: 42,
    })

    const found = await payload.findByID({
      id: created.id,
      collection: 'posts',
      depth: 0,
      overrideAccess: true,
    })

    expect(found).toMatchObject({
      id: created.id,
      author: user.id,
      content: [{ blockType: 'quote', text: 'to be' }],
      featured: true,
      headline: 'Hello',
      meta: { label: 'm', score: 7 },
      publishedAt,
      status: 'published',
      title: 'First post',
      views: 42,
    })
    expect(found['tags']).toHaveLength(2)
    expect(found['tags']?.[0]).toMatchObject({ addedAt: '2024-01-02T03:04:05.000Z', label: 'one' })
    expect(found['createdAt']).toMatch(/^\d{4}-\d{2}-\d{2}T.*Z$/)

    // Stored as the types SurrealDB can compare: a datetime and a record link, not strings.
    const [row] = await rawRows(
      'SELECT type::of(publishedAt) AS date, type::of(author) AS link, type::of(tags[0].addedAt) AS nested, type::of(createdAt) AS created FROM posts',
    )
    expect(row).toEqual({
      created: 'datetime',
      date: 'datetime',
      link: 'record',
      nested: 'datetime',
    })
  })

  test('populates a relationship at depth 1', async () => {
    const user = await createUser()
    const created = await createPost({ author: user.id })
    const found = await payload.findByID({
      id: created.id,
      collection: 'posts',
      depth: 1,
      overrideAccess: true,
    })

    expect(found['author']).toMatchObject({ id: user.id, email: 'first@example.com' })
  })

  test('creates ULID keys that sort in insertion order', async () => {
    const ids: string[] = []
    for (const title of ['a', 'b', 'c', 'd']) {
      ids.push((await createPost({ title })).id as string)
    }

    expect(ids.every((id) => /^[0-9A-Z]{26}$/.test(id))).toBe(true)

    const { docs } = await payload.find({
      collection: 'posts',
      limit: 0,
      overrideAccess: true,
      sort: 'id',
    })

    expect(docs.map((doc) => doc.id)).toEqual(ids)
  })

  test('strips keys Payload does not know on write', async () => {
    const doc = await payload.db.create({
      collection: 'posts',
      data: { title: 'strict', bogus: 'x', meta: { label: 'l', extra: 1 } },
    })

    expect(doc).not.toHaveProperty('bogus')
    expect(doc['meta']).toEqual({ label: 'l' })

    const [row] = await rawRows('SELECT * FROM posts')
    expect(row).not.toHaveProperty('bogus')
  })

  test('does not store virtual fields', async () => {
    await payload.db.create({ collection: 'posts', data: { title: 'v', computed: 'not stored' } })

    const [row] = await rawRows('SELECT * FROM posts')
    expect(row).not.toHaveProperty('computed')
  })

  test('casts values to the type of their field, as Mongoose did', async () => {
    const doc = await payload.db.create({
      collection: 'posts',
      data: {
        // The adapter is called directly, past Payload's validation
        title: 5,
        views: '12',
        // A Unix timestamp in milliseconds
        publishedAt: 1705314600000,
      },
    })

    expect(doc).toMatchObject({
      publishedAt: '2024-01-15T10:30:00.000Z',
      title: '5',
      views: 12,
    })
  })

  test('stores a single ID given for a hasMany relationship as a list of one', async () => {
    const user = await createUser()
    // The adapter is called directly, past Payload's validation
    const created = await payload.db.create({ collection: 'posts', data: { editors: user.id } })
    const [row] = await rawRows('SELECT editors FROM posts')

    expect(created).toMatchObject({ editors: [user.id] })
    expect(Array.isArray(row?.['editors'])).toBe(true)
    expect(await titles({ editors: { equals: user.id } })).toEqual([undefined])

    const updated = await payload.db.updateOne({
      collection: 'posts',
      data: { editors: null },
      id: created.id,
    })

    expect(updated).toMatchObject({ editors: null })
  })

  test('refuses a value that cannot be cast, instead of storing it', async () => {
    await expect(
      payload.db.create({ collection: 'posts', data: { title: 't', views: 'twelve' } }),
    ).rejects.toMatchObject({ status: 400 })
    await expect(
      payload.db.create({ collection: 'posts', data: { title: 't', publishedAt: 'not a date' } }),
    ).rejects.toMatchObject({ status: 400 })
  })

  test('keeps a custom ID given on create, string or number', async () => {
    const text = await payload.db.create({
      collection: 'posts',
      data: { id: 'custom-1', title: 't' },
    })
    const number = await payload.db.create({ collection: 'posts', data: { id: 9999, title: 'n' } })

    expect(text['id']).toBe('custom-1')
    expect(number['id']).toBe(9999)

    const found = await payload.db.findOne<{ id: number | string }>({
      collection: 'posts',
      where: { id: { equals: 9999 } },
    })
    expect(found?.id).toBe(9999)
  })

  test('stores null and treats it as missing', async () => {
    const created = await createPost({ title: 'nulled', views: 5 })
    const updated = await payload.update({
      id: created.id,
      collection: 'posts',
      data: { views: null },
      overrideAccess: true,
    })

    expect(updated['views']).toBeNull()
    expect(await titles({ views: { exists: false } })).toEqual(['nulled'])
    expect(await titles({ views: { equals: null } })).toEqual(['nulled'])
  })

  test('localizes a field per locale', async () => {
    const created = await createPost({ headline: 'Hello' })
    await payload.update({
      id: created.id,
      collection: 'posts',
      data: { headline: 'Hola' },
      locale: 'es',
      overrideAccess: true,
    })

    const all = await payload.findByID({
      id: created.id,
      collection: 'posts',
      locale: 'all',
      overrideAccess: true,
    })
    expect(all['headline']).toEqual({ en: 'Hello', es: 'Hola' })

    const { docs } = await payload.find({
      collection: 'posts',
      locale: 'es',
      overrideAccess: true,
      where: { headline: { equals: 'Hola' } },
    })
    expect(docs).toHaveLength(1)
  })

  describe('queries', () => {
    beforeEach(async () => {
      const user = await createUser()
      await createPost({
        author: user.id,
        featured: true,
        meta: { score: 1 },
        publishedAt: '2025-01-15T00:00:00.000Z',
        status: 'published',
        title: 'alpha',
        views: 10,
      })
      await createPost({
        featured: false,
        meta: { score: 2 },
        publishedAt: '2025-06-15T00:00:00.000Z',
        status: 'draft',
        title: 'bravo post',
        views: 20,
      })
      await createPost({ title: 'charlie' })
    })

    test('in and not_in with null treat a missing relationship like Mongo', async () => {
      const { docs: users } = await payload.find({ collection: 'users', overrideAccess: true })
      const author = users[0]?.id

      expect(await titles({ author: { in: ['zzz', null] } })).toEqual(['bravo post', 'charlie'])
      expect(await titles({ author: { not_in: [author, null] } })).toEqual([])
      expect(await titles({ author: { not_in: [author] } })).toEqual(['bravo post', 'charlie'])
    })

    test('all on a scalar field means every listed value equals the field', async () => {
      expect(await titles({ title: { all: ['alp'] } })).toEqual([])
      expect(await titles({ title: { all: ['alpha'] } })).toEqual(['alpha'])
      expect(await titles({ title: { all: ['alpha', 'alpha'] } })).toEqual(['alpha'])
      expect(await titles({ title: { all: ['alpha', 'charlie'] } })).toEqual([])
      expect(await titles({ title: { all: [] } })).toEqual([])
    })

    test('greater_than and less_than with null match nothing', async () => {
      expect(await titles({ views: { greater_than: null } })).toEqual([])
      expect(await titles({ views: { less_than: null } })).toEqual([])
    })

    test('where on text, number, date, checkbox, select, group and relationship', async () => {
      expect(await titles({ title: { equals: 'alpha' } })).toEqual(['alpha'])
      expect(await titles({ title: { not_equals: 'alpha' } })).toEqual(['bravo post', 'charlie'])
      expect(await titles({ title: { in: ['alpha', 'charlie'] } })).toEqual(['alpha', 'charlie'])
      expect(await titles({ title: { not_in: ['alpha'] } })).toEqual(['bravo post', 'charlie'])
      expect(await titles({ views: { greater_than: 10 } })).toEqual(['bravo post'])
      expect(await titles({ views: { less_than_equal: 20 } })).toEqual(['alpha', 'bravo post'])
      expect(await titles({ publishedAt: { greater_than: '2025-03-01T00:00:00.000Z' } })).toEqual([
        'bravo post',
      ])
      expect(await titles({ publishedAt: { equals: '2025-01-15T00:00:00.000Z' } })).toEqual([
        'alpha',
      ])
      expect(await titles({ featured: { equals: true } })).toEqual(['alpha'])
      expect(await titles({ status: { equals: 'draft' } })).toEqual(['bravo post'])
      expect(await titles({ 'meta.score': { equals: 2 } })).toEqual(['bravo post'])
      expect(await titles({ title: { like: 'POST' } })).toEqual(['bravo post'])
      expect(await titles({ title: { contains: 'har' } })).toEqual(['charlie'])
      expect(await titles({ views: { exists: true } })).toEqual(['alpha', 'bravo post'])

      const [author] = (await payload.find({ collection: 'users', overrideAccess: true })).docs
      expect(await titles({ author: { equals: author!.id } })).toEqual(['alpha'])
      expect(await titles({ author: { exists: false } })).toEqual(['bravo post', 'charlie'])
    })

    test('and / or', async () => {
      expect(
        await titles({ or: [{ title: { equals: 'alpha' } }, { views: { equals: 20 } }] }),
      ).toEqual(['alpha', 'bravo post'])
      expect(
        await titles({ and: [{ views: { greater_than: 5 } }, { status: { equals: 'draft' } }] }),
      ).toEqual(['bravo post'])
    })

    test('sorts ascending, descending and by several keys', async () => {
      expect(await titles({}, '-title')).toEqual(['charlie', 'bravo post', 'alpha'])
      expect(await titles({}, '-views')).toEqual(['bravo post', 'alpha', 'charlie'])
      expect(await titles({}, ['featured', 'title'])).toEqual(['charlie', 'bravo post', 'alpha'])
    })

    test('paginates and counts', async () => {
      const first = await payload.find({
        collection: 'posts',
        limit: 2,
        overrideAccess: true,
        sort: 'title',
      })
      expect(first.docs.map((doc) => doc['title'])).toEqual(['alpha', 'bravo post'])
      expect(first).toMatchObject({
        hasNextPage: true,
        hasPrevPage: false,
        limit: 2,
        page: 1,
        totalDocs: 3,
        totalPages: 2,
      })

      const second = await payload.find({
        collection: 'posts',
        limit: 2,
        overrideAccess: true,
        page: 2,
        sort: 'title',
      })
      expect(second.docs.map((doc) => doc['title'])).toEqual(['charlie'])
      expect(second).toMatchObject({ hasNextPage: false, hasPrevPage: true, page: 2 })

      const all = await payload.find({ collection: 'posts', limit: 0, overrideAccess: true })
      expect(all).toMatchObject({ limit: 3, totalDocs: 3, totalPages: 1 })

      // Bulk operations ask for no pagination and a limit, and the limit still holds
      const unpaged = await payload.db.find({
        collection: 'posts',
        limit: 2,
        pagination: false,
        sort: 'title',
      })
      expect(unpaged.docs).toHaveLength(2)
      expect(unpaged).toMatchObject({ hasNextPage: false, limit: 2, page: 1, totalDocs: 2 })

      expect(await payload.count({ collection: 'posts', overrideAccess: true })).toEqual({
        totalDocs: 3,
      })
      expect(
        await payload.count({
          collection: 'posts',
          overrideAccess: true,
          where: { views: { greater_than: 0 } },
        }),
      ).toEqual({ totalDocs: 2 })
      expect(
        await payload.count({
          collection: 'posts',
          overrideAccess: true,
          where: { title: { equals: 'nothing' } },
        }),
      ).toEqual({ totalDocs: 0 })
    })

    test('a relationship path answers positive and negative operators like Mongo', async () => {
      expect(await titles({ 'author.name': { equals: 'First' } })).toEqual(['alpha'])
      // A post without an author has no author whose name differs
      expect(await titles({ 'author.name': { not_equals: 'First' } })).toEqual([])
      expect(await titles({ 'author.name': { not_equals: 'Other' } })).toEqual(['alpha'])
    })
  })

  describe('writes', () => {
    test('updates keep the fields that were not sent', async () => {
      const created = await createPost({
        meta: { label: 'keep', score: 1 },
        title: 'before',
        views: 3,
      })
      const updated = await payload.update({
        id: created.id,
        collection: 'posts',
        data: { title: 'after' },
        overrideAccess: true,
      })

      expect(updated).toMatchObject({ meta: { label: 'keep', score: 1 }, title: 'after', views: 3 })
      expect(new Date(updated['updatedAt']).getTime()).toBeGreaterThanOrEqual(
        new Date(created['updatedAt']).getTime(),
      )
    })

    test('replaces a top-level key as a whole, never merging into it', async () => {
      const created = await createPost({ meta: { label: 'old', score: 1 } })
      const updated = await payload.db.updateOne({
        id: created.id,
        collection: 'posts',
        data: { meta: { score: 5 } },
      })

      expect(updated['meta']).toEqual({ score: 5 })
    })

    test('an atomic increment inside a group keeps the rest of the group', async () => {
      const created = await createPost({ meta: { label: 'keep', score: 1 } })

      const updated = await payload.db.updateOne({
        id: created.id,
        collection: 'posts',
        data: { meta: { score: { $inc: 4 } } },
      })

      expect(updated['meta']).toEqual({ label: 'keep', score: 5 })
    })

    test('upsert on a number ID collection creates the row under the given ID', async () => {
      const where = { id: { equals: 7 } }

      await payload.db.upsert({ collection: 'numbered', data: { id: 7, title: 'seven' }, where })
      await payload.db.upsert({ collection: 'numbered', data: { id: 7, title: 'again' }, where })

      const found = await payload.findByID({
        id: 7,
        collection: 'numbered',
        overrideAccess: true,
      })
      expect(found).toMatchObject({ id: 7, title: 'again' })
      expect(await payload.count({ collection: 'numbered', overrideAccess: true })).toEqual({
        totalDocs: 1,
      })
    })

    test('upsert takes the ID from an id equals condition when data has none', async () => {
      await payload.db.upsert({
        collection: 'numbered',
        data: { title: 'from where' },
        where: { and: [{ id: { equals: 9 } }] },
      })

      const found = await payload.findByID({ id: 9, collection: 'numbered', overrideAccess: true })
      expect(found).toMatchObject({ id: 9, title: 'from where' })
    })

    test('a number given for a text ID collection is stored as a text key', async () => {
      await payload.db.create({ collection: 'coded', data: { id: '999', title: 'text key' } })

      const found = await payload.findByID({ id: 999, collection: 'coded', overrideAccess: true })
      expect(found).toMatchObject({ id: '999', title: 'text key' })

      const created = await payload.db.create({
        collection: 'coded',
        data: { id: 555, title: 'from number' },
      })
      expect(created['id']).toBe('555')
    })

    test('deletes one document and many', async () => {
      const first = await createPost({ title: 'one' })
      await createPost({ title: 'two' })
      await createPost({ title: 'three' })

      const deleted = await payload.delete({
        id: first.id,
        collection: 'posts',
        overrideAccess: true,
      })
      expect(deleted.id).toBe(first.id)
      await expect(
        payload.findByID({ id: first.id, collection: 'posts', overrideAccess: true }),
      ).rejects.toThrow()

      const many = await payload.delete({
        collection: 'posts',
        overrideAccess: true,
        where: { title: { in: ['two', 'three'] } },
      })
      expect(many.docs).toHaveLength(2)
      expect(await payload.count({ collection: 'posts', overrideAccess: true })).toEqual({
        totalDocs: 0,
      })
    })

    test('lets exactly one of many concurrent compare-and-set updates win', async () => {
      const post = await createPost({ title: 'pending' })

      const results = await Promise.all(
        Array.from({ length: 20 }, () =>
          payload.db.updateOne({
            collection: 'posts',
            data: { title: 'processing' },
            options: { atomic: true },
            where: { and: [{ id: { equals: post.id } }, { title: { equals: 'pending' } }] },
          }),
        ),
      )

      expect(results.filter(Boolean)).toHaveLength(1)
    })

    test('applies atomic increments', async () => {
      const post = await createPost({ title: 'counter', views: 1 })

      await payload.db.updateOne({
        id: post.id,
        collection: 'posts',
        data: { views: { $inc: 4 } },
      })

      const found = await payload.findByID({
        id: post.id,
        collection: 'posts',
        overrideAccess: true,
      })
      expect(found['views']).toBe(5)
    })

    test('applies atomic array pushes and relationship pushes and removes', async () => {
      const first = await createUser()
      const second = await createUser('second@example.com')
      const post = await createPost({ title: 'ops' })
      const update = (data: Record<string, unknown>) =>
        payload.db.updateOne({ id: post.id, collection: 'posts', data })

      await update({
        editors: { $push: first.id },
        tags: { $push: { addedAt: '2024-01-02T03:04:05.000Z', label: 'x' } },
      })
      // The first ID is already there, so only the second one is added
      await update({ editors: { $push: [first.id, second.id] } })

      let found = await payload.findByID({
        id: post.id,
        collection: 'posts',
        depth: 0,
        overrideAccess: true,
      })
      expect(found['editors']).toEqual([first.id, second.id])
      expect(found['tags']).toMatchObject([{ addedAt: '2024-01-02T03:04:05.000Z', label: 'x' }])

      const [row] = await rawRows(
        'SELECT type::of(editors[0]) AS link, type::of(tags[0].addedAt) AS date FROM posts',
      )
      expect(row).toEqual({ date: 'datetime', link: 'record' })

      await update({ editors: { $remove: first.id } })
      found = await payload.findByID({
        id: post.id,
        collection: 'posts',
        depth: 0,
        overrideAccess: true,
      })
      expect(found['editors']).toEqual([second.id])
    })

    test('upserts: creates when nothing matches, updates when it does', async () => {
      const where = { title: { equals: 'upserted' } }

      const created = await payload.db.upsert({
        collection: 'posts',
        data: { title: 'upserted', views: 1 },
        where,
      })
      const updated = await payload.db.upsert({
        collection: 'posts',
        data: { title: 'upserted', views: 2 },
        where,
      })

      expect(updated['id']).toBe(created['id'])
      expect(updated['views']).toBe(2)
      expect(await payload.count({ collection: 'posts', overrideAccess: true })).toEqual({
        totalDocs: 1,
      })
    })
  })
})

describe('system collections', () => {
  test('payload-kv: set, get, has, keys, delete, clear', async () => {
    await payload.kv.set('a', { n: 1 })
    await payload.kv.set('b', 'text')
    await payload.kv.set('a', { n: 2 })

    expect(await payload.kv.get('a')).toEqual({ n: 2 })
    expect(await payload.kv.has('b')).toBe(true)
    expect(await payload.kv.has('missing')).toBe(false)
    expect((await payload.kv.keys()).toSorted()).toEqual(['a', 'b'])

    await payload.kv.delete('a')
    expect(await payload.kv.get('a')).toBeNull()

    await payload.kv.clear()
    expect(await payload.kv.keys()).toEqual([])
  })

  test('payload-preferences: upsert by key and polymorphic user', async () => {
    const user = await createUser()
    const where = {
      and: [
        { key: { equals: 'nav' } },
        { 'user.value': { equals: user.id } },
        { 'user.relationTo': { equals: 'users' } },
      ],
    }
    const data = (value: unknown) => ({
      key: 'nav',
      user: { relationTo: 'users', value: user.id },
      value,
    })

    await payload.db.upsert({
      collection: 'payload-preferences',
      data: data({ open: true }),
      where,
    })
    await payload.db.upsert({
      collection: 'payload-preferences',
      data: data({ open: false }),
      where,
    })

    const found = await payload.find({
      collection: 'payload-preferences',
      depth: 0,
      overrideAccess: true,
      where,
    })

    expect(found.totalDocs).toBe(1)
    expect(found.docs[0]).toMatchObject({ value: { open: false } })
    expect(found.docs[0]?.['user']).toEqual({ relationTo: 'users', value: user.id })

    const [row] = await rawRows('SELECT type::of(user.value) AS link FROM `payload-preferences`')
    expect(row).toEqual({ link: 'record' })
  })

  test('payload-locked-documents: lock and find by the locked document', async () => {
    const user = await createUser()
    const post = await createPost({})

    await payload.db.create({
      collection: 'payload-locked-documents',
      data: {
        document: { relationTo: 'posts', value: post.id },
        globalSlug: undefined,
        user: { relationTo: 'users', value: user.id },
      },
    })

    const found = await payload.db.find({
      collection: 'payload-locked-documents',
      where: {
        and: [
          { 'document.value': { equals: post.id } },
          { 'document.relationTo': { equals: 'posts' } },
        ],
      },
    })

    expect(found.totalDocs).toBe(1)
    expect(found.docs[0]).toMatchObject({ document: { relationTo: 'posts', value: post.id } })

    const none = await payload.db.find({
      collection: 'payload-locked-documents',
      where: { 'document.value': { equals: 'someone-else' } },
    })
    expect(none.totalDocs).toBe(0)
  })

  test('payload-migrations: record and list batches', async () => {
    await payload.db.create({ collection: 'payload-migrations', data: { name: 'a', batch: 1 } })
    await payload.db.create({ collection: 'payload-migrations', data: { name: 'b', batch: 2 } })

    const latest = await payload.db.find({
      collection: 'payload-migrations',
      limit: 1,
      sort: '-name',
    })
    expect(latest.docs[0]).toMatchObject({ name: 'b', batch: 2 })

    const status = await payload.db.find<{ id: string; name: string }>({
      collection: 'payload-migrations',
      limit: 0,
      where: { batch: { greater_than_equal: 1 } },
    })
    expect(status.docs.map((doc) => doc.name).toSorted()).toEqual(['a', 'b'])
  })
})
