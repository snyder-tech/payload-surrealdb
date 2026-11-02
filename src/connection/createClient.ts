import type { ConnectOptions } from 'surrealdb'

import { Surreal } from 'surrealdb'

import { sdkWebSocketImpl } from './closeSafeWebSocket.js'

export type ClientArgs = {
  auth: NonNullable<ConnectOptions['authentication']>
  database: string
  namespace: string
  /** Without a timeout the SDK waits forever on a query the server never answers. */
  requestTimeout: number
  url: string
}

const MIN_SERVER_VERSION = [3, 3, 0] as const

const assertSupportedServer = async (client: Surreal): Promise<void> => {
  const { version } = await client.version()
  const match = /(\d+)\.(\d+)\.(\d+)/.exec(version)

  if (!match) {
    throw new Error(`Cannot read the SurrealDB server version from "${version}".`)
  }

  const [major = 0, minor = 0, patch = 0] = match.slice(1).map(Number)
  const [minMajor, minMinor, minPatch] = MIN_SERVER_VERSION
  const supported =
    major !== minMajor
      ? major > minMajor
      : minor !== minMinor
        ? minor > minMinor
        : patch >= minPatch

  if (!supported) {
    throw new Error(
      `SurrealDB ${MIN_SERVER_VERSION.join('.')} or newer is required, but the server reports "${version}".`,
    )
  }
}

const LOOPBACK_HOSTS = new Set(['127.0.0.1', '::1', '[::1]', 'localhost'])

/**
 * Opens one connection. Dates are decoded to native `Date` (nanoseconds are lost, Payload only
 * needs milliseconds). `SurrealPool` opens several of these.
 */
export const createClient = async ({
  auth,
  database,
  namespace,
  requestTimeout,
  url,
}: ClientArgs): Promise<Surreal> => {
  const { hostname, protocol } = new URL(url)
  const client = new Surreal({
    codecOptions: { useNativeDates: true },
    // Only a WebSocket engine has a handshake to leak; the HTTP engine never opens one.
    ...(protocol === 'ws:' || protocol === 'wss:' ? { websocketImpl: sdkWebSocketImpl() } : {}),
  })

  try {
    await client.connect(url, {
      authentication: auth,
      database,
      namespace,
      // The SDK closes the socket when a ping is unanswered for 10 s, and a loopback server busy
      // with one long query answers late. A loopback socket cannot drop silently, so it needs no
      // keepalive.
      ...(LOOPBACK_HOSTS.has(hostname) ? { pingInterval: 0 } : {}),
      // The SDK gives up after 5 attempts and then the one shared client stays dead.
      reconnect: { attempts: -1, enabled: true, retryDelay: 100, retryDelayMax: 10_000 },
      requestTimeout,
    })
    await assertSupportedServer(client)
  } catch (error) {
    // Closing a client that never connected can throw too, and that must not hide `error`
    await client.close().catch(() => false)
    throw error
  }

  return client
}
