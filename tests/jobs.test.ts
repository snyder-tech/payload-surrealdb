import type { Job, Payload, TaskConfig, Where } from 'payload'

import { buildConfig, getPayload } from 'payload'
import { isRetryableConflict } from 'surrealdb'
import { afterAll, beforeAll, beforeEach, describe, expect, test, vi } from 'vitest'

import type { SurrealDBAdapter } from '../src/index.js'

import { connect } from '../src/connect.js'
import { init } from '../src/init.js'
import { surrealdbAdapter } from '../src/index.js'
import { beginTransaction, bootPayload, connectionArgs } from './helpers/payload.js'

const DATABASE = 'jobs'

type RecordTask = { input: { n: number }; output: Record<string, never> }

const recordTask: TaskConfig<RecordTask> = {
  slug: 'record',
  handler: async ({ input, req }) => {
    await req.payload.create({
      collection: 'runs',
      data: { n: input.n },
      overrideAccess: true,
      req,
    })

    return { output: {} }
  },
  inputSchema: [{ name: 'n', type: 'number', required: true }],
  outputSchema: [],
}

const config = buildConfig({
  collections: [
    { slug: 'users', auth: true, fields: [], versions: false },
    { slug: 'runs', fields: [{ name: 'n', type: 'number' }], versions: false },
  ],
  db: surrealdbAdapter(connectionArgs(DATABASE)),
  jobs: { deleteJobOnComplete: false, tasks: [recordTask] },
  secret: 'test-secret',
  telemetry: false,
  typescript: { autoGenerate: false },
})

let payload: Payload
let adapter: SurrealDBAdapter
const extraAdapters: SurrealDBAdapter[] = []

const future = () => new Date(Date.now() + 60 * 60_000).toISOString()

/** The condition `payload.jobs.run` uses to find a job that nobody holds. */
const claimable = (): Where => {
  const now = new Date().toISOString()

  return {
    and: [
      { completedAt: { exists: false } },
      { hasError: { not_equals: true } },
      {
        or: [{ processingUntil: { exists: false } }, { processingUntil: { less_than_equal: now } }],
      },
      { or: [{ waitUntil: { exists: false } }, { waitUntil: { less_than: now } }] },
    ],
  }
}

/** Another adapter instance of the same config, with its own connections to the same database. */
const openAdapter = async (): Promise<SurrealDBAdapter> => {
  const instance = surrealdbAdapter(connectionArgs(DATABASE)).init({ payload }) as SurrealDBAdapter

  init.call(instance)
  await connect.call(instance, { hotReload: true })
  extraAdapters.push(instance)

  return instance
}

const createJobs = async (count: number): Promise<string[]> => {
  const ids: string[] = []

  // Distinct creation times, so that the order the claims follow is the order of `n`.
  const start = Date.now()

  for (let n = 0; n < count; n++) {
    const job = await payload.db.create({
      collection: 'payload-jobs',
      data: {
        createdAt: new Date(start + n).toISOString(),
        input: { n },
        queue: 'default',
        taskSlug: 'record',
      },
    })

    ids.push(String(job['id']))
  }

  return ids
}

const allJobs = async () => {
  const { docs } = await payload.db.find<Job>({
    collection: 'payload-jobs',
    limit: 0,
    sort: 'createdAt',
  })

  return docs
}

type Claim = { ids: string[]; worker: number }

/** One worker: claims `limit` jobs at a time until nothing is left, the way `payload.jobs.run` does. */
const claimAll = async ({
  db,
  limit,
  worker,
  inTransaction = false,
}: {
  db: SurrealDBAdapter
  inTransaction?: boolean
  limit: number
  worker: number
}): Promise<Claim[]> => {
  const claims: Claim[] = []

  for (;;) {
    // Payload opens a transaction around every job update, which a claim then does not run in.
    const transactionID = inTransaction ? await db.beginTransaction() : null
    const docs = await db.updateJobs({
      data: {
        processingToken: `worker-${worker}`,
        processingUntil: future(),
        updatedAt: new Date().toISOString(),
      },
      limit,
      req: transactionID === null ? {} : { transactionID },
      sort: 'createdAt',
      where: claimable(),
    })

    if (transactionID !== null) {
      await db.commitTransaction(transactionID)
    }

    if (!docs?.length) {
      return claims
    }

    claims.push({ ids: docs.map((doc) => String(doc.id)), worker })
  }
}

