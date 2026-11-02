import { connect as tcpConnect, createServer } from 'node:net'
import type { AddressInfo, Server, Socket } from 'node:net'
import { APIError } from 'payload'
import { Surreal, SurrealSession } from 'surrealdb'
import { afterAll, afterEach, beforeAll, describe, expect, test, vi } from 'vitest'

import type { PoolArgs, TransactionLimits } from '../src/connection/pool.js'

import { SurrealPool } from '../src/connection/pool.js'
import { SURREAL_URL } from './helpers/payload.js'

const clientArgs = {
  auth: { password: 'root', username: 'root' },
  database: 'pool',
  namespace: 'm2',
  requestTimeout: 10_000,
  url: SURREAL_URL,
}

const limits: TransactionLimits = {
  acquireTimeoutMs: 30_000,
  maxPerSession: 60,
  sessionsPerConnection: 4,
  timeoutMs: 30_000,
}

const pools: SurrealPool[] = []
const warnings: string[] = []

const makePool = async (overrides: Partial<PoolArgs> = {}): Promise<SurrealPool> => {
  const pool = await SurrealPool.create({
    client: clientArgs,
    size: 2,
    transactions: limits,
    warn: (message) => warnings.push(message),
    ...overrides,
  })
  pools.push(pool)

  return pool
}

const countRows = async (pool: SurrealPool): Promise<number> => {
  const [rows] = await pool.query<[{ count: number }[]]>('SELECT count() FROM acct GROUP ALL')

  return rows[0]?.count ?? 0
}

const write = (pool: SurrealPool, id: string, n: number) =>
  pool.transaction(id).query(`CREATE acct SET n = ${n}`)

let setup: SurrealPool

beforeAll(async () => {
  setup = await makePool({ transactions: false })
  await setup.query(
    'DEFINE NAMESPACE IF NOT EXISTS m2; DEFINE DATABASE IF NOT EXISTS pool; DEFINE TABLE IF NOT EXISTS acct SCHEMALESS;',
  )
})

afterEach(async () => {
  await setup.query('DELETE acct')
  warnings.length = 0
})

afterAll(async () => {
  await Promise.all(pools.map((pool) => pool.destroy()))
})

describe('plain queries', () => {
  test('rotate over every connection', async () => {
    const pool = await makePool({ size: 4 })
    const spy = vi.spyOn(Surreal.prototype, 'query')

    try {
      const results = await Promise.all(
        Array.from({ length: 12 }, (_, n) => pool.query<[number]>(`RETURN ${n}`)),
      )
      const perConnection = new Map<unknown, number>()

      for (const connection of spy.mock.contexts) {
        perConnection.set(connection, (perConnection.get(connection) ?? 0) + 1)
      }

      expect(results.flat()).toEqual(Array.from({ length: 12 }, (_, n) => n))
      expect([...perConnection.values()]).toEqual([3, 3, 3, 3])
    } finally {
      spy.mockRestore()
    }
  })

  test('are refused after destroy', async () => {
    const pool = await makePool()
    await pool.destroy()

    await expect(pool.query('RETURN 1')).rejects.toThrow('pool is closed')
  })
})

