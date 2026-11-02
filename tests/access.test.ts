import type { Field, Payload, Where } from 'payload'

import { buildConfig } from 'payload'
import { afterAll, beforeAll, describe, expect, test } from 'vitest'

import { surrealdbAdapter } from '../src/index.js'
import { bootPayload, connectionArgs } from './helpers/payload.js'

/**
 * Every read here goes through Payload with `overrideAccess: false` and no user, so the access
 * functions of the related collections apply. Each query is also run with `overrideAccess: true`:
 * the restricted data is there, and the filters that find it for an operator must not find it for
 * the public.
 */

const publicOnly = { read: () => ({ visibility: { equals: 'public' } }) }
const visibility: Field = { name: 'visibility', type: 'select', options: ['public', 'secret'] }

const config = buildConfig({
  collections: [
    {
      slug: 'cats',
      access: { read: () => true },
      fields: [
        { name: 'name', type: 'text' },
        { name: 'posts', type: 'join', collection: 'posts', on: 'category' },
        { name: 'mixed', type: 'join', collection: ['posts', 'notes'], on: 'category' },
      ],
      versions: false,
    },
    {
      slug: 'people',
      access: publicOnly,
      fields: [{ name: 'name', type: 'text' }, visibility],
      versions: false,
    },
    {
      slug: 'tags',
      access: publicOnly,
      fields: [{ name: 'name', type: 'text' }, visibility],
      versions: false,
    },
    {
      slug: 'notes',
      access: publicOnly,
      fields: [
        { name: 'title', type: 'text' },
        visibility,
        { name: 'category', type: 'relationship', relationTo: 'cats' },
      ],
      versions: false,
    },
    {
      slug: 'posts',
      access: publicOnly,
      fields: [
        { name: 'title', type: 'text' },
        visibility,
        { name: 'category', type: 'relationship', relationTo: 'cats' },
        { name: 'author', type: 'relationship', relationTo: 'people' },
        { name: 'tags', type: 'relationship', hasMany: true, relationTo: 'tags' },
        { name: 'ltags', type: 'relationship', hasMany: true, localized: true, relationTo: 'tags' },
        {
          name: 'items',
          type: 'array',
          fields: [{ name: 'who', type: 'relationship', relationTo: 'people' }],
        },
      ],
      versions: false,
    },
    {
      slug: 'holders',
      access: { read: () => true },
      fields: [
        { name: 'label', type: 'text' },
        {
          name: 'items',
          type: 'array',
          fields: [{ name: 'who', type: 'relationship', relationTo: 'people' }],
        },
        { name: 'tags', type: 'relationship', hasMany: true, relationTo: 'tags' },
        { name: 'ltags', type: 'relationship', hasMany: true, localized: true, relationTo: 'tags' },
      ],
      versions: false,
    },
    {
      slug: 'shelves',
      access: { read: () => true },
      fields: [
        { name: 'name', type: 'text' },
        { name: 'docs', type: 'join', collection: 'drafted', on: 'shelf' },
      ],
      versions: { drafts: true },
    },
    {
      slug: 'drafted',
      access: { read: () => ({ _status: { equals: 'published' } }) },
      fields: [
        { name: 'title', type: 'text' },
        { name: 'shelf', type: 'relationship', relationTo: 'shelves' },
      ],
      versions: { drafts: true },
    },
  ],
  db: surrealdbAdapter(connectionArgs('access')),
  localization: { defaultLocale: 'en', locales: ['en', 'es'] },
  secret: 'test-secret',
  telemetry: false,
  typescript: { autoGenerate: false },
})

let payload: Payload

const asOperator = { depth: 0, overrideAccess: true } as const
const asPublic = { depth: 0, overrideAccess: false } as const

type Page = { docs: unknown[]; hasNextPage: boolean; totalDocs?: number }

const page = (value: unknown): Page => value as Page

const ids = {
  cat: '',
  openPost: '',
  openNote: '',
  draftOnly: '',
  openDoc: '',
  shelf: '',
}

/** How many documents of `collection` the query finds, for the public and for an operator. */
const counts = async (collection: string, where: Where, locale?: 'en' | 'es') => {
  const args = { collection, ...(locale ? { locale } : {}), where }
  const [publicly, operator] = await Promise.all([
    payload.count({ ...args, overrideAccess: false }),
    payload.count({ ...args, overrideAccess: true }),
  ])

  return { operator: operator.totalDocs, public: publicly.totalDocs }
}

