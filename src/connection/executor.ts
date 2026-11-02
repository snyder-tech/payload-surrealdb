import type { RetryValue } from 'surrealdb'

/** `SurrealPool` is the executor for plain queries; a transaction hands out one of its own. */
export type Executor = {
  /** Whether every query runs inside one interactive transaction, so `BEGIN`/`COMMIT` are not allowed. */
  readonly inTransaction: boolean
  /**
   * Runs `sql` and resolves to one slot per statement. Rejects with the first statement error.
   * `retry` replays the request when it loses a write conflict, `true` with the SDK's defaults or with
   * the given delays and attempts. It only applies outside a
   * transaction: inside one, conflicts surface when the transaction commits.
   */
  query: <R extends unknown[]>(
    sql: string,
    vars?: Record<string, unknown>,
    options?: { retry?: RetryValue },
  ) => Promise<R>
}
