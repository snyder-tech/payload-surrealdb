import type { Payload } from 'payload'

import { buildConfig } from 'payload'
import { afterAll, beforeAll, describe, expect, test } from 'vitest'

import type { Args } from '../src/index.js'

import { surrealdbAdapter } from '../src/index.js'
import { bootPayload, connectionArgs } from './helpers/payload.js'

const allowAll = { create: () => true, delete: () => true, read: () => true }

const config = (database: string, collation: Args['collation']) =>
  buildConfig({
    collections: [
      {
        slug: 'people',
        access: allowAll,
        fields: [{ name: 'name', type: 'text' }],
        versions: false,
      },
      {
        slug: 'items',
        access: allowAll,
        defaultSort: 'name',
        fields: [
          { name: 'name', type: 'text' },
          { name: 'rank', type: 'number' },
          { name: 'when', type: 'date' },
          { name: 'owner', type: 'relationship', relationTo: 'people' },
          { name: 'tags', type: 'text', hasMany: true },
        ],
        versions: false,
      },
    ],
    db: surrealdbAdapter({
      ...connectionArgs(database),
      ...(collation === undefined ? {} : { collation }),
    }),
    secret: 'test-secret',
    telemetry: false,
    typescript: { autoGenerate: false },
  })

const names = ['b', 'B', 'a', 'á', 'Post 10', 'Post 2', 'Post 1', 'c']

type Setup = { name: string; payload: Payload }

const boot = async (database: string, collation: Args['collation']): Promise<Setup> => {
  const payload = await bootPayload(config(database, collation), database)

  for (const [index, name] of names.entries()) {
    const owner = await payload.create({
      collection: 'people',
      data: { name },
      overrideAccess: true,
    })

    await payload.create({
      collection: 'items',
      data: {
        name,
        owner: owner.id,
        rank: names.length - index,
        tags: [name],
        when: new Date(Date.UTC(2020, 0, 1 + index)).toISOString(),
      },
      overrideAccess: true,
    })
  }

  return { name: database, payload }
}

const sorted = async ({ payload }: Setup, sort: string) =>
  (
    await payload.find({ collection: 'items', depth: 0, limit: 0, overrideAccess: true, sort })
  ).docs.map(({ name }) => name)

const sortedPage = async ({ payload }: Setup, page: number) =>
  (
    await payload.find({
      collection: 'items',
      depth: 0,
      limit: 3,
      overrideAccess: true,
      page,
      sort: 'name',
    })
  ).docs.map(({ name }) => name)

const binaryOrder = ['B', 'Post 1', 'Post 10', 'Post 2', 'a', 'b', 'c', 'á']
const collatedOrder = ['a', 'á', 'B', 'b', 'c', 'Post 1', 'Post 10', 'Post 2']
const numericOrder = ['a', 'á', 'B', 'b', 'c', 'Post 1', 'Post 2', 'Post 10']

let binary: Setup
let disabled: Setup
let collated: Setup
let numeric: Setup

beforeAll(async () => {
  binary = await boot('collation-binary', undefined)
  disabled = await boot('collation-disabled', false)
  collated = await boot('collation-collate', true)
  numeric = await boot('collation-numeric', { numericOrdering: true })
})

afterAll(async () => {
  await Promise.all([binary, disabled, collated, numeric].map(({ payload }) => payload.destroy()))
})

describe('without a collation', () => {
  test.each(['unset', 'false'])('sorts by byte value when it is %s', async (option) => {
    const setup = option === 'unset' ? binary : disabled

    expect(await sorted(setup, 'name')).toEqual(binaryOrder)
    expect(await sorted(setup, '-name')).toEqual(binaryOrder.toReversed())
  })
})

describe('collation: true', () => {
  test('sorts letters alphabetically instead of by byte value', async () => {
    expect(await sorted(collated, 'name')).toEqual(collatedOrder)
    expect(await sorted(collated, '-name')).toEqual(collatedOrder.toReversed())
  })

  test('does not sort numbers inside text numerically', async () => {
    expect((await sorted(collated, 'name')).slice(-3)).toEqual(['Post 1', 'Post 10', 'Post 2'])
  })

  test('applies to the collection default sort', async () => {
    const { docs } = await collated.payload.find({
      collection: 'items',
      depth: 0,
      limit: 0,
      overrideAccess: true,
    })

    expect(docs.map(({ name }) => name)).toEqual(collatedOrder)
  })

  test('applies to a sort by a related document', async () => {
    expect(await sorted(collated, 'owner.name')).toEqual(collatedOrder)
    expect(await sorted(binary, 'owner.name')).toEqual(binaryOrder)
  })

  test('applies to a sort by the values of a hasMany field', async () => {
    expect(await sorted(collated, 'tags')).toEqual(collatedOrder)
    expect(await sorted(collated, '-tags')).toEqual(collatedOrder.toReversed())
  })

  test('keeps pages in order', async () => {
    expect(await sortedPage(collated, 1)).toEqual(collatedOrder.slice(0, 3))
    expect(await sortedPage(collated, 3)).toEqual(collatedOrder.slice(6))
  })

  test('leaves number and date sorts alone', async () => {
    expect(await sorted(collated, 'rank')).toEqual(await sorted(binary, 'rank'))
    expect(await sorted(collated, '-rank')).toEqual(await sorted(binary, '-rank'))
    expect(await sorted(collated, 'when')).toEqual(await sorted(binary, 'when'))
    expect(await sorted(collated, 'when')).toEqual(names)
  })
})

describe('collation: { numericOrdering: true }', () => {
  test('sorts numbers inside text by value', async () => {
    expect(await sorted(numeric, 'name')).toEqual(numericOrder)
    expect(await sorted(numeric, '-name')).toEqual(numericOrder.toReversed())
  })

  test('also applies to a sort by a related document', async () => {
    expect(await sorted(numeric, 'owner.name')).toEqual(numericOrder)
  })
})

describe('collation with a bulk update', () => {
  test('picks the rows of a limited bulk update in collated order', async () => {
    const { docs } = await collated.payload.update({
      collection: 'items',
      data: { rank: 0 },
      depth: 0,
      limit: 2,
      overrideAccess: true,
      sort: 'name',
      where: { name: { exists: true } },
    })

    expect(docs.map(({ name }) => name)).toEqual(['a', 'á'])
  })
})
