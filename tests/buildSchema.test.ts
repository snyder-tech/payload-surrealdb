import type { Block, Payload } from 'payload'

import { buildConfig } from 'payload'
import { afterAll, beforeAll, describe, expect, test } from 'vitest'

import type { SurrealDBAdapter } from '../src/index.js'

import { surrealdbAdapter } from '../src/index.js'
import { toDefineIndex } from '../src/models/buildSchema.js'
import { bootPayload, connectionArgs } from './helpers/payload.js'

const sharedBlock: Block = { slug: 'shared', fields: [{ name: 'ref', type: 'text', index: true }] }

const config = buildConfig({
  blocks: [sharedBlock],
  collections: [
    { slug: 'users', auth: true, fields: [], versions: false },
    { slug: 'authors', fields: [{ name: 'name', type: 'text' }], versions: false },
    {
      slug: 'pages',
      fields: [
        { name: 'plain', type: 'text' },
        { name: 'indexed', type: 'text', index: true },
        { name: 'slug', type: 'text', unique: true },
        { name: 'views', type: 'number', index: true },
        { name: 'virtualField', type: 'text', index: true, virtual: true },
        { name: 'localizedTitle', type: 'text', localized: true, unique: true },
        { name: 'point', type: 'point', index: true },
        { name: 'slot', type: 'point', unique: true },
        {
          name: 'meta',
          type: 'group',
          fields: [
            { name: 'code', type: 'text', unique: true },
            {
              name: 'seo',
              type: 'group',
              fields: [{ name: 'keyword', type: 'text', index: true }],
            },
          ],
        },
        {
          type: 'tabs',
          tabs: [{ name: 'tabbed', fields: [{ name: 'label', type: 'text', index: true }] }],
        },
        {
          name: 'rows',
          type: 'array',
          fields: [
            { name: 'sku', type: 'text', unique: true },
            { name: 'note', type: 'text', index: true },
          ],
        },
        {
          name: 'content',
          type: 'blocks',
          blocks: [
            { slug: 'hero', fields: [{ name: 'heading', type: 'text', index: true }] },
            { slug: 'teaser', fields: [{ name: 'heading', type: 'text', index: true }] },
            'shared',
          ],
        },
        { name: 'keywords', type: 'text', hasMany: true, index: true },
        { name: 'author', type: 'relationship', relationTo: 'authors', index: true },
        {
          name: 'coauthors',
          type: 'relationship',
          relationTo: 'authors',
          hasMany: true,
          index: true,
        },
        { name: 'related', type: 'relationship', relationTo: ['authors', 'pages'], index: true },
        {
          name: 'editors',
          type: 'relationship',
          hasMany: true,
          relationTo: 'authors',
          unique: true,
        },
        {
          name: 'owners',
          type: 'relationship',
          hasMany: true,
          relationTo: ['authors', 'pages'],
          unique: true,
        },
        { name: 'a', type: 'text' },
        { name: 'b', type: 'text', localized: true },
        { name: 'c', type: 'text' },
      ],
      indexes: [{ fields: ['a', 'c'], unique: true }, { fields: ['a', 'b'] }],
      versions: { drafts: true },
    },
    { slug: 'plain', fields: [{ name: 'title', type: 'text', index: true }], versions: false },
  ],
  db: surrealdbAdapter(connectionArgs('buildschema')),
  globals: [
    {
      slug: 'settings',
      fields: [{ name: 'site', type: 'text', unique: true }],
      versions: { drafts: true },
    },
  ],
  jobs: { tasks: [{ slug: 'noop', handler: () => ({ output: {} }) }] },
  localization: { defaultLocale: 'en', locales: ['en', 'pt-BR'] },
  secret: 'test-secret',
  telemetry: false,
  typescript: { autoGenerate: false },
})

let payload: Payload
let adapter: SurrealDBAdapter

const ddl = (table: string) =>
  adapter.indexes
    .filter((index) => index.table === table)
    .map(toDefineIndex)
    .map((statement) => statement.replace('DEFINE INDEX IF NOT EXISTS ', ''))

