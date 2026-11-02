import type { Payload, TypeWithID } from 'payload'

import { buildConfig } from 'payload'
import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'vitest'

import { surrealdbAdapter } from '../src/index.js'
import { beginTransaction, bootPayload, connectionArgs } from './helpers/payload.js'

// Payload 4 turns `versions` on for every collection; only the ones that test drafts keep them.
const config = buildConfig({
  collections: [
    {
      slug: 'people',
      fields: [{ name: 'name', type: 'text' }],
      versions: false,
    },
    {
      slug: 'categories',
      fields: [
        { name: 'name', type: 'text' },
        { name: 'posts', type: 'join', collection: 'posts', on: 'category' },
        { name: 'few', type: 'join', collection: 'posts', defaultLimit: 1, on: 'category' },
        { name: 'items', type: 'join', collection: ['posts', 'notes'], on: 'category' },
        { name: 'articles', type: 'join', collection: 'articles', on: 'categories' },
        { name: 'drafted', type: 'join', collection: 'drafted', on: 'category' },
        { name: 'localizedPosts', type: 'join', collection: 'lposts', on: 'category' },
        {
          name: 'grp',
          type: 'group',
          fields: [{ name: 'inGroup', type: 'join', collection: 'posts', on: 'category' }],
        },
      ],
      versions: { drafts: true },
    },
    {
      slug: 'posts',
      fields: [
        { name: 'title', type: 'text' },
        { name: 'number', type: 'number' },
        { name: 'category', type: 'relationship', relationTo: 'categories' },
        { name: 'author', type: 'relationship', relationTo: 'people' },
      ],
      versions: false,
    },
    {
      slug: 'notes',
      fields: [
        { name: 'title', type: 'text' },
        { name: 'number', type: 'number' },
        { name: 'category', type: 'relationship', relationTo: 'categories' },
      ],
      versions: false,
    },
    {
      slug: 'articles',
      fields: [
        { name: 'title', type: 'text' },
        { name: 'categories', type: 'relationship', hasMany: true, relationTo: 'categories' },
      ],
      versions: false,
    },
    {
      slug: 'drafted',
      fields: [
        { name: 'title', type: 'text' },
        { name: 'category', type: 'relationship', relationTo: 'categories' },
      ],
      versions: { drafts: true },
    },
    {
      slug: 'lposts',
      fields: [
        { name: 'title', type: 'text' },
        { name: 'category', type: 'relationship', localized: true, relationTo: 'categories' },
      ],
      versions: false,
    },
  ],
  db: surrealdbAdapter(connectionArgs('joins')),
  localization: { defaultLocale: 'en', locales: ['en', 'es'] },
  secret: 'test-secret',
  telemetry: false,
  typescript: { autoGenerate: false },
})

let payload: Payload

type Page = { docs: unknown[]; hasNextPage: boolean; totalDocs?: number }
type WithPosts = TypeWithID & { posts?: Page }

const create = (
  collection: 'articles' | 'drafted' | 'lposts' | 'notes' | 'people' | 'posts',
  data: Record<string, unknown>,
  draft = false,
) => payload.create({ collection, data, depth: 0, draft, overrideAccess: true })

const category = (name: string) =>
  payload.create({ collection: 'categories', data: { name }, depth: 0, overrideAccess: true })

/** One category, read with the joins asked for. */
const joined = async (id: number | string, joins: Record<string, unknown> | false) =>
  payload.findByID({
    id,
    collection: 'categories',
    depth: 0,
    joins: joins as never,
    overrideAccess: true,
  })

const page = (value: unknown): Page => value as Page

const entry = (relationTo: string, doc: { id: number | string }) => ({
  relationTo,
  value: doc.id,
})

beforeAll(async () => {
  payload = await bootPayload(config, 'joins')
})

beforeEach(async () => {
  await payload.db.clearDatabase()
})

afterAll(async () => {
  await payload.destroy()
})

