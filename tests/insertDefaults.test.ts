import type { Payload, Where } from 'payload'

import { NotFound, buildConfig } from 'payload'
import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'vitest'

import { surrealdbAdapter } from '../src/index.js'
import { fromRecordId, isRecordId } from '../src/utilities/recordId.js'
import { beginTransaction, bootPayload, connectionArgs } from './helpers/payload.js'

// Anonymous readers see a document when it is published, or has no status at all.
const publicRead = ({ req }: { req: { user?: unknown } }): boolean | Where =>
  req.user ? true : { or: [{ _status: { equals: 'published' } }, { _status: { exists: false } }] }

const config = buildConfig({
  collections: [
    { slug: 'users', auth: true, fields: [], versions: false },
    {
      slug: 'posts',
      access: { read: publicRead },
      fields: [
        { name: 'title', type: 'text', localized: true },
        { name: 'body', type: 'text' },
      ],
      versions: { drafts: true },
    },
    {
      slug: 'defaults',
      fields: [
        { name: 'title', type: 'text' },
        { name: 'text', type: 'text', defaultValue: 'T' },
        { name: 'dynamic', type: 'text', defaultValue: () => 'computed by Payload' },
        { name: 'rank', type: 'number', defaultValue: 0 },
        { name: 'flag', type: 'checkbox', defaultValue: false },
        { name: 'mode', type: 'select', defaultValue: 'a', options: ['a', 'b'] },
        { name: 'when', type: 'date', defaultValue: '2020-01-01T00:00:00.000Z' },
        { name: 'point', type: 'point', defaultValue: [10, 20] },
        { name: 'localizedText', type: 'text', defaultValue: 'LT', localized: true },
        {
          name: 'group',
          type: 'group',
          defaultValue: {},
          fields: [{ name: 'note', type: 'text', defaultValue: 'GN' }],
        },
        {
          name: 'bareGroup',
          type: 'group',
          fields: [{ name: 'note', type: 'text', defaultValue: 'BN' }],
        },
        {
          name: 'localizedGroup',
          type: 'group',
          localized: true,
          fields: [{ name: 'note', type: 'text', defaultValue: 'LN' }],
        },
        {
          name: 'rows',
          type: 'array',
          fields: [
            { name: 'label', type: 'text', defaultValue: 'AL' },
            { name: 'detail', type: 'text' },
          ],
        },
        {
          name: 'defaultRows',
          type: 'array',
          defaultValue: [{}],
          fields: [{ name: 'label', type: 'text', defaultValue: 'AL' }],
        },
        {
          name: 'layout',
          type: 'blocks',
          blocks: [{ slug: 'quote', fields: [{ name: 'text', type: 'text', defaultValue: 'BT' }] }],
        },
        { name: 'tags', type: 'select', hasMany: true, options: ['x', 'y'] },
        {
          name: 'localizedTags',
          type: 'select',
          hasMany: true,
          localized: true,
          options: ['x', 'y'],
        },
        { name: 'names', type: 'text', hasMany: true },
        {
          type: 'tabs',
          tabs: [
            { name: 'seo', fields: [{ name: 'metaTitle', type: 'text', defaultValue: 'ST' }] },
            { label: 'Extra', fields: [{ name: 'extra', type: 'text', defaultValue: 'XT' }] },
          ],
        },
      ],
      versions: false,
    },
  ],
  db: surrealdbAdapter(connectionArgs('insertdefaults')),
  globals: [
    {
      slug: 'site',
      access: { read: publicRead },
      fields: [
        { name: 'tagline', type: 'text', localized: true },
        { name: 'banner', type: 'text', defaultValue: 'B' },
      ],
      versions: { drafts: true },
    },
  ],
  localization: { defaultLocale: 'en', locales: ['en', 'es'] },
  secret: 'test-secret',
  telemetry: false,
  typescript: { autoGenerate: false },
})

let payload: Payload

