import type { RetryValue, Surreal, SurrealSession, SurrealTransaction } from 'surrealdb'

import { APIError } from 'payload'
import { isRetryableConflict } from 'surrealdb'

import type { ClientArgs } from './createClient.js'
import type { Executor } from './executor.js'

import { createClient } from './createClient.js'

export type TransactionLimits = {
  /** How long `beginTransaction` queues for a free slot before it fails, in milliseconds. */
  acquireTimeoutMs: number
  /** Open transactions a session may hold. The server refuses the 65th with "Too many open transactions". */
  maxPerSession: number
  /** Sessions forked on each connection. Each one adds `maxPerSession` of capacity. */
  sessionsPerConnection: number
  /** How long a transaction may stay open before the reaper cancels it, in milliseconds. */
  timeoutMs: number
}

export type PoolArgs = {
  client: ClientArgs
  /** WebSocket connections. Ignored for an HTTP URL, which gets one. */
  size: number
  /** `false` turns interactive transactions off: no sessions are forked and no reaper runs. */
  transactions: false | TransactionLimits
  warn: (message: string, error: unknown) => void
}

type Connection = {
  client: Surreal
  /** Counts the reconnects of this connection: the server rolls back every transaction of an older epoch. */
  epoch: number
  slots: Slot[]
}

/** One server-side session: it carries its own budget of open transactions. */
type Slot = {
  connection: Connection
  open: number
  session: SurrealSession
}

type TransactionEntry = {
  /** Set once the transaction is committed or cancelled, so a late query fails instead of reaching the server. */
  closed: boolean
  connection: Connection
  /** The `epoch` of the connection when the transaction began. */
  epoch: number
  failed: boolean
  inFlight: Set<Promise<unknown>>
  slot: Slot
  startedAt: number
  tx: SurrealTransaction
}

type Waiter = {
  reject: (error: APIError) => void
  resolve: (slot: Slot) => void
  timer: NodeJS.Timeout
}

type LostReason = 'reconnect' | 'timeout'

/** Lost transactions are remembered until someone commits or rolls them back; this bounds the memory when nobody does. */
const MAX_LOST_TRANSACTIONS = 10_000

/** What the server answers when a transaction is committed on a connection that is not the one it began on. */
const TRANSACTION_NOT_FOUND = /Transaction not found/i

const isWebSocketUrl = (url: string): boolean => /^wss?:/i.test(url)

/**
 * Connections to SurrealDB and the transactions open on them.
 *
 * Plain queries rotate over the connections. A transaction lives on one forked session; each
 * session may hold fewer than 64 of them, and a caller that finds every session full queues
 * instead of failing. The server never times a transaction out, so a reaper cancels the ones
 * that stay open too long. A reconnect makes the server roll back every transaction of that
 * connection, so those entries are dropped. A transaction that was cancelled or rolled back
 * this way is remembered as lost until its owner commits or rolls it back, so a commit never
 * reports success for work that was discarded.
 */
export class SurrealPool implements Executor {
  readonly inTransaction = false
  /** Open transactions by ID, the registry `getSession` resolves `req.transactionID` against. */
  readonly sessions = new Map<string, TransactionEntry>()

  readonly #args: PoolArgs
  readonly #connections: Connection[]
  #destroyed = false
  readonly #lost = new Map<string, LostReason>()
  #next = 0
  readonly #reaper: NodeJS.Timeout | undefined
  readonly #waiters: Waiter[] = []

  private constructor(args: PoolArgs, connections: Connection[]) {
    this.#args = args
    this.#connections = connections

    for (const connection of connections) {
      connection.client.subscribe('reconnecting', () => this.#evict(connection))
    }

    if (args.transactions) {
      this.#reaper = setInterval(
        () => this.#reap(),
        Math.min(5000, args.transactions.timeoutMs / 2),
      )
      this.#reaper.unref()
    }
  }

  static async create(args: PoolArgs): Promise<SurrealPool> {
    const webSocket = isWebSocketUrl(args.client.url)
    const opened = await Promise.allSettled(
      Array.from({ length: webSocket ? args.size : 1 }, () => createClient(args.client)),
    )
    const clients = opened.flatMap((result) =>
      result.status === 'fulfilled' ? [result.value] : [],
    )

    try {
      const failed = opened.find((result) => result.status === 'rejected')

      if (failed) {
        throw failed.reason
      }

      // The HTTP engine has no sessions, which is also why it has no transactions.
      const connections = await Promise.all(
        clients.map(async (client): Promise<Connection> => {
          const connection: Connection = { client, epoch: 0, slots: [] }

          if (webSocket && args.transactions) {
            // `forkSession` keeps the namespace, database and credentials; `newSession` would not.
            const sessions = await Promise.all(
              Array.from({ length: args.transactions.sessionsPerConnection }, () =>
                client.forkSession(),
              ),
            )
            connection.slots = sessions.map((session) => ({ connection, open: 0, session }))
          }

          return connection
        }),
      )

      return new SurrealPool(args, connections)
    } catch (error) {
      await Promise.allSettled(clients.map((client) => client.close()))
      throw error
    }
  }

