import type { Operator, Payload, TypeWithID, Where } from 'payload'

import { buildConfig } from 'payload'
import { afterAll, beforeAll, describe, expect, test } from 'vitest'

import type { SurrealDBAdapter } from '../src/index.js'

import { surrealdbAdapter } from '../src/index.js'
import { buildQuery } from '../src/queries/buildQuery.js'
import { ParamBag, escapeIdent } from '../src/queries/sql.js'
import { bootPayload, connectionArgs } from './helpers/payload.js'

/**
 * SurrealDB 3.3.2-3.3.5 returns wrong rows for a range over an indexed datetime when whole-second
 * and fractional-second values mix, and orders such values wrongly within one second. These
 * tests keep that data on indexed date fields (`createdAt`, `updatedAt` and a custom `at`).
 */

const config = buildConfig({
  collections: [
    {
      slug: 'ticks',
      fields: [
        { name: 'at', type: 'date', index: true },
        { name: 'label', type: 'text' },
      ],
      versions: false,
    },
    {
      slug: 'sorted',
      fields: [
        { name: 'at', type: 'date', index: true },
        { name: 'label', type: 'text' },
      ],
      versions: false,
    },
    {
      slug: 'ledger',
      fields: [{ name: 'at', type: 'date', index: true }],
      versions: { maxPerDoc: 0 },
    },
  ],
  db: surrealdbAdapter(connectionArgs('date_index')),
  secret: 'date-index-test',
  typescript: { autoGenerate: false },
})

const iso = (time: string) => `2026-01-01T${time}Z`

// a and b share a whole second, one with a fraction and one without; c and d sit either side.
const mixed = {
  a: iso('00:00:15.000'),
  b: iso('00:00:15.500'),
  c: iso('00:00:10.000'),
  d: iso('00:00:20.250'),
}

const operators = ['greater_than', 'greater_than_equal', 'less_than', 'less_than_equal'] as const

/** What each operator keeps, by the value it compares with and by label. */
const expected: Record<string, Record<(typeof operators)[number], string[]>> = {
  [iso('00:00:15.000')]: {
    greater_than: ['b', 'd'],
    greater_than_equal: ['a', 'b', 'd'],
    less_than: ['c'],
    less_than_equal: ['a', 'c'],
  },
  [iso('00:00:15.500')]: {
    greater_than: ['d'],
    greater_than_equal: ['b', 'd'],
    less_than: ['a', 'c'],
    less_than_equal: ['a', 'b', 'c'],
  },
}

const dateFields = ['at', 'createdAt', 'updatedAt'] as const

type Row = TypeWithID & { at?: string; label?: string }

let payload: Payload
let adapter: SurrealDBAdapter

const connection = () => {
  if (!payload.db.connection) {
    throw new Error('The adapter is not connected.')
  }

  return payload.db.connection
}

beforeAll(async () => {
  payload = await bootPayload(config, 'date-index')
  adapter = payload.db as SurrealDBAdapter

  for (const [label, at] of Object.entries(mixed)) {
    await payload.db.create({
      collection: 'ticks',
      data: { at, createdAt: at, label, updatedAt: at },
      returning: false,
    })
  }
})

afterAll(async () => {
  await payload.destroy()
})

const labelsOf = (docs: Row[]) => docs.map((doc) => doc.label).toSorted()

describe('the fixture really is on indexed fields', () => {
  test.each(dateFields)('%s has an index', async (field) => {
    const [info] = await connection().query<[{ indexes: Record<string, string> }]>(
      `INFO FOR TABLE ${escapeIdent('ticks')}`,
    )

    expect(Object.values(info.indexes).some((def) => def.includes(`FIELDS ${field}`))).toBe(true)
  })
})

