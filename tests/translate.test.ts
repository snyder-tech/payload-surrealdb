import type { Payload, Sort, TypeWithID, Where } from 'payload'

import { readFileSync } from 'node:fs'
import { afterAll, beforeAll, describe, expect, test } from 'vitest'

import type { SurrealDBAdapter } from '../src/index.js'

import { buildQuery } from '../src/queries/buildQuery.js'
import { ParamBag, escapeIdent, toIdiom } from '../src/queries/sql.js'
import { beginTransaction, bootPayload } from './helpers/payload.js'
import { semanticsConfig } from './helpers/semanticsConfig.js'

/**
 * The query-semantics cases (the short IDs such as O19 are case labels), run through the adapter
 * against the fixture. `ids` is what Mongo returns for the same query, so a
 * passing case means the translation behaves like Mongo, not merely like SurrealDB.
 */

const POSTS = ['p1', 'p2', 'p3', 'p4', 'p5', 'p6', 'p7']
const JSON_ALL = [
  'j1',
  'j2',
  'j3',
  'j4',
  'j5',
  'j6',
  'j8',
  'j9',
  'j10',
  'j11',
  'j12',
  'j13',
  'j14',
  'j15',
]
const minus = (all: string[], remove: string[]) => all.filter((id) => !remove.includes(id))

type Case = {
  collection: string
  /** The expected IDs. Compared in order when `sort` is set. */
  ids: (number | string)[]
  key: string
  locale?: string
  sort?: Sort
  where?: Where
}

const posts = (key: string, where: Where, ids: string[]): Case => ({
  collection: 'posts',
  ids,
  key,
  where,
})

const points = (key: string, where: Where, ids: string[]): Case => ({
  collection: 'pt',
  ids,
  key,
  where,
})

const square = (min: number, max: number) => ({
  coordinates: [
    [
      [min, min + 10],
      [min, max + 10],
      [max, max + 10],
      [max, min + 10],
      [min, min + 10],
    ],
  ],
  type: 'Polygon',
})

