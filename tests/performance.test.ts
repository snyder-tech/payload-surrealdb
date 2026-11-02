import type { Payload, Where } from 'payload'

import { buildConfig } from 'payload'
import { afterAll, beforeAll, describe, expect, test } from 'vitest'

import { surrealdbAdapter } from '../src/index.js'
import { bootPayload, connectionArgs } from './helpers/payload.js'

/**
 * Filters through a hasMany relationship, with the nested `where` that Payload builds for an
 * anonymous request, over a table big enough for a quadratic search to show. The even tags are
 * readable, so the filter keeps ten thousand of the twenty thousand: the list of matching IDs a
 * naive translation would search for every row. That took 2.6 s; it takes well under a tenth of
 * that, so the limit is generous and only a return to a search in proportion to the product of the
 * list and the table can reach it.
 */

const ROWS = 20_000
const LIMIT_MS = 1_500

const config = buildConfig({
  collections: [
    {
      slug: 'ptags',
      access: { read: () => ({ visibility: { equals: 'public' } }) },
      fields: [
        { name: 'name', type: 'text' },
        { name: 'visibility', type: 'select', options: ['public', 'secret'] },
      ],
      versions: false,
    },
    {
      slug: 'pposts',
      access: { read: () => true },
      fields: [
        { name: 'title', type: 'text' },
        { name: 'tags', type: 'relationship', hasMany: true, relationTo: 'ptags' },
      ],
      versions: false,
    },
  ],
  db: surrealdbAdapter(connectionArgs('performance')),
  secret: 'test-secret',
  telemetry: false,
  typescript: { autoGenerate: false },
})

let payload: Payload

/** Post `i` links to tag `i` and to tag `i % 7 + 1`; a tag is readable when its number is even. */
const readableTag = (tag: number) => tag % 2 === 0
const postHasReadableTag = (post: number) => readableTag(post) || readableTag((post % 7) + 1)

const expectedPosts = Array.from({ length: ROWS }, (_, post) => post).filter(
  postHasReadableTag,
).length

const timed = async <T>(run: () => Promise<T>): Promise<{ elapsed: number; result: T }> => {
  const start = performance.now()
  const result = await run()

  return { elapsed: performance.now() - start, result }
}

beforeAll(async () => {
  payload = await bootPayload(config, 'performance')

  const seeded = await payload.db.connection?.query(`
    FOR $i IN 0..${ROWS} {
      CREATE type::record('ptags', <string>$i) SET
        name = 'tag' + <string>$i,
        visibility = IF $i % 2 = 0 { 'public' } ELSE { 'secret' };
    };
    FOR $i IN 0..${ROWS} {
      CREATE type::record('pposts', <string>$i) SET
        title = 'post' + <string>$i,
        tags = [type::record('ptags', <string>$i), type::record('ptags', <string>($i % 7 + 1))],
        createdAt = time::now(),
        updatedAt = time::now();
    };
  `)

  if (!seeded) {
    throw new Error('The adapter is not connected.')
  }
}, 120_000)

afterAll(async () => {
  await payload.destroy()
})

describe('a filter through a hasMany relationship on a large table', () => {
  test('a path as an anonymous request filters it, with the access of the related documents', async () => {
    const { elapsed, result } = await timed(() =>
      payload.count({
        collection: 'pposts',
        overrideAccess: false,
        where: { 'tags.name': { not_equals: 'nobody' } },
      }),
    )

    expect(result.totalDocs).toBe(expectedPosts)
    expect(elapsed).toBeLessThan(LIMIT_MS)
  })

  test.each([
    ['contains', expectedPosts],
    ['not_equals', ROWS - expectedPosts],
  ] as const)('%s a nested where', async (operator, expected) => {
    const where: Where = { tags: { [operator]: { visibility: { equals: 'public' } } } }
    const { elapsed, result } = await timed(() => payload.db.count({ collection: 'pposts', where }))

    expect(result.totalDocs).toBe(expected)
    expect(elapsed).toBeLessThan(LIMIT_MS)
  })

  test('equals a nested where, which every link must satisfy', async () => {
    const where: Where = { tags: { equals: { visibility: { equals: 'public' } } } }
    const { elapsed, result } = await timed(() => payload.db.count({ collection: 'pposts', where }))
    const every = Array.from({ length: ROWS }, (_, post) => post).filter(
      (post) => readableTag(post) && readableTag((post % 7) + 1),
    ).length

    expect(result.totalDocs).toBe(every)
    expect(elapsed).toBeLessThan(LIMIT_MS)
  })
})
