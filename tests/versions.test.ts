import type { Payload } from 'payload'

import { APIError, buildConfig } from 'payload'
import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'vitest'

import { surrealdbAdapter } from '../src/index.js'
import { beginTransaction, bootPayload, connectionArgs } from './helpers/payload.js'

const config = buildConfig({
  collections: [
    {
      slug: 'users',
      auth: true,
      fields: [{ name: 'name', type: 'text' }],
      versions: false,
    },
    {
      slug: 'articles',
      fields: [
        { name: 'title', type: 'text', localized: true },
        { name: 'rank', type: 'number' },
        { name: 'body', type: 'text' },
        {
          name: 'group',
          type: 'group',
          fields: [
            { name: 'note', type: 'text' },
            { name: 'extra', type: 'text' },
          ],
        },
        {
          name: 'items',
          type: 'array',
          fields: [
            { name: 'label', type: 'text' },
            { name: 'detail', type: 'text' },
          ],
        },
        {
          name: 'layout',
          type: 'blocks',
          blocks: [
            {
              slug: 'quote',
              fields: [
                { name: 'text', type: 'text' },
                { name: 'cite', type: 'text' },
              ],
            },
          ],
        },
      ],
      versions: { drafts: { autosave: true }, maxPerDoc: 0 },
    },
    {
      slug: 'plain',
      fields: [{ name: 'title', type: 'text' }],
      versions: { maxPerDoc: 0 },
    },
    {
      slug: 'capped',
      fields: [{ name: 'title', type: 'text' }],
      versions: { drafts: true, maxPerDoc: 2 },
    },
  ],
  db: surrealdbAdapter(connectionArgs('versions')),
  globals: [
    {
      slug: 'settings',
      fields: [
        { name: 'siteName', type: 'text', localized: true },
        { name: 'tagline', type: 'text' },
        {
          name: 'social',
          type: 'group',
          fields: [
            { name: 'handle', type: 'text' },
            { name: 'url', type: 'text' },
          ],
        },
      ],
      versions: { drafts: true },
    },
    {
      slug: 'footer',
      fields: [{ name: 'text', type: 'text' }],
    },
    {
      slug: 'cappedNotice',
      fields: [{ name: 'text', type: 'text' }],
      versions: { drafts: true, max: 2 },
    },
  ],
  localization: { defaultLocale: 'en', locales: ['en', 'es'] },
  secret: 'test-secret',
  telemetry: false,
  typescript: { autoGenerate: false },
})

let payload: Payload

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

const createArticle = (data: Record<string, unknown> = {}, draft = false) =>
  payload.create({
    collection: 'articles',
    data: { title: 'first', ...data },
    draft,
    overrideAccess: true,
  })

const saveDraft = (id: number | string, data: Record<string, unknown>, autosave = false) =>
  payload.update({
    id,
    autosave,
    collection: 'articles',
    data,
    draft: true,
    overrideAccess: true,
  })

const versionsOf = async (id: number | string) =>
  (
    await payload.findVersions({
      collection: 'articles',
      limit: 0,
      overrideAccess: true,
      sort: 'updatedAt',
      where: { parent: { equals: id } },
    })
  ).docs

const latestVersions = (id: number | string) =>
  rawRows(
    `SELECT id FROM \`_articles_versions\` WHERE parent = type::record('articles', '${id}') AND latest = true`,
  )

const seedDrafts = async () => {
  const ids: (number | string)[] = []

  for (const [title, rank] of [
    ['alpha', 3],
    ['bravo', 1],
    ['charlie', 2],
    ['delta', 4],
  ] as const) {
    const article = await createArticle({ rank, title }, true)
    ids.push(article.id)
  }

  // The newest draft of bravo differs from the one it started with
  const [, bravo] = ids

  if (bravo === undefined) {
    throw new Error('The seed is incomplete.')
  }

  await saveDraft(bravo, { rank: 9, title: 'bravo edited' })

  return ids
}

const createSelectable = () =>
  createArticle({
    body: 'long text',
    group: { extra: 'x', note: 'n' },
    items: [
      { detail: 'd1', label: 'l1' },
      { detail: 'd2', label: 'l2' },
    ],
    layout: [{ blockType: 'quote', cite: 'someone', text: 'quote text' }],
    rank: 5,
    title: 'selected',
  })

beforeAll(async () => {
  payload = await bootPayload(config, 'versions')
})

beforeEach(async () => {
  await payload.db.clearDatabase()
})

afterAll(async () => {
  await payload.destroy()
})

describe('boot', () => {
  test('defines the version tables and the global tables', async () => {
    const [info] = await connection().query<[{ tables: Record<string, string> }]>('INFO FOR DB')

    expect(Object.keys(info.tables)).toEqual(
      expect.arrayContaining([
        '_articles_versions',
        '_plain_versions',
        '_global_settings',
        '_global_settings_versions',
        '_global_footer',
      ]),
    )
  })
})

