import type { Payload } from 'payload'

import { buildConfig } from 'payload'
import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'vitest'

import { surrealdbAdapter } from '../src/index.js'
import { bootPayload, connectionArgs } from './helpers/payload.js'

const config = buildConfig({
  collections: [
    {
      slug: 'categories',
      fields: [{ name: 'title', type: 'text' }],
      versions: false,
    },
    {
      slug: 'posts',
      fields: [
        { name: 'title', type: 'text' },
        { name: 'number', type: 'number' },
        { name: 'tags', type: 'text', hasMany: true },
        { name: 'category', type: 'relationship', relationTo: 'categories' },
        { name: 'cats', type: 'relationship', hasMany: true, relationTo: 'categories' },
        { name: 'when', type: 'date' },
        { name: 'label', type: 'text', localized: true },
        { name: 'group', type: 'group', fields: [{ name: 'note', type: 'text' }] },
      ],
      versions: false,
    },
  ],
  db: surrealdbAdapter(connectionArgs('findDistinct')),
  localization: { defaultLocale: 'en', locales: ['en', 'es'] },
  secret: 'test-secret',
  telemetry: false,
  typescript: { autoGenerate: false },
})

let payload: Payload

const create = (data: Record<string, unknown>) =>
  payload.create({ collection: 'posts', data, depth: 0, overrideAccess: true })

const category = (title: string) =>
  payload.create({ collection: 'categories', data: { title }, depth: 0, overrideAccess: true })

const distinct = (args: Record<string, unknown> & { field: string }) =>
  payload.db.findDistinct({ collection: 'posts', ...args })

beforeAll(async () => {
  payload = await bootPayload(config, 'findDistinct')
})

beforeEach(async () => {
  await payload.db.clearDatabase()
})

afterAll(async () => {
  await payload.destroy()
})

