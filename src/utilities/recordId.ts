import { APIError } from 'payload'
import { RecordId, Uuid } from 'surrealdb'

export type IDType = 'number' | 'text'

/**
 * A string key and a number key are different records (`t:⟨12⟩` vs `t:12`), and a float key makes
 * the SDK hang, so keys are validated here. Returns undefined when `key` cannot be a key of a table
 * with this ID type: callers decide whether that means "no match" (queries) or an error (writes).
 */
export const toRecordId = (
  table: string,
  key: unknown,
  customIDType?: IDType,
): RecordId | undefined => {
  if (customIDType === 'number') {
    const parsed = typeof key === 'string' && /^-?\d+$/.test(key) ? Number(key) : key
    return typeof parsed === 'number' && Number.isSafeInteger(parsed)
      ? new RecordId(table, parsed)
      : undefined
  }

  // A text ID collection stores every key as text, so a number is the key `'999'`, not `999`.
  if (customIDType === 'text' && typeof key === 'number' && Number.isSafeInteger(key)) {
    return new RecordId(table, String(key))
  }

  if (typeof key === 'string' && key !== '') {
    return new RecordId(table, key)
  }

  // Without an ID type, a number key is only produced by `allowIDOnCreate` and stays a number so it reads back unchanged.
  if (typeof key === 'number' && Number.isSafeInteger(key)) {
    return new RecordId(table, key)
  }

  return undefined
}

/** `toRecordId` for writes, where an unusable key is a caller error. */
export const toRecordIdOrThrow = (table: string, key: unknown, customIDType?: IDType): RecordId => {
  const recordId = toRecordId(table, key, customIDType)

  if (!recordId) {
    throw new APIError(`Invalid ID ${JSON.stringify(key)} for "${table}".`, 400)
  }

  return recordId
}

/** The bare key Payload sees, never `table:key`. */
export const fromRecordId = (recordId: RecordId): number | string => {
  const key = recordId.id

  if (typeof key === 'string' || typeof key === 'number') {
    return key
  }

  if (typeof key === 'bigint' && key >= Number.MIN_SAFE_INTEGER && key <= Number.MAX_SAFE_INTEGER) {
    return Number(key)
  }

  if (key instanceof Uuid) {
    return key.toString()
  }

  throw new APIError(`Unsupported record key type for ${recordId.toString()}.`)
}

export const isRecordId = (value: unknown): value is RecordId => value instanceof RecordId