const cases: Case[] = [
  // scalar
  posts('S01 title equals', { title: { equals: 'valueToQuery' } }, ['p1']),
  posts('S02 title not_equals', { title: { not_equals: 'valueToQuery' } }, minus(POSTS, ['p1'])),
  posts('S03 title equals null', { title: { equals: null } }, ['p3']),
  posts('S03n number equals null (NULL and missing)', { number: { equals: null } }, [
    'p4',
    'p5',
    'p6',
    'p7',
  ]),
  posts('S04 title not_equals null', { title: { not_equals: null } }, minus(POSTS, ['p3'])),
  posts('S05 text in', { text: { in: ['text-1', 'text-3'] } }, ['p1', 'p3']),
  posts('S06 text in with null', { text: { in: ['text-1', 'text-3', null] } }, [
    'p1',
    'p3',
    'p4',
    'p5',
    'p6',
    'p7',
  ]),
  posts('S07 text not_in', { text: { not_in: ['text-1'] } }, minus(POSTS, ['p1'])),
  posts('S08a text in []', { text: { in: [] } }, []),
  posts('S08b text not_in []', { text: { not_in: [] } }, POSTS),
  posts('S09 description exists true', { description: { exists: true } }, ['p1']),
  posts('S10 description exists false', { description: { exists: false } }, minus(POSTS, ['p1'])),
  posts('S11 title exists true (empty counts as missing)', { title: { exists: true } }, [
    'p1',
    'p2',
    'p5',
    'p6',
    'p7',
  ]),
  posts('S12 title exists false', { title: { exists: false } }, ['p3', 'p4']),
  posts('S13a number exists true', { number: { exists: true } }, ['p1', 'p2', 'p3']),
  posts('S13b number exists false', { number: { exists: false } }, ['p4', 'p5', 'p6', 'p7']),
  // comparison
  posts('C01 number greater_than', { number: { greater_than: 1 } }, ['p2', 'p3']),
  posts('C02 number less_than', { number: { less_than: 2 } }, ['p1']),
  posts('C03 number less_than_equal', { number: { less_than_equal: 2 } }, ['p1', 'p2']),
  posts('C04 number greater_than_equal', { number: { greater_than_equal: 10 } }, ['p3']),
  posts('C05 date greater_than', { date: { greater_than: '2025-03-01T00:00:00.000Z' } }, ['p2']),
  posts('C06 date less_than', { date: { less_than: '2025-03-01T00:00:00.000Z' } }, ['p1']),
  posts(
    'C07 createdAt in (millisecond precision)',
    { createdAt: { in: ['2025-01-01T00:00:00.123Z'] } },
    ['p1'],
  ),
  posts('C08 checkbox equals true', { checkbox: { equals: true } }, ['p1', 'p3']),
  posts('C09 checkbox equals false', { checkbox: { equals: false } }, ['p2']),
  posts(
    'C10 checkbox exists false',
    { checkboxNotRequired: { exists: false } },
    minus(POSTS, ['p1']),
  ),
  posts('C11 checkbox exists true (false counts)', { checkboxNotRequired: { exists: true } }, [
    'p1',
  ]),
  posts(
    'C12 field named select, exists false',
    { select: { exists: false } },
    minus(POSTS, ['p1', 'p2']),
  ),
  // geo
  points('G01 point near, maximum distance', { point: { near: '10.01, 20.01, 10000' } }, ['p1']),
  points('G02 point near, minimum distance only', { point: { near: '10.01, 20.01, null, 1500' } }, [
    'p1',
    'nyc',
    'x1',
    'x2',
    'x3',
  ]),
  points(
    'G03 point near, a larger minimum distance',
    { point: { near: '10.01, 20.01, null, 1700' } },
    ['nyc', 'x1', 'x2', 'x3'],
  ),
  points('G04 point near at a high latitude', { point: { near: '-74.0059, 40.7128, 12000' } }, [
    'nyc',
  ]),
  points('G06 point within a polygon', { point: { within: square(9, 11) } }, ['p1']),
  points(
    'G07 point within a polygon that is too small',
    { point: { within: square(0.9, 1.1) } },
    [],
  ),
  points('G08 point intersects a polygon', { point: { intersects: square(9, 11) } }, ['p1']),
  points(
    'G09 point intersects a polygon that is too small',
    { point: { intersects: square(0.9, 1.1) } },
    [],
  ),
  // like, not_like, contains
  posts('L01 like', { title: { like: 'prefix' } }, ['p5']),
  ...['%', '.', '(', '$', '^', '[', '*', '|'].map((char) =>
    posts(`L02 like ${char}`, { title: { like: char } }, ['p5']),
  ),
  ...['\\', "'"].map((char) => posts(`L02 like ${char}`, { title: { like: char } }, [])),
  posts('L03 like Cyrillic, case-insensitive', { title: { like: 'Тест' } }, ['p6']),
  posts('L04 like multi-word AND', { title: { like: 'привет нагрузки' } }, ['p6']),
  posts('L05 like case-insensitive partial', { title: { like: 'words partial' } }, ['p7']),
  posts('L06 not_like keeps missing', { title: { not_like: 'prefix' } }, minus(POSTS, ['p5'])),
  posts('L07 contains whole value', { title: { contains: 'VALUE' } }, ['p1', 'p5']),
  posts('L08 contains is not split', { title: { contains: 'words partial' } }, []),
  posts('L09 two operators on one path', { title: { like: 'value', not_equals: 'valueToQuery' } }, [
    'p5',
  ]),
  posts('L10 or', { or: [{ title: { equals: 'valueToQuery' } }, { number: { equals: 10 } }] }, [
    'p1',
    'p3',
  ]),
  posts('L11 group', { 'group.number': { equals: 100 } }, ['p1']),
  posts('L12 group exists false', { 'group.text': { exists: false } }, minus(POSTS, ['p1'])),
  // id
  posts('I01 id equals', { id: { equals: 'p2' } }, ['p2']),
  posts('I02 id in', { id: { in: ['p1', 'p3'] } }, ['p1', 'p3']),
  posts('I03 id not_in', { id: { not_in: ['p1'] } }, minus(POSTS, ['p1'])),
  posts('I04 id like', { id: { like: 'p1' } }, ['p1']),
  posts('I05 id exists', { id: { exists: true } }, POSTS),
  posts('I06 id in with not_in []', { id: { in: ['p3'], not_in: [] } }, ['p3']),
  posts('I09 id equals nothing', { id: { equals: 'missing' } }, []),
  posts('I10 id not_equals', { id: { not_equals: 'p1' } }, minus(POSTS, ['p1'])),
  { collection: 'cnum', ids: [999], key: 'I07 custom number id', where: { id: { equals: 999 } } },
  {
    collection: 'cnum',
    ids: [999],
    key: 'I07b custom number id from a string',
    where: { id: { equals: '999' } },
  },
  {
    collection: 'pages',
    ids: ['999'],
    key: 'I08 a numeric-looking string key is a string key',
    where: { id: { equals: '999' } },
  },
  {
    collection: 'pages',
    ids: [],
    key: 'I08b a number key is another record',
    where: { id: { equals: 999 } },
  },
  // single relationship
  posts('R01 author equals', { author: { equals: 'u1' } }, ['p1']),
  posts('R02 author not_equals', { author: { not_equals: 'u1' } }, minus(POSTS, ['p1'])),
  posts('R03 author in', { author: { in: ['u1', 'u2'] } }, ['p1', 'p2']),
  posts('R04 author not_in', { author: { not_in: ['u1'] } }, minus(POSTS, ['p1'])),
  posts('R05 author exists false', { author: { exists: false } }, ['p4', 'p5', 'p6', 'p7']),
  {
    collection: 'rels',
    ids: ['r1', 'r2', 'r3', 'r4', 'r5'],
    key: 'P13 rel in [] or not_in []',
    where: { or: [{ rel: { in: [] } }, { rel: { not_in: [] } }] },
  },
  {
    collection: 'rels',
    ids: ['r1', 'r2', 'r3', 'r4', 'r5'],
    key: 'P14 single relationship not_equals an array',
    where: { rel: { not_equals: ['m2'] } },
  },
  // hasMany relationship
  ...[
    ['H01 contains', { movies: { contains: 'm1' } }, ['d1', 'd2']],
    ['H02 equals a value means any element', { movies: { equals: 'm2' } }, ['d1', 'd3']],
    ['H03 in', { movies: { in: ['m1'] } }, ['d1', 'd2']],
    ['H04 not_in keeps missing and empty', { movies: { not_in: ['m1'] } }, ['d3', 'd4', 'd5']],
    ['H05 all', { movies: { all: ['m1', 'm2'] } }, ['d1']],
    ['H06 not_equals', { movies: { not_equals: 'm1' } }, ['d3', 'd4', 'd5']],
    ['H07a equals the whole array', { movies: { equals: ['m1', 'm2'] } }, ['d1']],
    ['H07b equals the whole array', { movies: { equals: ['m1'] } }, ['d2']],
    [
      'H07c not_equals the whole array',
      { movies: { not_equals: ['m1'] } },
      ['d1', 'd3', 'd4', 'd5'],
    ],
    ['H08a exists true, empty counts', { movies: { exists: true } }, ['d1', 'd2', 'd3', 'd4']],
    ['H08b exists false', { movies: { exists: false } }, ['d5']],
  ].map(([key, where, ids]): Case => ({
    collection: 'directors',
    ids: ids as string[],
    key: key as string,
    where: where as Where,
  })),
  // polymorphic relationship
  ...[
    ['P01 poly.value equals', { 'poly.value': { equals: 'm1' } }, ['r1']],
    ['P02 poly.relationTo equals', { 'poly.relationTo': { equals: 'tags' } }, ['r2']],
    [
      'P03 poly equals { relationTo, value }',
      { poly: { equals: { relationTo: 'movies', value: 'm1' } } },
      ['r1'],
    ],
    [
      'P04 polyMany equals { relationTo, value }',
      { polyMany: { equals: { relationTo: 'tags', value: 't1' } } },
      ['r1'],
    ],
    ['P05 polyMany.value in', { 'polyMany.value': { in: ['t1', 't2'] } }, ['r1', 'r2']],
    ['P06 polyMany.relationTo equals', { 'polyMany.relationTo': { equals: 'movies' } }, ['r1']],
    [
      'P07 poly.value across number and text ID types',
      { 'poly.value': { equals: '999' } },
      ['r4', 'r5'],
    ],
    [
      'P07b poly.value and relationTo',
      { and: [{ 'poly.value': { equals: '999' } }, { 'poly.relationTo': { equals: 'cnum' } }] },
      ['r4'],
    ],
    ['P11 poly.value not_equals', { 'poly.value': { not_equals: 'm1' } }, ['r2', 'r3', 'r4', 'r5']],
  ].map(([key, where, ids]): Case => ({
    collection: 'rels',
    ids: ids as string[],
    key: key as string,
    where: where as Where,
  })),
  {
    collection: 'rels',
    ids: ['r1'],
    key: 'P09 localized polymorphic equals',
    locale: 'en',
    where: { polyLoc: { equals: { relationTo: 'movies', value: 'm1' } } },
  },
  // hasMany text, number, select
  ...[
    ['T01 hasMany in', { hasMany: { in: ['one'] } }, ['tf1']],
    [
      'T02 hasMany equals AND hasManySecond equals',
      { hasMany: { equals: 'two' }, hasManySecond: { equals: '4' } },
      ['tf2'],
    ],
    [
      'T03 hasMany contains is a substring of any element',
      { hasMany: { contains: 'banana' } },
      ['tf2'],
    ],
    [
      'T04 hasMany contains a list is ORed',
      { hasMany: { contains: ['banana', 'apple'] } },
      ['tf1', 'tf2'],
    ],
    ['T05a hasMany select contains is exact', { selectMany: { contains: 'banana' } }, []],
    ['T05b hasMany select contains is exact', { selectMany: { contains: 'bananabread' } }, ['tf2']],
    ['T06a nums in', { nums: { in: [5] } }, ['tf1']],
    ['T06b nums not_in', { nums: { not_in: [5] } }, ['tf2', 'tf3', 'tf4']],
    ['T06c nums all', { nums: { all: [5, 10] } }, ['tf1']],
    ['T06d nums greater_than any element', { nums: { greater_than: 11 } }, ['tf2']],
    ['T06e nums less_than any element', { nums: { less_than: 6 } }, ['tf1']],
    [
      'T12a hasMany exists true, empty counts',
      { hasMany: { exists: true } },
      ['tf1', 'tf2', 'tf3'],
    ],
  ].map(([key, where, ids]): Case => ({
    collection: 'tf',
    ids: ids as string[],
    key: key as string,
    where: where as Where,
  })),
  // localized
  {
    collection: 'loc',
    ids: ['l1'],
    key: 'Z01 localized equals, locale en',
    locale: 'en',
    where: { title: { equals: 'English title' } },
  },
  {
    collection: 'loc',
    ids: ['l1'],
    key: 'Z02 localized equals, locale es',
    locale: 'es',
    where: { title: { equals: 'Spanish title' } },
  },
  {
    collection: 'loc',
    ids: ['l1'],
    key: 'Z03 locale all with an explicit locale path',
    locale: 'all',
    where: { 'title.es': { equals: 'Spanish title' } },
  },
  {
    collection: 'loc',
    ids: [],
    key: 'Z04 locale all without a locale path matches nothing, like Mongo',
    locale: 'all',
    where: { title: { equals: 'English title' } },
  },
  {
    collection: 'loc',
    ids: ['l1'],
    key: 'Z05 localized group',
    locale: 'en',
    where: { 'localizedGroup.text': { equals: 'find this' } },
  },
  // relationship paths, which resolve the related IDs first
  posts('R06 author.name equals', { 'author.name': { equals: 'Alice' } }, ['p1']),
  posts(
    'R07 author.name not_equals leaves out posts without an author',
    {
      'author.name': { not_equals: 'Alice' },
    },
    ['p2', 'p3'],
  ),
  posts('R08 two hops', { 'author.manager.name': { equals: 'Bob' } }, ['p1']),
  posts('R09 author.name exists false', { 'author.name': { exists: false } }, ['p3']),
  posts('R10 category.title equals', { 'category.title': { equals: 'new-category' } }, ['p1']),
  posts('R11 author.name in', { 'author.name': { in: ['Alice', 'Bob'] } }, ['p1', 'p2']),
  posts('R12 author.name not_in', { 'author.name': { not_in: ['Alice'] } }, ['p2', 'p3']),
  posts('R13 author.name like', { 'author.name': { like: 'ali' } }, ['p1']),
  posts(
    'R14 a relationship path inside an or',
    {
      or: [{ 'author.name': { equals: 'Alice' } }, { 'category.title': { equals: 'nope' } }],
    },
    ['p1'],
  ),
  posts(
    'R15 two paths through the same relationship are ANDed',
    {
      and: [{ 'author.name': { equals: 'Alice' } }, { 'author.manager.name': { equals: 'Bob' } }],
    },
    ['p1'],
  ),
  posts('R16 author.id equals', { 'author.id': { equals: 'u1' } }, ['p1']),
  ...[
    [
      'H09 contains a nested where',
      { movies: { contains: { name: { equals: 'recalls' } } } },
      ['d1', 'd2'],
    ],
    [
      'H10 not_equals a nested where',
      { movies: { not_equals: { name: { equals: 'recalls' } } } },
      ['d3', 'd4', 'd5'],
    ],
    [
      'H11 equals a nested where means every element',
      { movies: { equals: { name: { equals: 'electric-cars' } } } },
      ['d3', 'd4', 'd5'],
    ],
    [
      'H12 equals a nested where on a hasMany select',
      { movies: { equals: { select: { equals: 'a' } } } },
      ['d1', 'd2', 'd3', 'd4', 'd5'],
    ],
    [
      'H13 contains an and, both on the same related document',
      {
        movies: { contains: { and: [{ name: { equals: 'recalls' } }, { id: { equals: 'm2' } }] } },
      },
      [],
    ],
    [
      'H14 movies.name through a hasMany relationship',
      { 'movies.name': { equals: 'recalls' } },
      ['d1', 'd2'],
    ],
    ['H15 movies.name not_equals', { 'movies.name': { not_equals: 'recalls' } }, ['d1', 'd3']],
    [
      'H16 equals an empty nested where',
      { movies: { equals: {} } },
      ['d1', 'd2', 'd3', 'd4', 'd5'],
    ],
    [
      'K01 contains on a join with a nested where',
      { moviesJoin: { contains: { name: { equals: 'recalls' } } } },
      ['d2'],
    ],
    ['K02 a join path', { 'moviesJoin.name': { equals: 'electric-cars' } }, ['d1']],
  ].map(([key, where, ids]): Case => ({
    collection: 'directors',
    ids: ids as string[],
    key: key as string,
    where: where as Where,
  })),
  ...[
    ['P10 polyMany.value all', { 'polyMany.value': { all: ['m1'] } }, ['r1']],
    ['P10b polyMany.value all of two ids', { 'polyMany.value': { all: ['m1', 't1'] } }, ['r1']],
    [
      'P10c polyMany.value all with one id missing',
      { 'polyMany.value': { all: ['m1', 't2'] } },
      [],
    ],
    ['P12 array.rel.name', { 'array.rel.name': { equals: 'electric-cars' } }, ['r1']],
    ['P11a array.rel equals', { 'array.rel': { equals: 'm1' } }, ['r2']],
  ].map(([key, where, ids]): Case => ({
    collection: 'rels',
    ids: ids as string[],
    key: key as string,
    where: where as Where,
  })),
  // paths through arrays and blocks
  ...[
    ['T07a array.texts equals', { 'array.texts': { equals: 'text_2' } }, ['tf1', 'tf2']],
    ['T07b array.texts equals', { 'array.texts': { equals: 'text_1' } }, ['tf1']],
    ['T07c array.texts in', { 'array.texts': { in: ['text_other'] } }, ['tf2']],
    [
      'T07d array.texts not_in',
      { 'array.texts': { not_in: ['text_other'] } },
      ['tf1', 'tf3', 'tf4'],
    ],
    ['T08a blocks.texts equals', { 'blocks.texts': { equals: 'text_2' } }, ['tf1', 'tf2']],
    ['T08b blocks.blockType equals', { 'blocks.blockType': { equals: 'other' } }, ['tf2']],
    [
      'T08c blocks.blockType in',
      { 'blocks.blockType': { in: ['other', 'blockWithText'] } },
      ['tf1', 'tf2'],
    ],
    [
      'T09a array.date greater_than',
      { 'array.date': { greater_than: '2025-06-01T00:00:00.000Z' } },
      ['tf1', 'tf2'],
    ],
    [
      'T09b array.date greater_than',
      { 'array.date': { greater_than: '2025-07-15T00:00:00.000Z' } },
      ['tf2'],
    ],
    [
      'T09c array.date less_than',
      { 'array.date': { less_than: '2024-06-01T00:00:00.000Z' } },
      ['tf2'],
    ],
    [
      'T10 two array paths are not tied to one element',
      {
        and: [
          { 'array.text': { equals: 'required' } },
          { 'array.anotherText': { equals: 'another' } },
        ],
      },
      ['tf1', 'tf2'],
    ],
    ['T11 array.localizedText equals', { 'array.localizedText': { equals: 'test' } }, ['tf1']],
    ['T12 array.texts exists true', { 'array.texts': { exists: true } }, ['tf1', 'tf2']],
    ['T12b array.texts exists false', { 'array.texts': { exists: false } }, ['tf3', 'tf4']],
    ['T13 array.text like', { 'array.text': { like: 'requ' } }, ['tf1', 'tf2']],
    ['T14 array.text not_like', { 'array.text': { not_like: 'requ' } }, ['tf3', 'tf4']],
  ].map(([key, where, ids]): Case => ({
    collection: 'tf',
    ids: ids as string[],
    key: key as string,
    locale: 'en',
    where: where as Where,
  })),
  // paths inside json
  ...[
    ['J01 json.foo like', { 'json.foo': { like: 'bar' } }, ['j1']],
    [
      'J02 json.baz not_like',
      { 'json.baz': { not_like: 'bar' } },
      JSON_ALL.filter((id) => id !== 'j2'),
    ],
    ['J03a json.foo equals', { 'json.foo': { equals: 'foobar' } }, ['j1']],
    ['J03b json.foo equals is not a substring match', { 'json.foo': { equals: 'bar' } }, []],
    ['J04 json.number equals', { 'json.number': { equals: 5 } }, ['j1']],
    ['J05 json.foo exists true', { 'json.foo': { exists: true } }, ['j1']],
    ['J07a json.value in', { 'json.value': { in: [1, 3] } }, ['j3', 'j5']],
    [
      'J07b json.value not_in keeps missing',
      { 'json.value': { not_in: [1, 3] } },
      JSON_ALL.filter((id) => !['j3', 'j5'].includes(id)),
    ],
    [
      'J09 two json paths',
      { and: [{ 'json.isEven': { equals: true } }, { 'json.value': { in: [1, 4, 2, 3] } }] },
      ['j4', 'j6'],
    ],
    [
      'J10 deep paths through arrays and objects',
      {
        and: [
          { 'json.array.text': { equals: 'some-text' } },
          { 'json.array.object.text': { equals: 'deep-text' } },
          { 'json.array.object.array': { in: [10, 20] } },
          { 'json.array.object.array': { exists: true } },
          { 'json.array.object.notexists': { exists: false } },
        ],
      },
      ['j11'],
    ],
    ['J11a json.doc.value equals', { 'json.doc.value': { equals: '42' } }, ['j12', 'j14']],
    [
      'J11b json.doc.value and relationTo',
      {
        and: [
          { 'json.doc.value': { equals: '42' } },
          { 'json.doc.relationTo': { equals: 'posts' } },
        ],
      },
      ['j12'],
    ],
    [
      'J12 json.doc.value exists true',
      { 'json.doc.value': { exists: true } },
      ['j12', 'j13', 'j14'],
    ],
    ['J06a json exists false', { json: { exists: false } }, ['j8']],
  ].map(([key, where, ids]): Case => ({
    collection: 'jf',
    ids: ids as string[],
    key: key as string,
    where: where as Where,
  })),
  // sort (ordered)
  ...[
    ['O01 text', 'st', 'text', ['s1', 's10', 's11', 's12', 's2', 's3']],
    ['O02 -text', 'st', '-text', ['s3', 's2', 's12', 's11', 's10', 's1']],
    ['O03 -number', 'st', '-number', ['s12', 's11', 's10', 's3', 's2', 's1']],
    ['O04 two keys', 'st', ['number2', 'number'], ['s3', 's10', 's1', 's2', 's11', 's12']],
    ['O05 mixed directions', 'st', ['number2', '-number'], ['s10', 's3', 's2', 's1', 's12', 's11']],
    ['O06 group path', 'st', ['-group.number', '-number'], ['s10', 's2', 's11', 's3', 's12', 's1']],
    ['O07 fallback -createdAt', 'st', 'number2', ['s10', 's3', 's2', 's1', 's12', 's11']],
    [
      'O08 null and missing sort first, binary order',
      'sn',
      'v',
      ['n3', 'n4', 'n2', 'n5', 'n1', 'n6'],
    ],
    ['O09 null and missing sort last descending', 'sn', '-v', ['n6', 'n1', 'n5', 'n2', 'n4', 'n3']],
    ['O10 binary order of keys', 'sn', 'k', ['n4', 'n3', 'n5', 'n2', 'n1', 'n6']],
    [
      'O18 sorting by a field that does not exist does not error',
      'st',
      'fake',
      ['s12', 's11', 's10', 's3', 's2', 's1'],
    ],
  ].map(([key, collection, sort, ids]): Case => ({
    collection: collection as string,
    ids: ids as string[],
    key: key as string,
    sort: sort as Sort,
  })),
  // sort through relationships and arrays
  ...[
    [
      'O11 arr.text ascending sorts by the smallest element',
      'arrsort',
      'arr.text',
      ['a3', 'a1', 'a2'],
    ],
    [
      'O12 arr.text descending sorts by the largest element',
      'arrsort',
      '-arr.text',
      ['a1', 'a3', 'a2'],
    ],
    ['O13 director.name', 'movies', 'director.name', ['m3', 'm2', 'm1']],
    ['O13b -director.name', 'movies', '-director.name', ['m1', 'm2', 'm3']],
    ['O14 -director.movie.name, two hops', 'movies', '-director.movie.name', ['m1', 'm2', 'm3']],
  ].map(([key, collection, sort, ids]): Case => ({
    collection: collection as string,
    ids: ids as string[],
    key: key as string,
    sort: sort as Sort,
  })),
  {
    collection: 'directors',
    ids: ['d2', 'd3'],
    key: 'O15 -movies.name on a hasMany relationship sorts by the largest name',
    sort: '-movies.name',
    where: { id: { in: ['d2', 'd3'] } },
  },
  {
    collection: 'directors',
    // d1 and d3 both start at 'electric-cars', and ties end on `id` in the direction of the last key
    ids: ['d3', 'd1', 'd2'],
    key: 'O15b movies.name ascending sorts by the smallest name',
    sort: 'movies.name',
    where: { id: { in: ['d1', 'd2', 'd3'] } },
  },
  {
    collection: 'loc',
    ids: ['l3', 'l1', 'l2'],
    key: 'O16 localized sort, locale en',
    locale: 'en',
    sort: 'number',
  },
  {
    collection: 'loc',
    ids: ['l3', 'l2', 'l1'],
    key: 'O17 localized sort, locale nb',
    locale: 'nb',
    sort: 'number',
  },
]

