import type { Payload, Where } from 'payload'

import { buildConfig } from 'payload'
import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'vitest'

import type { SurrealDBAdapter } from '../src/index.js'

import { surrealdbAdapter } from '../src/index.js'
import { buildQueryTarget } from '../src/queries/buildQueryTarget.js'
import { ParamBag, whereClause } from '../src/queries/sql.js'
import { bootPayload, connectionArgs } from './helpers/payload.js'

const DATABASE = 'targets'

const config = buildConfig({
  collections: [
    { slug: 'users', auth: true, fields: [], versions: false },
    {
      slug: 'items',
      fields: [
        { name: 'title', type: 'text' },
        { name: 'rank', type: 'number' },
        { name: 'visibility', type: 'select', options: ['public', 'secret'] },
      ],
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
      slug: 'big',
      fields: [{ name: 'n', type: 'number' }],
      versions: false,
    },
  ],
  db: surrealdbAdapter(connectionArgs(DATABASE)),
  secret: 'test-secret',
  telemetry: false,
  typescript: { autoGenerate: false },
})

type Item = { id: string; title: string; visibility: string }

let payload: Payload
let adapter: SurrealDBAdapter
/** `a` to `e`, in the order of creation. */
let keys: string[]

const MISSING = 'nobody-has-this-id'

beforeAll(async () => {
  payload = await bootPayload(config, DATABASE)
  adapter = payload.db as SurrealDBAdapter
})

beforeEach(async () => {
  await payload.db.deleteMany({ collection: 'items', where: {} })
  await payload.db.deleteMany({ collection: 'numbered', where: {} })
  keys = []

  for (const [title, rank, visibility] of [
    ['a', 1, 'public'],
    ['b', 2, 'secret'],
    ['c', 3, 'public'],
    ['d', 4, 'secret'],
    ['e', 5, 'public'],
  ] as const) {
    const doc = await payload.db.create({
      collection: 'items',
      data: { rank, title, visibility },
    })

    keys.push(String(doc['id']))
  }

  for (const id of [11, 12, 13]) {
    await payload.db.create({ collection: 'numbered', data: { id, title: `n${id}` } })
  }
})

afterAll(async () => {
  await payload.destroy()
})

/**
 * The same condition behind an `or`, which is not read as naming the records and so filters the
 * table with `id IN`. It is what the answer to every `where` below is compared to.
 */
const viaTable = (ids: unknown): Where => ({ or: [{ id: { in: ids } }] })

type Case = { name: string; where: (ids: string[]) => Where; viaTable?: (ids: string[]) => Where }

const cases: Case[] = [
  { name: 'in, every record present', where: (k) => ({ id: { in: [k[0], k[2], k[4]] } }) },
  {
    name: 'in, some records missing',
    where: (k) => ({ id: { in: [k[1], MISSING, 'also-missing', k[3]] } }),
  },
  { name: 'in, only missing records', where: () => ({ id: { in: [MISSING] } }) },
  { name: 'in, empty list', where: () => ({ id: { in: [] } }) },
  { name: 'in, a record listed twice', where: (k) => ({ id: { in: [k[0], k[0], k[1]] } }) },
  { name: 'in, a comma separated string', where: (k) => ({ id: { in: `${k[0]},${k[2]}` } }) },
  {
    name: 'in, IDs of the wrong type',
    where: (k) => ({ id: { in: [k[0], 12, { nested: true }, null, '', true] } }),
  },
  { name: 'equals, a present record', where: (k) => ({ id: { equals: k[3] } }) },
  { name: 'equals, a missing record', where: () => ({ id: { equals: MISSING } }) },
  { name: 'equals, a number on a text ID collection', where: () => ({ id: { equals: 12 } }) },
  { name: 'equals, null', where: () => ({ id: { equals: null } }) },
  {
    name: 'in, with access control ANDed beside it',
    where: (k) => ({ id: { in: k }, visibility: { equals: 'public' } }),
  },
  {
    name: 'in, with access control in an and',
    where: (k) => ({ and: [{ id: { in: k } }, { visibility: { equals: 'secret' } }] }),
  },
  {
    name: 'in, inside nested ands',
    where: (k) => ({
      and: [
        { and: [{ rank: { greater_than: 1 } }, { id: { in: k } }] },
        { rank: { less_than: 5 } },
      ],
    }),
  },
  {
    name: 'in, with a condition that matches no listed record',
    where: (k) => ({ id: { in: k }, title: { equals: 'zzz' } }),
  },
  {
    name: 'equals, with another operator on the same ID',
    where: (k) => ({ id: { equals: k[0], not_equals: k[0] } }),
  },
  {
    name: 'two ID conditions, which must both hold',
    where: (k) => ({ and: [{ id: { in: [k[0], k[1], k[2]] } }, { id: { equals: k[1] } }] }),
  },
  {
    name: 'in, with an or beside it',
    where: (k) => ({
      id: { in: k },
      or: [{ rank: { less_than: 2 } }, { title: { equals: 'e' } }],
    }),
  },
]