  /** False on the HTTP engine and when transactions are turned off: `beginTransaction` returns null. */
  get supportsTransactions(): boolean {
    return this.#connections.every((connection) => connection.slots.length > 0)
  }

  async query<R extends unknown[]>(
    sql: string,
    vars?: Record<string, unknown>,
    options?: { requestTimeout?: number; retry?: RetryValue },
  ): Promise<R> {
    const connection = this.#connections[this.#next++ % this.#connections.length]

    if (!connection || this.#destroyed) {
      throw new APIError('The SurrealDB connection pool is closed.')
    }

    let query = connection.client.query<R>(sql, vars)

    if (options?.requestTimeout !== undefined) {
      query = query.requestTimeout(options.requestTimeout)
    }

    return (await (options?.retry ? query.retry(options.retry) : query).collect()) as R
  }

  async begin(): Promise<string> {
    const slot = await this.#acquire()
    let tx: SurrealTransaction

    try {
      tx = await slot.session.beginTransaction()
    } catch (error) {
      this.#release(slot)
      throw error
    }

    const id = crypto.randomUUID()
    this.sessions.set(id, {
      closed: false,
      connection: slot.connection,
      epoch: slot.connection.epoch,
      failed: false,
      inFlight: new Set(),
      slot,
      startedAt: Date.now(),
      tx,
    })

    return id
  }

  /** The executor for the open transaction `id`; throws when it is gone, and says why when it is known. */
  transaction(id: string): Executor {
    const entry = this.sessions.get(id)

    if (entry) {
      return {
        inTransaction: true,
        query: (sql, vars) => this.#queryInTransaction(entry, sql, vars),
      }
    }

    const lost = this.#lost.get(id)

    if (lost) {
      throw this.#lostError(lost)
    }

    throw this.#notOpenError(id)
  }

  /**
   * Commits `id`. A transaction that had a failed query is cancelled instead and this throws, so a
   * caller that swallowed the error cannot persist half of its work. An ID that is not open
   * throws: with the lost reason when the transaction was lost, otherwise because it was already
   * finished or never began here. Succeeding would report work as persisted that is not.
   */
  async commit(id: string): Promise<void> {
    const entry = this.sessions.get(id)

    if (!entry) {
      const lost = this.#lost.get(id)

      if (lost) {
        this.#lost.delete(id)
        throw this.#lostError(lost)
      }

      throw this.#notOpenError(id)
    }

    // Removed first so a concurrent commit or rollback of the same ID finds nothing to act on.
    this.sessions.delete(id)

    try {
      // A commit sent while a query is still running persists only what that query had done so far.
      while (entry.inFlight.size > 0) {
        await Promise.allSettled(entry.inFlight)
      }

      // The server rolled the transaction back with the old connection, so a failed query is no news.
      if (entry.epoch !== entry.connection.epoch) {
        entry.closed = true
        throw this.#lostError('reconnect')
      }

      entry.closed = true

      if (entry.failed) {
        await this.#cancelTransaction(entry)
        throw new APIError(
          'A query inside this transaction failed, so the transaction was rolled back instead of committed.',
        )
      }

      await entry.tx.commit()
    } catch (error) {
      if (
        entry.epoch !== entry.connection.epoch ||
        (error instanceof Error && TRANSACTION_NOT_FOUND.test(error.message))
      ) {
        throw this.#lostError('reconnect')
      }

      if (isRetryableConflict(error)) {
        throw new APIError(
          'The transaction conflicted with another write and was rolled back. Retry the request.',
          409,
        )
      }

      throw error
    } finally {
      entry.closed = true
      this.#release(entry.slot)
    }
  }

  /** Rolling back what is already gone is not an error, and it consumes the record of a lost transaction. */
  async rollback(id: string): Promise<void> {
    const entry = this.sessions.get(id)

    if (!entry) {
      this.#lost.delete(id)
      return
    }

    this.sessions.delete(id)
    await this.#cancelTransaction(entry)
    this.#release(entry.slot)
  }