const expectEachJobClaimedOnce = async (claims: Claim[], jobIDs: string[]) => {
  const claimed = claims.flatMap(({ ids }) => ids)

  expect(claimed).toHaveLength(jobIDs.length)
  expect(new Set(claimed).size).toBe(jobIDs.length)
  expect(claimed.toSorted()).toEqual(jobIDs.toSorted())

  // What the claimant was told matches what is stored: nobody else's token is on a job
  const owner = new Map(claims.flatMap(({ ids, worker }) => ids.map((id) => [id, worker])))

  for (const job of await allJobs()) {
    expect(job.processingToken).toBe(`worker-${owner.get(String(job.id))}`)
  }
}

beforeAll(async () => {
  payload = await bootPayload(config, DATABASE)
  adapter = payload.db as SurrealDBAdapter
})

beforeEach(async () => {
  await payload.db.deleteMany({ collection: 'payload-jobs', where: {} })
  await payload.db.deleteMany({ collection: 'runs', where: {} })
})

afterAll(async () => {
  await Promise.all(extraAdapters.map((instance) => instance.destroy?.()))
  await payload.destroy()
})

describe('claiming jobs', () => {
  test('3 adapter instances on separate connections claim 500 jobs with no double claim', async () => {
    const jobIDs = await createJobs(500)
    const workers = [adapter, await openAdapter(), await openAdapter(), await openAdapter()]

    expect(new Set(workers.map((worker) => worker.connection)).size).toBe(workers.length)

    const claims = (
      await Promise.all(workers.map((db, worker) => claimAll({ db, limit: 5, worker })))
    ).flat()

    await expectEachJobClaimedOnce(claims, jobIDs)
    // Every worker took part, or the test would prove nothing about contention
    expect(new Set(claims.map(({ worker }) => worker)).size).toBeGreaterThan(1)
  })

  test('without the retry, losing claims fail with a write conflict and the winners still never overlap', async () => {
    const jobIDs = await createJobs(300)
    const workers = [adapter, await openAdapter(), await openAdapter(), await openAdapter()]
    const spies = workers.map((db) => {
      const query = db.connection!.query.bind(db.connection)

      return vi
        .spyOn(db.connection!, 'query')
        .mockImplementation((sql, vars, options) => query(sql, vars, { ...options, retry: false }))
    })
    let conflicts = 0

    const claimed = new Set<string>()
    let duplicates = 0

    try {
      await Promise.all(
        workers.map(async (db, worker) => {
          for (let idle = 0; idle < 3;) {
            try {
              const docs = await db.updateJobs({
                data: { processingToken: `worker-${worker}`, processingUntil: future() },
                limit: 5,
                sort: 'createdAt',
                where: claimable(),
              })

              idle = docs?.length ? 0 : idle + 1

              for (const doc of docs ?? []) {
                duplicates += claimed.has(String(doc.id)) ? 1 : 0
                claimed.add(String(doc.id))
              }
            } catch (error) {
              if (!isRetryableConflict(error)) {
                throw error
              }

              conflicts++
            }
          }
        }),
      )
    } finally {
      spies.forEach((spy) => spy.mockRestore())
    }

    // Four workers going for the same first jobs do conflict, which is what the retry is for
    expect(conflicts).toBeGreaterThan(0)
    expect(duplicates).toBe(0)
    expect(claimed.size).toBe(jobIDs.length)
  })

  test('parallel claims on one adapter instance never overlap', async () => {
    const jobIDs = await createJobs(200)
    const claims = (
      await Promise.all(
        Array.from({ length: 6 }, (_, worker) => claimAll({ db: adapter, limit: 3, worker })),
      )
    ).flat()

    await expectEachJobClaimedOnce(claims, jobIDs)
  })

  test('claims one by one across instances', async () => {
    const jobIDs = await createJobs(60)
    const workers = [adapter, await openAdapter(), await openAdapter()]
    const claims = (
      await Promise.all(workers.map((db, worker) => claimAll({ db, limit: 1, worker })))
    ).flat()

    await expectEachJobClaimedOnce(claims, jobIDs)
  })

  test('claims made the way Payload makes them, inside a transaction each, never overlap', async () => {
    const jobIDs = await createJobs(150)
    const workers = [adapter, await openAdapter(), await openAdapter()]
    const claims = (
      await Promise.all(
        workers.map((db, worker) => claimAll({ db, inTransaction: true, limit: 4, worker })),
      )
    ).flat()

    await expectEachJobClaimedOnce(claims, jobIDs)
  })

  test('a claim is not undone by rolling back the transaction it was given', async () => {
    const [id] = await createJobs(1)
    const transactionID = await beginTransaction(payload)

    const docs = await adapter.updateJobs({
      data: { processingToken: 'held', processingUntil: future() },
      limit: 1,
      req: { transactionID },
      sort: 'createdAt',
      where: claimable(),
    })
    await adapter.rollbackTransaction(transactionID)

    expect(docs?.map((doc) => String(doc.id))).toEqual([id])
    const [job] = await allJobs()
    expect(job?.processingToken).toBe('held')
  })

  test('claims in the order of the sort', async () => {
    await createJobs(6)
    const docs = await adapter.updateJobs({
      data: { processingToken: 'a', processingUntil: future() },
      limit: 4,
      sort: '-createdAt',
      where: claimable(),
    })

    expect(docs?.map((doc) => (doc.input as { n: number }).n)).toEqual([5, 4, 3, 2])
    expect((await allJobs()).filter((job) => job.processingToken === 'a')).toHaveLength(4)
  })

  test('skips jobs that are held, and takes them back once the claim has expired', async () => {
    const [held, expired, free] = await createJobs(3)

    for (const [id, processingUntil] of [
      [held, future()],
      [expired, new Date(Date.now() - 1000).toISOString()],
    ] as const) {
      await adapter.updateJobs({
        data: { processingToken: `old-${id}`, processingUntil },
        id: id ?? '',
        returning: false,
      })
    }

    const docs = await adapter.updateJobs({
      data: { processingToken: 'new', processingUntil: future() },
      limit: 10,
      sort: 'createdAt',
      where: claimable(),
    })

    expect(docs?.map((doc) => String(doc.id))).toEqual([expired, free])
    expect(docs?.map((doc) => doc.processingToken)).toEqual(['new', 'new'])

    const afterwards = await adapter.updateJobs({
      data: { processingToken: 'again', processingUntil: future() },
      limit: 10,
      sort: 'createdAt',
      where: claimable(),
    })

    expect(afterwards).toEqual([])
    expect((await allJobs()).find((job) => String(job.id) === held)?.processingToken).toBe(
      `old-${held}`,
    )
  })

  test('a job waiting until later is not claimed before then', async () => {
    const [waiting, ready] = await createJobs(2)

    await adapter.updateJobs({
      data: { waitUntil: future() },
      id: waiting ?? '',
      returning: false,
    })

    const docs = await adapter.updateJobs({
      data: { processingToken: 'x', processingUntil: future() },
      limit: 10,
      sort: 'createdAt',
      where: claimable(),
    })

    expect(docs?.map((doc) => String(doc.id))).toEqual([ready])
  })
})