describe('collection versions', () => {
  test('a draft create stores the document and one latest version of it', async () => {
    const article = await createArticle({ title: 'draft one' }, true)

    expect(article['_status']).toBe('draft')

    const versions = await versionsOf(article.id)

    expect(versions).toHaveLength(1)
    expect(versions[0]).toMatchObject({
      parent: article.id,
      latest: true,
      version: { _status: 'draft', title: 'draft one' },
    })
    expect(typeof versions[0]?.id).toBe('string')
    expect(versions[0]?.createdAt).toMatch(/^\d{4}-\d{2}-\d{2}T.*Z$/)
  })

  test('every save adds a version and only the newest stays latest', async () => {
    const article = await createArticle({ title: 'v1' }, true)

    for (const title of ['v2', 'v3', 'v4']) {
      await saveDraft(article.id, { title })
    }

    const versions = await versionsOf(article.id)

    expect(versions.map((version) => version.version['title'])).toEqual(['v1', 'v2', 'v3', 'v4'])
    expect(versions.map((version) => version.latest)).toEqual([
      undefined,
      undefined,
      undefined,
      true,
    ])
    expect(await latestVersions(article.id)).toHaveLength(1)

    const latest = await payload.findVersions({
      collection: 'articles',
      overrideAccess: true,
      where: { and: [{ parent: { equals: article.id } }, { latest: { equals: true } }] },
    })

    expect(latest.docs.map((version) => version.version['title'])).toEqual(['v4'])
  })

  test('an autosave rewrites the latest autosave version instead of adding one', async () => {
    const article = await createArticle({ title: 'v1' }, true)

    await saveDraft(article.id, { title: 'auto 1' }, true)
    await saveDraft(article.id, { title: 'auto 2' }, true)

    const versions = await versionsOf(article.id)

    expect(versions).toHaveLength(2)
    expect(versions[0]).toMatchObject({ version: { title: 'v1' } })
    expect(versions[1]).toMatchObject({
      autosave: true,
      latest: true,
      version: { title: 'auto 2' },
    })
    expect(await latestVersions(article.id)).toHaveLength(1)
  })

  test('publishing keeps the draft history and updates the document', async () => {
    const article = await createArticle({ title: 'draft' }, true)

    await payload.update({
      id: article.id,
      collection: 'articles',
      data: { _status: 'published', title: 'live' },
      overrideAccess: true,
    })

    const stored = await payload.findByID({
      id: article.id,
      collection: 'articles',
      overrideAccess: true,
    })
    const versions = await versionsOf(article.id)

    expect(stored).toMatchObject({ _status: 'published', title: 'live' })
    expect(versions.map((version) => version.version['_status'])).toEqual(['draft', 'published'])
    expect(await latestVersions(article.id)).toHaveLength(1)
  })

  test('publishing a locale and saving a draft of another keeps one latest version per document', async () => {
    const article = await payload.create({
      collection: 'articles',
      data: { _status: 'published', title: 'english' },
      locale: 'en',
      overrideAccess: true,
    })

    await payload.update({
      id: article.id,
      collection: 'articles',
      data: { _status: 'published', title: 'espanol' },
      locale: 'es',
      overrideAccess: true,
    })
    await payload.update({
      id: article.id,
      collection: 'articles',
      data: { _status: 'draft', title: 'english draft' },
      draft: true,
      locale: 'en',
      overrideAccess: true,
    })

    const live = await payload.findByID({
      id: article.id,
      collection: 'articles',
      locale: 'all',
      overrideAccess: true,
    })
    const { docs } = await payload.findVersions({
      collection: 'articles',
      locale: 'all',
      overrideAccess: true,
      where: { and: [{ parent: { equals: article.id } }, { latest: { equals: true } }] },
    })

    expect(live['title']).toEqual({ en: 'english', es: 'espanol' })
    expect(live['_status']).toEqual({ en: 'published', es: 'published' })
    expect(docs).toHaveLength(1)
    expect(docs[0]?.version['_status']).toEqual({ en: 'draft', es: 'published' })
    expect(docs[0]?.version['title']).toEqual({ en: 'english draft', es: 'espanol' })
    expect(await latestVersions(article.id)).toHaveLength(1)
  })

  test('restoring a version writes it back as a new latest version', async () => {
    const article = await createArticle({ title: 'one' }, true)

    await saveDraft(article.id, { title: 'two' })

    const [first] = await versionsOf(article.id)

    if (!first) {
      throw new Error('The first version is missing.')
    }

    const restored = await payload.restoreVersion({
      id: first.id,
      collection: 'articles',
      overrideAccess: true,
    })

    expect(restored['title']).toBe('one')

    const stored = await payload.findByID({
      id: article.id,
      collection: 'articles',
      overrideAccess: true,
    })
    const versions = await versionsOf(article.id)

    expect(stored['title']).toBe('one')
    expect(versions.length).toBeGreaterThanOrEqual(3)
    expect(await latestVersions(article.id)).toHaveLength(1)
  })

  test('restoring with a select still stores the whole document in the new version', async () => {
    const article = await createArticle({ body: 'text', rank: 5, title: 'one' }, true)

    await saveDraft(article.id, { title: 'two' })

    const [first] = await versionsOf(article.id)

    if (!first) {
      throw new Error('The first version is missing.')
    }

    const restored = await payload.restoreVersion({
      id: first.id,
      collection: 'articles',
      overrideAccess: true,
      select: { title: true },
    })
    const [latest] = await rawRows(
      `SELECT version FROM \`_articles_versions\` WHERE parent = type::record('articles', '${article.id}') AND latest = true`,
    )

    expect(Object.keys(restored).toSorted()).toEqual(['id', 'title'])
    expect(latest?.['version']).toMatchObject({ body: 'text', rank: 5 })
  })

  test('keeps only the newest versions of a document when the collection has a limit', async () => {
    const doc = await payload.create({
      collection: 'capped',
      data: { title: 'v0' },
      draft: true,
      overrideAccess: true,
    })

    for (const title of ['v1', 'v2', 'v3', 'v4']) {
      await payload.update({
        id: doc.id,
        collection: 'capped',
        data: { title },
        draft: true,
        overrideAccess: true,
      })
    }

    const { docs } = await payload.findVersions({
      collection: 'capped',
      overrideAccess: true,
      sort: 'updatedAt',
      where: { parent: { equals: doc.id } },
    })

    expect(docs.map((version) => version.version['title'])).toEqual(['v3', 'v4'])
    expect(docs.map((version) => version.latest === true)).toEqual([false, true])
  })

  test('lists versions with a sort, a page and a total', async () => {
    const article = await createArticle({ title: 'v1' }, true)

    for (const title of ['v2', 'v3', 'v4', 'v5']) {
      await saveDraft(article.id, { title })
    }

    const page = await payload.findVersions({
      collection: 'articles',
      limit: 2,
      overrideAccess: true,
      page: 2,
      sort: '-updatedAt',
      where: { parent: { equals: article.id } },
    })

    expect(page.docs.map((version) => version.version['title'])).toEqual(['v3', 'v2'])
    expect(page).toMatchObject({
      hasNextPage: true,
      hasPrevPage: true,
      totalDocs: 5,
      totalPages: 3,
    })
  })

  test('sorts versions by a field of the version and filters on it', async () => {
    const article = await createArticle({ rank: 3, title: 'c' }, true)

    await saveDraft(article.id, { rank: 1, title: 'a' })
    await saveDraft(article.id, { rank: 2, title: 'b' })

    const sorted = await payload.findVersions({
      collection: 'articles',
      overrideAccess: true,
      sort: 'version.rank',
      where: { parent: { equals: article.id } },
    })
    const filtered = await payload.findVersions({
      collection: 'articles',
      overrideAccess: true,
      where: { 'version.rank': { greater_than: 1 } },
    })

    expect(sorted.docs.map((version) => version.version['rank'])).toEqual([1, 2, 3])
    expect(filtered.totalDocs).toBe(2)
  })

  test('counts versions with a where', async () => {
    const article = await createArticle({}, true)

    await saveDraft(article.id, { title: 'v2' })

    const all = await payload.countVersions({ collection: 'articles', overrideAccess: true })
    const latest = await payload.countVersions({
      collection: 'articles',
      overrideAccess: true,
      where: { latest: { equals: true } },
    })

    expect(all.totalDocs).toBe(2)
    expect(latest.totalDocs).toBe(1)
  })

  test('a collection with versions but no drafts has no latest flag', async () => {
    const plain = await payload.create({
      collection: 'plain',
      data: { title: 'one' },
      overrideAccess: true,
    })

    await payload.update({
      id: plain.id,
      collection: 'plain',
      data: { title: 'two' },
      overrideAccess: true,
    })

    const versions = await rawRows('SELECT * FROM `_plain_versions` ORDER BY createdAt')

    expect(versions).toHaveLength(2)
    expect(versions.every((version) => !('latest' in version))).toBe(true)
  })

  test('deleting a document deletes its versions and leaves the others', async () => {
    const doomed = await createArticle({ title: 'doomed' }, true)
    const kept = await createArticle({ title: 'kept' }, true)

    await saveDraft(doomed.id, { title: 'doomed 2' })
    await payload.delete({ id: doomed.id, collection: 'articles', overrideAccess: true })

    expect(await versionsOf(doomed.id)).toHaveLength(0)
    expect(await versionsOf(kept.id)).toHaveLength(1)
  })

  test('deleting with a where deletes the versions of every match', async () => {
    const a = await createArticle({ title: 'bulk' }, true)
    const b = await createArticle({ title: 'bulk' }, true)
    const other = await createArticle({ title: 'other' }, true)

    await payload.delete({
      collection: 'articles',
      overrideAccess: true,
      where: { title: { equals: 'bulk' } },
    })

    expect(await versionsOf(a.id)).toHaveLength(0)
    expect(await versionsOf(b.id)).toHaveLength(0)
    expect(await versionsOf(other.id)).toHaveLength(1)
  })
})