describe('join fields', () => {
  test('hold the IDs of the joined documents, paged per parent', async () => {
    const big = await category('big')
    const small = await category('small')
    const empty = await category('empty')
    const bigPosts = []

    for (const title of ['a', 'b', 'c', 'd', 'e']) {
      bigPosts.push(await create('posts', { category: big.id, title }))
    }
    const smallPost = await create('posts', { category: small.id, title: 'z' })

    const joins = { posts: { count: true, limit: 2, sort: 'title' } }
    const first = await joined(big.id, joins)

    expect(first['posts']).toEqual({
      docs: [bigPosts[0]?.id, bigPosts[1]?.id],
      hasNextPage: true,
      totalDocs: 5,
    })

    // Each parent has its own page and its own total, in the same request
    const { docs } = await payload.find({
      collection: 'categories',
      depth: 0,
      joins: joins as never,
      overrideAccess: true,
      sort: 'name',
    })
    const byName = Object.fromEntries(docs.map((doc) => [doc['name'], doc['posts']]))

    expect(byName).toEqual({
      big: { docs: [bigPosts[0]?.id, bigPosts[1]?.id], hasNextPage: true, totalDocs: 5 },
      empty: { docs: [], hasNextPage: false, totalDocs: 0 },
      small: { docs: [smallPost.id], hasNextPage: false, totalDocs: 1 },
    })
    expect(empty.id).toBeDefined()

    const last = await joined(big.id, { posts: { count: true, limit: 2, page: 3, sort: 'title' } })
    expect(last['posts']).toEqual({ docs: [bigPosts[4]?.id], hasNextPage: false, totalDocs: 5 })

    const middle = await joined(big.id, { posts: { limit: 2, page: 2, sort: 'title' } })
    expect(middle['posts']).toEqual({
      docs: [bigPosts[2]?.id, bigPosts[3]?.id],
      hasNextPage: true,
    })
  })

  test('sort, where and limit 0 apply to the joined documents', async () => {
    const parent = await category('parent')
    const created = []

    for (const [title, number] of [
      ['a', 3],
      ['b', 1],
      ['c', 2],
    ] as const) {
      created.push(await create('posts', { category: parent.id, number, title }))
    }

    const byNumber = await joined(parent.id, { posts: { limit: 0, sort: '-number' } })
    expect(byNumber['posts']).toEqual({
      docs: [created[0]?.id, created[2]?.id, created[1]?.id],
      hasNextPage: false,
    })

    const filtered = await joined(parent.id, {
      posts: { count: true, sort: 'title', where: { number: { greater_than: 1 } } },
    })
    expect(filtered['posts']).toEqual({
      docs: [created[0]?.id, created[2]?.id],
      hasNextPage: false,
      totalDocs: 2,
    })
  })

  test('use the default limit of the join and of the collection', async () => {
    const parent = await category('parent')

    for (const title of ['a', 'b', 'c']) {
      await create('posts', { category: parent.id, title })
    }

    const doc = await joined(parent.id, {})
    expect(page(doc['few'])).toMatchObject({ hasNextPage: true })
    expect(page(doc['few']).docs).toHaveLength(1)
    expect(page(doc['posts']).docs).toHaveLength(3)
  })

  test('can be turned off, and stay out of a select that leaves them out', async () => {
    const parent = await category('parent')
    await create('posts', { category: parent.id, title: 'a' })

    expect(await joined(parent.id, false)).not.toHaveProperty('posts')
    expect(await joined(parent.id, { posts: false })).not.toHaveProperty('posts')
    expect(await joined(parent.id, {})).toHaveProperty('posts')

    const selected = await payload.db.findOne<WithPosts>({
      collection: 'categories',
      select: { name: true },
      where: { id: { equals: parent.id } },
    })
    expect(selected).not.toHaveProperty('posts')

    const withJoin = await payload.db.findOne<WithPosts>({
      collection: 'categories',
      select: { posts: true },
      where: { id: { equals: parent.id } },
    })
    expect(page(withJoin?.posts).docs).toHaveLength(1)
  })

  test('filter on a path through a relationship', async () => {
    const parent = await category('parent')
    const ann = await create('people', { name: 'ann' })
    const bob = await create('people', { name: 'bob' })
    const byAnn = await create('posts', { author: ann.id, category: parent.id, title: 'ann post' })
    await create('posts', { author: bob.id, category: parent.id, title: 'bob post' })
    await create('posts', { category: parent.id, title: 'orphan' })

    const doc = await joined(parent.id, {
      posts: { count: true, where: { 'author.name': { equals: 'ann' } } },
    })
    expect(doc['posts']).toEqual({ docs: [byAnn.id], hasNextPage: false, totalDocs: 1 })

    const negative = await joined(parent.id, {
      posts: { count: true, where: { 'author.name': { not_equals: 'ann' } } },
    })
    expect(page(negative['posts']).totalDocs).toBe(1)
  })

  test('sort by a path through a relationship', async () => {
    const parent = await category('parent')
    const ann = await create('people', { name: 'ann' })
    const bob = await create('people', { name: 'bob' })
    const first = await create('posts', { author: bob.id, category: parent.id, title: 'x' })
    const second = await create('posts', { author: ann.id, category: parent.id, title: 'y' })

    const doc = await joined(parent.id, { posts: { sort: 'author.name' } })
    expect(page(doc['posts']).docs).toEqual([second.id, first.id])
  })

  test('hold a join to a hasMany relationship', async () => {
    const one = await category('one')
    const two = await category('two')
    const both = await create('articles', { categories: [one.id, two.id], title: 'both' })
    const onlyTwo = await create('articles', { categories: [two.id], title: 'two' })

    expect(page((await joined(one.id, {}))['articles']).docs).toEqual([both.id])
    expect(page((await joined(two.id, { articles: { sort: 'title' } }))['articles'])).toEqual({
      docs: [both.id, onlyTwo.id],
      hasNextPage: false,
    })
  })

  test('hold a join placed inside a group', async () => {
    const parent = await category('parent')
    const post = await create('posts', { category: parent.id, title: 'a' })

    const doc = await joined(parent.id, {})
    expect(doc['grp']).toEqual({ inGroup: { docs: [post.id], hasNextPage: false } })
  })

  test('are read for findOne and for find alike', async () => {
    const parent = await category('parent')
    const post = await create('posts', { category: parent.id, title: 'a' })

    const one = await payload.db.findOne<WithPosts>({
      collection: 'categories',
      where: { id: { equals: parent.id } },
    })
    expect(page(one?.posts).docs).toEqual([post.id])

    const many = await payload.db.find<WithPosts>({ collection: 'categories', where: {} })
    expect(page(many.docs[0]?.posts).docs).toEqual([post.id])
  })

  test('are read inside a transaction, including its uncommitted writes', async () => {
    const parent = await category('parent')
    const transactionID = await beginTransaction(payload)
    const req = { transactionID }

    try {
      const post = await payload.create({
        collection: 'posts',
        data: { category: parent.id, title: 'uncommitted' },
        depth: 0,
        overrideAccess: true,
        req,
      })
      const inside = await payload.findByID({
        id: parent.id,
        collection: 'categories',
        depth: 0,
        overrideAccess: true,
        req,
      })
      const outside = await joined(parent.id, {})

      expect(page(inside['posts']).docs).toEqual([post.id])
      expect(page(outside['posts']).docs).toEqual([])
    } finally {
      await payload.db.rollbackTransaction(transactionID)
    }
  })
})