beforeAll(async () => {
  payload = await bootPayload(config, 'buildschema')
  adapter = payload.db as SurrealDBAdapter
})

afterAll(async () => {
  await payload.destroy()
})

describe('generated index DDL', () => {
  test('a collection', () => {
    expect(ddl('pages')).toMatchInlineSnapshot(`
      [
        "\`pages::count\` ON \`pages\` COUNT",
        "\`pages__indexed\` ON \`pages\` FIELDS \`indexed\`",
        "\`pages__slug__unique\` ON \`pages\` FIELDS \`slug\` UNIQUE",
        "\`pages__views\` ON \`pages\` FIELDS \`views\`",
        "\`pages__localizedTitle_en__unique\` ON \`pages\` FIELDS \`localizedTitle\`.\`en\` UNIQUE",
        "\`pages__localizedTitle_pt_BR__unique\` ON \`pages\` FIELDS \`localizedTitle\`.\`pt-BR\` UNIQUE",
        "\`pages__slot__unique\` ON \`pages\` FIELDS \`slot\` UNIQUE",
        "\`pages__meta_code__unique\` ON \`pages\` FIELDS \`meta\`.\`code\` UNIQUE",
        "\`pages__meta_seo_keyword\` ON \`pages\` FIELDS \`meta\`.\`seo\`.\`keyword\`",
        "\`pages__tabbed_label\` ON \`pages\` FIELDS \`tabbed\`.\`label\`",
        "\`pages__rows_each_sku\` ON \`pages\` FIELDS \`rows\`.*.\`sku\`",
        "\`pages__rows_each_note\` ON \`pages\` FIELDS \`rows\`.*.\`note\`",
        "\`pages__content_each_heading\` ON \`pages\` FIELDS \`content\`.*.\`heading\`",
        "\`pages__content_each_ref\` ON \`pages\` FIELDS \`content\`.*.\`ref\`",
        "\`pages__keywords_each\` ON \`pages\` FIELDS \`keywords\`.*",
        "\`pages__author\` ON \`pages\` FIELDS \`author\`",
        "\`pages__related_value\` ON \`pages\` FIELDS \`related\`.\`value\`",
        "\`pages__editors__unique\` ON \`pages\` FIELDS \`editors\`.chain(|$v| array::distinct($v ?? [])) UNIQUE",
        "\`pages__owners__unique\` ON \`pages\` FIELDS \`owners\`.chain(|$v| array::distinct(($v ?? []).map(|$link| $link.value))) UNIQUE",
        "\`pages__updatedAt\` ON \`pages\` FIELDS \`updatedAt\`",
        "\`pages__createdAt\` ON \`pages\` FIELDS \`createdAt\`",
        "\`pages___status_en\` ON \`pages\` FIELDS \`_status\`.\`en\`",
        "\`pages___status_pt_BR\` ON \`pages\` FIELDS \`_status\`.\`pt-BR\`",
        "\`pages__a__c__unique\` ON \`pages\` FIELDS \`a\`, \`c\` UNIQUE",
        "\`pages__a__b_en\` ON \`pages\` FIELDS \`a\`, \`b\`.\`en\`",
        "\`pages__a__b_pt_BR\` ON \`pages\` FIELDS \`a\`, \`b\`.\`pt-BR\`",
      ]
    `)
  })

  test('the version table of a collection', () => {
    expect(ddl('_pages_versions')).toMatchInlineSnapshot(`
      [
        "\`_pages_versions::count\` ON \`_pages_versions\` COUNT",
        "\`_pages_versions__parent\` ON \`_pages_versions\` FIELDS \`parent\`",
        "\`_pages_versions__version_indexed\` ON \`_pages_versions\` FIELDS \`version\`.\`indexed\`",
        "\`_pages_versions__version_views\` ON \`_pages_versions\` FIELDS \`version\`.\`views\`",
        "\`_pages_versions__version_meta_seo_keyword\` ON \`_pages_versions\` FIELDS \`version\`.\`meta\`.\`seo\`.\`keyword\`",
        "\`_pages_versions__version_tabbed_label\` ON \`_pages_versions\` FIELDS \`version\`.\`tabbed\`.\`label\`",
        "\`_pages_versions__version_rows_each_note\` ON \`_pages_versions\` FIELDS \`version\`.\`rows\`.*.\`note\`",
        "\`_pages_versions__version_content_each_heading\` ON \`_pages_versions\` FIELDS \`version\`.\`content\`.*.\`heading\`",
        "\`_pages_versions__version_content_each_ref\` ON \`_pages_versions\` FIELDS \`version\`.\`content\`.*.\`ref\`",
        "\`_pages_versions__version_keywords_each\` ON \`_pages_versions\` FIELDS \`version\`.\`keywords\`.*",
        "\`_pages_versions__version_author\` ON \`_pages_versions\` FIELDS \`version\`.\`author\`",
        "\`_pages_versions__version_related_value\` ON \`_pages_versions\` FIELDS \`version\`.\`related\`.\`value\`",
        "\`_pages_versions__version_updatedAt\` ON \`_pages_versions\` FIELDS \`version\`.\`updatedAt\`",
        "\`_pages_versions__version_createdAt\` ON \`_pages_versions\` FIELDS \`version\`.\`createdAt\`",
        "\`_pages_versions__version__status_en\` ON \`_pages_versions\` FIELDS \`version\`.\`_status\`.\`en\`",
        "\`_pages_versions__version__status_pt_BR\` ON \`_pages_versions\` FIELDS \`version\`.\`_status\`.\`pt-BR\`",
        "\`_pages_versions__createdAt\` ON \`_pages_versions\` FIELDS \`createdAt\`",
        "\`_pages_versions__updatedAt\` ON \`_pages_versions\` FIELDS \`updatedAt\`",
        "\`_pages_versions__publishedLocale\` ON \`_pages_versions\` FIELDS \`publishedLocale\`",
        "\`_pages_versions__latest\` ON \`_pages_versions\` FIELDS \`latest\`",
        "\`_pages_versions__version_a__version_c\` ON \`_pages_versions\` FIELDS \`version\`.\`a\`, \`version\`.\`c\`",
        "\`_pages_versions__version_a__version_b_en\` ON \`_pages_versions\` FIELDS \`version\`.\`a\`, \`version\`.\`b\`.\`en\`",
        "\`_pages_versions__version_a__version_b_pt_BR\` ON \`_pages_versions\` FIELDS \`version\`.\`a\`, \`version\`.\`b\`.\`pt-BR\`",
      ]
    `)
  })

  test('a collection without anything to index only gets the count index', () => {
    expect(ddl('authors')).toMatchInlineSnapshot(`
      [
        "\`authors::count\` ON \`authors\` COUNT",
        "\`authors__updatedAt\` ON \`authors\` FIELDS \`updatedAt\`",
        "\`authors__createdAt\` ON \`authors\` FIELDS \`createdAt\`",
      ]
    `)
  })

  test('a global and its versions', () => {
    expect(ddl('_global_settings')).toMatchInlineSnapshot(`
      [
        "\`_global_settings::count\` ON \`_global_settings\` COUNT",
        "\`_global_settings__site__unique\` ON \`_global_settings\` FIELDS \`site\` UNIQUE",
        "\`_global_settings___status\` ON \`_global_settings\` FIELDS \`_status\`",
      ]
    `)
    expect(ddl('_global_settings_versions')).toMatchInlineSnapshot(`
      [
        "\`_global_settings_versions::count\` ON \`_global_settings_versions\` COUNT",
        "\`_global_settings_versions__version__status\` ON \`_global_settings_versions\` FIELDS \`version\`.\`_status\`",
        "\`_global_settings_versions__createdAt\` ON \`_global_settings_versions\` FIELDS \`createdAt\`",
        "\`_global_settings_versions__updatedAt\` ON \`_global_settings_versions\` FIELDS \`updatedAt\`",
        "\`_global_settings_versions__publishedLocale\` ON \`_global_settings_versions\` FIELDS \`publishedLocale\`",
        "\`_global_settings_versions__latest\` ON \`_global_settings_versions\` FIELDS \`latest\`",
      ]
    `)
  })

  test('the job queue', () => {
    expect(ddl('payload-jobs')).toMatchInlineSnapshot(`
      [
        "\`payload-jobs::count\` ON \`payload-jobs\` COUNT",
        "\`payload-jobs__completedAt\` ON \`payload-jobs\` FIELDS \`completedAt\`",
        "\`payload-jobs__totalTried\` ON \`payload-jobs\` FIELDS \`totalTried\`",
        "\`payload-jobs__hasError\` ON \`payload-jobs\` FIELDS \`hasError\`",
        "\`payload-jobs__taskSlug\` ON \`payload-jobs\` FIELDS \`taskSlug\`",
        "\`payload-jobs__queue\` ON \`payload-jobs\` FIELDS \`queue\`",
        "\`payload-jobs__waitUntil\` ON \`payload-jobs\` FIELDS \`waitUntil\`",
        "\`payload-jobs__processingUntil\` ON \`payload-jobs\` FIELDS \`processingUntil\`",
        "\`payload-jobs__concurrencyKey\` ON \`payload-jobs\` FIELDS \`concurrencyKey\`",
        "\`payload-jobs__updatedAt\` ON \`payload-jobs\` FIELDS \`updatedAt\`",
        "\`payload-jobs__createdAt\` ON \`payload-jobs\` FIELDS \`createdAt\`",
      ]
    `)
  })

  test('the auth collection', () => {
    expect(ddl('users')).toMatchInlineSnapshot(`
      [
        "\`users::count\` ON \`users\` COUNT",
        "\`users__updatedAt\` ON \`users\` FIELDS \`updatedAt\`",
        "\`users__createdAt\` ON \`users\` FIELDS \`createdAt\`",
        "\`users__email__unique\` ON \`users\` FIELDS \`email\` UNIQUE",
      ]
    `)
  })
})