describe('where that names records reads the same as the table filter', () => {
  describe.each(cases)('$name', ({ where }) => {
    test('find, with its page and total', async () => {
      for (const [limit, page] of [
        [0, 1],
        [2, 1],
        [2, 2],
        [2, 3],
      ] as const) {
        const named = await payload.db.find({
          collection: 'items',
          limit,
          page,
          sort: 'rank',
          where: where(keys),
        })
        // The same condition inside an `or` does not name the records, so it filters the table
        const expected = await payload.db.find({
          collection: 'items',
          limit,
          page,
          sort: 'rank',
          where: { or: [where(keys)] },
        })

        expect(named.docs.map((doc) => doc['id'])).toEqual(expected.docs.map((doc) => doc['id']))
        expect({ ...named, docs: undefined }).toEqual({ ...expected, docs: undefined })
      }
    })

    test('count and findOne', async () => {
      const expected = await payload.db.count({
        collection: 'items',
        where: { or: [where(keys)] },
      })

      expect(await payload.db.count({ collection: 'items', where: where(keys) })).toEqual(expected)

      const one = await payload.db.findOne({ collection: 'items', where: where(keys) })
      const matching = await payload.db.find({
        collection: 'items',
        sort: 'rank',
        where: { or: [where(keys)] },
      })

      if (matching.docs.length === 0) {
        expect(one).toBeNull()
      } else {
        expect(matching.docs.map((doc) => doc['id'])).toContain(one?.['id'])
      }
    })
  })

  test('a number ID collection: strings that are numbers, numbers and junk', async () => {
    for (const ids of [[11, 13], ['11', '12'], ['11', 'abc', 99, 1.5, 12], [], 'x,12']) {
      const named = await payload.db.find({
        collection: 'numbered',
        sort: 'id',
        where: { id: { in: ids } },
      })
      const expected = await payload.db.find({
        collection: 'numbered',
        sort: 'id',
        where: viaTable(ids),
      })

      expect(named.docs.map((doc) => doc['id'])).toEqual(expected.docs.map((doc) => doc['id']))
      expect(named.totalDocs).toBe(expected.totalDocs)
    }

    expect(
      (
        await payload.db.find({
          collection: 'numbered',
          where: { id: { equals: '12' } },
        })
      ).docs.map((doc) => doc['id']),
    ).toEqual([12])
    expect(
      (await payload.db.count({ collection: 'numbered', where: { id: { equals: 'abc' } } }))
        .totalDocs,
    ).toBe(0)
  })

  test('a query that does not read a list of records still works through the table', async () => {
    const { docs } = await payload.db.find<Item>({
      collection: 'items',
      sort: 'rank',
      where: { id: { not_in: [keys[0]] } },
    })

    expect(docs.map((doc) => doc['title'])).toEqual(['b', 'c', 'd', 'e'])
  })
})