beforeAll(async () => {
  payload = await bootPayload(config, 'access')

  const create = (collection: string, data: Record<string, unknown>) =>
    payload.create({ collection, data, locale: 'en', ...asOperator })

  const cat = await create('cats', { name: 'c' })
  const openPerson = await create('people', { name: 'Alice', visibility: 'public' })
  const secretPerson = await create('people', { name: 'SecretBob', visibility: 'secret' })
  const openTag = await create('tags', { name: 'pubtag', visibility: 'public' })
  const secretTag = await create('tags', { name: 'secrettag', visibility: 'secret' })
  const openPost = await create('posts', {
    author: secretPerson.id,
    category: cat.id,
    items: [{ who: openPerson.id }, { who: secretPerson.id }],
    ltags: [openTag.id, secretTag.id],
    tags: [openTag.id, secretTag.id],
    title: 'public post',
    visibility: 'public',
  })

  await create('posts', { category: cat.id, title: 'SECRET POST', visibility: 'secret' })
  await create('notes', { category: cat.id, title: 'SECRET NOTE', visibility: 'secret' })

  const openNote = await create('notes', {
    category: cat.id,
    title: 'public note',
    visibility: 'public',
  })

  await create('holders', {
    items: [{ who: openPerson.id }, { who: secretPerson.id }],
    label: 'h',
    ltags: [openTag.id, secretTag.id],
    tags: [openTag.id, secretTag.id],
  })

  const shelf = await create('shelves', { _status: 'published', name: 's' })
  const openDoc = await create('drafted', { _status: 'published', shelf: shelf.id, title: 'pub' })
  const draftOnly = await payload.create({
    collection: 'drafted',
    data: { shelf: shelf.id, title: 'SECRET DRAFT' },
    draft: true,
    ...asOperator,
  })

  await payload.update({
    collection: 'drafted',
    data: { title: 'SECRET EDIT' },
    draft: true,
    id: openDoc.id,
    ...asOperator,
  })

  ids.cat = String(cat.id)
  ids.openPost = String(openPost.id)
  ids.openNote = String(openNote.id)
  ids.draftOnly = String(draftOnly.id)
  ids.openDoc = String(openDoc.id)
  ids.shelf = String(shelf.id)
})

afterAll(async () => {
  await payload.destroy()
})

// Payload puts the access constraint into the object it is given, so each read gets its own
const catJoins = () => ({ mixed: { count: true }, posts: { count: true } }) as never
const shelfJoins = () => ({ docs: { count: true } }) as never

describe('joins of a collection with access control', () => {
  test('find leaves out the restricted documents of a join and of its count', async () => {
    const { docs } = await payload.find({
      collection: 'cats',
      joins: catJoins(),
      ...asPublic,
    })

    expect(docs).toHaveLength(1)
    expect(page(docs[0]?.['posts'])).toEqual({
      docs: [ids.openPost],
      hasNextPage: false,
      totalDocs: 1,
    })
    expect(page(docs[0]?.['mixed']).totalDocs).toBe(2)
    expect(new Set(page(docs[0]?.['mixed']).docs.map((doc) => JSON.stringify(doc)))).toEqual(
      new Set([
        JSON.stringify({ relationTo: 'posts', value: ids.openPost }),
        JSON.stringify({ relationTo: 'notes', value: ids.openNote }),
      ]),
    )
  })

  test('findByID leaves them out too', async () => {
    const doc = await payload.findByID({
      collection: 'cats',
      id: ids.cat,
      joins: catJoins(),
      ...asPublic,
    })

    expect(page(doc['posts'])).toEqual({
      docs: [ids.openPost],
      hasNextPage: false,
      totalDocs: 1,
    })
    expect(page(doc['mixed']).totalDocs).toBe(2)
  })

  test('an operator sees all of them', async () => {
    const doc = await payload.findByID({
      collection: 'cats',
      id: ids.cat,
      joins: catJoins(),
      ...asOperator,
    })

    expect(page(doc['posts']).totalDocs).toBe(2)
    expect(page(doc['mixed']).totalDocs).toBe(4)
  })
})