describe('drafts', () => {
  test('lists documents as their latest draft', async () => {
    await seedDrafts()

    const { docs, totalDocs } = await payload.find({
      collection: 'articles',
      draft: true,
      overrideAccess: true,
      sort: 'rank',
    })

    expect(totalDocs).toBe(4)
    expect(docs.map((doc) => doc['title'])).toEqual(['charlie', 'alpha', 'delta', 'bravo edited'])
    expect(docs.every((doc) => typeof doc.id === 'string')).toBe(true)
  })

  test('gives each draft the ID of its document, not of the version', async () => {
    const ids = await seedDrafts()

    const { docs } = await payload.find({
      collection: 'articles',
      draft: true,
      overrideAccess: true,
    })

    expect(docs.map((doc) => doc.id).toSorted()).toEqual([...ids].toSorted())
  })

  test('filters, sorts and pages drafts', async () => {
    await seedDrafts()

    const page = await payload.find({
      collection: 'articles',
      draft: true,
      limit: 2,
      overrideAccess: true,
      page: 2,
      sort: '-rank',
      where: { rank: { greater_than: 1 } },
    })

    expect(page.docs.map((doc) => doc['rank'])).toEqual([3, 2])
    expect(page).toMatchObject({
      hasNextPage: false,
      hasPrevPage: true,
      totalDocs: 4,
      totalPages: 2,
    })
  })

  test('a draft query with pagination off ignores the page, like Mongo', async () => {
    await seedDrafts()

    const { docs } = await payload.find({
      collection: 'articles',
      draft: true,
      limit: 2,
      overrideAccess: true,
      page: 2,
      pagination: false,
      sort: 'rank',
    })

    expect(docs.map((doc) => doc['title'])).toEqual(['charlie', 'alpha'])
  })

  test('filters drafts on a localized field in the requested locale', async () => {
    const article = await createArticle({ title: 'hello' }, true)

    await payload.update({
      id: article.id,
      collection: 'articles',
      data: { title: 'hola' },
      draft: true,
      locale: 'es',
      overrideAccess: true,
    })

    const spanish = await payload.find({
      collection: 'articles',
      draft: true,
      locale: 'es',
      overrideAccess: true,
      where: { title: { equals: 'hola' } },
    })
    const english = await payload.find({
      collection: 'articles',
      draft: true,
      locale: 'en',
      overrideAccess: true,
      where: { title: { equals: 'hola' } },
    })

    expect(spanish.docs.map((doc) => doc.id)).toEqual([article.id])
    expect(english.docs).toHaveLength(0)
  })

  test('finds a draft by its document ID, also with like', async () => {
    const ids = await seedDrafts()
    const [id] = ids

    if (id === undefined) {
      throw new Error('The seed is incomplete.')
    }

    for (const where of [{ id: { equals: id } }, { id: { like: id } }]) {
      const { docs } = await payload.find({
        collection: 'articles',
        draft: true,
        overrideAccess: true,
        where,
      })

      expect(docs.map((doc) => doc.id)).toEqual([id])
    }
  })

  test('sorts drafts by id', async () => {
    const ids = await seedDrafts()

    const { docs } = await payload.find({
      collection: 'articles',
      draft: true,
      overrideAccess: true,
      sort: 'id',
    })

    expect(docs.map((doc) => doc.id)).toEqual([...ids].toSorted())
  })

  test('selects fields of drafts', async () => {
    await seedDrafts()

    const { docs } = await payload.find({
      collection: 'articles',
      draft: true,
      overrideAccess: true,
      select: { rank: true },
      sort: 'rank',
    })

    expect(docs.map((doc) => Object.keys(doc).toSorted())).toEqual(
      Array.from({ length: 4 }, () => ['id', 'rank']),
    )
    // bravo's newest draft has rank 9
    expect(docs.map((doc) => doc['rank'])).toEqual([2, 3, 4, 9])
  })

  test('findByID with draft returns the latest draft', async () => {
    const article = await createArticle({ title: 'live' }, true)

    await payload.update({
      id: article.id,
      collection: 'articles',
      data: { _status: 'published', title: 'live' },
      overrideAccess: true,
    })
    await saveDraft(article.id, { title: 'work in progress' })

    const draft = await payload.findByID({
      id: article.id,
      collection: 'articles',
      draft: true,
      overrideAccess: true,
    })
    const published = await payload.findByID({
      id: article.id,
      collection: 'articles',
      overrideAccess: true,
    })

    expect(draft['title']).toBe('work in progress')
    expect(published['title']).toBe('live')
  })
})

