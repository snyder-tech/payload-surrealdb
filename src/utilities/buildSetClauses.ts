import type { ParamBag } from '../queries/sql.js'
import type { AtomicOperations } from './transform.js'

import { escapeIdent, toIdiom } from '../queries/sql.js'

const isPlainObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && Object.getPrototypeOf(value) === Object.prototype

const isEmptyContainer = (value: unknown): boolean =>
  value === undefined || (isPlainObject(value) && Object.values(value).every(isEmptyContainer))

/**
 * One `SET key = $v` per top-level key. `MERGE` is never used: it deep-merges nested objects, so
 * stale keys would survive, and Payload expects each top-level key to be replaced as a whole.
 * `undefined` clears the field, except for a container that is empty only because an atomic
 * operation was pulled out of it: writing that would wipe the siblings the operation applies next to.
 */
export const buildSetClauses = ({
  atomic,
  params,
  row,
}: {
  atomic: AtomicOperations
  params: ParamBag
  row: Record<string, unknown>
}): string[] => {
  const atomicPaths = [
    ...Object.keys(atomic.$inc),
    ...Object.keys(atomic.$push),
    ...Object.keys(atomic.$addToSet),
    ...Object.keys(atomic.$pull),
  ]
  const holdsAtomicPath = (key: string) => atomicPaths.some((path) => path.startsWith(`${key}.`))

  return [
    ...Object.entries(row)
      .filter(([key, value]) => !(isEmptyContainer(value) && holdsAtomicPath(key)))
      .map(
        ([key, value]) =>
          `${escapeIdent(key)} = ${value === undefined ? 'NONE' : params.add(value)}`,
      ),
    // `+=` creates a missing number or array
    ...Object.entries(atomic.$inc).map(([path, n]) => `${toIdiom(path)} += ${params.add(n)}`),
    ...Object.entries(atomic.$push).map(
      ([path, items]) => `${toIdiom(path)} += ${params.add(items)}`,
    ),
    ...Object.entries(atomic.$addToSet).map(([path, items]) => {
      const idiom = toIdiom(path)
      return `${idiom} = array::union(${idiom} ?? [], ${params.add(items)})`
    }),
    ...Object.entries(atomic.$pull).map(([path, items]) => {
      const idiom = toIdiom(path)
      return `${idiom} = array::complement(${idiom} ?? [], ${params.add(items)})`
    }),
  ]
}
