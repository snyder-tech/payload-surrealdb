import type { Payload, PayloadRequest } from 'payload'

import { APIError, buildConfig, commitTransaction, initTransaction, killTransaction } from 'payload'
import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'vitest'

import { surrealdbAdapter } from '../src/index.js'
import { beginTransaction, bootPayload, connectionArgs, SURREAL_URL } from './helpers/payload.js'

const collection = 'accounts'

const fields = [
  { name: 'title', type: 'text' },
  { name: 'balance', type: 'number' },
] as const

// Payload 4 turns `versions` on for every collection; these tests do not use versions, so they are off.
const config = buildConfig({
  collections: [
    { slug: 'users', auth: true, fields: [], versions: false },
    {
      slug: collection,
      fields: [...fields],
      hooks: {
        afterChange: [
          ({ doc }: { doc: { title?: string } }) => {
            if (doc.title === 'boom') {
              throw new Error('afterChange failed')
            }
          },
        ],
      },
      versions: false,
    },
  ],
  db: surrealdbAdapter(connectionArgs('transactions')),
  secret: 'test-secret',
  telemetry: false,
  typescript: { autoGenerate: false },
})

let payload: Payload

const begin = () => beginTransaction(payload)

const request = (
  transactionID: NonNullable<PayloadRequest['transactionID']>,
): Partial<PayloadRequest> => ({ transactionID })

const titles = async (req?: Partial<PayloadRequest>) => {
  const { docs } = await payload.db.find<{ title: string }>({
    collection,
    limit: 0,
    sort: 'title',
    ...(req && { req }),
  })

  return docs.map((doc) => doc.title)
}

const createAccount = (title: string, req?: Partial<PayloadRequest>, balance = 0) =>
  payload.db.create({ collection, data: { balance, title }, ...(req && { req }) })

beforeAll(async () => {
  payload = await bootPayload(config, 'transactions')
})

beforeEach(async () => {
  await payload.db.deleteMany({ collection, where: {} })
})

afterAll(async () => {
  await payload.destroy()
})

describe('adapter calls in one transaction', () => {
  test('a commit persists every call, and none of them is visible before it', async () => {
    const id = await begin()
    const req = request(id)

    await createAccount('first', req)
    await createAccount('second', req)

    expect(await titles(req)).toEqual(['first', 'second'])
    expect(await titles()).toEqual([])

    await payload.db.commitTransaction(id)

    expect(await titles()).toEqual(['first', 'second'])
  })

  test('a rollback discards every call', async () => {
    const id = await begin()
    const req = request(id)

    await createAccount('first', req)
    await createAccount('second', req)
    await payload.db.rollbackTransaction(id)

    expect(await titles()).toEqual([])
  })

  test('update, upsert and delete take part in the transaction', async () => {
    await createAccount('kept')
    await createAccount('removed')
    const id = await begin()
    const req = request(id)

    await payload.db.updateOne({
      collection,
      data: { balance: 5 },
      req,
      where: { title: { equals: 'kept' } },
    })
    await payload.db.upsert({
      collection,
      data: { title: 'upserted' },
      req,
      where: { title: { equals: 'upserted' } },
    })
    await payload.db.deleteOne({ collection, req, where: { title: { equals: 'removed' } } })

    expect(await titles()).toEqual(['kept', 'removed'])
    await payload.db.rollbackTransaction(id)
    expect(await titles()).toEqual(['kept', 'removed'])

    const again = await begin()
    await payload.db.upsert({
      collection,
      data: { title: 'upserted' },
      req: request(again),
      where: { title: { equals: 'upserted' } },
    })
    await payload.db.commitTransaction(again)
    expect(await titles()).toEqual(['kept', 'removed', 'upserted'])
  })

  test('an ID that is not a string or number runs outside any transaction', async () => {
    // Payload's dataloader copies `transactionID` through JSON, which leaves `{}`
    const req = request({} as NonNullable<PayloadRequest['transactionID']>)

    await createAccount('plain', req)

    expect(await titles()).toEqual(['plain'])
  })

  test('an ID that was already committed fails instead of running outside the transaction', async () => {
    const id = await begin()
    await payload.db.commitTransaction(id)

    await expect(createAccount('late', request(id))).rejects.toThrow(APIError)
    expect(await titles()).toEqual([])
  })

  test('rolling back twice, or committing with no ID, does nothing', async () => {
    const id = await begin()
    await createAccount('once', request(id))

    await payload.db.commitTransaction(id)
    await payload.db.rollbackTransaction(id)
    await payload.db.rollbackTransaction(id)
    await payload.db.commitTransaction('')

    expect(await titles()).toEqual(['once'])
  })

  test('committing an ID that is already gone fails instead of reporting success', async () => {
    const id = await begin()
    await payload.db.commitTransaction(id)

    await expect(payload.db.commitTransaction(id)).rejects.toThrow(APIError)
    await expect(payload.db.commitTransaction('never-issued')).rejects.toThrow('is not open')
  })
})