describe('transactions', () => {
  test('a commit persists every write of the transaction', async () => {
    const pool = await makePool()
    const id = await pool.begin()

    await write(pool, id, 1)
    await write(pool, id, 2)
    expect(await countRows(pool)).toBe(0)

    await pool.commit(id)

    expect(await countRows(pool)).toBe(2)
    expect(pool.sessions.size).toBe(0)
  })

  test('a rollback discards every write of the transaction', async () => {
    const pool = await makePool()
    const id = await pool.begin()

    await write(pool, id, 1)
    await pool.rollback(id)

    expect(await countRows(pool)).toBe(0)
    expect(pool.sessions.size).toBe(0)
  })

  test('a rollback of a transaction that is gone does nothing', async () => {
    const pool = await makePool()
    const id = await pool.begin()

    await write(pool, id, 1)
    await pool.commit(id)
    await pool.rollback(id)
    await pool.rollback('never-issued')

    expect(await countRows(pool)).toBe(1)
  })

  test('a commit of a transaction that is gone fails instead of reporting success', async () => {
    const pool = await makePool()
    const id = await pool.begin()
    await pool.commit(id)

    await expect(pool.commit(id)).rejects.toThrow('already committed or rolled back')
    await expect(pool.commit('never-issued')).rejects.toThrow(APIError)
    await expect(pool.commit('never-issued')).rejects.toThrow(
      'Transaction never-issued is not open',
    )
  })

  test('a transaction that had a failed query is cancelled instead of committed', async () => {
    const pool = await makePool()
    const id = await pool.begin()

    await write(pool, id, 1)
    // The server does not abort a transaction on a failed statement, so this alone would still commit
    await expect(pool.transaction(id).query('THROW "boom"')).rejects.toThrow('boom')

    await expect(pool.commit(id)).rejects.toThrow('rolled back instead of committed')

    expect(await countRows(pool)).toBe(0)
    expect(pool.sessions.size).toBe(0)
  })

  test('a commit waits for the queries still running', async () => {
    const pool = await makePool()
    const id = await pool.begin()

    // Committed while it runs, the server keeps only the rows written so far (about 50 of 3,000).
    const running = pool.transaction(id).query('FOR $i IN 0..3000 { CREATE acct SET n = $i }')
    await pool.commit(id)

    await expect(running).resolves.toBeDefined()
    expect(await countRows(pool)).toBe(3000)
  })

  test('a query issued while the commit waits joins the commit', async () => {
    const pool = await makePool()
    const id = await pool.begin()
    const executor = pool.transaction(id)

    const running = executor.query('FOR $i IN 0..3000 { CREATE acct SET n = $i }')
    const committing = pool.commit(id)
    // The commit removed the transaction from the registry, but its executor is still usable until the wait ends
    const late = executor.query('CREATE acct SET n = -1')

    await Promise.all([running, late, committing])

    expect(await countRows(pool)).toBe(3001)
  })

  test('a query on a finished transaction fails instead of reaching the server', async () => {
    const pool = await makePool()
    const id = await pool.begin()
    const executor = pool.transaction(id)

    await pool.commit(id)

    await expect(executor.query('CREATE acct SET n = 1')).rejects.toThrow(
      'already committed, rolled back or cancelled',
    )
    expect(() => pool.transaction(id)).toThrow('already committed or rolled back')
  })

  test('two transactions writing one row conflict, and the second commit is a 409', async () => {
    const pool = await makePool()
    await setup.query('CREATE acct:shared SET n = 0')

    const first = await pool.begin()
    const second = await pool.begin()

    await pool.transaction(first).query('UPDATE acct:shared SET n = 1')
    await pool.transaction(second).query('UPDATE acct:shared SET n = 2')
    await pool.commit(first)

    const error = await pool.commit(second).catch((caught: unknown) => caught)

    expect(error).toBeInstanceOf(APIError)
    expect(error).toHaveProperty('status', 409)
    const [rows] = await pool.query<[{ n: number }[]]>('SELECT n FROM acct:shared')
    expect(rows).toEqual([{ n: 1 }])
  })
})

