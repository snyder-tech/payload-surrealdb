-- Fixture for Payload where/sort semantics on SurrealDB 3.3.x (ns 'semantics', db 'fx').
-- Storage model = Mongo-shaped documents: record links for relationships,
-- {relationTo, value} objects for polymorphic, {<locale>: v} objects for localized,
-- datetime for dates, geometry point for point fields. One deliberate NULL row (posts:p4)
-- to prove every "missing" guard covers both NONE and NULL.

REMOVE TABLE IF EXISTS posts; REMOVE TABLE IF EXISTS users; REMOVE TABLE IF EXISTS categories;
REMOVE TABLE IF EXISTS movies; REMOVE TABLE IF EXISTS directors; REMOVE TABLE IF EXISTS tags;
REMOVE TABLE IF EXISTS rels; REMOVE TABLE IF EXISTS cnum; REMOVE TABLE IF EXISTS pages;
REMOVE TABLE IF EXISTS tf; REMOVE TABLE IF EXISTS jf; REMOVE TABLE IF EXISTS loc;
REMOVE TABLE IF EXISTS st; REMOVE TABLE IF EXISTS sn; REMOVE TABLE IF EXISTS pt;
REMOVE TABLE IF EXISTS arrsort; REMOVE TABLE IF EXISTS emptyt;

DEFINE TABLE posts SCHEMALESS; DEFINE TABLE users SCHEMALESS; DEFINE TABLE categories SCHEMALESS;
DEFINE TABLE movies SCHEMALESS; DEFINE TABLE directors SCHEMALESS; DEFINE TABLE tags SCHEMALESS;
DEFINE TABLE rels SCHEMALESS; DEFINE TABLE cnum SCHEMALESS; DEFINE TABLE pages SCHEMALESS;
DEFINE TABLE tf SCHEMALESS; DEFINE TABLE jf SCHEMALESS; DEFINE TABLE loc SCHEMALESS;
DEFINE TABLE st SCHEMALESS; DEFINE TABLE sn SCHEMALESS; DEFINE TABLE pt SCHEMALESS;
DEFINE TABLE arrsort SCHEMALESS; DEFINE TABLE emptyt SCHEMALESS;

-- Deep "values at path" helper: flattens nested arrays, drops NONE/NULL.
DEFINE FUNCTION OVERWRITE fn::pvals($v: any) -> array {
  IF type::is_array($v) { RETURN array::flatten($v.map(|$x| fn::pvals($x))) }
  ELSE IF $v = NONE OR $v = NULL { RETURN [] }
  ELSE { RETURN [$v] }
};

-- users / categories (relationship targets, multi-hop)
CREATE users:u1 CONTENT { name: 'Alice', manager: users:u2 };
CREATE users:u2 CONTENT { name: 'Bob', manager: users:u3 };
CREATE users:u3 CONTENT { role: 'nameless' };
CREATE categories:c1 CONTENT { title: 'new-category' };

-- posts: scalar shapes
CREATE posts:p1 CONTENT { title: 'valueToQuery', text: 'text-1', description: 'exists', number: 1,
  select: 'one', checkbox: true, checkboxNotRequired: false, date: d'2025-01-15T00:00:00Z',
  createdAt: d'2025-01-01T00:00:00.123Z', author: users:u1, category: categories:c1,
  group: { number: 100, text: 'g1' } };
CREATE posts:p2 CONTENT { title: 'Post Two', text: 'text-2', number: 2, select: 'two', checkbox: false,
  date: d'2025-06-15T00:00:00Z', createdAt: d'2025-01-02T00:00:00Z', author: users:u2,
  group: { number: 200 } };
CREATE posts:p3 CONTENT { text: 'text-3', number: 10, checkbox: true, createdAt: d'2025-01-03T00:00:00Z',
  author: users:u3 };
CREATE posts:p4 CONTENT { title: '', text: NULL, number: NULL, select: NULL, description: NULL,
  createdAt: d'2025-01-04T00:00:00Z' };