let payload: Payload
let adapter: SurrealDBAdapter

const connection = () => {
  if (!payload.db.connection) {
    throw new Error('The adapter is not connected.')
  }

  return payload.db.connection
}

beforeAll(async () => {
  payload = await bootPayload(semanticsConfig, 'semantics')
  // `payload.db` is the adapter this package built
  adapter = payload.db as SurrealDBAdapter

  await connection().query(
    readFileSync(new URL('./fixtures/semantics.surql', import.meta.url), 'utf8'),
  )
})

afterAll(async () => {
  await payload.destroy()
})

const translate = (where: Where, collectionSlug = 'posts') => {
  const params = new ParamBag()
  const sql = buildQuery({
    adapter,
    collectionSlug,
    fields: payload.collections[collectionSlug]!.config.flattenedFields,
    params,
    where,
  })

  return { sql, vars: params.vars }
}

/** The `LET` statements that a `where` needs in front of the statement that uses it. */
const preludeOf = (where: Where) => {
  const params = new ParamBag()

  buildQuery({
    adapter,
    collectionSlug: 'posts',
    fields: payload.collections['posts']!.config.flattenedFields,
    params,
    where,
  })

  return params.prelude
}

const foundIds = async (where: Where, collection = 'posts') => {
  const { docs } = await payload.db.find({ collection, limit: 0, where })
  return docs.map((doc) => doc.id).toSorted()
}

