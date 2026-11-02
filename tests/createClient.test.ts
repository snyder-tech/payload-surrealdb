import type { ConnectOptions } from 'surrealdb'

import { Surreal } from 'surrealdb'
import { afterEach, describe, expect, test, vi } from 'vitest'

import { createClient } from '../src/connection/createClient.js'

const args = {
  auth: { password: 'root', username: 'root' },
  database: 'unused',
  namespace: 'unused',
  requestTimeout: 1000,
  url: 'ws://127.0.0.1:1/rpc',
}

afterEach(() => {
  vi.restoreAllMocks()
})

describe('createClient', () => {
  test('reconnects without giving up and with a backoff', async () => {
    let seen: ConnectOptions | undefined
    vi.spyOn(Surreal.prototype, 'connect').mockImplementation((_url, options) => {
      seen = options
      return Promise.reject(new Error('connect failed'))
    })
    vi.spyOn(Surreal.prototype, 'close').mockResolvedValue(true)

    await expect(createClient(args)).rejects.toThrow('connect failed')

    expect(seen?.reconnect).toMatchObject({ attempts: -1, enabled: true })
    expect(seen?.reconnect).toHaveProperty('retryDelayMax')
  })

  test('a failing close does not hide the connect error', async () => {
    vi.spyOn(Surreal.prototype, 'connect').mockRejectedValue(new Error('connect failed'))
    vi.spyOn(Surreal.prototype, 'close').mockRejectedValue(new Error('close failed'))

    await expect(createClient(args)).rejects.toThrow('connect failed')
  })
})