const logEntry = (message: string) => ({
  completedAt: new Date().toISOString(),
  executedAt: new Date().toISOString(),
  state: 'succeeded',
  taskID: message,
  taskSlug: 'record',
})

describe('updating jobs', () => {
  test('by id, returning the job or nothing', async () => {
    const [id] = await createJobs(1)

    const [updated] = (await adapter.updateJobs({ data: { totalTried: 2 }, id: id ?? '' })) ?? []
    expect(updated).toMatchObject({ id, totalTried: 2 })

    expect(
      await adapter.updateJobs({ data: { totalTried: 3 }, id: id ?? '', returning: false }),
    ).toBeNull()
    expect((await allJobs())[0]?.totalTried).toBe(3)

    expect(await adapter.updateJobs({ data: { totalTried: 4 }, id: 'missing' })).toEqual([])
  })

  test('every job that matches, when there is no limit', async () => {
    await createJobs(5)
    const docs = await adapter.updateJobs({
      data: { hasError: true },
      sort: 'createdAt',
      where: { 'input.n': { less_than: 3 } },
    })

    expect(docs).toHaveLength(3)
    expect((await allJobs()).filter((job) => job.hasError)).toHaveLength(3)
  })

  test('appends to the log, and does not write an empty one', async () => {
    const [id] = await createJobs(1)

    await adapter.updateJobs({ data: { log: { $push: logEntry('one') } }, id: id ?? '' })
    await adapter.updateJobs({ data: { log: { $push: logEntry('two') } }, id: id ?? '' })
    await adapter.updateJobs({ data: { log: [], totalTried: 1 }, id: id ?? '' })

    const [job] = await allJobs()
    expect(job?.log?.map((each) => each.taskID)).toEqual(['one', 'two'])
    expect(job?.totalTried).toBe(1)
  })

  test('releasing a claim clears it', async () => {
    const [id] = await createJobs(1)

    await adapter.updateJobs({
      data: { processingToken: 'held', processingUntil: future() },
      id: id ?? '',
    })
    await adapter.updateJobs({
      data: { processingToken: null, processingUntil: null },
      id: id ?? '',
    })

    const [job] = await allJobs()
    expect(job?.processingUntil ?? null).toBeNull()
    expect(job?.processingToken ?? null).toBeNull()
  })

  test('a condition on another collection is answered in the same unit', async () => {
    await createJobs(3)
    const docs = await adapter.updateJobs({
      data: { totalTried: 7 },
      limit: 2,
      sort: 'createdAt',
      where: { taskSlug: { in: ['record'] } },
    })

    expect(docs).toHaveLength(2)
  })
})