const rawIds = async (sql: string) => {
  const [rows] = await connection().query<[{ id: { id: string } }[]]>(sql)
  return rows.map((row) => String(row.id.id)).toSorted()
}

/** The directors whose `movies` meet `operator` for the movies not named 'recalls'. */
const dangling = (operator: 'contains' | 'equals' | 'not_equals') =>
  foundIds({ movies: { [operator]: { name: { not_equals: 'recalls' } } } }, 'directors')

describe('where and sort, from the semantics fixture', () => {
  test.each(cases)('$key', async ({ collection, ids, locale, sort, where }) => {
    const { docs } = await payload.db.find({
      collection,
      limit: 0,
      ...(locale ? { locale } : {}),
      ...(sort ? { sort } : {}),
      ...(where ? { where } : {}),
    })
    const found = docs.map((doc) => doc.id)

    // Without a sort the order is not part of the contract
    expect(sort ? found : found.toSorted()).toEqual(sort ? ids : ids.toSorted())
  })

  test('paginates a sorted page (O19)', async () => {
    const page = await payload.db.find({ collection: 'st', limit: 2, page: 2, sort: 'number' })

    expect(page.docs.map((doc) => doc.id)).toEqual(['s3', 's10'])
    expect(page).toMatchObject({ page: 2, totalDocs: 6, totalPages: 3 })
  })

  test('counts with the same filter as find', async () => {
    expect(
      await payload.db.count({ collection: 'posts', where: { number: { greater_than: 1 } } }),
    ).toEqual({ totalDocs: 2 })
  })
})