describe('writes that name records', () => {
  const titles = async () =>
    (await payload.db.find<Item>({ collection: 'items', limit: 0, sort: 'rank' })).docs.map(
      (doc) => `${doc['title']}:${doc['visibility']}`,
    )

  test('updateOne by id, with the condition that goes with it', async () => {
    const [a, b] = keys

    expect(
      await payload.db.updateOne({
        collection: 'items',
        data: { title: 'A' },
        where: { id: { equals: a } },
      }),
    ).toMatchObject({ id: a, title: 'A' })

    // A condition that does not hold leaves the record as it is
    expect(
      await payload.db.updateOne({
        collection: 'items',
        data: { title: 'nope' },
        where: { and: [{ id: { equals: b } }, { visibility: { equals: 'public' } }] },
      }),
    ).toBeNull()

    expect((await titles()).slice(0, 2)).toEqual(['A:public', 'b:secret'])
  })

  test('updateOne of a record that does not exist creates nothing', async () => {
    for (const options of [{}, { atomic: true }]) {
      expect(
        await payload.db.updateOne({
          collection: 'items',
          data: { title: 'ghost' },
          options,
          where: { id: { equals: MISSING } },
        }),
      ).toBeNull()
    }

    expect(await payload.db.count({ collection: 'items' })).toEqual({ totalDocs: 5 })
    expect(
      await payload.db.count({ collection: 'items', where: { title: { equals: 'ghost' } } }),
    ).toEqual({ totalDocs: 0 })
  })

  test('updateOne by an id in a list of several picks one that matches', async () => {
    const doc = await payload.db.updateOne({
      collection: 'items',
      data: { title: 'picked' },
      where: { id: { in: keys.slice(1, 4) }, visibility: { equals: 'public' } },
    })

    expect(doc).toMatchObject({ id: keys[2], title: 'picked' })
  })

  test('updateMany by ids, with and without a limit', async () => {
    const [a, b, c, d] = keys
    const all = await payload.db.updateMany({
      collection: 'items',
      data: { title: 'x' },
      sort: '-rank',
      where: { id: { in: [a, MISSING, c, d] } },
    })

    expect(all?.map((doc) => doc['id'])).toEqual([d, c, a])

    const limited = await payload.db.updateMany({
      collection: 'items',
      data: { title: 'y' },
      limit: 2,
      sort: '-rank',
      where: { id: { in: [a, b, c, d] }, visibility: { equals: 'public' } },
    })

    expect(limited?.map((doc) => doc['id'])).toEqual([c, a])

    // The limit leaves every named record, so none is picked
    const roomy = await payload.db.updateMany({
      collection: 'items',
      data: { title: 'z' },
      limit: 10,
      sort: 'rank',
      where: { id: { in: [a, b] } },
    })

    expect(roomy?.map((doc) => doc['id'])).toEqual([a, b])
    expect(
      await payload.db.updateMany({
        collection: 'items',
        data: { title: 'q' },
        returning: false,
        where: { id: { in: [MISSING] } },
      }),
    ).toBeNull()
    expect(await titles()).toEqual(['z:public', 'z:secret', 'y:public', 'x:secret', 'e:public'])
  })

  test('deleteOne by id, with the condition that goes with it, and of a missing record', async () => {
    const [a, b] = keys

    expect(
      await payload.db.deleteOne({
        collection: 'items',
        where: { and: [{ id: { equals: a } }, { visibility: { equals: 'secret' } }] },
      }),
    ).toBeNull()
    expect(
      await payload.db.deleteOne({ collection: 'items', where: { id: { equals: MISSING } } }),
    ).toBeNull()
    expect(await payload.db.count({ collection: 'items' })).toEqual({ totalDocs: 5 })

    expect(
      await payload.db.deleteOne({ collection: 'items', where: { id: { equals: b } } }),
    ).toMatchObject({ id: b, title: 'b' })
    expect(await titles()).toEqual(['a:public', 'c:public', 'd:secret', 'e:public'])
  })

  test('deleteOne by an id in a list of several deletes one that matches', async () => {
    const deleted = await payload.db.deleteOne({
      collection: 'items',
      where: { id: { in: keys }, visibility: { equals: 'secret' } },
    })

    expect(['b', 'd']).toContain(deleted?.['title'])
    expect(await payload.db.count({ collection: 'items' })).toEqual({ totalDocs: 4 })
  })

  test('deleteMany by ids, with the condition that goes with them', async () => {
    const [a, b, c] = keys

    await payload.db.deleteMany({
      collection: 'items',
      where: { id: { in: [a, b, c, MISSING] }, visibility: { equals: 'public' } },
    })
    expect(await titles()).toEqual(['b:secret', 'd:secret', 'e:public'])

    await payload.db.deleteMany({ collection: 'items', where: { id: { in: [] } } })
    expect(await payload.db.count({ collection: 'items' })).toEqual({ totalDocs: 3 })
  })
})