describe('on a large queue', () => {
  const ROWS = 20_000
  const CALLS = 20
  /**
   * A call that reads the whole table costs about 3 ms per 1,000 rows on top of its own work, so
   * 60 ms or more here; one that reads only the jobs it touches costs a few. The limits are means
   * over many calls, and only a return to reading the table can reach them. A claim has to
   * filter and sort the whole queue to find its first jobs, which is about 55 ms here and 270 ms
   * when the update also reads the table, so its limit sits between the two.
   */
  const TOUCHED_LIMIT_MS = 30
  const CLAIM_LIMIT_MS = 150

  const mean = async (run: (index: number) => Promise<unknown>): Promise<number> => {
    const start = performance.now()

    for (let index = 0; index < CALLS; index++) {
      await run(index)
    }

    return (performance.now() - start) / CALLS
  }

  test('updates by id, heartbeats and claims do not read the whole table', async () => {
    const seeded = await adapter.connection?.query(`
      FOR $i IN 0..${ROWS} {
        CREATE \`payload-jobs\`:ulid() SET
          createdAt = time::now(),
          input = { n: $i },
          queue = 'default',
          taskSlug = 'record',
          updatedAt = time::now();
      };
    `)

    if (!seeded) {
      throw new Error('The adapter is not connected.')
    }

    const { docs } = await adapter.find<Job>({
      collection: 'payload-jobs',
      limit: CALLS * 5,
      sort: 'createdAt',
    })
    const ids = docs.map((doc) => String(doc.id))

    expect(await adapter.count({ collection: 'payload-jobs' })).toEqual({ totalDocs: ROWS })

    const byId = await mean((index) =>
      adapter.updateJobs({ data: { totalTried: index }, id: ids[index] ?? '' }),
    )
    // Payload's own per-job updates ask for a limit of one next to the `id` condition
    const byWhere = await mean((index) =>
      adapter.updateJobs({
        data: { totalTried: index },
        limit: 1,
        where: { id: { equals: ids[index] } },
      }),
    )
    const heartbeat = await mean((index) =>
      adapter.updateJobs({
        data: { updatedAt: new Date().toISOString() },
        returning: false,
        where: { id: { in: ids.slice(index * 5, index * 5 + 5) } },
      }),
    )
    const claim = await mean(() =>
      adapter.updateJobs({
        data: { processingToken: 'big', processingUntil: future() },
        limit: 5,
        sort: 'createdAt',
        where: claimable(),
      }),
    )

    expect(byId).toBeLessThan(TOUCHED_LIMIT_MS)
    expect(byWhere).toBeLessThan(TOUCHED_LIMIT_MS)
    expect(heartbeat).toBeLessThan(TOUCHED_LIMIT_MS)
    expect(claim).toBeLessThan(CLAIM_LIMIT_MS)
    expect(
      (
        await adapter.count({
          collection: 'payload-jobs',
          where: { processingToken: { equals: 'big' } },
        })
      ).totalDocs,
    ).toBe(CALLS * 5)
  }, 120_000)
})