describe('geo', () => {
  test('G05 near orders by distance, nearest first', async () => {
    const { docs } = await payload.db.find({
      collection: 'pt',
      where: { point: { near: '0, 0, 100000, 0' } },
    })

    expect(docs.map((doc) => doc.id)).toEqual(['x2', 'x3', 'x1'])
  })

  test('G05trap geo::distance throws on a row without a point, so it is guarded', async () => {
    await expect(
      connection().query('SELECT id FROM pt WHERE geo::distance(point, (0, 0)) <= 100000'),
    ).rejects.toThrow(/geo::distance/)
  })

  test('near binds the point and the distances', () => {
    const params = new ParamBag()
    const condition = buildQuery({
      adapter,
      collectionSlug: 'pt',
      fields: adapter.payload.collections['pt']!.config.flattenedFields,
      params,
      where: { point: { near: '1, 2, 3, 4' } },
    })

    expect(condition).toBe(
      `(type::is_point(\`point\`) AND geo::distance(\`point\`, $p0) * ${6_378_100 / 6_371_008.8} <= $p1 AND geo::distance(\`point\`, $p0) * ${6_378_100 / 6_371_008.8} >= $p2)`,
    )
    expect(Object.keys(params.vars)).toEqual(['p0', 'p1', 'p2'])
  })
})