describe('the transaction limit', () => {
  test('200 concurrent transactional writes all succeed with two connections', async () => {
    const pool = await makePool()

    await Promise.all(
      Array.from({ length: 200 }, async (_, n) => {
        const id = await pool.begin()
        await write(pool, id, n)
        await pool.commit(id)
      }),
    )

    expect(await countRows(pool)).toBe(200)
  })

  test('callers queue for a free slot instead of failing, and are served in order', async () => {
    // Room for 4 open transactions: two connections with one session each, two transactions per session.
    const pool = await makePool({
      transactions: { ...limits, maxPerSession: 2, sessionsPerConnection: 1 },
    })
    const open = await Promise.all(Array.from({ length: 4 }, () => pool.begin()))
    const served: number[] = []
    const waiting = [4, 5].map(async (n) => {
      const id = await pool.begin()
      served.push(n)
      return id
    })

    await new Promise((resolve) => setTimeout(resolve, 100))
    expect(served).toEqual([])

    await pool.commit(open[0] as string)
    await expect(waiting[0]).resolves.toEqual(expect.any(String))
    expect(served).toEqual([4])

    await pool.rollback(open[1] as string)
    await Promise.all(waiting)
    expect(served).toEqual([4, 5])
  })

  test('200 concurrent writes succeed when only 8 transactions fit at once', async () => {
    const pool = await makePool({
      transactions: { ...limits, maxPerSession: 4, sessionsPerConnection: 1 },
    })

    await Promise.all(
      Array.from({ length: 200 }, async (_, n) => {
        const id = await pool.begin()
        await write(pool, id, n)
        await pool.commit(id)
      }),
    )

    expect(await countRows(pool)).toBe(200)
  })

  test('a caller that waits too long gets a clear error', async () => {
    const pool = await makePool({
      transactions: {
        ...limits,
        acquireTimeoutMs: 100,
        maxPerSession: 1,
        sessionsPerConnection: 1,
      },
    })
    await Promise.all([pool.begin(), pool.begin()])

    const error = await pool.begin().catch((caught: unknown) => caught)

    expect(error).toBeInstanceOf(APIError)
    expect(error).toHaveProperty('status', 503)
    expect(error).toHaveProperty(
      'message',
      expect.stringContaining('No transaction slot became free within 100 ms'),
    )
  })

  test('a waiter that times out mid-queue leaves the others in order', async () => {
    const pool = await makePool({
      transactions: {
        ...limits,
        acquireTimeoutMs: 400,
        maxPerSession: 1,
        sessionsPerConnection: 1,
      },
    })
    const [first, second] = await Promise.all([pool.begin(), pool.begin()])
    const served: string[] = []
    const queue = (name: string) =>
      pool.begin().then(
        (id) => {
          served.push(name)
          return id
        },
        (error: unknown) => error,
      )
    const timedOut = queue('a')
    await new Promise((resolve) => setTimeout(resolve, 150))
    const b = queue('b')
    await new Promise((resolve) => setTimeout(resolve, 100))
    const c = queue('c')

    // `a` times out at 400 ms, before the slots are released
    await expect(timedOut).resolves.toHaveProperty('status', 503)
    await pool.commit(first as string)
    const bId = await b
    expect(served).toEqual(['b'])

    await pool.commit(bId as string)
    await pool.rollback(second as string)
    await c
    expect(served).toEqual(['b', 'c'])
  })

  test('a begin the server rejects gives its slot back', async () => {
    const pool = await makePool({
      size: 1,
      transactions: {
        ...limits,
        acquireTimeoutMs: 200,
        maxPerSession: 1,
        sessionsPerConnection: 1,
      },
    })
    const spy = vi
      .spyOn(SurrealSession.prototype, 'beginTransaction')
      .mockRejectedValueOnce(new Error('server said no'))

    try {
      await expect(pool.begin()).rejects.toThrow('server said no')

      // With a leaked slot this would queue and fail after 200 ms
      const id = await pool.begin()
      await pool.commit(id)
    } finally {
      spy.mockRestore()
    }
  })

  test('destroy rejects the callers that are still waiting', async () => {
    const pool = await makePool({
      transactions: { ...limits, maxPerSession: 1, sessionsPerConnection: 1 },
    })
    await Promise.all([pool.begin(), pool.begin()])
    const waiting = expect(pool.begin()).rejects.toThrow('pool was closed')

    await pool.destroy()

    await waiting
  })
})

