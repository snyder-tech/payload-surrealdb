import type { Payload, TypeWithID, ValidationError, Where } from 'payload'

import { buildConfig } from 'payload'
import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'vitest'

import { surrealdbAdapter } from '../src/index.js'
import { bootPayload, connectionArgs } from './helpers/payload.js'

type Point = [number, number]
type Place = {
  [key: string]: unknown
  id: string
  name?: string
  point?: Point
}

const allowAll = {
  create: () => true,
  delete: () => true,
  read: () => true,
  readVersions: () => true,
  update: () => true,
}

const config = buildConfig({
  collections: [
    { slug: 'users', auth: true, fields: [], versions: false },
    {
      slug: 'places',
      access: allowAll,
      fields: [
        { name: 'name', type: 'text' },
        { name: 'point', type: 'point' },
        { name: 'slot', type: 'point', unique: true },
        { name: 'defaulted', type: 'point', defaultValue: [1, 2] },
        { name: 'localizedPoint', type: 'point', localized: true },
        { name: 'localizedSlot', type: 'point', localized: true, unique: true },
        {
          name: 'group',
          type: 'group',
          fields: [
            { name: 'point', type: 'point' },
            { name: 'slot', type: 'point', unique: true },
          ],
        },
        { name: 'rows', type: 'array', fields: [{ name: 'point', type: 'point' }] },
        {
          name: 'content',
          type: 'blocks',
          blocks: [{ slug: 'spot', fields: [{ name: 'point', type: 'point' }] }],
        },
      ],
      versions: { drafts: true },
    },
    {
      slug: 'trips',
      access: allowAll,
      fields: [
        { name: 'title', type: 'text' },
        { name: 'home', type: 'relationship', relationTo: 'places' },
        { name: 'stops', type: 'relationship', hasMany: true, relationTo: 'places' },
      ],
      versions: false,
    },
  ],
  db: surrealdbAdapter(connectionArgs('geo')),
  globals: [
    {
      slug: 'venue',
      access: allowAll,
      fields: [
        { name: 'point', type: 'point' },
        { name: 'fallback', type: 'point', defaultValue: [3, 4] },
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

type Options = { draft?: boolean; locale?: 'en' | 'es' }

const create = (data: Record<string, unknown>, options: Options = {}): Promise<Place> =>
  payload.create({
    collection: 'places',
    data,
    depth: 0,
    overrideAccess: true,
    ...options,
  }) as Promise<Place>

/** A localized value is written for one locale at a time, as Payload's API does. */
const setLocalized = (id: string, locale: 'en' | 'es', data: Record<string, unknown>) =>
  payload.update({ id, collection: 'places', data, depth: 0, locale, overrideAccess: true })

const find = async (where: Where, extra: { locale?: 'en' | 'es'; sort?: string } = {}) => {
  const { docs } = (await payload.find({
    collection: 'places',
    depth: 0,
    overrideAccess: true,
    where,
    ...extra,
  })) as { docs: Place[] }

  return docs.map(({ name }) => name)
}

const nearPage = (page: number) =>
  payload
    .find({
      collection: 'places',
      depth: 0,
      limit: 2,
      overrideAccess: true,
      page,
      where: { point: { near: '0, 0, 100000' } },
    })
    .then(({ docs, totalDocs }) => ({ names: docs.map(({ name }) => name), totalDocs }))

const rawRows = async (sql: string) => {
  if (!payload.db.connection) {
    throw new Error('The adapter is not connected.')
  }

  const [rows] = await payload.db.connection.query<[Record<string, unknown>[]]>(sql)
  return rows
}

const violation = async (promise: Promise<unknown>): Promise<ValidationError> => {
  const error = await promise.then(
    () => undefined,
    (caught: unknown) => caught,
  )

  expect(error).toHaveProperty('name', 'ValidationError')

  return error as ValidationError
}

beforeAll(async () => {
  payload = await bootPayload(config, 'geo')
})

beforeEach(async () => {
  await payload.db.deleteMany({ collection: 'places', where: {} })
  await payload.db.deleteMany({ collection: 'trips', where: {} })
  await payload.db.deleteVersions({ collection: 'places', where: {} })
})

afterAll(async () => {
  await payload.destroy()
})

// Longitude steps of 0.0005, 0.002 and 0.01 degrees on the equator are about 56 m, 222 m and 1112 m.
const equator = async () => {
  await create({ name: 'far', point: [0.01, 0] })
  await create({ name: 'origin', point: [0, 0] })
  await create({ name: 'near', point: [0.0005, 0] })
  await create({ name: 'mid', point: [0.002, 0] })
  await create({ name: 'unlocated' })
  await create({ name: 'nulled', point: null })
}

describe('points are stored as geometry and read as [lng, lat]', () => {
  test('through the Local API', async () => {
    const created = await create({ name: 'a', point: [7, -7] })

    expect(created.point).toEqual([7, -7])
    expect(
      (
        await payload.findByID({
          id: created.id,
          collection: 'places',
          depth: 0,
          overrideAccess: true,
        })
      )['point'],
    ).toEqual([7, -7])
  })

  test('as a geometry value in the database, and as GeoJSON from the adapter', async () => {
    const { id } = await create({ name: 'a', point: [7, -7] })
    const [row] = await rawRows('SELECT type::is_point(point) AS stored FROM places')
    const doc = await payload.db.findOne<Place>({
      collection: 'places',
      where: { id: { equals: id } },
    })

    expect(row?.['stored']).toBe(true)
    expect(doc?.point).toEqual({ type: 'Point', coordinates: [7, -7] })
  })

  test('inside groups, arrays, blocks and localized fields', async () => {
    const doc = await create({
      name: 'nested',
      content: [{ blockType: 'spot', point: [5, 6] }],
      group: { point: [3, 4] },
      localizedPoint: [1, 2],
      rows: [{ point: [11, 12] }, { point: [13, 14] }],
    })

    await setLocalized(doc.id, 'es', { localizedPoint: [8, 9] })
    const [row] = await rawRows(
      `SELECT type::is_point(group.point) AS group, type::is_point(rows[0].point) AS row,
         type::is_point(content[0].point) AS block, type::is_point(localizedPoint.es) AS localized FROM places`,
    )

    expect(row).toEqual({ block: true, group: true, localized: true, row: true })

    const read = (locale: 'en' | 'es') =>
      payload.findByID({ id: doc.id, collection: 'places', depth: 0, locale, overrideAccess: true })

    expect(await read('es')).toMatchObject({
      content: [{ blockType: 'spot', point: [5, 6] }],
      group: { point: [3, 4] },
      localizedPoint: [8, 9],
      rows: [{ point: [11, 12] }, { point: [13, 14] }],
    })
    expect((await read('en'))['localizedPoint']).toEqual([1, 2])
  })

  test('a static default is stored as a geometry value and read back', async () => {
    const { id } = await create({ name: 'defaults' })
    const [row] = await rawRows('SELECT type::is_point(defaulted) AS stored FROM places')

    expect(row?.['stored']).toBe(true)
    expect(
      (await payload.findByID({ id, collection: 'places', depth: 0, overrideAccess: true }))[
        'defaulted'
      ],
    ).toEqual([1, 2])
  })

  test('updates replace the point', async () => {
    const { id } = await create({ name: 'moves', point: [1, 1] })
    const updated = await payload.update({
      id,
      collection: 'places',
      data: { point: [2, 3] },
      depth: 0,
    })
    const [row] = await rawRows('SELECT type::is_point(point) AS stored FROM places')

    expect(updated['point']).toEqual([2, 3])
    expect(row?.['stored']).toBe(true)
  })

  test('versions keep the point as a geometry value', async () => {
    const { id } = await create({ name: 'versioned', point: [4, 5] }, { draft: true })
    const [row] = await rawRows(
      'SELECT type::is_point(version.point) AS stored FROM _places_versions',
    )
    const { docs } = await payload.findVersions({
      collection: 'places',
      depth: 0,
      where: { parent: { equals: id } },
    })

    expect(row?.['stored']).toBe(true)
    expect(docs[0]?.version['point']).toEqual([4, 5])
  })

  test('in a global and in its versions', async () => {
    await payload.updateGlobal({
      slug: 'venue',
      data: { point: [12, 13] },
      depth: 0,
      overrideAccess: true,
    })

    const global = await payload.findGlobal({ slug: 'venue', depth: 0, overrideAccess: true })
    const { docs } = await payload.findGlobalVersions({
      slug: 'venue',
      depth: 0,
      overrideAccess: true,
    })
    const [row] = await rawRows('SELECT type::is_point(point) AS stored FROM _global_venue')

    expect(row?.['stored']).toBe(true)
    expect(global['point']).toEqual([12, 13])
    expect(global['fallback']).toEqual([3, 4])
    expect(docs[0]?.version['point']).toEqual([12, 13])
  })

  test('a point that is not GeoJSON with two numbers is rejected', async () => {
    await expect(
      payload.db.create({
        collection: 'places',
        data: { point: { coordinates: ['x', 1], type: 'Point' } },
      }),
    ).rejects.toThrow('Invalid point')
  })
})

describe('near', () => {
  test('orders by distance, nearest first, when no sort is given', async () => {
    await equator()

    expect(await find({ point: { near: '0, 0, 100000' } })).toEqual([
      'origin',
      'near',
      'mid',
      'far',
    ])
  })

  test('replaces an explicit sort, as Mongo does', async () => {
    await equator()

    expect(await find({ point: { near: '0, 0, 100000' } }, { sort: '-name' })).toEqual([
      'origin',
      'near',
      'mid',
      'far',
    ])
  })

  test('maximum distance', async () => {
    await equator()

    expect(await find({ point: { near: '0, 0, 100' } })).toEqual(['origin', 'near'])
    expect(await find({ point: { near: '0, 0, 300' } })).toEqual(['origin', 'near', 'mid'])
  })

  test('measures on the Earth radius Mongo uses, so the distance bounds cut where Mongo does', async () => {
    await create({ name: 'north', point: [0, 1] })

    // One degree of latitude is 6378100 * PI / 180 = 111318.85 m for Mongo's 2dsphere. On SurrealDB's own
    // radius it is 111194.93 m, which would put the point inside 111300.
    const mongoMetres = (6_378_100 * Math.PI) / 180

    expect(mongoMetres).toBeCloseTo(111_318.845, 3)
    expect(await find({ point: { near: '0,0,111320' } })).toEqual(['north'])
    expect(await find({ point: { near: '0,0,111319' } })).toEqual(['north'])
    expect(await find({ point: { near: '0,0,111318' } })).toEqual([])
    expect(await find({ point: { near: '0,0,111300' } })).toEqual([])
    expect(await find({ point: { near: '0,0,null,111318' } })).toEqual(['north'])
    expect(await find({ point: { near: '0,0,null,111319' } })).toEqual([])
  })

  test('minimum distance, with and without a maximum', async () => {
    await equator()

    expect(await find({ point: { near: '0, 0, null, 100' } })).toEqual(['mid', 'far'])
    expect(await find({ point: { near: '0, 0, 300, 100' } })).toEqual(['mid'])
  })

  test('as an array', async () => {
    await equator()

    expect(await find({ point: { near: [0, 0, 100, 0] } })).toEqual(['origin', 'near'])
    expect(await find({ point: { near: ['0', '0', null, 100] } })).toEqual(['mid', 'far'])
  })

  test('ignores documents without a point', async () => {
    await equator()

    const names = await find({ point: { near: '0, 0, null, 0' } })

    expect(names).not.toContain('unlocated')
    expect(names).not.toContain('nulled')
    expect(names).toHaveLength(4)
  })

  test('a condition without a point or without any distance is dropped', async () => {
    await equator()

    expect(await find({ point: { near: '0, 0' } })).toHaveLength(6)
    expect(await find({ point: { near: '0' } })).toHaveLength(6)
  })

  test('a longitude that is not a number is an error', async () => {
    await expect(find({ point: { near: 'x, 0, 100' } })).rejects.toThrow('numeric longitude')
  })

  test('pages follow the distance order', async () => {
    await equator()

    expect(await nearPage(1)).toEqual({ names: ['origin', 'near'], totalDocs: 4 })
    expect(await nearPage(2)).toEqual({ names: ['mid', 'far'], totalDocs: 4 })
  })

  test('combined with other conditions, and with an or', async () => {
    await equator()

    expect(
      await find({ and: [{ point: { near: '0, 0, 100000' } }, { name: { not_equals: 'near' } }] }),
    ).toEqual(['origin', 'mid', 'far'])
    // A row without a point can only reach the order through an `or`, and sorts last
    expect(
      await find({ or: [{ point: { near: '0, 0, 100' } }, { name: { equals: 'unlocated' } }] }),
    ).toEqual(['origin', 'near', 'unlocated'])
  })

  test('inside a group, an array, a block and a localized field', async () => {
    const { id } = await create({
      name: 'nested',
      content: [{ blockType: 'spot', point: [0, 0.0001] }],
      group: { point: [0, 0.0002] },
      localizedPoint: [50, 50],
      rows: [{ point: [40, 40] }, { point: [0, 0.0004] }],
    })

    await setLocalized(id, 'es', { localizedPoint: [0, 0.0003] })
    await create({ name: 'elsewhere', group: { point: [60, 60] }, rows: [{ point: [70, 70] }] })

    expect(await find({ 'group.point': { near: '0, 0, 100' } })).toEqual(['nested'])
    expect(await find({ 'rows.point': { near: '0, 0, 100' } })).toEqual(['nested'])
    expect(await find({ 'content.point': { near: '0, 0, 100' } })).toEqual(['nested'])
    expect(await find({ localizedPoint: { near: '0, 0, 100' } }, { locale: 'es' })).toEqual([
      'nested',
    ])
    expect(await find({ localizedPoint: { near: '0, 0, 100' } }, { locale: 'en' })).toEqual([])
  })

  test('inside a relationship path, with the points on the related documents', async () => {
    const nearby = await create({ name: 'nearby', point: [10, 20] })
    const away = await create({ name: 'away', point: [-50, 20] })
    const withNearby = await payload.create({
      collection: 'trips',
      data: { stops: [nearby.id], title: 'near trip' },
      overrideAccess: true,
    })

    await payload.create({
      collection: 'trips',
      data: { stops: [away.id], title: 'far trip' },
      overrideAccess: true,
    })
    await payload.create({
      collection: 'trips',
      data: { home: nearby.id, title: 'home trip' },
      overrideAccess: true,
    })

    const titles = async (where: Where) =>
      (await payload.find({ collection: 'trips', depth: 0, overrideAccess: true, where })).docs.map(
        ({ title }) => title,
      )

    // `equals` asks for every stop to match, which a trip without stops does too
    expect(await titles({ stops: { equals: { point: { near: '10, 20, 100000' } } } })).toEqual([
      'home trip',
      'near trip',
    ])
    expect(await titles({ stops: { contains: { point: { near: '10, 20, 100000' } } } })).toEqual([
      withNearby['title'],
    ])
    expect(await titles({ 'home.point': { near: '10, 20, 100000' } })).toEqual(['home trip'])
    expect(await titles({ 'stops.point': { near: '10, 20, 100000' } })).toEqual(['near trip'])
  })

  test('through the versions queries, nearest first', async () => {
    await create({ name: 'faraway', point: [0.01, 0] }, { draft: true })
    await create({ name: 'close', point: [0.0005, 0] }, { draft: true })

    const { docs } = await payload.findVersions({
      collection: 'places',
      depth: 0,
      where: { 'version.point': { near: '0, 0, 100000' } },
    })

    expect(docs.map(({ version }) => version['name'])).toEqual(['close', 'faraway'])
  })

  test('through a draft query, nearest first', async () => {
    await create({ name: 'faraway', point: [0.01, 0] }, { draft: true })
    await create({ name: 'close', point: [0.0005, 0] }, { draft: true })

    const { docs } = await payload.find({
      collection: 'places',
      depth: 0,
      draft: true,
      overrideAccess: true,
      where: { point: { near: '0, 0, 100000' } },
    })

    expect(docs.map(({ name }) => name)).toEqual(['close', 'faraway'])
  })
})

describe('within and intersects', () => {
  const polygon = {
    coordinates: [
      [
        [9, 19],
        [9, 21],
        [11, 21],
        [11, 19],
        [9, 19],
      ],
    ],
    type: 'Polygon',
  }

  beforeEach(async () => {
    await create({ name: 'inside', point: [10, 20] })
    await create({ name: 'outside', point: [30, 40] })
    await create({ name: 'unlocated' })
    await create({ name: 'nulled', point: null })
  })

  test.each(['within', 'intersects'])('%s a polygon', async (operator) => {
    expect(await find({ point: { [operator]: polygon } })).toEqual(['inside'])
  })

  test.each(['within', 'intersects'])('%s a polygon that is too small', async (operator) => {
    const small = {
      coordinates: [
        [
          [0.9, 1.9],
          [0.9, 2.1],
          [1.1, 2.1],
          [1.1, 1.9],
          [0.9, 1.9],
        ],
      ],
      type: 'Polygon',
    }

    expect(await find({ point: { [operator]: small } })).toEqual([])
  })

  test.each(['within', 'intersects'])(
    '%s a polygon whose numbers arrive as text',
    async (operator) => {
      const text = {
        ...polygon,
        coordinates: [polygon.coordinates[0]!.map((position) => position.map(String))],
      }

      expect(await find({ point: { [operator]: text } })).toEqual(['inside'])
    },
  )

  test('within a multi polygon', async () => {
    const multi = {
      coordinates: [
        polygon.coordinates,
        [
          [
            [29, 39],
            [29, 41],
            [31, 41],
            [31, 39],
            [29, 39],
          ],
        ],
      ],
      type: 'MultiPolygon',
    }

    expect((await find({ point: { within: multi } })).toSorted()).toEqual(['inside', 'outside'])
  })

  test('inside a group and an array', async () => {
    await create({ name: 'grouped', group: { point: [10, 20] }, rows: [{ point: [10, 20] }] })

    expect(await find({ 'group.point': { within: polygon } })).toEqual(['grouped'])
    expect(await find({ 'rows.point': { intersects: polygon } })).toEqual(['grouped'])
  })

  test('within a multi polygon whose numbers arrive as text', async () => {
    const multi = {
      coordinates: [
        polygon.coordinates.map((ring) => ring.map((position) => position.map(String))),
      ],
      type: 'MultiPolygon',
    }

    expect(await find({ point: { within: multi } })).toEqual(['inside'])
  })

  test.each(['within', 'intersects'])(
    '%s coordinates nested 5000 deep is a 400',
    async (operator) => {
      let coordinates: unknown = ['1']

      for (let depth = 0; depth < 5000; depth++) {
        coordinates = [coordinates]
      }

      const error = await find({ point: { [operator]: { coordinates, type: 'Polygon' } } }).catch(
        (caught: unknown) => caught,
      )

      expect(error).toMatchObject({
        message: expect.stringContaining('needs a GeoJSON geometry'),
        status: 400,
      })
    },
  )

  test('a geometry that is not GeoJSON is an error', async () => {
    await expect(
      find({ point: { within: { coordinates: [[1, 2]], type: 'Nope' } } }),
    ).rejects.toThrow('needs a GeoJSON geometry')
    await expect(find({ point: { intersects: 'polygon' } })).rejects.toThrow(
      'needs a GeoJSON geometry',
    )
  })
})

describe('exists on a point', () => {
  test('is true only for a stored point', async () => {
    await create({ name: 'located', point: [1, 1] })
    await create({ name: 'unlocated' })
    await create({ name: 'nulled', point: null })

    expect(await find({ point: { exists: true } })).toEqual(['located'])
    expect((await find({ point: { exists: false } })).toSorted()).toEqual(['nulled', 'unlocated'])
  })
})

describe('unique points', () => {
  test('exact coordinates cannot be stored twice', async () => {
    await create({ name: 'first', slot: [77.111, -66.222] })

    const error = await violation(create({ name: 'second', slot: [77.111, -66.222] }))

    expect(error.data.errors).toEqual([{ message: 'Value must be unique', path: 'slot' }])
  })

  test('coordinates that differ in the last decimal are different points', async () => {
    await create({ name: 'first', slot: [77.111, -66.222] })

    await expect(create({ name: 'second', slot: [77.111, -66.2220001] })).resolves.toBeDefined()
  })

  test('a point that is null or missing is not a duplicate', async () => {
    await create({ name: 'first', slot: null })
    await create({ name: 'second', slot: null })
    await create({ name: 'third' })

    await expect(create({ name: 'fourth' })).resolves.toBeDefined()
  })

  test('inside a group', async () => {
    await create({ group: { slot: [55.333, 44.444] } })

    const error = await violation(create({ group: { slot: [55.333, 44.444] } }))

    expect(error.data.errors).toEqual([{ message: 'Value must be unique', path: 'group.slot' }])
  })

  test('per locale when localized', async () => {
    await create({ localizedSlot: [1, 1] }, { locale: 'en' })

    await expect(create({ localizedSlot: [1, 1] }, { locale: 'es' })).resolves.toBeDefined()

    const error = await violation(create({ localizedSlot: [1, 1] }, { locale: 'es' }))

    expect(error.data.errors).toEqual([{ message: 'Value must be unique', path: 'localizedSlot' }])
  })

  test('an update that collides', async () => {
    await create({ name: 'taken', slot: [5, 5] })
    const { id } = await create({ name: 'free', slot: [6, 6] })

    const error = await violation(
      payload.update({
        id,
        collection: 'places',
        data: { slot: [5, 5] },
        depth: 0,
        overrideAccess: true,
      }),
    )

    expect(error.data.errors).toEqual([{ message: 'Value must be unique', path: 'slot' }])
  })

  test('versions may repeat a point', async () => {
    const doc = await create({ name: 'versioned', slot: [9, 9] })

    await payload.update({
      id: doc.id,
      collection: 'places',
      data: { name: 'again' },
      depth: 0,
      overrideAccess: true,
    })

    const { totalDocs } = await payload.findVersions({
      collection: 'places',
      where: { parent: { equals: doc.id } },
    })

    expect(totalDocs).toBeGreaterThan(1)
  })

  test('a non-unique point is not indexed, because SurrealDB has no spatial index', async () => {
    if (!payload.db.connection) {
      throw new Error('The adapter is not connected.')
    }

    const [info] =
      await payload.db.connection.query<[{ indexes: Record<string, string> }]>(
        'INFO FOR TABLE places',
      )
    const names = Object.keys(info.indexes)

    expect(names).toContain('places__slot__unique')
    expect(names.filter((name) => name.includes('__point'))).toEqual([])
  })
})

describe('a relationship to a document that does not exist', () => {
  test('is stored as it was given, as Mongo does, and read back unpopulated', async () => {
    const trip = (await payload.create({
      collection: 'trips',
      data: { home: 'not-real-id', title: 'dangling' },
      overrideAccess: true,
    })) as TypeWithID & { home: unknown }

    expect(trip.home).toBe('not-real-id')

    const read = await payload.findByID({
      id: trip.id,
      collection: 'trips',
      depth: 1,
      overrideAccess: true,
    })

    expect(read['home']).toBe('not-real-id')
  })
})