describe('invalid queries', () => {
  test('a path that is not a field is a 400', async () => {
    await expect(
      payload.db.find({ collection: 'posts', where: { nonexistent: { equals: 1 } } }),
    ).rejects.toMatchObject({ status: 400 })
  })

  test('an object value for like is a 400', async () => {
    await expect(
      payload.db.find({ collection: 'posts', where: { title: { like: { a: { equals: 1 } } } } }),
    ).rejects.toMatchObject({ status: 400 })
  })
})

describe('generated SurrealQL', () => {
  test('binds every value and escapes every identifier', () => {
    expect(translate({ title: { equals: "x'; DELETE posts; --" } })).toEqual({
      sql: '(`title` = $p0)',
      vars: { p0: "x'; DELETE posts; --" },
    })
  })

  test('escapes reserved words', () => {
    expect(translate({ select: { equals: 'one' } }).sql).toBe('(`select` = $p0)')
  })

  test('binds dates as Date, not as a string', () => {
    const { vars } = translate({ date: { greater_than: '2025-03-01T00:00:00.000Z' } })

    expect(vars['p0']).toBeInstanceOf(Date)
  })

  test('guards a comparison with the type of the value', () => {
    expect(translate({ number: { less_than: 2 } }).sql).toBe(
      '(type::is_number(`number`) AND `number` < $p0)',
    )
  })

  test('treats missing as NONE or NULL', () => {
    expect(translate({ title: { equals: null } }).sql).toBe('((`title` = NONE OR `title` = NULL))')
  })

  test('keeps documents with a missing field for not_equals', () => {
    expect(translate({ title: { not_equals: 'a' } }).sql).toBe('(`title` != $p0)')
  })

  test('skips an or that has no conditions', () => {
    expect(translate({ or: [{}, {}] }).sql).toBeNull()
  })

  test('ANDs several operators on one path and several paths', () => {
    expect(
      translate({ number: { greater_than: 1, less_than: 9 }, title: { equals: 'a' } }).sql,
    ).toBe(
      '(type::is_number(`number`) AND `number` > $p0) AND (type::is_number(`number`) AND `number` < $p1) AND (`title` = $p2)',
    )
  })

  test('escapes hyphenated locale segments', () => {
    expect(toIdiom('title.en-US')).toBe('`title`.`en-US`')
    expect(escapeIdent('a`b')).toBe('`a\\`b`')
  })
})