describe('the reaper', () => {
  test('cancels an abandoned transaction and frees its slot', async () => {
    const pool = await makePool({
      transactions: {
        ...limits,
        acquireTimeoutMs: 1000,
        maxPerSession: 1,
        sessionsPerConnection: 1,
        timeoutMs: 200,
      },
    })
    const abandoned = await pool.begin()
    await write(pool, abandoned, 1)
    const other = await pool.begin()

    await vi.waitFor(() => expect(pool.sessions.size).toBe(0), { timeout: 3000 })

    await expect(pool.commit(abandoned)).rejects.toThrow('stayed open longer than')
    await expect(pool.commit(other)).rejects.toThrow('stayed open longer than')
    expect(await countRows(pool)).toBe(0)

    // Both slots are free again: with a leak this would wait for a slot and fail after 1 s
    const fresh = await pool.begin()
    await pool.commit(fresh)
  })

  test('frees exactly the capacity: all of it opens again and the next begin queues', async () => {
    const small: TransactionLimits = {
      acquireTimeoutMs: 150,
      maxPerSession: 2,
      sessionsPerConnection: 1,
      timeoutMs: 500,
    }
    const pool = await makePool({ transactions: small })
    await Promise.all(Array.from({ length: 4 }, () => pool.begin()))

    await vi.waitFor(() => expect(pool.sessions.size).toBe(0), { timeout: 3000 })

    const reopened = await Promise.all(Array.from({ length: 4 }, () => pool.begin()))
    expect(reopened).toHaveLength(4)
    // A slot released twice would leave room for a fifth
    await expect(pool.begin()).rejects.toThrow('No transaction slot became free')
  })

  test('still reports a lost transaction long after the reaper cancelled it', async () => {
    const pool = await makePool({ transactions: { ...limits, timeoutMs: 200 } })
    const abandoned = await pool.begin()
    await write(pool, abandoned, 1)

    await vi.waitFor(() => expect(pool.sessions.size).toBe(0), { timeout: 3000 })
    // Far past ten times the timeout, when the record used to be forgotten
    await new Promise((resolve) => setTimeout(resolve, 2600))

    await expect(pool.commit(abandoned)).rejects.toThrow('stayed open longer than')
    expect(await countRows(pool)).toBe(0)
  })

  test('a rollback consumes the lost record without error', async () => {
    const pool = await makePool({ transactions: { ...limits, timeoutMs: 200 } })
    const abandoned = await pool.begin()

    await vi.waitFor(() => expect(pool.sessions.size).toBe(0), { timeout: 3000 })
    await pool.rollback(abandoned)

    await expect(pool.commit(abandoned)).rejects.toThrow('is not open')
  })
})