describe('range operators on an indexed date, in the translator', () => {
  const cases = dateFields.flatMap((field) =>
    Object.keys(expected).flatMap((value) =>
      operators.map((operator) => ({ field, operator, value })),
    ),
  )

  test.each(cases)('$field $operator $value', async ({ field, operator, value }) => {
    const params = new ParamBag()
    const condition = buildQuery({
      adapter,
      collectionSlug: 'ticks',
      fields: payload.collections['ticks']!.config.flattenedFields,
      params,
      where: { [field]: { [operator]: value } } satisfies Where,
    })
    const [rows] = await connection().query<[{ label: string }[]]>(
      `SELECT label FROM ${escapeIdent('ticks')} WHERE ${condition}`,
      params.vars,
    )

    expect(rows.map((row) => row.label).toSorted()).toEqual(expected[value]?.[operator])
  })

  test('a missing or null date matches no range', async () => {
    await payload.db.create({ collection: 'ticks', data: { label: 'none' }, returning: false })
    const { docs } = await payload.db.find<Row>({
      collection: 'ticks',
      limit: 0,
      where: { at: { less_than: iso('01:00:00.000') } },
    })

    expect(labelsOf(docs)).toEqual(['a', 'b', 'c', 'd'])
    await payload.db.deleteMany({ collection: 'ticks', where: { label: { equals: 'none' } } })
  })
})

describe('range operators on an indexed date, through find', () => {
  const cases = dateFields.flatMap((field) =>
    Object.keys(expected).flatMap((value) =>
      operators.map((operator) => ({ field, operator, value })),
    ),
  )

  test.each(cases)('$field $operator $value', async ({ field, operator, value }) => {
    const where: Where = { [field]: { [operator as Operator]: value } }
    const { docs, totalDocs } = await payload.db.find<Row>({ collection: 'ticks', limit: 0, where })
    const counted = await payload.db.count({ collection: 'ticks', where })

    expect(labelsOf(docs)).toEqual(expected[value]?.[operator])
    expect(totalDocs).toBe(docs.length)
    expect(counted.totalDocs).toBe(docs.length)
  })

  test('equals and not_equals agree with a scan', async () => {
    const equal = await payload.db.find<Row>({
      collection: 'ticks',
      limit: 0,
      where: { at: { equals: mixed.a } },
    })
    const unequal = await payload.db.find<Row>({
      collection: 'ticks',
      limit: 0,
      where: { at: { not_equals: mixed.b } },
    })
    const inList = await payload.db.find<Row>({
      collection: 'ticks',
      limit: 0,
      where: { at: { in: [mixed.a, mixed.b] } },
    })

    expect(labelsOf(equal.docs)).toEqual(['a'])
    expect(labelsOf(unequal.docs)).toEqual(['a', 'c', 'd'])
    expect(labelsOf(inList.docs)).toEqual(['a', 'b'])
  })
})

const versionDates = (docs: { version: Record<string, unknown> }[]) =>
  docs.map((doc) => doc.version['at']).filter((at) => typeof at === 'string')

describe('range operators on a version field', () => {
  test('version.at and the version updatedAt', async () => {
    const parent = await payload.db.create({
      collection: 'ledger',
      data: { at: mixed.a },
    })

    for (const [label, at] of Object.entries(mixed)) {
      await payload.db.createVersion({
        autosave: false,
        collectionSlug: 'ledger',
        createdAt: at,
        parent: parent.id,
        updatedAt: at,
        versionData: { at, label },
      })
    }

    const base = { collection: 'ledger', limit: 0, pagination: false } as const
    const byVersionField = await payload.db.findVersions({
      ...base,
      where: { 'version.at': { greater_than_equal: iso('00:00:15.000') } },
    })
    const byUpdatedAt = await payload.db.findVersions({
      ...base,
      where: { updatedAt: { less_than_equal: iso('00:00:15.500') } },
    })

    expect(versionDates(byVersionField.docs).toSorted()).toEqual(
      [mixed.a, mixed.b, mixed.d].toSorted(),
    )
    expect(versionDates(byUpdatedAt.docs).toSorted()).toEqual(
      [mixed.a, mixed.b, mixed.c].toSorted(),
    )
  })
})