describe('draft documents of a joined collection', () => {
  test('stay out of the join, and a draft edit hides the published document of a draft read', async () => {
    const published = await payload.find({
      collection: 'shelves',
      draft: false,
      joins: shelfJoins(),
      ...asPublic,
    })

    expect(page(published.docs[0]?.['docs'])).toEqual({
      docs: [ids.openDoc],
      hasNextPage: false,
      totalDocs: 1,
    })

    // The latest version of the document is a draft, which the access function does not allow
    const drafts = await payload.find({
      collection: 'shelves',
      draft: true,
      joins: shelfJoins(),
      ...asPublic,
    })

    expect(page(drafts.docs[0]?.['docs'])).toEqual({ docs: [], hasNextPage: false, totalDocs: 0 })
  })

  test.each([false, true])('stay out of a populated join with draft: %s', async (draft) => {
    const { docs } = await payload.find({
      collection: 'shelves',
      depth: 1,
      draft,
      joins: shelfJoins(),
      overrideAccess: false,
    })

    expect(JSON.stringify(docs[0]?.['docs'])).not.toContain('SECRET')
    expect(JSON.stringify(docs[0]?.['docs'])).not.toContain(ids.draftOnly)
  })

  test.each([false, true])('cannot be found through a join path with draft: %s', async (draft) => {
    const found = async (title: string, overrideAccess: boolean) =>
      (
        await payload.find({
          collection: 'shelves',
          depth: 0,
          draft,
          overrideAccess,
          where: { 'docs.title': { equals: title } },
        })
      ).totalDocs

    expect(await found('SECRET DRAFT', false)).toBe(0)
    expect(await found('SECRET EDIT', false)).toBe(0)
  })

  test('are found through a join path by an operator, so the misses above are the access control', async () => {
    const { totalDocs } = await payload.find({
      collection: 'shelves',
      depth: 0,
      overrideAccess: true,
      where: { 'docs.title': { equals: 'SECRET DRAFT' } },
    })

    expect(totalDocs).toBe(1)
  })
})

describe('relationship paths into a collection with access control', () => {
  test('a single relationship cannot match a restricted document', async () => {
    expect(await counts('posts', { 'author.name': { equals: 'SecretBob' } })).toEqual({
      operator: 1,
      public: 0,
    })
    expect(await counts('posts', { 'author.name': { not_equals: 'Alice' } })).toEqual({
      operator: 1,
      public: 0,
    })
  })

  test('a hasMany relationship cannot match a restricted document', async () => {
    expect(await counts('posts', { 'tags.name': { equals: 'secrettag' } })).toEqual({
      operator: 1,
      public: 0,
    })
    expect(await counts('posts', { 'tags.name': { equals: 'pubtag' } })).toEqual({
      operator: 1,
      public: 1,
    })
    expect(await counts('holders', { 'tags.name': { equals: 'secrettag' } })).toEqual({
      operator: 1,
      public: 0,
    })
  })

  test('a localized hasMany relationship cannot match a restricted document', async () => {
    expect(await counts('posts', { 'ltags.name': { equals: 'secrettag' } }, 'en')).toEqual({
      operator: 1,
      public: 0,
    })
    expect(await counts('posts', { 'ltags.name': { equals: 'pubtag' } }, 'en')).toEqual({
      operator: 1,
      public: 1,
    })
  })

  test('a join path cannot match a restricted document', async () => {
    expect(await counts('cats', { 'posts.title': { equals: 'SECRET POST' } })).toEqual({
      operator: 1,
      public: 0,
    })
    expect(await counts('cats', { 'posts.title': { equals: 'public post' } })).toEqual({
      operator: 1,
      public: 1,
    })
  })
})

/** The values found, one list however the documents hold them. */
const distinct = async (field: string, overrideAccess: boolean, locale?: 'en') => {
  const { values } = await payload.findDistinct({
    collection: 'holders',
    field,
    overrideAccess,
    ...(locale ? { locale } : {}),
  })

  return values.flatMap((value) => [value[field]].flat()).toSorted()
}

describe('findDistinct on a path into a collection with access control', () => {
  test('keeps the values of the restricted documents out of a hasMany relationship', async () => {
    expect(await distinct('tags.name', true)).toEqual(['pubtag', 'secrettag'])
    expect(await distinct('tags.name', false)).toEqual(['pubtag'])
  })

  test('keeps them out of a localized hasMany relationship', async () => {
    expect(await distinct('ltags.name', true, 'en')).toEqual(['pubtag', 'secrettag'])
    expect(await distinct('ltags.name', false, 'en')).not.toContain('secrettag')
  })

  test('keeps them out of a relationship in an array', async () => {
    expect(await distinct('items.who.name', true)).toEqual(['Alice', 'SecretBob'])
    expect(await distinct('items.who.name', false)).toEqual(['Alice'])
  })
})
