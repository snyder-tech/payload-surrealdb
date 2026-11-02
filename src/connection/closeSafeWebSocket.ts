/**
 * Node's built-in WebSocket does not abort a handshake when `close()` is called while CONNECTING:
 * it reports the socket closed, then completes the upgrade and holds the server connection until
 * the process exits. The SDK closes mid-handshake whenever a connect times out, so every timeout
 * leaks one server connection. Defer that close until the handshake settles, and hide the late
 * `open` from the SDK, which has already torn its session down.
 */
export const closeSafeWebSocket = (Base: typeof WebSocket): typeof WebSocket =>
  class CloseSafeWebSocket extends Base {
    // Initialized by a field rather than a constructor so the class keeps every runtime
    // constructor overload; the guard still registers before the SDK attaches its listeners.
    #closeRequested: boolean = this.#guardLateOpen()

    #guardLateOpen(): false {
      this.addEventListener('open', (event) => {
        if (!this.#closeRequested) {
          return
        }

        event.stopImmediatePropagation()
        super.close()
      })

      return false
    }

    override close(code?: number, reason?: string): void {
      if (this.readyState === Base.CONNECTING) {
        this.#closeRequested = true
        return
      }

      super.close(code, reason)
    }
  }

/** Bun aborts a CONNECTING socket on `close()`, so it keeps the runtime implementation. */
export const sdkWebSocketImpl = (): typeof WebSocket =>
  'bun' in process.versions ? globalThis.WebSocket : closeSafeWebSocket(globalThis.WebSocket)
