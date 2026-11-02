import type { Executor } from '../connection/executor.js'

/** SQL text whose every value is a bound parameter and every identifier is escaped. */
export type Fragment = string

/**
 * Collects the values bound to one SurrealQL request, and the `LET` statements that run before
 * it. A single bag is shared by every fragment of the request, so parameter names never collide
 * between sub-queries.
 */
export class ParamBag {
  readonly vars: Record<string, unknown> = {}
  #count = 0
  readonly #lets: string[] = []

  /** Binds `value` and returns the `$name` to put in the SQL. */
  add(value: unknown): string {
    const name = `p${this.#count++}`
    this.vars[name] = value
    return `$${name}`
  }

  /**
   * Evaluates `expression` once, before the statements of the request, and returns the `$name`
   * that holds the result. A subquery written inline in a `WHERE` is evaluated again for every
   * row, which is orders of magnitude slower on a table of any size.
   */
  define(expression: string): string {
    const name = `h${this.#lets.length}`
    this.#lets.push(`LET $${name} = (${expression});`)
    return `$${name}`
  }

  /** The `LET` statements of the request, to put in front of its statements. */
  get prelude(): string {
    return this.#lets.join('\n')
  }

  /** How many results the `LET` statements put in front of the request's own results. */
  get preludeLength(): number {
    return this.#lets.length
  }
}

/**
 * Runs `sql` with the bag's variables and `LET` statements, and resolves to one slot per
 * statement of `sql`: the results of the `LET` statements are left out.
 */
export const runQuery = async <R extends unknown[]>(
  db: Executor,
  params: ParamBag,
  sql: string,
  options?: { retry?: boolean },
): Promise<R> => {
  const results = await db.query<unknown[]>(
    params.preludeLength > 0 ? `${params.prelude}\n${sql}` : sql,
    params.vars,
    options,
  )

  return results.slice(params.preludeLength) as R
}

/**
 * Always escapes, so reserved words (`select`), hyphens (`payload-kv`, `en-US`) and every other
 * oddity are safe without keeping a list of reserved words.
 */
export const escapeIdent = (name: string): string =>
  `\`${name.replaceAll('\\', '\\\\').replaceAll('`', '\\`')}\``

/** Turns a dotted Payload path into an escaped SurrealQL idiom: `title.en-US` -> `title`.`en-US`. */
export const toIdiom = (path: string): string => path.split('.').map(escapeIdent).join('.')

/** ANDs fragments, returning null when there is nothing to combine. */
export const and = (fragments: Fragment[]): Fragment | null => {
  if (fragments.length === 0) {
    return null
  }
  return fragments.map((fragment) => `(${fragment})`).join(' AND ')
}

/** ORs fragments, returning null when there is nothing to combine. */
export const or = (fragments: Fragment[]): Fragment | null => {
  if (fragments.length === 0) {
    return null
  }
  return fragments.map((fragment) => `(${fragment})`).join(' OR ')
}

/** `" WHERE ..."` for a non-null condition, otherwise an empty string. */
export const whereClause = (condition: Fragment | null): string =>
  condition ? ` WHERE ${condition}` : ''