describe('ordering an indexed date', () => {
  // Whole and fractional seconds interleave inside the same second, which is what the index orders wrongly.
  const fractions = [0, 500, 250, 100, 999, 0, 500]
  const rows = Array.from({ length: 40 }, (_, i) => ({
    at: iso(
      `00:00:${String(i % 20).padStart(2, '0')}.${String(fractions[i % fractions.length]).padStart(3, '0')}`,
    ),
    label: `r${String(i).padStart(2, '0')}`,
  }))

  beforeAll(async () => {
    for (const row of rows) {
      await payload.db.create({
        collection: 'sorted',
        data: { ...row, createdAt: row.at, updatedAt: row.at },
        returning: false,
      })
    }
  })

  // Equal times keep their `id` order, which is the creation order for ULIDs, so r-labels break ties.
  const byTime = (direction: 1 | -1) =>
    rows
      .toSorted(
        (left, right) =>
          direction * (Date.parse(left.at) - Date.parse(right.at)) ||
          direction * left.label.localeCompare(right.label),
      )
      .map((row) => row.label)

  test.each(['at', 'createdAt', 'updatedAt'])('%s ascending, whole result', async (field) => {
    const { docs } = await payload.db.find<Row>({ collection: 'sorted', limit: 0, sort: field })

    expect(docs.map((doc) => doc.label)).toEqual(byTime(1))
  })

  test.each(['at', 'createdAt', 'updatedAt'])('-%s descending, whole result', async (field) => {
    const { docs } = await payload.db.find<Row>({
      collection: 'sorted',
      limit: 0,
      sort: `-${field}`,
    })

    expect(docs.map((doc) => doc.label)).toEqual(byTime(-1))
  })

  test('pages hold the same rows as the whole result and the total stays right', async () => {
    const asc = byTime(1)
    const seen: unknown[] = []

    for (let page = 1; page <= 4; page++) {
      const result = await payload.db.find<Row>({
        collection: 'sorted',
        limit: 10,
        page,
        sort: 'at',
      })

      seen.push(...result.docs.map((doc) => doc.label))
      expect(result).toMatchObject({ totalDocs: 40, totalPages: 4 })
    }

    expect(seen).toEqual(asc)
  })

  test('a limit on a descending sort takes the newest rows', async () => {
    const { docs } = await payload.db.find<Row>({
      collection: 'sorted',
      limit: 7,
      page: 2,
      sort: '-at',
    })

    expect(docs.map((doc) => doc.label)).toEqual(byTime(-1).slice(7, 14))
  })

  test('a select that leaves the sort field out returns no helper key', async () => {
    const { docs } = await payload.db.find<Row>({
      collection: 'sorted',
      limit: 3,
      select: { label: true },
      sort: 'at',
    })

    expect(docs.map((doc) => Object.keys(doc).toSorted())).toEqual(docs.map(() => ['id', 'label']))
  })

  test('updateMany with a limit picks rows in date order', async () => {
    const updated = await payload.db.updateMany({
      collection: 'sorted',
      data: { label: 'picked' },
      limit: 5,
      sort: 'at',
      where: { label: { not_equals: 'zzz' } },
    })

    expect(updated).toHaveLength(5)
    const { docs } = await payload.db.find<Row>({
      collection: 'sorted',
      limit: 0,
      sort: 'at',
      where: { label: { equals: 'picked' } },
    })
    const firstFive = byTime(1).slice(0, 5)
    expect(docs).toHaveLength(5)
    expect(docs.map((doc) => Date.parse(String(doc.at)))).toEqual(
      rows
        .filter((row) => firstFive.includes(row.label))
        .map((row) => Date.parse(row.at))
        .toSorted((left, right) => left - right),
    )
  })
})