describe('relationship paths in a request', () => {
  test('resolve the related IDs once, before the statement that uses them', () => {
    const where: Where = { 'author.name': { equals: 'Alice' } }
    const { sql, vars } = translate(where)

    expect(sql).toBe('(`author` IN $h0)')
    expect(preludeOf(where)).toBe('LET $h0 = (SELECT VALUE id FROM `users` WHERE `name` = $p0);')
    expect(vars).toEqual({ p0: 'Alice' })
  })

  test('chain one LET per hop, last field first', () => {
    const where: Where = { 'author.manager.name': { equals: 'Bob' } }

    expect(translate(where).sql).toBe('(`author` IN $h1)')
    expect(preludeOf(where)).toBe(
      [
        'LET $h0 = (SELECT VALUE id FROM `users` WHERE `name` = $p0);',
        'LET $h1 = (SELECT VALUE id FROM `users` WHERE `manager` IN $h0);',
      ].join('\n'),
    )
  })

  test('filter a list of links in place, with no list of the matching IDs', () => {
    const where: Where = { movies: { contains: { name: { equals: 'recalls' } } } }
    const { sql } = translate(where, 'directors')

    expect(sql).toBe('(array::len(((`movies` ?? []))[WHERE id != NONE AND ((`name` = $p0))]) > 0)')
    expect(sql).not.toMatch(/CONTAINSANY|CONTAINSNONE|ALLINSIDE|\$h\d/)
  })

  test('leave out the links whose document is gone, for every operator', async () => {
    await connection().query(`
      CREATE directors:g1 CONTENT { name: 'gone-only', movies: [movies:gone] };
      CREATE directors:g2 CONTENT { name: 'gone-and-match', movies: [movies:m2, movies:gone] };
    `)

    try {
      // `movies:gone` is NONE, which `not_equals` would match if the link were not checked first
      expect(await dangling('contains')).toEqual(['d1', 'd3', 'g2'])
      expect(await dangling('not_equals')).toEqual(['d2', 'd4', 'd5', 'g1'])
      // The link that is gone is not one that matches, so `equals` fails for both
      expect(await dangling('equals')).toEqual(['d3', 'd4', 'd5'])
    } finally {
      await connection().query('DELETE directors:g1, directors:g2')
    }
  })

  test('resolve the IDs of an upsert inside the unit that writes it', async () => {
    const where: Where = { 'author.name': { equals: 'Nobody' } }
    const created = await payload.db.upsert({
      collection: 'posts',
      data: { title: 'upserted' },
      where,
    })

    try {
      expect(created).toMatchObject({ title: 'upserted' })
      expect(await rawIds(`SELECT id FROM posts WHERE title = 'upserted'`)).toEqual([
        String(created?.['id']),
      ])
    } finally {
      await payload.db.deleteOne({ collection: 'posts', where: { title: { equals: 'upserted' } } })
    }

    const transactionID = await beginTransaction(payload)

    try {
      const updated = await payload.db.upsert({
        collection: 'posts',
        data: { title: 'upserted in a transaction' },
        req: { transactionID },
        where: { 'author.name': { equals: 'Alice' } },
      })

      expect(updated).toMatchObject({ id: 'p1', title: 'upserted in a transaction' })
    } finally {
      await payload.db.rollbackTransaction(transactionID)
    }

    expect(await rawIds(`SELECT id FROM posts WHERE title = 'upserted'`)).toEqual([])
  })

  test('store a single { relationTo, value } given for a polymorphic hasMany as a list of one', async () => {
    const created = await payload.db.create({
      collection: 'rels',
      data: { polyMany: { relationTo: 'movies', value: 'm1' } },
    })

    try {
      expect(created).toMatchObject({ polyMany: [{ relationTo: 'movies', value: 'm1' }] })
      expect(await foundIds({ 'polyMany.value': { equals: 'm1' } }, 'rels')).toContain(
        String(created.id),
      )
    } finally {
      await payload.db.deleteOne({ collection: 'rels', where: { id: { equals: created.id } } })
    }
  })

  test('bind a hostile value and leave the data alone', async () => {
    const hostile = "x'; REMOVE TABLE posts; --"

    expect(translate({ 'author.name': { equals: hostile } }).sql).not.toContain(hostile)
    expect(await foundIds({ 'author.name': { equals: hostile } })).toEqual([])
    expect(await rawIds('SELECT id FROM posts')).toHaveLength(7)
  })

  test('keep the results of count, updateMany and deleteMany in place', async () => {
    const transactionID = await beginTransaction(payload)
    const req = { transactionID }
    const where: Where = { 'author.name': { equals: 'Alice' } }

    try {
      expect(await payload.db.count({ collection: 'posts', req, where })).toEqual({ totalDocs: 1 })

      const updated = await payload.db.updateMany({
        collection: 'posts',
        data: { title: 'changed' },
        req,
        where,
      })
      expect(updated?.map((doc) => [doc['id'], doc['title']])).toEqual([['p1', 'changed']])

      await payload.db.deleteMany({ collection: 'posts', req, where })
      expect(await payload.db.count({ collection: 'posts', req })).toEqual({ totalDocs: 6 })
    } finally {
      await payload.db.rollbackTransaction(transactionID)
    }

    expect(await payload.db.count({ collection: 'posts' })).toEqual({ totalDocs: 7 })
  })

  test('see the writes of their own transaction, which separate lookups cannot', async () => {
    const transactionID = await beginTransaction(payload)
    const req = { transactionID }

    try {
      const user = await payload.db.create({
        collection: 'users',
        data: { name: 'Zed' },
        req,
      })
      await payload.db.create({ collection: 'posts', data: { author: user.id, title: 'z' }, req })

      const { docs } = await payload.db.find<TypeWithID & { title?: string }>({
        collection: 'posts',
        req,
        where: { 'author.name': { equals: 'Zed' } },
      })
      expect(docs.map((doc) => doc['title'])).toEqual(['z'])
    } finally {
      await payload.db.rollbackTransaction(transactionID)
    }

    expect(await foundIds({ 'author.name': { equals: 'Zed' } })).toEqual([])
  })
})