describe('a dropped connection', () => {
  let proxy: Server
  const proxied = new Set<Socket>()

  beforeAll(async () => {
    const target = new URL(SURREAL_URL)

    proxy = createServer((client) => {
      const upstream = tcpConnect(Number(target.port), target.hostname)
      proxied.add(client)
      proxied.add(upstream)
      client.pipe(upstream)
      upstream.pipe(client)
      client.on('error', () => upstream.destroy())
      upstream.on('error', () => client.destroy())
      client.on('close', () => upstream.destroy())
      upstream.on('close', () => client.destroy())
    })
    await new Promise<void>((resolve) => proxy.listen(0, '127.0.0.1', resolve))
  })

  afterAll(() => {
    for (const socket of proxied) {
      socket.destroy()
    }
    proxy.close()
  })

  test('loses its transactions with a clear error and the pool keeps working', async () => {
    const { port } = proxy.address() as AddressInfo
    const pool = await makePool({
      client: { ...clientArgs, url: `ws://127.0.0.1:${port}/rpc` },
      transactions: { ...limits, maxPerSession: 1, sessionsPerConnection: 1 },
    })
    const ids = await Promise.all([pool.begin(), pool.begin()])
    await Promise.all(ids.map((id) => write(pool, id, 1)))

    for (const socket of proxied) {
      socket.destroy()
    }

    await vi.waitFor(() => expect(pool.sessions.size).toBe(0), { timeout: 5000 })

    for (const id of ids) {
      expect(() => pool.transaction(id)).toThrow('Transaction lost due to reconnect')
    }

    const commitError = await pool.commit(ids[0] as string).catch((caught: unknown) => caught)
    expect(commitError).toBeInstanceOf(APIError)
    expect(commitError).toHaveProperty('status', 503)
    expect(commitError).toHaveProperty(
      'message',
      expect.stringContaining('Transaction lost due to reconnect'),
    )
    expect(await countRows(setup)).toBe(0)

    // Every slot was freed, so a new transaction does not wait
    const fresh = await pool.begin()
    await write(pool, fresh, 7)
    await pool.commit(fresh)
    expect(await countRows(setup)).toBe(1)
  })
  const proxiedPool = async (maxPerSession: number) => {
    const { port } = proxy.address() as AddressInfo

    return makePool({
      client: { ...clientArgs, url: `ws://127.0.0.1:${port}/rpc` },
      size: 1,
      transactions: { ...limits, acquireTimeoutMs: 1500, maxPerSession, sessionsPerConnection: 1 },
    })
  }

  const dropConnection = () => {
    for (const socket of proxied) {
      socket.destroy()
    }
  }

  test('a commit cut off by the reconnect is reported as lost due to reconnect', async () => {
    const pool = await proxiedPool(1)
    const id = await pool.begin()
    await write(pool, id, 1)

    const entry = pool.sessions.get(id)
    expect(entry).toBeDefined()
    const { tx } = entry!
    const commit = tx.commit.bind(tx)
    // The connection drops right as the commit goes out, so it reaches the new connection for an unknown transaction
    vi.spyOn(tx, 'commit').mockImplementation(async () => {
      dropConnection()
      await vi.waitFor(() => pool.query('RETURN 1'), { timeout: 5000 })
      return commit()
    })

    const error = await pool.commit(id).catch((caught: unknown) => caught)

    expect(error).toBeInstanceOf(APIError)
    expect(error).toHaveProperty('status', 503)
    expect(error).toHaveProperty(
      'message',
      expect.stringContaining('Transaction lost due to reconnect'),
    )
    expect(await countRows(setup)).toBe(0)

    // Its slot was freed
    await pool.commit(await pool.begin())
  })

  test('a reconnect while the commit waits on a running query is reported as lost', async () => {
    const pool = await proxiedPool(1)
    const id = await pool.begin()
    const running = pool.transaction(id).query('SLEEP 3s; CREATE acct SET n = 1')
    const settled = running.catch((caught: unknown) => caught)
    const committing = pool.commit(id).catch((caught: unknown) => caught)

    await new Promise((resolve) => setTimeout(resolve, 200))
    dropConnection()

    expect(await settled).toBeInstanceOf(Error)
    const error = await committing

    expect(error).toBeInstanceOf(APIError)
    expect(error).toHaveProperty('status', 503)
    expect(error).toHaveProperty(
      'message',
      expect.stringContaining('Transaction lost due to reconnect'),
    )
    expect(await countRows(setup)).toBe(0)

    await pool.commit(await pool.begin())
  })

  test('after the eviction exactly the full capacity opens again and the next begin queues', async () => {
    const pool = await proxiedPool(3)
    await Promise.all(Array.from({ length: 3 }, () => pool.begin()))

    dropConnection()
    await vi.waitFor(() => expect(pool.sessions.size).toBe(0), { timeout: 5000 })

    await Promise.all(Array.from({ length: 3 }, () => pool.begin()))
    await expect(pool.begin()).rejects.toThrow('No transaction slot became free')
  })
})

describe('the HTTP engine', () => {
  test('has no transactions, but queries work', async () => {
    const pool = await makePool({
      client: { ...clientArgs, url: SURREAL_URL.replace('ws://', 'http://') },
    })

    expect(pool.supportsTransactions).toBe(false)
    await pool.query('CREATE acct SET n = 1')
    expect(await countRows(pool)).toBe(1)
  })
})

describe('transactions turned off', () => {
  test('fork no sessions', async () => {
    const pool = await makePool({ transactions: false })

    expect(pool.supportsTransactions).toBe(false)
  })
})