CREATE posts:p5 CONTENT { title: 'prefix-value ~!@#$%^&*()_+-+[]{}|;:"<>,.?/})', createdAt: d'2025-01-05T00:00:00Z' };
CREATE posts:p6 CONTENT { title: 'привет, это тест полезной нагрузки', createdAt: d'2025-01-06T00:00:00Z' };
CREATE posts:p7 CONTENT { title: 'Separate WORDS should partially match', createdAt: d'2025-01-07T00:00:00Z' };

-- relationship targets
CREATE tags:t1 CONTENT { name: 'red' };
CREATE tags:t2 CONTENT { name: 'blue' };
CREATE cnum:999 CONTENT { title: 'numeric id' };
CREATE pages:⟨999⟩ CONTENT { title: 'string id that looks numeric' };
CREATE movies:m1 CONTENT { name: 'recalls', select: ['a'], director: directors:d2 };
CREATE movies:m2 CONTENT { name: 'electric-cars', select: ['a', 'b'], director: directors:d1 };
CREATE movies:m3 CONTENT { name: 'Pulp Fiction', select: [] };
CREATE directors:d1 CONTENT { name: 'mixed', movies: [movies:m1, movies:m2], movie: movies:m2 };
CREATE directors:d2 CONTENT { name: 'recalls', movies: [movies:m1], movie: movies:m1 };
CREATE directors:d3 CONTENT { name: 'electric-cars', movies: [movies:m2] };
CREATE directors:d4 CONTENT { name: 'empty', movies: [] };
CREATE directors:d5 CONTENT { name: 'nomovies' };

-- relationship-fields: single, hasMany, polymorphic single/hasMany, relationship in array, localized poly
CREATE rels:r1 CONTENT {
  rel: movies:m1, relMany: [movies:m1, movies:m2],
  poly: { relationTo: 'movies', value: movies:m1 },
  polyMany: [{ relationTo: 'movies', value: movies:m1 }, { relationTo: 'tags', value: tags:t1 }],
  polyLoc: { en: { relationTo: 'movies', value: movies:m1 } },
  array: [{ id: 'ra1', rel: movies:m2 }] };
CREATE rels:r2 CONTENT {
  relMany: [movies:m3],
  poly: { relationTo: 'tags', value: tags:t1 },
  polyMany: [{ relationTo: 'tags', value: tags:t2 }],
  array: [{ id: 'ra2', rel: movies:m1 }, { id: 'ra3' }] };
CREATE rels:r3 CONTENT { relMany: [] };
CREATE rels:r4 CONTENT { poly: { relationTo: 'cnum', value: cnum:999 } };
CREATE rels:r5 CONTENT { poly: { relationTo: 'pages', value: pages:⟨999⟩ } };

-- text-fields: hasMany text/number/select, arrays, blocks
CREATE tf:tf1 CONTENT { text: 'cat', hasMany: ['one', 'five', 'apple pie'], hasManySecond: ['4'],
  nums: [5, 10], selectMany: ['one', 'four'],
  array: [{ id: 'x1', texts: ['text_1', 'text_2'], date: d'2025-07-01T00:00:00Z',
            text: 'required', anotherText: 'another', localizedText: { en: 'test' } }],
  blocks: [{ id: 'b1', blockType: 'blockWithText', texts: ['text_1', 'text_2'] }] };
CREATE tf:tf2 CONTENT { text: 'dog', hasMany: ['two', 'Banana bread'], hasManySecond: ['4'],
  nums: [13], selectMany: ['three', 'bananabread'],
  array: [{ id: 'x2', texts: ['text_other', 'text_2'], date: d'2024-02-01T00:00:00Z', text: 'required' },
          { id: 'x3', date: d'2025-08-01T00:00:00Z', anotherText: 'another', localizedText: { en: 'nope' } }],
  blocks: [{ id: 'b2', blockType: 'other', texts: ['text_other', 'text_2'] }] };
CREATE tf:tf3 CONTENT { text: 'dog-unique-test', hasMany: [], nums: [], selectMany: [], array: [], blocks: [] };
CREATE tf:tf4 CONTENT { text: 'cat-unique-test' };