describe('polymorphic join fields', () => {
  test('hold { relationTo, value } sorted and paged across the collections', async () => {
    const parent = await category('parent')
    const other = await category('other')
    const a = await create('posts', { category: parent.id, number: 1, title: 'a' })
    const b = await create('notes', { category: parent.id, number: 2, title: 'b' })
    const c = await create('posts', { category: parent.id, number: 3, title: 'c' })
    const d = await create('notes', { category: parent.id, number: 4, title: 'd' })
    await create('notes', { category: other.id, number: 9, title: 'elsewhere' })

    const all = await joined(parent.id, { items: { count: true, limit: 0, sort: 'number' } })

    expect(all['items']).toEqual({
      docs: [entry('posts', a), entry('notes', b), entry('posts', c), entry('notes', d)],
      hasNextPage: false,
      totalDocs: 4,
    })

    const second = await joined(parent.id, {
      items: { count: true, limit: 2, page: 2, sort: 'number' },
    })
    expect(second['items']).toEqual({
      docs: [entry('posts', c), entry('notes', d)],
      hasNextPage: false,
      totalDocs: 4,
    })

    const descending = await joined(parent.id, { items: { limit: 3, sort: '-number' } })
    expect(descending['items']).toEqual({
      docs: [entry('notes', d), entry('posts', c), entry('notes', b)],
      hasNextPage: true,
    })
  })

  test('filter on relationTo and on fields', async () => {
    const parent = await category('parent')
    const a = await create('posts', { category: parent.id, number: 1, title: 'a' })
    await create('notes', { category: parent.id, number: 2, title: 'b' })

    const onlyPosts = await joined(parent.id, {
      items: { count: true, where: { relationTo: { equals: 'posts' } } },
    })
    expect(onlyPosts['items']).toEqual({
      docs: [{ relationTo: 'posts', value: a.id }],
      hasNextPage: false,
      totalDocs: 1,
    })

    const listed = await joined(parent.id, {
      items: { count: true, where: { relationTo: { in: 'notes,tags' } } },
    })
    expect(page(listed['items']).totalDocs).toBe(1)

    const excluded = await joined(parent.id, {
      items: {
        count: true,
        where: { relationTo: { not_equals: 'posts' }, number: { exists: true } },
      },
    })
    expect(page(excluded['items']).docs).toHaveLength(1)

    const byField = await joined(parent.id, {
      items: { count: true, where: { title: { equals: 'a' } } },
    })
    expect(page(byField['items']).docs).toEqual([{ relationTo: 'posts', value: a.id }])
  })
})