const rawRows = async (sql: string) => {
  if (!payload.db.connection) {
    throw new Error('The adapter is not connected.')
  }

  const [rows] = await payload.db.connection.query<[Record<string, unknown>[]]>(sql)
  return rows
}

const idOf = (row: Record<string, unknown>) => {
  const id = row['id']

  if (!isRecordId(id)) {
    throw new Error('The row has no record ID.')
  }

  return fromRecordId(id)
}

beforeAll(async () => {
  payload = await bootPayload(config, 'insertdefaults')
})

beforeEach(async () => {
  await payload.db.clearDatabase()
})

afterAll(async () => {
  await payload.destroy()
})

const readAsAnonymous = async (locale: 'en' | 'es', draft: boolean, id: number | string) => {
  const found = await payload.find({
    collection: 'posts',
    draft,
    locale,
    overrideAccess: false,
  })
  const byID = await payload
    .findByID({ id, collection: 'posts', draft, locale, overrideAccess: false })
    .then(
      (doc) => doc,
      (error: unknown) => {
        // Not being able to see the document is the only failure that proves it is hidden
        expect(error).toBeInstanceOf(NotFound)
        return null
      },
    )

  return { byID, found: found.docs }
}

describe('anonymous reads of drafts on a localized site', () => {
  const secret = 'SECRET unreleased title'

  test('a draft saved in one locale is hidden from anonymous readers in every locale', async () => {
    const draft = await payload.create({
      collection: 'posts',
      data: { body: 'SECRET unreleased body', title: secret },
      draft: true,
      locale: 'en',
      overrideAccess: true,
    })

    for (const locale of ['en', 'es'] as const) {
      for (const useDraft of [false, true]) {
        const { byID, found } = await readAsAnonymous(locale, useDraft, draft.id)

        expect(found, `find ${locale} draft=${useDraft}`).toEqual([])
        expect(byID, `findByID ${locale} draft=${useDraft}`).toBeNull()
      }
    }
  })

  test('publishing one locale shows the document in that locale only', async () => {
    const draft = await payload.create({
      collection: 'posts',
      data: { title: secret },
      draft: true,
      locale: 'en',
      overrideAccess: true,
    })

    await payload.update({
      id: draft.id,
      collection: 'posts',
      data: { _status: 'published' },
      locale: 'en',
      overrideAccess: true,
    })

    const english = await readAsAnonymous('en', false, draft.id)
    const spanish = await readAsAnonymous('es', false, draft.id)

    expect(english.found.map((doc) => doc['title'])).toEqual([secret])
    expect(english.byID?.['title']).toBe(secret)
    expect(spanish.found).toEqual([])
    expect(spanish.byID).toBeNull()
  })

  test('the statuses of every locale are stored on the document and on its version', async () => {
    await payload.create({
      collection: 'posts',
      data: { title: secret },
      draft: true,
      locale: 'en',
      overrideAccess: true,
    })

    const [post] = await rawRows('SELECT _status FROM posts')
    const [version] = await rawRows('SELECT version._status AS status FROM _posts_versions')

    expect(post?.['_status']).toEqual({ en: 'draft', es: 'draft' })
    expect(version?.['status']).toEqual({ en: 'draft', es: 'draft' })
  })

  test('a global draft is hidden from anonymous readers in every locale', async () => {
    await payload.updateGlobal({
      slug: 'site',
      data: { tagline: 'SECRET draft tagline' },
      draft: true,
      locale: 'en',
      overrideAccess: true,
    })

    for (const locale of ['en', 'es'] as const) {
      for (const draft of [false, true]) {
        const site = await payload.findGlobal({
          slug: 'site',
          draft,
          locale,
          overrideAccess: false,
        })

        expect(JSON.stringify(site), `findGlobal ${locale} draft=${draft}`).not.toContain('SECRET')
      }
    }
  })
})