describe('select', () => {
  test('include mode returns the selected fields and the id', async () => {
    const article = await createSelectable()

    const found = await payload.findByID({
      id: article.id,
      collection: 'articles',
      overrideAccess: true,
      select: { rank: true, title: true },
    })

    expect(Object.keys(found).toSorted()).toEqual(['id', 'rank', 'title'])
    expect(found['title']).toBe('selected')
  })

  test('exclude mode returns everything but the excluded fields', async () => {
    const article = await createSelectable()

    const found = await payload.findByID({
      id: article.id,
      collection: 'articles',
      overrideAccess: true,
      select: { body: false, items: false },
    })

    expect(found).not.toHaveProperty('body')
    expect(found).not.toHaveProperty('items')
    expect(found).toMatchObject({ rank: 5, title: 'selected' })
  })

  test('a nested group select drops the siblings', async () => {
    const article = await createSelectable()

    const found = await payload.findByID({
      id: article.id,
      collection: 'articles',
      overrideAccess: true,
      select: { group: { note: true } },
    })

    expect(found['group']).toEqual({ note: 'n' })
    expect(found).not.toHaveProperty('rank')
  })

  test('a select inside an array keeps the array shape and the row ids', async () => {
    const article = await createSelectable()

    const found = await payload.findByID({
      id: article.id,
      collection: 'articles',
      overrideAccess: true,
      select: { items: { label: true } },
    })

    expect(found['items']).toEqual([
      { id: expect.any(String), label: 'l1' },
      { id: expect.any(String), label: 'l2' },
    ])
  })

  test('a select inside a block keeps the block type', async () => {
    const article = await createSelectable()

    const found = await payload.findByID({
      id: article.id,
      collection: 'articles',
      overrideAccess: true,
      select: { layout: { quote: { text: true } } },
    })

    expect(found['layout']).toEqual([
      { id: expect.any(String), blockType: 'quote', text: 'quote text' },
    ])
  })

  test('a localized field keeps its locales', async () => {
    const article = await createSelectable()

    await payload.update({
      id: article.id,
      collection: 'articles',
      data: { title: 'seleccionado' },
      locale: 'es',
      overrideAccess: true,
    })

    const found = await payload.findByID({
      id: article.id,
      collection: 'articles',
      locale: 'all',
      overrideAccess: true,
      select: { title: true },
    })

    expect(found['title']).toEqual({ en: 'selected', es: 'seleccionado' })
  })

  test('find applies select to every document', async () => {
    await createSelectable()
    await createArticle({ rank: 1, title: 'second' })

    const { docs } = await payload.find({
      collection: 'articles',
      overrideAccess: true,
      select: { rank: true },
      sort: 'rank',
    })

    expect(docs.map((doc) => Object.keys(doc).toSorted())).toEqual([
      ['id', 'rank'],
      ['id', 'rank'],
    ])
  })

  test('update returns only the selected fields', async () => {
    const article = await createSelectable()

    const updated = await payload.update({
      id: article.id,
      collection: 'articles',
      data: { rank: 6 },
      overrideAccess: true,
      select: { rank: true },
    })

    expect(Object.keys(updated).toSorted()).toEqual(['id', 'rank'])
    expect(updated['rank']).toBe(6)
  })

  test('select reaches the version methods', async () => {
    const article = await createSelectable()

    const { docs } = await payload.findVersions({
      collection: 'articles',
      overrideAccess: true,
      select: { version: { rank: true } },
      where: { parent: { equals: article.id } },
    })

    expect(docs).toHaveLength(1)
    expect(docs[0]?.version).toEqual({ rank: 5 })
  })
})