const indexesInDatabase = async (table: string): Promise<string[]> => {
  const [info] = await payload.db.connection!.query<[{ indexes: { name: string }[] }]>(
    `INFO FOR TABLE ${JSON.stringify(table)} STRUCTURE`,
  )

  return info.indexes.map(({ name }) => name).toSorted()
}

describe('applying the indexes', () => {
  test('connect defines every generated index', async () => {
    for (const table of ['pages', '_pages_versions', 'payload-jobs', '_global_settings', 'users']) {
      const expected = adapter.indexes
        .filter((index) => index.table === table)
        .map(({ name }) => name)
        .toSorted()

      expect(await indexesInDatabase(table)).toEqual(expected)
    }
  })

  test('connecting again leaves the indexes alone', async () => {
    await adapter.connect!({ hotReload: true })

    expect(await indexesInDatabase('pages')).toHaveLength(ddl('pages').length)
  })

  test('an unfiltered count is answered from the count index', async () => {
    const [plan] = await payload.db.connection!.query<[{ operator: string }]>(
      'SELECT count() FROM pages GROUP ALL EXPLAIN',
    )

    expect(plan.operator).toBe('CountScan')
  })

  test('the map from index name to field path covers every unique index', () => {
    expect([...adapter.uniqueIndexPaths].filter(([name]) => name.startsWith('pages__'))).toEqual([
      ['pages__slug__unique', 'slug'],
      ['pages__localizedTitle_en__unique', 'localizedTitle.en'],
      ['pages__localizedTitle_pt_BR__unique', 'localizedTitle.pt-BR'],
      ['pages__slot__unique', 'slot'],
      ['pages__meta_code__unique', 'meta.code'],
      ['pages__editors__unique', 'editors'],
      ['pages__owners__unique', 'owners'],
      ['pages__a__c__unique', 'a'],
    ])
  })
})