describe('defaults on insert', () => {
  test('db.create stores the static defaults of every kind of field', async () => {
    const created = await payload.db.create({
      collection: 'defaults',
      data: {
        layout: [{ blockType: 'quote' }],
        localizedGroup: { en: {} },
        localizedTags: { en: ['x'] },
        localizedText: { en: 'given' },
        rows: [{}, { label: 'given' }],
        title: 'direct',
      },
    })

    expect(created).toMatchObject({
      defaultRows: [{ label: 'AL' }],
      extra: 'XT',
      flag: false,
      group: { note: 'GN' },
      layout: [{ blockType: 'quote', text: 'BT' }],
      localizedGroup: { en: { note: 'LN' } },
      localizedTags: { en: ['x'], es: [] },
      localizedText: { en: 'given', es: 'LT' },
      mode: 'a',
      point: { coordinates: [10, 20], type: 'Point' },
      rank: 0,
      rows: [{ label: 'AL' }, { label: 'given' }],
      tags: [],
      text: 'T',
      title: 'direct',
      when: '2020-01-01T00:00:00.000Z',
    })
  })

  test('what has no static default stays missing, as with Mongoose', async () => {
    const created = await payload.db.create({ collection: 'defaults', data: { title: 'direct' } })

    // A function default is Payload's to apply
    expect(created).not.toHaveProperty('dynamic')
    // A localized field, a group, a named tab and an array that were not given are not created
    expect(created).not.toHaveProperty('localizedText')
    expect(created).not.toHaveProperty('localizedGroup')
    expect(created).not.toHaveProperty('localizedTags')
    expect(created).not.toHaveProperty('bareGroup')
    expect(created).not.toHaveProperty('seo')
    expect(created).not.toHaveProperty('rows')
    expect(created).not.toHaveProperty('layout')
    expect(created).not.toHaveProperty('names')
  })

  test('a value that is given wins, null included', async () => {
    const created = await payload.db.create({
      collection: 'defaults',
      data: { rank: 7, text: null, title: 'given' },
    })

    expect(created).toMatchObject({ rank: 7, text: null })
  })

  test('the data of the caller is not changed', async () => {
    const data = { title: 'direct' }

    await payload.db.create({ collection: 'defaults', data })

    expect(data).toEqual({ title: 'direct' })
  })

  test('rows get their own copy of an object default', async () => {
    const first = await payload.db.create({ collection: 'defaults', data: { title: 'one' } })
    const second = await payload.db.create({ collection: 'defaults', data: { title: 'two' } })

    expect(first['defaultRows']).toEqual([{ label: 'AL' }])
    expect(second['defaultRows']).toEqual([{ label: 'AL' }])
    expect(first['defaultRows']).not.toBe(second['defaultRows'])
  })

  test('createGlobal stores the defaults', async () => {
    const created = await payload.db.createGlobal({ slug: 'site', data: { tagline: { en: 'x' } } })

    expect(created).toMatchObject({ banner: 'B', tagline: { en: 'x' } })
  })

  describe('createGlobal of a global that is already stored', () => {
    const bannerStored = async () =>
      (await rawRows('SELECT banner FROM _global_site'))[0]?.['banner']

    test('is a conflict, so what the caller saved is never swapped for what was stored', async () => {
      await payload.db.createGlobal({ slug: 'site', data: { banner: 'first' } })

      await expect(
        payload.db.createGlobal({ slug: 'site', data: { banner: 'second' } }),
      ).rejects.toMatchObject({ status: 409 })
      expect(await bannerStored()).toBe('first')
    })

    test('with `returning: false` leaves it as it is', async () => {
      await payload.db.createGlobal({ slug: 'site', data: { banner: 'first' } })

      expect(
        await payload.db.createGlobal({
          slug: 'site',
          data: { banner: 'later' },
          returning: false,
        }),
      ).toBeNull()
      expect(await bannerStored()).toBe('first')
    })

    test('creates at once: one is stored, and the others are a conflict', async () => {
      const settled = await Promise.allSettled(
        Array.from({ length: 6 }, (_, n) =>
          payload.db.createGlobal({ slug: 'site', data: { banner: `B${n}` } }),
        ),
      )
      const created = settled.filter((result) => result.status === 'fulfilled')
      const rejected = settled.filter((result) => result.status === 'rejected')

      expect(created).toHaveLength(1)
      expect(rejected).toHaveLength(5)
      expect(rejected.every(({ reason }) => reason?.status === 409)).toBe(true)
      expect(await rawRows('SELECT id FROM _global_site')).toHaveLength(1)
      expect(created[0]?.value).toMatchObject({ banner: await bannerStored() })
    })

    test('creates at once with `returning: false`, as the job scheduler makes them, all succeed on one record', async () => {
      const results = await Promise.all(
        Array.from({ length: 6 }, (_, n) =>
          payload.db.createGlobal({ slug: 'site', data: { banner: `B${n}` }, returning: false }),
        ),
      )

      expect(results).toEqual(Array.from({ length: 6 }, () => null))
      expect(await rawRows('SELECT id FROM _global_site')).toHaveLength(1)
    })

    test('inside a transaction that began after it was stored, is a conflict, or kept with `returning: false`', async () => {
      await payload.db.createGlobal({ slug: 'site', data: { banner: 'first' } })
      const transactionID = await beginTransaction(payload)

      try {
        await expect(
          payload.db.createGlobal({
            slug: 'site',
            data: { banner: 'second' },
            req: { transactionID },
          }),
        ).rejects.toMatchObject({ status: 409 })
        expect(
          await payload.db.createGlobal({
            slug: 'site',
            data: { banner: 'third' },
            req: { transactionID },
            returning: false,
          }),
        ).toBeNull()
      } finally {
        await payload.db.rollbackTransaction(transactionID)
      }

      expect(await bannerStored()).toBe('first')
    })

    test('in two transactions that began before it was stored: the second commit is a conflict', async () => {
      const first = await beginTransaction(payload)
      const second = await beginTransaction(payload)

      await payload.db.createGlobal({
        slug: 'site',
        data: { banner: 'first' },
        req: { transactionID: first },
      })
      // Neither sees the other's global yet, so both create it
      await payload.db.createGlobal({
        slug: 'site',
        data: { banner: 'second' },
        req: { transactionID: second },
      })
      await payload.db.commitTransaction(first)

      await expect(payload.db.commitTransaction(second)).rejects.toMatchObject({ status: 409 })
      expect(await rawRows('SELECT id FROM _global_site')).toHaveLength(1)
      expect(await bannerStored()).toBe('first')
    })
  })

  test('createVersion fills the defaults under version and every locale of a localized field', async () => {
    const post = await payload.db.create({ collection: 'posts', data: { title: { en: 'x' } } })

    await payload.db.createVersion({
      autosave: false,
      collectionSlug: 'posts',
      createdAt: new Date().toISOString(),
      parent: post.id,
      updatedAt: new Date().toISOString(),
      versionData: { _status: { en: 'draft' }, title: { en: 'x' } },
    })

    const [version] = await rawRows('SELECT version FROM _posts_versions')

    expect(version?.['version']).toMatchObject({ _status: { en: 'draft', es: 'draft' } })
  })

  test('createGlobalVersion fills the defaults under version', async () => {
    await payload.db.createGlobalVersion({
      autosave: false,
      createdAt: new Date().toISOString(),
      globalSlug: 'site',
      updatedAt: new Date().toISOString(),
      versionData: { _status: { en: 'draft' }, tagline: { en: 'x' } },
    })

    const [version] = await rawRows('SELECT version FROM _global_site_versions')

    expect(version?.['version']).toMatchObject({
      _status: { en: 'draft', es: 'draft' },
      banner: 'B',
    })
  })

  test('the version data of the caller is not changed', async () => {
    const post = await payload.db.create({ collection: 'posts', data: { title: { en: 'x' } } })
    const versionData = { _status: { en: 'draft' }, title: { en: 'x' } }

    await payload.db.createVersion({
      autosave: false,
      collectionSlug: 'posts',
      createdAt: new Date().toISOString(),
      parent: post.id,
      updatedAt: new Date().toISOString(),
      versionData,
    })

    expect(versionData).toEqual({ _status: { en: 'draft' }, title: { en: 'x' } })
  })

  test('upsert fills the defaults when it creates a row', async () => {
    const created = await payload.db.upsert({
      collection: 'defaults',
      data: { title: 'new' },
      where: { title: { equals: 'new' } },
    })

    expect(created).toMatchObject({ rank: 0, text: 'T', title: 'new' })
  })
})

