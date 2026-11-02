import type { Destroy } from 'payload'

import type { SurrealDBAdapter } from './index.js'

export const destroy: Destroy = async function destroy(this: SurrealDBAdapter) {
  await this.connection?.destroy()
  this.connection = undefined
}