describe('findDistinct', () => {
  test('lists each value once, sorted by the field, and pages the values', async () => {
    for (const [title, copies] of [
      ['title-3', 1],
      ['title-1', 3],
      ['title-2', 2],
      ['title-4', 1],
      ['title-5', 2],
    ] as const) {
      for (let copy = 0; copy < copies; copy++) {
        await create({ title })
      }
    }

    const all = await distinct({ field: 'title' })
    expect(all.values.map((each) => each['title'])).toEqual([
      'title-1',
      'title-2',
      'title-3',
      'title-4',
      'title-5',
    ])
    expect(all).toMatchObject({
      hasNextPage: false,
      limit: 0,
      page: 1,
      totalDocs: 5,
      totalPages: 1,
    })

    const descending = await distinct({ field: 'title', sort: '-title' })
    expect(descending.values.map((each) => each['title'])).toEqual([
      'title-5',
      'title-4',
      'title-3',
      'title-2',
      'title-1',
    ])

    const second = await distinct({ field: 'title', limit: 2, page: 2 })
    expect(second.values.map((each) => each['title'])).toEqual(['title-3', 'title-4'])
    expect(second).toEqual({
      hasNextPage: true,
      hasPrevPage: true,
      limit: 2,
      nextPage: 3,
      page: 2,
      pagingCounter: 3,
      prevPage: 1,
      totalDocs: 5,
      totalPages: 3,
      values: second.values,
    })

    const last = await distinct({ field: 'title', limit: 2, page: 3 })
    expect(last.values).toEqual([{ title: 'title-5' }])
    expect(last).toMatchObject({ hasNextPage: false, nextPage: null })
  })

  test('sorts by another field, which takes the largest value of each group', async () => {
    await create({ number: 5, title: 'a' })
    await create({ number: 50, title: 'a' })
    await create({ number: 30, title: 'b' })
    await create({ number: 10, title: 'c' })

    const ascending = await distinct({ field: 'title', sort: 'number' })
    const descending = await distinct({ field: 'title', sort: '-number' })

    expect(ascending.values.map((each) => each['title'])).toEqual(['c', 'b', 'a'])
    expect(descending.values.map((each) => each['title'])).toEqual(['a', 'b', 'c'])
  })

  test('groups a missing value and a null as one null', async () => {
    await create({ title: 'a' })
    await create({})
    await create({ title: null })

    const { values } = await distinct({ field: 'title' })

    expect(values).toEqual([{ title: null }, { title: 'a' }])
  })

  test('lists the elements of a hasMany field, and a null for an empty one', async () => {
    await create({ tags: ['b', 'a'] })
    await create({ tags: ['c', 'a'] })
    await create({ tags: [] })
    await create({})

    const { totalDocs, values } = await distinct({ field: 'tags' })

    expect(values).toEqual([{ tags: null }, { tags: 'a' }, { tags: 'b' }, { tags: 'c' }])
    expect(totalDocs).toBe(4)
  })

  test('lists the keys of a relationship, and of a hasMany one', async () => {
    const one = await category('one')
    const two = await category('two')
    await create({ category: one.id, cats: [one.id, two.id] })
    await create({ category: one.id, cats: [two.id] })
    await create({ category: two.id })

    const single = await distinct({ field: 'category' })
    const many = await distinct({ field: 'cats' })

    expect(single.values.map((each) => each['category']).toSorted()).toEqual(
      [one.id, two.id].toSorted(),
    )
    expect(many.values.map((each) => each['cats']).toSorted()).toEqual(
      [one.id, two.id, null].toSorted(),
    )
  })

  test('reads a field through a relationship and leaves out what has none', async () => {
    const one = await category('one')
    const two = await category('two')
    await create({ category: two.id })
    await create({ category: one.id })
    await create({ category: one.id })
    await create({ title: 'no category' })

    const { totalDocs, values } = await distinct({ field: 'category.title' })

    expect(values).toEqual([{ 'category.title': 'one' }, { 'category.title': 'two' }])
    expect(totalDocs).toBe(2)

    // A post without a category is the null value of the field itself, and it sorts first
    const ordered = await distinct({ field: 'category', sort: 'category.title' })
    expect(ordered.values).toEqual([{ category: null }, { category: one.id }, { category: two.id }])

    const reversed = await distinct({ field: 'category', sort: '-category.title' })
    expect(reversed.values).toEqual([
      { category: two.id },
      { category: one.id },
      { category: null },
    ])
  })

  test('keeps only the related documents that access allows', async () => {
    const open = await category('open')
    const secret = await category('secret')
    await create({ cats: [open.id, secret.id], title: 'mixed' })
    await create({ cats: [secret.id], title: 'only secret' })

    const result = await distinct({
      field: 'cats.title',
      relatedAccess: { cats: { title: { not_equals: 'secret' } } },
      where: { cats: { contains: { title: { not_equals: 'secret' } } } },
    })

    expect(result.values).toEqual([{ 'cats.title': 'open' }])
  })

  test('filters with a where, including a path through a relationship', async () => {
    const one = await category('one')
    await create({ category: one.id, title: 'kept' })
    await create({ title: 'dropped' })

    const { values } = await distinct({
      field: 'title',
      where: { 'category.title': { equals: 'one' } },
    })

    expect(values).toEqual([{ title: 'kept' }])
  })

  test('reads the locale of a localized field, and dates as ISO strings', async () => {
    await payload.create({
      collection: 'posts',
      data: { label: 'hola', when: '2025-02-03T04:05:06.000Z' },
      depth: 0,
      locale: 'es',
      overrideAccess: true,
    })
    await payload.create({
      collection: 'posts',
      data: { label: 'hello', when: '2025-01-01T00:00:00.000Z' },
      depth: 0,
      locale: 'en',
      overrideAccess: true,
    })

    expect((await distinct({ field: 'label', locale: 'es' })).values).toEqual([
      { label: null },
      { label: 'hola' },
    ])
    expect((await distinct({ field: 'when' })).values).toEqual([
      { when: '2025-01-01T00:00:00.000Z' },
      { when: '2025-02-03T04:05:06.000Z' },
    ])
  })

  test('reads a field inside a group', async () => {
    await create({ group: { note: 'x' } })
    await create({ group: { note: 'x' } })
    await create({ group: { note: 'y' } })

    expect((await distinct({ field: 'group.note' })).values).toEqual([
      { 'group.note': 'x' },
      { 'group.note': 'y' },
    ])
  })
})