const runs = async () => {
  const { docs } = await payload.db.find<{ n: number }>({
    collection: 'runs',
    limit: 0,
    sort: 'n',
  })

  return docs.map(({ n }) => n)
}

const queue = async (count: number) => {
  for (let n = 0; n < count; n++) {
    await payload.jobs.queue({ input: { n }, overrideAccess: true, task: 'record' })
  }
}

describe('running jobs through Payload', () => {
  test('queued jobs run once and are marked complete', async () => {
    await queue(12)
    const result = await payload.jobs.run({ limit: 100, overrideAccess: true })

    expect(result.jobStatus).toBeDefined()
    expect(await runs()).toEqual(Array.from({ length: 12 }, (_, n) => n))

    const jobs = await allJobs()
    expect(jobs).toHaveLength(12)

    for (const job of jobs) {
      expect(job.completedAt).toBeTruthy()
      expect(job.hasError).toBeFalsy()
      expect(job.totalTried).toBe(1)
    }

    // A second run finds nothing more to do
    await payload.jobs.run({ limit: 100, overrideAccess: true })
    expect(await runs()).toHaveLength(12)
  })

  test('concurrent runs on one instance run every job once', async () => {
    await queue(40)
    await Promise.all(
      Array.from({ length: 4 }, () => payload.jobs.run({ limit: 7, overrideAccess: true })),
    )
    // Jobs a worker could not take are picked up by one more run
    await payload.jobs.run({ limit: 100, overrideAccess: true })

    expect(await runs()).toEqual(Array.from({ length: 40 }, (_, n) => n))
  })

  test('a second Payload instance, with its own connections, runs jobs alongside the first', async () => {
    await queue(60)

    process.env['PAYLOAD_DROP_DATABASE'] = 'false'
    const second = await getPayload({ config, cron: false, key: 'jobs-second' })

    try {
      await Promise.all([
        payload.jobs.run({ limit: 8, overrideAccess: true }),
        second.jobs.run({ limit: 8, overrideAccess: true }),
        payload.jobs.run({ limit: 8, overrideAccess: true }),
        second.jobs.run({ limit: 8, overrideAccess: true }),
      ])
      await payload.jobs.run({ limit: 100, overrideAccess: true })

      expect(await runs()).toEqual(Array.from({ length: 60 }, (_, n) => n))
    } finally {
      await second.destroy()
      process.env['PAYLOAD_DROP_DATABASE'] = 'true'
    }
  })

  test('a job whose claim has expired is run again', async () => {
    await queue(1)
    const [job] = await allJobs()

    await adapter.updateJobs({
      data: {
        processingToken: 'dead-worker',
        processingUntil: new Date(Date.now() - 1000).toISOString(),
      },
      id: String(job?.id),
    })
    await payload.jobs.run({ limit: 10, overrideAccess: true })

    expect(await runs()).toEqual([0])
  })
})