  async destroy(): Promise<void> {
    this.#destroyed = true
    clearInterval(this.#reaper)

    for (const waiter of this.#waiters.splice(0)) {
      clearTimeout(waiter.timer)
      waiter.reject(new APIError('The SurrealDB connection pool was closed.'))
    }

    const entries = [...this.sessions.values()]
    this.sessions.clear()
    await Promise.all(entries.map((entry) => this.#cancelTransaction(entry)))
    await Promise.all(this.#connections.map(({ client }) => client.close()))
  }

  #queryInTransaction<R extends unknown[]>(
    entry: TransactionEntry,
    sql: string,
    vars?: Record<string, unknown>,
  ): Promise<R> {
    if (entry.closed) {
      return Promise.reject(
        new APIError('This transaction was already committed, rolled back or cancelled.'),
      )
    }

    // The failure is recorded before this promise settles, so a commit that waits on it sees it.
    const tracked = entry.tx
      .query<R>(sql, vars)
      .collect()
      .then(
        (result) => {
          entry.inFlight.delete(tracked)
          return result as R
        },
        (error: unknown) => {
          entry.failed = true
          entry.inFlight.delete(tracked)
          throw error
        },
      )

    entry.inFlight.add(tracked)

    return tracked
  }

  /** Cancels on the server and never throws: the caller is giving up on the transaction already. */
  async #cancelTransaction(entry: TransactionEntry): Promise<void> {
    entry.closed = true

    try {
      await entry.tx.cancel()
    } catch (error) {
      this.#args.warn('Could not cancel a SurrealDB transaction', error)
    }
  }

  /** Only reached once a connection has slots, which only exist when transactions are on. */
  get #limits(): TransactionLimits {
    if (!this.#args.transactions) {
      throw new APIError('Interactive transactions are turned off for this connection.')
    }

    return this.#args.transactions
  }

  #acquire(): Promise<Slot> {
    if (this.#destroyed) {
      return Promise.reject(new APIError('The SurrealDB connection pool is closed.'))
    }

    const slot = this.#freeSlot()

    if (slot) {
      slot.open++
      return Promise.resolve(slot)
    }

    const { acquireTimeoutMs } = this.#limits

    return new Promise<Slot>((resolve, reject) => {
      const waiter: Waiter = {
        reject,
        resolve,
        timer: setTimeout(() => {
          this.#waiters.splice(this.#waiters.indexOf(waiter), 1)
          reject(
            new APIError(
              `No transaction slot became free within ${acquireTimeoutMs} ms. Raise transactionOptions.acquireTimeoutMs or pool.size.`,
              503,
            ),
          )
        }, acquireTimeoutMs),
      }

      this.#waiters.push(waiter)
    })
  }

  /** The least loaded session with room left, so open transactions spread over connections. */
  #freeSlot(): Slot | undefined {
    let best: Slot | undefined

    for (const { slots } of this.#connections) {
      for (const slot of slots) {
        if (slot.open < this.#limits.maxPerSession && (!best || slot.open < best.open)) {
          best = slot
        }
      }
    }

    return best
  }

  /** Frees the slot and hands it straight to the longest waiting caller, which keeps the queue fair. */
  #release(slot: Slot): void {
    slot.open--

    const waiter = this.#waiters.shift()

    if (waiter) {
      clearTimeout(waiter.timer)
      slot.open++
      waiter.resolve(slot)
    }
  }

  #evict(connection: Connection): void {
    connection.epoch++

    for (const [id, entry] of this.sessions) {
      if (entry.connection === connection) {
        this.sessions.delete(id)
        this.#markLost(id, 'reconnect')
        // The server rolled the transaction back with the old connection, there is nothing to cancel.
        entry.closed = true
        this.#release(entry.slot)
      }
    }
  }

  #reap(): void {
    const now = Date.now()
    const { timeoutMs } = this.#limits

    for (const [id, entry] of this.sessions) {
      if (now - entry.startedAt > timeoutMs) {
        this.sessions.delete(id)
        this.#markLost(id, 'timeout')
        void this.#cancelTransaction(entry).finally(() => this.#release(entry.slot))
      }
    }
  }

  /** Never forgets by age, because a commit that finds nothing has to be told its work is gone. */
  #markLost(id: string, reason: LostReason): void {
    this.#lost.set(id, reason)

    const oldest = this.#lost.keys().next()

    if (this.#lost.size > MAX_LOST_TRANSACTIONS && !oldest.done) {
      this.#lost.delete(oldest.value)
      this.#args.warn(
        `Forgot the lost SurrealDB transaction ${oldest.value}: more than ${MAX_LOST_TRANSACTIONS} lost transactions were never committed or rolled back. A later commit of it will fail as "not open" instead of "lost".`,
        undefined,
      )
    }
  }

  #notOpenError(id: string): APIError {
    return new APIError(
      `Transaction ${id} is not open: it was already committed or rolled back, or it never began on this adapter.`,
    )
  }

  #lostError(reason: LostReason): APIError {
    return reason === 'reconnect'
      ? new APIError(
          'Transaction lost due to reconnect: the connection to SurrealDB dropped and the server rolled the transaction back.',
          503,
        )
      : new APIError(
          `Transaction lost: it stayed open longer than transactionOptions.timeoutMs (${this.#limits.timeoutMs} ms) and was cancelled.`,
        )
  }
}