-- json fields
CREATE jf:j1 CONTENT { json: { foo: 'foobar', number: 5 } };
CREATE jf:j2 CONTENT { json: { baz: 'bar', number: 10 } };
CREATE jf:j3 CONTENT { json: { value: 1, isEven: false } };
CREATE jf:j4 CONTENT { json: { value: 2, isEven: true } };
CREATE jf:j5 CONTENT { json: { value: 3, isEven: false } };
CREATE jf:j6 CONTENT { json: { value: 4, isEven: true } };
CREATE jf:j8 CONTENT { };
CREATE jf:j9 CONTENT { json: [] };
CREATE jf:j10 CONTENT { json: { value: 'literal-value' } };
CREATE jf:j11 CONTENT { json: { array: [{ text: 'some-text', object: { text: 'deep-text', array: [10] } }] } };
CREATE jf:j12 CONTENT { json: { doc: { value: '42', relationTo: 'posts' } } };
CREATE jf:j13 CONTENT { json: { doc: { value: '99', relationTo: 'posts' } } };
CREATE jf:j14 CONTENT { json: { doc: { value: '42', relationTo: 'other' } } };
CREATE jf:j15 CONTENT { json: { value: NULL } };

-- localized
CREATE loc:l1 CONTENT { title: { en: 'English title', es: 'Spanish title' },
  localizedGroup: { en: { text: 'find this' } }, number: { en: 10, nb: 20 } };
CREATE loc:l2 CONTENT { title: { en: 'word_b' }, localizedGroup: { en: { text: 'do not find this' } },
  number: { en: 25, nb: 5 } };
CREATE loc:l3 CONTENT { title: { en: 'others_c' } };

-- sort spec data (test/sort/int.spec.ts:17-24) + createdAt for fallback
CREATE st:s1 CONTENT { group: { number: 100 }, number: 1, number2: 10, text: 'Post 1', createdAt: d'2025-01-01T00:00:01Z' };
CREATE st:s2 CONTENT { group: { number: 200 }, number: 2, number2: 10, text: 'Post 2', createdAt: d'2025-01-01T00:00:02Z' };
CREATE st:s3 CONTENT { group: { number: 150 }, number: 3, number2: 5, text: 'Post 3', createdAt: d'2025-01-01T00:00:03Z' };
CREATE st:s10 CONTENT { group: { number: 200 }, number: 10, number2: 5, text: 'Post 10', createdAt: d'2025-01-01T00:00:04Z' };
CREATE st:s11 CONTENT { group: { number: 150 }, number: 11, number2: 20, text: 'Post 11', createdAt: d'2025-01-01T00:00:05Z' };
CREATE st:s12 CONTENT { group: { number: 100 }, number: 12, number2: 20, text: 'Post 12', createdAt: d'2025-01-01T00:00:06Z' };

-- null / case ordering
CREATE sn:n1 CONTENT { v: 'b', k: 'aa' };
CREATE sn:n2 CONTENT { v: 'B', k: 'aA' };
CREATE sn:n3 CONTENT { k: 'a0' };
CREATE sn:n4 CONTENT { v: NULL, k: 'Zz' };
CREATE sn:n5 CONTENT { v: 'a', k: 'a1' };
CREATE sn:n6 CONTENT { v: 'á', k: 'b0' };

-- array sub-field sort (database/int.spec.ts:2045)
CREATE arrsort:a1 CONTENT { arr: [{ text: 'z' }, { text: 'b' }] };
CREATE arrsort:a2 CONTENT { arr: [{ text: 'c' }, { text: 'd' }] };
CREATE arrsort:a3 CONTENT { arr: [{ text: 'a' }, { text: 'y' }] };

-- points (stored [lng, lat] as geometry point)
CREATE pt:p0 CONTENT { };
CREATE pt:p1 CONTENT { point: (10, 20) };
CREATE pt:nyc CONTENT { point: (-74.0059, 40.8026) };
CREATE pt:x1 CONTENT { point: (0.7, 0) };
CREATE pt:x2 CONTENT { point: (0.1, 0) };
CREATE pt:x3 CONTENT { point: (0.4, 0) };