describe('adapter methods', () => {
  test('createVersion returns null when asked not to return', async () => {
    const article = await createArticle({}, true)

    const result = await payload.db.createVersion({
      autosave: false,
      collectionSlug: 'articles',
      createdAt: new Date().toISOString(),
      parent: article.id,
      returning: false,
      updatedAt: new Date().toISOString(),
      versionData: { title: 'direct' },
    })

    expect(result).toBeNull()
    expect(await versionsOf(article.id)).toHaveLength(2)
  })

  test('createVersion keeps versions with the same updatedAt both latest, like Mongo', async () => {
    const article = await createArticle({}, true)
    const updatedAt = new Date(Date.now() + 60_000).toISOString()

    for (const title of ['a', 'b']) {
      await payload.db.createVersion({
        autosave: false,
        collectionSlug: 'articles',
        createdAt: updatedAt,
        parent: article.id,
        updatedAt,
        versionData: { title },
      })
    }

    // The first one unsets the original draft, the second one cannot tell it from its own twin
    expect(await latestVersions(article.id)).toHaveLength(2)
  })

  test('createVersion stores the published locale', async () => {
    const article = await createArticle({}, true)

    const created = await payload.db.createVersion({
      autosave: false,
      collectionSlug: 'articles',
      createdAt: new Date().toISOString(),
      parent: article.id,
      publishedLocale: 'es',
      updatedAt: new Date(Date.now() + 1000).toISOString(),
      versionData: { title: { en: 'a' } },
    })

    expect(created).toMatchObject({ parent: article.id, latest: true, publishedLocale: 'es' })
  })

  test('updateVersion returns null when nothing matches', async () => {
    const result = await payload.db.updateVersion({
      id: 'nope',
      collection: 'articles',
      versionData: { version: { title: 'x' } },
    })

    expect(result).toBeNull()
  })

  test('updateVersion replaces the given keys and returns the row', async () => {
    const article = await createArticle({}, true)
    const [version] = await versionsOf(article.id)

    if (!version) {
      throw new Error('The version is missing.')
    }

    const updated = await payload.db.updateVersion({
      id: version.id,
      collection: 'articles',
      versionData: { version: { rank: 7, title: 'replaced' } },
    })

    expect(updated).toMatchObject({
      id: version.id,
      parent: article.id,
      latest: true,
      version: { rank: 7, title: 'replaced' },
    })
    expect(updated.version).not.toHaveProperty('_status')
  })

  test('deleteVersions needs a collection or a global', async () => {
    await expect(payload.db.deleteVersions({ where: {} })).rejects.toThrow(APIError)
  })

  test('findVersions with pagination off still skips the earlier pages', async () => {
    const article = await createArticle({ title: 'v1' }, true)

    for (const title of ['v2', 'v3', 'v4']) {
      await saveDraft(article.id, { title })
    }

    const { docs } = await payload.db.findVersions({
      collection: 'articles',
      limit: 2,
      page: 2,
      pagination: false,
      sort: 'updatedAt',
    })

    expect(docs.map((doc) => doc.version['title'])).toEqual([{ en: 'v3' }, { en: 'v4' }])
  })
})

