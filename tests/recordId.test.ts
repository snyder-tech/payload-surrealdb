import { RecordId } from 'surrealdb'
import { describe, expect, test } from 'vitest'

import { and, escapeIdent, or, ParamBag, whereClause } from '../src/queries/sql.js'
import { fromRecordId, toRecordId, toRecordIdOrThrow } from '../src/utilities/recordId.js'

describe('toRecordId', () => {
  test('keeps a string key a string, even when it looks numeric', () => {
    const recordId = toRecordId('posts', '12')

    expect(recordId?.id).toBe('12')
    expect(recordId?.equals(new RecordId('posts', '12'))).toBe(true)
    expect(recordId?.equals(new RecordId('posts', 12))).toBe(false)
  })

  test('keeps a safe integer a number key', () => {
    expect(toRecordId('posts', 12)?.id).toBe(12)
  })

  test('turns a numeric string into a number key for a number ID collection', () => {
    expect(toRecordId('cnum', '12', 'number')?.id).toBe(12)
    expect(toRecordId('cnum', 12, 'number')?.id).toBe(12)
  })

  test.each([
    ['a float', 12.5, undefined],
    ['an unsafe integer', 2 ** 53, undefined],
    ['an empty string', '', undefined],
    ['null', null, undefined],
    ['an object', { id: 1 }, undefined],
    ['a non-numeric string for a number ID', 'abc', 'number'],
    ['a float string for a number ID', '1.5', 'number'],
  ] as const)('rejects %s, which would hang the connection or never match', (_name, key, type) => {
    expect(toRecordId('posts', key, type)).toBeUndefined()
    expect(() => toRecordIdOrThrow('posts', key, type)).toThrow(/Invalid ID/)
  })
})

describe('fromRecordId', () => {
  test('returns the bare key, never table:key', () => {
    expect(fromRecordId(new RecordId('posts', 'abc'))).toBe('abc')
    expect(fromRecordId(new RecordId('posts', 7))).toBe(7)
  })

  test('rejects a key Payload cannot use', () => {
    expect(() => fromRecordId(new RecordId('posts', [1, 2]))).toThrow(/Unsupported record key/)
  })
})

describe('sql helpers', () => {
  test('ParamBag never reuses a name', () => {
    const params = new ParamBag()

    expect([params.add('a'), params.add('b'), params.add('a')]).toEqual(['$p0', '$p1', '$p2'])
    expect(params.vars).toEqual({ p0: 'a', p1: 'b', p2: 'a' })
  })

  test('escapes backticks and backslashes in identifiers', () => {
    expect(escapeIdent('select')).toBe('`select`')
    expect(escapeIdent('a`b')).toBe('`a\\`b`')
    expect(escapeIdent('a\\b')).toBe('`a\\\\b`')
  })

  test('and / or return null for nothing and parenthesise each part', () => {
    expect(and([])).toBeNull()
    expect(or([])).toBeNull()
    expect(and(['a OR b', 'c'])).toBe('(a OR b) AND (c)')
    expect(or(['a AND b', 'c'])).toBe('(a AND b) OR (c)')
  })

  test('whereClause is empty without a condition', () => {
    expect(whereClause(null)).toBe('')
    expect(whereClause('x')).toBe(' WHERE x')
  })
})

describe('toRecordId with an explicit text ID type', () => {
  test('turns a safe integer into a text key', () => {
    expect(toRecordId('coded', 999, 'text')?.id).toBe('999')
    expect(toRecordId('coded', '999', 'text')?.id).toBe('999')
  })

  test('still refuses an unsafe or fractional number', () => {
    expect(toRecordId('coded', 12.5, 'text')).toBeUndefined()
    expect(toRecordId('coded', 2 ** 53, 'text')).toBeUndefined()
  })

  test('keeps a client-supplied number a number when the ID type is not set', () => {
    expect(toRecordId('posts', 9999)?.id).toBe(9999)
  })
})