describe('through Payload', () => {
  test('a hook that throws after a write leaves nothing behind', async () => {
    await expect(
      payload.create({ collection, data: { title: 'boom' }, overrideAccess: true }),
    ).rejects.toThrow('afterChange failed')

    expect(await titles()).toEqual([])
  })

  test('a failure rolls back the writes that came before it on the same request', async () => {
    const req = { payload } as PayloadRequest
    await initTransaction(req)

    const first = await payload.create({
      collection,
      data: { title: 'first' },
      overrideAccess: true,
      req,
    })

    await payload
      .create({ collection, data: { title: 'boom' }, overrideAccess: true, req })
      .catch(() => undefined)

    expect(req.transactionID).toBeFalsy()
    // Nothing is left to commit, and the first write is gone too
    await commitTransaction(req)
    expect(await titles()).toEqual([])
    await expect(
      payload.findByID({ id: first.id, collection, overrideAccess: true }),
    ).rejects.toThrow('Not Found')
  })

  test('operations that share a request commit together', async () => {
    const req = { payload } as PayloadRequest
    await initTransaction(req)

    await payload.create({ collection, data: { title: 'one' }, overrideAccess: true, req })
    await payload.create({ collection, data: { title: 'two' }, overrideAccess: true, req })
    expect(await titles()).toEqual([])

    await commitTransaction(req)
    expect(await titles()).toEqual(['one', 'two'])
  })

  test('killing a transaction twice is harmless', async () => {
    const req = { payload } as PayloadRequest
    await initTransaction(req)
    await payload.create({ collection, data: { title: 'gone' }, overrideAccess: true, req })

    const { transactionID } = req
    await killTransaction(req)
    await payload.db.rollbackTransaction(transactionID!)

    expect(await titles()).toEqual([])
  })
})

describe('errors', () => {
  test('a failed query makes the commit cancel instead, so nothing is half persisted', async () => {
    const id = await begin()
    const req = request(id)

    await createAccount('written', req)
    // The server does not abort the transaction on a failed statement. The caller swallows the
    // error, as a hook that tolerates a failing write would, and goes on to commit.
    await payload.db
      .create({ collection, customID: 'dup', data: { title: 'dup-1' }, req })
      .then(() => payload.db.create({ collection, customID: 'dup', data: { title: 'dup-2' }, req }))
      .catch(() => undefined)

    await expect(payload.db.commitTransaction(id)).rejects.toThrow(
      'rolled back instead of committed',
    )

    expect(await titles()).toEqual([])
  })

  test('two transactions writing the same row: the second commit is a 409', async () => {
    const { id: rowID } = await createAccount('shared', undefined, 0)
    const first = await begin()
    const second = await begin()

    for (const [transactionID, balance] of [
      [first, 1],
      [second, 2],
    ] as const) {
      await payload.db.updateOne({
        id: rowID,
        collection,
        data: { balance },
        req: request(transactionID),
      })
    }

    await payload.db.commitTransaction(first)
    const error = await payload.db.commitTransaction(second).catch((caught: unknown) => caught)

    expect(error).toBeInstanceOf(APIError)
    expect(error).toHaveProperty('status', 409)
    const { docs } = await payload.db.find<{ balance: number }>({ collection, limit: 0 })
    expect(docs.map((doc) => doc.balance)).toEqual([1])
  })
})

describe('the transaction limit', () => {
  test('200 concurrent transactional writes with two connections all succeed', async () => {
    await Promise.all(
      Array.from({ length: 200 }, async (_, n) => {
        const id = await begin()
        await createAccount(`concurrent-${n}`, request(id))
        await payload.db.commitTransaction(id)
      }),
    )

    const { totalDocs } = await payload.db.count({ collection })
    expect(totalDocs).toBe(200)
  })
})

const expectNoTransactions = async (
  key: string,
  overrides: Parameters<typeof surrealdbAdapter>[0],
) => {
  const instance = await bootPayload(
    buildConfig({
      collections: [
        { slug: 'users', auth: true, fields: [], versions: false },
        { slug: collection, fields: [...fields], versions: false },
      ],
      db: surrealdbAdapter(overrides),
      secret: 'test-secret',
      telemetry: false,
      typescript: { autoGenerate: false },
    }),
    key,
  )

  // Payload then runs the operation without a transaction
  expect(await instance.db.beginTransaction()).toBeNull()
  const doc = await instance.db.create({ collection, data: { title: 'plain' } })
  const { docs } = await instance.db.find({ collection, limit: 0 })

  expect(docs.map((each) => each.id)).toEqual([doc.id])
  await instance.destroy()
}

describe('where transactions are not available', () => {
  test('over HTTP beginTransaction returns null and CRUD still works', async () => {
    await expectNoTransactions('http', {
      ...connectionArgs('transactions-http'),
      url: SURREAL_URL.replace('ws://', 'http://'),
    })
  })

  test('with transactionOptions: false beginTransaction returns null', async () => {
    await expectNoTransactions('off', {
      ...connectionArgs('transactions-off'),
      transactionOptions: false,
    })
  })
})