describe('concurrent saves', () => {
  test('parallel draft saves of one document leave exactly one latest version', async () => {
    const article = await createArticle({ title: 'start' }, true)

    const results = await Promise.allSettled(
      Array.from({ length: 12 }, (_, index) => saveDraft(article.id, { title: `save ${index}` })),
    )

    const failures = results.filter((result) => result.status === 'rejected')

    // A save that loses a write conflict is rolled back whole: it fails with a 409, it never leaves a second latest behind
    for (const failure of failures) {
      expect(failure.reason).toBeInstanceOf(APIError)
      expect(failure.reason).toMatchObject({ status: 409 })
    }

    const succeeded = results.length - failures.length
    const versions = await versionsOf(article.id)

    expect(succeeded).toBeGreaterThan(0)
    expect(versions).toHaveLength(1 + succeeded)
    expect(await latestVersions(article.id)).toHaveLength(1)
  })

  test('spaced parallel draft saves keep exactly one latest version', async () => {
    const article = await createArticle({ title: 'start' }, true)

    const results = await Promise.allSettled(
      Array.from(
        { length: 20 },
        (_, index) =>
          new Promise<void>((resolve, reject) => {
            setTimeout(() => {
              saveDraft(article.id, { title: `spaced ${index}` }).then(
                () => resolve(),
                (error: unknown) => reject(error),
              )
            }, index * 5)
          }),
      ),
    )

    const failures = results.filter((result) => result.status === 'rejected')

    // Only a lost write conflict may fail a save, and it fails whole with a 409
    for (const failure of failures) {
      expect(failure.reason).toBeInstanceOf(APIError)
      expect(failure.reason).toMatchObject({ status: 409 })
    }

    const succeeded = results.length - failures.length

    expect(succeeded).toBeGreaterThan(0)
    expect(await versionsOf(article.id)).toHaveLength(1 + succeeded)
    expect(await latestVersions(article.id)).toHaveLength(1)
  })

  test('a version saved on a whole second is unset by the next one', async () => {
    for (const updatedAt of ['2030-01-01T00:00:01.000Z', '2030-01-01T00:00:01.011Z']) {
      await payload.db.createVersion({
        autosave: false,
        collectionSlug: 'articles',
        createdAt: updatedAt,
        parent: 'whole-second',
        returning: false,
        updatedAt,
        versionData: { title: updatedAt },
      })
    }

    expect(await latestVersions('whole-second')).toHaveLength(1)
  })

  test('interleaved transactions saving the same parent conflict instead of both staying latest', async () => {
    // A parent with no version yet: the two transactions share no older row to unset, so only a
    // write they both make can make them conflict
    const parent = 'unsaved'
    const first = await beginTransaction(payload)
    const second = await beginTransaction(payload)

    await payload.db.createVersion({
      autosave: false,
      collectionSlug: 'articles',
      createdAt: '2030-01-01T00:00:01.000Z',
      parent,
      req: { transactionID: first },
      returning: false,
      updatedAt: '2030-01-01T00:00:01.000Z',
      versionData: { title: 'first' },
    })
    await payload.db.createVersion({
      autosave: false,
      collectionSlug: 'articles',
      createdAt: '2030-01-01T00:00:02.000Z',
      parent,
      req: { transactionID: second },
      returning: false,
      updatedAt: '2030-01-01T00:00:02.000Z',
      versionData: { title: 'second' },
    })

    const outcomes = await Promise.allSettled([
      payload.db.commitTransaction(first),
      payload.db.commitTransaction(second),
    ])
    const failures = outcomes.filter((outcome) => outcome.status === 'rejected')

    expect(failures).toHaveLength(1)
    expect(failures[0]?.reason).toBeInstanceOf(APIError)
    expect(failures[0]?.reason).toMatchObject({ status: 409 })
    expect(await versionsOf(parent)).toHaveLength(1)
    expect(await latestVersions(parent)).toHaveLength(1)
  })
})