const bootItems = async (key: string, overrides: Parameters<typeof surrealdbAdapter>[0]) =>
  bootPayload(
    buildConfig({
      collections: [
        { slug: 'users', auth: true, fields: [], versions: false },
        {
          slug: 'items',
          fields: [
            { name: 'title', type: 'text' },
            { name: 'group', type: 'group', fields: [{ name: 'inner', type: 'text' }] },
          ],
          versions: false,
        },
      ],
      db: surrealdbAdapter(overrides),
      indexSortableFields: true,
      secret: 'test-secret',
      telemetry: false,
      typescript: { autoGenerate: false },
    }),
    key,
  )

describe('options', () => {
  test('ensureIndexes: false generates the indexes but does not define them', async () => {
    const off = await bootItems('indexes-off', {
      ...connectionArgs('buildschema-off'),
      ensureIndexes: false,
    })
    const [info] = await off.db.connection!.query<[{ indexes: unknown[] }]>(
      'INFO FOR TABLE items STRUCTURE',
    )

    expect(info.indexes).toEqual([])
    expect((off.db as SurrealDBAdapter).indexes.some(({ table }) => table === 'items')).toBe(true)
    await off.destroy()
  })

  test('indexSortableFields indexes the top-level fields and not the nested ones', async () => {
    const on = await bootItems('indexes-sortable', connectionArgs('buildschema-sortable'))

    expect(
      (on.db as SurrealDBAdapter).indexes
        .filter(({ table }) => table === 'items')
        .map(({ name }) => name),
    ).toEqual([
      'items::count',
      'items__title',
      'items__createdBy_value',
      'items__updatedBy_value',
      'items__updatedAt',
      'items__createdAt',
    ])
    await on.destroy()
  })

  test('a field named count does not collide with the count index', async () => {
    const counted = await bootPayload(
      buildConfig({
        collections: [
          { slug: 'users', auth: true, fields: [], versions: false },
          {
            slug: 'things',
            fields: [{ name: 'count', type: 'number', index: true }],
            versions: false,
          },
        ],
        db: surrealdbAdapter(connectionArgs('buildschema-count')),
        secret: 'test-secret',
        telemetry: false,
        typescript: { autoGenerate: false },
      }),
      'indexes-count',
    )
    const expected = (counted.db as SurrealDBAdapter).indexes
      .filter(({ table }) => table === 'things')
      .map(({ name }) => name)
    const [info] = await counted.db.connection!.query<[{ indexes: { name: string }[] }]>(
      'INFO FOR TABLE things STRUCTURE',
    )

    expect(new Set(expected).size).toBe(expected.length)
    expect(expected).toContain('things__count')
    // `IF NOT EXISTS` silently skips a second index of the same name, so both have to exist
    expect(info.indexes.map(({ name }) => name).toSorted()).toEqual(expected.toSorted())
    expect(expected).toHaveLength(info.indexes.length)
    expect(expected.length).toBeGreaterThanOrEqual(2)
    await counted.destroy()
  })

  test('pool.size outside 2 to 4 is refused', () => {
    expect(() => surrealdbAdapter({ ...connectionArgs('x'), pool: { size: 1 } })).toThrow(
      'pool.size must be a whole number from 2 to 4',
    )
    expect(() => surrealdbAdapter({ ...connectionArgs('x'), pool: { size: 5 } })).toThrow(
      'pool.size',
    )
  })

  test.each(['acquireTimeoutMs', 'timeoutMs'] as const)(
    'transactionOptions.%s must be a positive whole number',
    (option) => {
      for (const value of [0, -1, Number.NaN, 1.5, Number.POSITIVE_INFINITY]) {
        expect(() =>
          surrealdbAdapter({ ...connectionArgs('x'), transactionOptions: { [option]: value } }),
        ).toThrow(`transactionOptions.${option} must be a positive whole number`)
      }

      expect(() =>
        surrealdbAdapter({ ...connectionArgs('x'), transactionOptions: { [option]: 1 } }),
      ).not.toThrow()
    },
  )
})