// A row written without the defaults, as one stored before they existed
const createBare = async () => {
  await rawRows(`CREATE defaults CONTENT { title: 'bare' }`)
}

const bareRow = async () => {
  const [row] = await rawRows('SELECT * FROM defaults')
  return row
}

describe('updates never apply defaults', () => {
  test('updateOne leaves the missing fields missing', async () => {
    await createBare()

    await payload.db.updateOne({
      collection: 'defaults',
      data: { title: 'changed' },
      where: { title: { equals: 'bare' } },
    })

    const row = await bareRow()

    expect(row).toMatchObject({ title: 'changed' })
    expect(row).not.toHaveProperty('text')
    expect(row).not.toHaveProperty('rank')
    expect(row).not.toHaveProperty('group')
  })

  test('updateMany leaves the missing fields missing', async () => {
    await createBare()

    await payload.db.updateMany({
      collection: 'defaults',
      data: { title: 'changed' },
      where: { title: { equals: 'bare' } },
    })

    expect(await bareRow()).not.toHaveProperty('text')
  })

  test('upsert that finds a row updates it without the defaults', async () => {
    await createBare()

    await payload.db.upsert({
      collection: 'defaults',
      data: { title: 'bare', rank: 3 },
      where: { title: { equals: 'bare' } },
    })

    const row = await bareRow()

    expect(row).toMatchObject({ rank: 3 })
    expect(row).not.toHaveProperty('text')
  })

  test('updateGlobal leaves the missing fields missing', async () => {
    await rawRows(
      `CREATE ONLY type::record('_global_site', 'singleton') CONTENT { globalType: 'site' }`,
    )
    await payload.db.updateGlobal({ slug: 'site', data: { tagline: { en: 'x' } } })

    const [site] = await rawRows('SELECT * FROM _global_site')

    expect(site).toMatchObject({ tagline: { en: 'x' } })
    expect(site).not.toHaveProperty('banner')
  })

  test('updateGlobalVersion leaves the missing fields missing', async () => {
    const [created] = await rawRows(
      `CREATE _global_site_versions CONTENT { latest: true, version: { tagline: { en: 'x' } } }`,
    )

    if (!created) {
      throw new Error('The version was not created.')
    }

    await payload.db.updateGlobalVersion({
      id: idOf(created),
      global: 'site',
      versionData: { version: { tagline: { en: 'y' } } },
    })

    const [stored] = await rawRows('SELECT version FROM _global_site_versions')

    expect(stored?.['version']).toEqual({ tagline: { en: 'y' } })
  })

  test('updateVersion leaves the statuses of the other locales missing', async () => {
    const [created] = await rawRows(
      `CREATE _posts_versions CONTENT { latest: true, version: { _status: { en: 'draft' } } }`,
    )

    if (!created) {
      throw new Error('The version was not created.')
    }

    await payload.db.updateVersion({
      id: idOf(created),
      collection: 'posts',
      versionData: { version: { _status: { en: 'published' } } },
    })

    const [stored] = await rawRows('SELECT version FROM _posts_versions')

    expect(stored?.['version']).toEqual({ _status: { en: 'published' } })
  })
})