describe('globals', () => {
  test('findGlobal returns an empty global before it is saved', async () => {
    const settings = await payload.findGlobal({ slug: 'settings', overrideAccess: true })

    expect(settings['siteName']).toBeUndefined()
  })

  test('the adapter returns null for a global that does not exist yet', async () => {
    expect(await payload.db.findGlobal({ slug: 'footer' })).toBeNull()
    expect(await payload.db.updateGlobal({ slug: 'footer', data: { text: 'x' } })).toBeNull()
    expect(await payload.db.findGlobal({ slug: 'footer' })).toBeNull()
  })

  test('the first update creates the global and later ones update it', async () => {
    await payload.updateGlobal({ slug: 'footer', data: { text: 'one' }, overrideAccess: true })
    await payload.updateGlobal({ slug: 'footer', data: { text: 'two' }, overrideAccess: true })

    const footer = await payload.findGlobal({ slug: 'footer', overrideAccess: true })
    const rows = await rawRows('SELECT * FROM `_global_footer`')

    expect(footer['text']).toBe('two')
    expect(rows).toHaveLength(1)
    expect(String(rows[0]?.['id'])).toBe('_global_footer:singleton')
    expect(rows[0]?.['globalType']).toBe('footer')
  })

  test('keeps the locales of a localized field', async () => {
    await payload.updateGlobal({
      slug: 'settings',
      data: { siteName: 'Site' },
      locale: 'en',
      overrideAccess: true,
    })
    await payload.updateGlobal({
      slug: 'settings',
      data: { siteName: 'Sitio' },
      locale: 'es',
      overrideAccess: true,
    })

    const all = await payload.findGlobal({ slug: 'settings', locale: 'all', overrideAccess: true })
    const spanish = await payload.findGlobal({
      slug: 'settings',
      locale: 'es',
      overrideAccess: true,
    })

    expect(all['siteName']).toEqual({ en: 'Site', es: 'Sitio' })
    expect(spanish['siteName']).toBe('Sitio')
  })

  test('select trims the global, nested paths included', async () => {
    await payload.updateGlobal({
      slug: 'settings',
      data: { social: { handle: '@site', url: 'https://example.com' }, tagline: 'tag' },
      overrideAccess: true,
    })

    const include = await payload.findGlobal({
      slug: 'settings',
      overrideAccess: true,
      select: { social: { handle: true } },
    })
    const exclude = await payload.findGlobal({
      slug: 'settings',
      overrideAccess: true,
      select: { tagline: false },
    })
    const updated = await payload.updateGlobal({
      slug: 'settings',
      data: { tagline: 'new' },
      overrideAccess: true,
      select: { tagline: true },
    })

    expect(include['social']).toEqual({ handle: '@site' })
    expect(include).not.toHaveProperty('tagline')
    expect(exclude).not.toHaveProperty('tagline')
    expect(exclude['social']).toEqual({ handle: '@site', url: 'https://example.com' })
    expect(updated['tagline']).toBe('new')
    expect(updated).not.toHaveProperty('social')
  })

  test('updating with a select still stores the whole global in its version', async () => {
    await payload.updateGlobal({
      slug: 'settings',
      data: { social: { handle: '@site', url: 'https://example.com' }, tagline: 'old' },
      overrideAccess: true,
    })

    await payload.updateGlobal({
      slug: 'settings',
      data: { tagline: 'new' },
      overrideAccess: true,
      select: { tagline: true },
    })

    const { docs } = await payload.findGlobalVersions({
      slug: 'settings',
      limit: 1,
      overrideAccess: true,
      sort: '-updatedAt',
    })

    expect(docs[0]?.version).toMatchObject({
      social: { handle: '@site', url: 'https://example.com' },
      tagline: 'new',
    })
  })

  test('keeps only the newest versions of a global when it has a limit', async () => {
    for (const text of ['v1', 'v2', 'v3', 'v4']) {
      await payload.updateGlobal({
        slug: 'cappedNotice',
        data: { text },
        draft: true,
        overrideAccess: true,
      })
    }

    const { docs } = await payload.findGlobalVersions({
      slug: 'cappedNotice',
      overrideAccess: true,
      sort: 'updatedAt',
    })

    expect(docs.map((version) => version.version['text'])).toEqual(['v3', 'v4'])
  })

  test('a global with versions records every save and keeps one latest', async () => {
    await payload.updateGlobal({
      slug: 'settings',
      data: { tagline: 'v1' },
      draft: true,
      overrideAccess: true,
    })

    for (const tagline of ['v2', 'v3']) {
      await payload.updateGlobal({
        slug: 'settings',
        data: { tagline },
        draft: true,
        overrideAccess: true,
      })
    }

    const versions = await payload.findGlobalVersions({
      slug: 'settings',
      overrideAccess: true,
      sort: 'updatedAt',
    })
    const latest = await payload.countGlobalVersions({
      global: 'settings',
      overrideAccess: true,
      where: { latest: { equals: true } },
    })

    expect(versions.docs.map((version) => version.version['tagline'])).toEqual(['v1', 'v2', 'v3'])
    expect(versions.totalDocs).toBe(3)
    expect(latest.totalDocs).toBe(1)
    expect(versions.docs.at(-1)?.latest).toBe(true)
  })

  test('publishing a global and reading its draft', async () => {
    await payload.updateGlobal({
      slug: 'settings',
      data: { _status: 'published', tagline: 'live' },
      overrideAccess: true,
    })
    await payload.updateGlobal({
      slug: 'settings',
      data: { tagline: 'wip' },
      draft: true,
      overrideAccess: true,
    })

    const live = await payload.findGlobal({ slug: 'settings', overrideAccess: true })
    const draft = await payload.findGlobal({ slug: 'settings', draft: true, overrideAccess: true })

    expect(live['tagline']).toBe('live')
    expect(draft['tagline']).toBe('wip')
  })

  test('restores a global version', async () => {
    await payload.updateGlobal({ slug: 'settings', data: { tagline: 'one' }, overrideAccess: true })
    await payload.updateGlobal({ slug: 'settings', data: { tagline: 'two' }, overrideAccess: true })

    const { docs } = await payload.findGlobalVersions({
      slug: 'settings',
      overrideAccess: true,
      sort: 'updatedAt',
    })
    const [first] = docs

    if (!first) {
      throw new Error('The first global version is missing.')
    }

    await payload.restoreGlobalVersion({ id: first.id, slug: 'settings', overrideAccess: true })

    const settings = await payload.findGlobal({ slug: 'settings', overrideAccess: true })
    const latest = await payload.countGlobalVersions({
      global: 'settings',
      overrideAccess: true,
      where: { latest: { equals: true } },
    })

    expect(settings['tagline']).toBe('one')
    expect(latest.totalDocs).toBe(1)
  })

  test('select reaches the global version methods', async () => {
    await payload.updateGlobal({
      slug: 'settings',
      data: { social: { handle: '@h', url: 'u' }, tagline: 't' },
      overrideAccess: true,
    })

    const { docs } = await payload.db.findGlobalVersions({
      global: 'settings',
      select: { version: { social: { handle: true } } },
    })

    expect(docs[0]?.version).toEqual({ social: { handle: '@h' } })
  })

  test('deleteVersions with a global slug deletes its versions only', async () => {
    await payload.updateGlobal({ slug: 'settings', data: { tagline: 'one' }, overrideAccess: true })
    await payload.updateGlobal({ slug: 'settings', data: { tagline: 'two' }, overrideAccess: true })

    await payload.db.deleteVersions({
      globalSlug: 'settings',
      where: { 'version.tagline': { equals: 'one' } },
    })

    const { totalDocs } = await payload.countGlobalVersions({
      global: 'settings',
      overrideAccess: true,
    })

    expect(totalDocs).toBe(1)
  })

  test('updateGlobalVersion returns null when nothing matches', async () => {
    expect(
      await payload.db.updateGlobalVersion({
        id: 'nope',
        global: 'settings',
        versionData: { version: { tagline: 'x' } },
      }),
    ).toBeNull()
  })

  test('interleaved transactions saving the global conflict instead of both staying latest', async () => {
    const first = await beginTransaction(payload)
    const second = await beginTransaction(payload)

    for (const [transactionID, tagline] of [
      [first, 'first'],
      [second, 'second'],
    ] as const) {
      await payload.db.createGlobalVersion({
        autosave: false,
        createdAt: new Date().toISOString(),
        globalSlug: 'settings',
        req: { transactionID },
        returning: false,
        updatedAt: new Date().toISOString(),
        versionData: { tagline },
      })
    }

    const outcomes = await Promise.allSettled([
      payload.db.commitTransaction(first),
      payload.db.commitTransaction(second),
    ])
    const failures = outcomes.filter((outcome) => outcome.status === 'rejected')

    expect(failures).toHaveLength(1)
    expect(failures[0]?.reason).toMatchObject({ status: 409 })
    expect(
      await rawRows('SELECT id FROM `_global_settings_versions` WHERE latest = true'),
    ).toHaveLength(1)
  })
})
