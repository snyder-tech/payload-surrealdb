import type { CollectionConfig } from 'payload'

import { buildConfig } from 'payload'

import { surrealdbAdapter } from '../../src/index.js'
import { connectionArgs } from './payload.js'

// Payload 4 turns `versions` on for every collection; these tests do not use versions, so they are off.
const collection = (config: CollectionConfig): CollectionConfig => ({ versions: false, ...config })

const polymorphic = ['movies', 'tags', 'cnum', 'pages']

/** The collections of the query-semantics fixture (`tests/fixtures/semantics.surql`), as Payload sees them. */
export const semanticsConfig = buildConfig({
  collections: [
    collection({
      slug: 'posts',
      fields: [
        { name: 'title', type: 'text' },
        { name: 'text', type: 'text' },
        { name: 'description', type: 'text' },
        { name: 'number', type: 'number' },
        { name: 'select', type: 'select', options: ['one', 'two'] },
        { name: 'checkbox', type: 'checkbox' },
        { name: 'checkboxNotRequired', type: 'checkbox' },
        { name: 'date', type: 'date' },
        { name: 'author', type: 'relationship', relationTo: 'users' },
        { name: 'category', type: 'relationship', relationTo: 'categories' },
        {
          name: 'group',
          type: 'group',
          fields: [
            { name: 'number', type: 'number' },
            { name: 'text', type: 'text' },
          ],
        },
      ],
    }),
    collection({
      slug: 'users',
      auth: true,
      fields: [
        { name: 'name', type: 'text' },
        { name: 'manager', type: 'relationship', relationTo: 'users' },
        { name: 'role', type: 'text' },
      ],
    }),
    collection({ slug: 'categories', fields: [{ name: 'title', type: 'text' }] }),
    collection({
      slug: 'movies',
      fields: [
        { name: 'name', type: 'text' },
        { name: 'select', type: 'select', hasMany: true, options: ['a', 'b'] },
        { name: 'director', type: 'relationship', relationTo: 'directors' },
      ],
    }),
    collection({
      slug: 'directors',
      fields: [
        { name: 'name', type: 'text' },
        { name: 'movies', type: 'relationship', hasMany: true, relationTo: 'movies' },
        { name: 'movie', type: 'relationship', relationTo: 'movies' },
        { name: 'moviesJoin', type: 'join', collection: 'movies', on: 'director' },
      ],
    }),
    collection({ slug: 'tags', fields: [{ name: 'name', type: 'text' }] }),
    collection({
      slug: 'rels',
      fields: [
        { name: 'rel', type: 'relationship', relationTo: 'movies' },
        { name: 'relMany', type: 'relationship', hasMany: true, relationTo: 'movies' },
        { name: 'poly', type: 'relationship', relationTo: polymorphic },
        { name: 'polyMany', type: 'relationship', hasMany: true, relationTo: polymorphic },
        { name: 'polyLoc', type: 'relationship', localized: true, relationTo: polymorphic },
        {
          name: 'array',
          type: 'array',
          fields: [{ name: 'rel', type: 'relationship', relationTo: 'movies' }],
        },
      ],
    }),
    collection({
      slug: 'cnum',
      fields: [
        { name: 'id', type: 'number' },
        { name: 'title', type: 'text' },
      ],
    }),
    collection({ slug: 'pages', fields: [{ name: 'title', type: 'text' }] }),
    collection({
      slug: 'tf',
      fields: [
        { name: 'text', type: 'text' },
        { name: 'hasMany', type: 'text', hasMany: true },
        { name: 'hasManySecond', type: 'text', hasMany: true },
        { name: 'nums', type: 'number', hasMany: true },
        {
          name: 'selectMany',
          type: 'select',
          hasMany: true,
          options: ['one', 'four', 'three', 'bananabread', 'banana'],
        },
        {
          name: 'array',
          type: 'array',
          fields: [
            { name: 'texts', type: 'text', hasMany: true },
            { name: 'date', type: 'date' },
            { name: 'text', type: 'text' },
            { name: 'anotherText', type: 'text' },
            { name: 'localizedText', type: 'text', localized: true },
          ],
        },
        {
          name: 'blocks',
          type: 'blocks',
          blocks: [
            { slug: 'blockWithText', fields: [{ name: 'texts', type: 'text', hasMany: true }] },
            { slug: 'other', fields: [{ name: 'texts', type: 'text', hasMany: true }] },
          ],
        },
      ],
    }),
    collection({ slug: 'pt', fields: [{ name: 'point', type: 'point' }] }),
    collection({ slug: 'jf', fields: [{ name: 'json', type: 'json' }] }),
    collection({
      slug: 'arrsort',
      fields: [{ name: 'arr', type: 'array', fields: [{ name: 'text', type: 'text' }] }],
    }),
    collection({
      slug: 'loc',
      fields: [
        { name: 'title', type: 'text', localized: true },
        { name: 'number', type: 'number', localized: true },
        {
          name: 'localizedGroup',
          type: 'group',
          fields: [{ name: 'text', type: 'text' }],
          localized: true,
        },
      ],
    }),
    collection({
      slug: 'st',
      fields: [
        { name: 'group', type: 'group', fields: [{ name: 'number', type: 'number' }] },
        { name: 'number', type: 'number' },
        { name: 'number2', type: 'number' },
        { name: 'text', type: 'text' },
      ],
    }),
    collection({
      slug: 'sn',
      fields: [
        { name: 'v', type: 'text' },
        { name: 'k', type: 'text' },
      ],
    }),
  ],
  db: surrealdbAdapter(connectionArgs('semantics')),
  localization: { defaultLocale: 'en', locales: ['en', 'es', 'nb'] },
  secret: 'test-secret',
  telemetry: false,
  typescript: { autoGenerate: false },
})