describe('the plan of what names records', () => {
  const plan = async (where: Where, collectionSlug = 'items') => {
    const params = new ParamBag()
    const { condition, from } = buildQueryTarget({
      adapter,
      collectionSlug,
      fields: payload.collections[collectionSlug]?.config.flattenedFields ?? [],
      params,
      where,
    })
    const [rows] = await adapter.connection!.query<[unknown]>(
      `SELECT * FROM ${from}${whereClause(condition)} EXPLAIN`,
      params.vars,
    )

    return JSON.stringify(rows)
  }

  test('the table filter reads the table, which is what naming the records avoids', async () => {
    expect(await plan(viaTable(keys))).toContain('TableScan')
  })

  test.each(cases.filter(({ name }) => name.startsWith('in,') || name.startsWith('equals,')))(
    '$name does not scan the table',
    async ({ where }) => {
      const explained = await plan(where(keys))

      expect(explained).not.toContain('TableScan')
      expect(explained).not.toContain('Iterate Table')
    },
  )
})

describe('on a large table', () => {
  const ROWS = 20_000
  const CALLS = 20
  /**
   * Updating or deleting a record that is picked by a subquery costs about 3 ms per 1,000 rows,
   * 60 ms or more here, while one that is named costs a few. The limit is a mean over many calls,
   * and only a return to reading the table can reach it.
   */
  const MEAN_LIMIT_MS = 30

  const mean = async (run: (index: number) => Promise<unknown>): Promise<number> => {
    const start = performance.now()

    for (let index = 0; index < CALLS; index++) {
      await run(index)
    }

    return (performance.now() - start) / CALLS
  }

  test('writes that name records do not read the whole table', async () => {
    const seeded = await adapter.connection?.query(`
      FOR $i IN 0..${ROWS} { CREATE big:ulid() SET n = $i, createdAt = time::now(), updatedAt = time::now(); };
    `)

    if (!seeded) {
      throw new Error('The adapter is not connected.')
    }

    const { docs } = await payload.db.find({
      collection: 'big',
      limit: CALLS * 7,
      sort: 'createdAt',
    })
    const ids = docs.map((doc) => String(doc['id']))
    const named = (index: number, count: number) => ids.slice(index * 3, index * 3 + count)

    const updateOne = await mean((index) =>
      payload.db.updateOne({
        collection: 'big',
        data: { n: -1 },
        where: { id: { equals: ids[index] } },
      }),
    )
    const atomic = await mean((index) =>
      payload.db.updateOne({
        collection: 'big',
        data: { n: -2 },
        options: { atomic: true },
        where: { id: { equals: ids[index] } },
      }),
    )
    const updateMany = await mean((index) =>
      payload.db.updateMany({
        collection: 'big',
        data: { n: -3 },
        limit: 3,
        sort: 'createdAt',
        where: { id: { in: named(index, 3) } },
      }),
    )
    const deleteOne = await mean((index) =>
      payload.db.deleteOne({
        collection: 'big',
        where: { id: { equals: ids[index + CALLS * 6] } },
      }),
    )
    const deleteMany = await mean((index) =>
      payload.db.deleteMany({ collection: 'big', where: { id: { in: named(index + 20, 3) } } }),
    )

    expect(updateOne).toBeLessThan(MEAN_LIMIT_MS)
    expect(atomic).toBeLessThan(MEAN_LIMIT_MS)
    expect(updateMany).toBeLessThan(MEAN_LIMIT_MS)
    expect(deleteOne).toBeLessThan(MEAN_LIMIT_MS)
    expect(deleteMany).toBeLessThan(MEAN_LIMIT_MS)
    expect(await payload.db.count({ collection: 'big' })).toEqual({
      totalDocs: ROWS - CALLS - CALLS * 3,
    })
  }, 120_000)
})