describe('join fields of drafts', () => {
  test('read the latest version, and the parent of it, when drafts are asked for', async () => {
    const parent = await category('parent')
    const doc = await create('drafted', { category: parent.id, title: 'published' })

    await payload.update({
      id: doc.id,
      collection: 'drafted',
      data: { title: 'draft title' },
      depth: 0,
      draft: true,
      overrideAccess: true,
    })

    const published = await joined(parent.id, {
      drafted: { where: { title: { equals: 'published' } } },
    })
    expect(page(published['drafted']).docs).toEqual([doc.id])

    const publishedOnly = await joined(parent.id, {
      drafted: { where: { title: { equals: 'draft title' } } },
    })
    expect(page(publishedOnly['drafted']).docs).toEqual([])

    const asDraft = await payload.findByID({
      id: parent.id,
      collection: 'categories',
      depth: 0,
      draft: true,
      joins: { drafted: { count: true, where: { title: { equals: 'draft title' } } } } as never,
      overrideAccess: true,
    })
    expect(asDraft['drafted']).toEqual({ docs: [doc.id], hasNextPage: false, totalDocs: 1 })

    const draftMiss = await payload.findByID({
      id: parent.id,
      collection: 'categories',
      depth: 0,
      draft: true,
      joins: { drafted: { where: { title: { equals: 'published' } } } } as never,
      overrideAccess: true,
    })
    expect(page(draftMiss['drafted']).docs).toEqual([])
  })

  test('are placed on the draft listing of the parent collection', async () => {
    const parent = await category('parent')
    const post = await create('posts', { category: parent.id, title: 'a' })
    const item = await create('notes', { category: parent.id, title: 'n' })

    const { docs } = await payload.find({
      collection: 'categories',
      depth: 0,
      draft: true,
      joins: { items: { count: true, sort: 'title' }, posts: { count: true } } as never,
      overrideAccess: true,
    })

    expect(docs).toHaveLength(1)
    expect(docs[0]?.['id']).toBe(parent.id)
    expect(docs[0]?.['posts']).toEqual({ docs: [post.id], hasNextPage: false, totalDocs: 1 })
    expect(docs[0]?.['items']).toEqual({
      docs: [
        { relationTo: 'posts', value: post.id },
        { relationTo: 'notes', value: item.id },
      ],
      hasNextPage: false,
      totalDocs: 2,
    })
  })
})

describe('localized join fields', () => {
  test('follow the locale, and `all` reads every locale', async () => {
    const parent = await category('parent')
    const doc = await payload.create({
      collection: 'lposts',
      data: { title: 'only english' },
      depth: 0,
      locale: 'en',
      overrideAccess: true,
    })

    await payload.update({
      id: doc.id,
      collection: 'lposts',
      data: { category: parent.id },
      depth: 0,
      locale: 'en',
      overrideAccess: true,
    })

    const english = await payload.findByID({
      id: parent.id,
      collection: 'categories',
      depth: 0,
      locale: 'en',
      overrideAccess: true,
    })
    const spanish = await payload.findByID({
      id: parent.id,
      collection: 'categories',
      depth: 0,
      locale: 'es',
      overrideAccess: true,
    })
    const all = await payload.findByID({
      id: parent.id,
      collection: 'categories',
      depth: 0,
      locale: 'all',
      overrideAccess: true,
    })

    expect(page(english['localizedPosts']).docs).toEqual([doc.id])
    expect(page(spanish['localizedPosts']).docs).toEqual([])
    expect(all['localizedPosts']).toEqual({
      en: { docs: [doc.id], hasNextPage: false },
      es: { docs: [], hasNextPage: false },
    })
  })
})