describe('sort aliases', () => {
  test('are not returned with the documents', async () => {
    const { docs } = await payload.db.find({ collection: 'movies', sort: 'director.name' })

    expect(docs.flatMap((doc) => Object.keys(doc).filter((key) => key.startsWith('__')))).toEqual(
      [],
    )
  })

  test('page without repeating or skipping a row', async () => {
    const sort = 'arr.text'
    const seen: unknown[] = []

    for (const page of [1, 2, 3]) {
      const result = await payload.db.find({ collection: 'arrsort', limit: 1, page, sort })
      seen.push(...result.docs.map((doc) => doc.id))
    }

    expect(seen).toEqual(['a3', 'a1', 'a2'])
  })

  test('keep a select, which trims the keys the alias is not among', async () => {
    const { docs } = await payload.db.find({
      collection: 'movies',
      select: { name: true },
      sort: '-director.name',
    })

    expect(docs).toEqual([
      { id: 'm1', name: 'recalls' },
      { id: 'm2', name: 'electric-cars' },
      { id: 'm3', name: 'Pulp Fiction' },
    ])
  })
})

describe('identifier escaping, live', () => {
  test('round-trips reserved words, hyphens, backticks and backslashes', async () => {
    const names = ['select', 'x-y', 'a`b', 'c\\d', 'en-US']
    const set = names.map((name, index) => `${escapeIdent(name)} = ${index}`).join(', ')

    const [rows] = await connection().query<[Record<string, number>[]]>(
      `CREATE ${escapeIdent('esc')}:1 SET ${set} RETURN ${names.map(escapeIdent).join(', ')}`,
    )

    expect(rows).toEqual([Object.fromEntries(names.map((name, index) => [name, index]))])
  })
})

describe('naive translations that SurrealDB 3.3.2 gets wrong (regression guards)', () => {
  test('IS NONE misses NULL', async () => {
    expect(await rawIds('SELECT id FROM posts WHERE number IS NONE')).not.toEqual([
      'p4',
      'p5',
      'p6',
      'p7',
    ])
  })

  test('a bare < matches missing values', async () => {
    expect(await rawIds('SELECT id FROM posts WHERE number < 2')).not.toEqual(['p1'])
  })

  test('an ISO string does not compare as a date', async () => {
    expect(await rawIds("SELECT id FROM posts WHERE date > '2025-03-01T00:00:00Z'")).not.toEqual([
      'p2',
    ])
  })

  test('a bare number key is not the string key', async () => {
    expect(await rawIds('SELECT id FROM pages WHERE id = pages:999')).toEqual([])
  })

  test('string::lowercase throws on a missing value', async () => {
    await expect(
      connection().query(
        "SELECT id FROM posts WHERE !string::contains(string::lowercase(title), 'prefix')",
      ),
    ).rejects.toThrow()
  })
})
