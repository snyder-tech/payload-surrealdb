import type { PayloadRequest } from 'payload'

import { ValidationError } from 'payload'
import { AlreadyExistsError, InternalError } from 'surrealdb'

import type { SurrealDBAdapter } from '../index.js'

// The message ends in the offending value, which can itself contain "with record", so only the name is read.
const UNIQUE_INDEX_MESSAGE = /^Database index `([^`]+)` already contains /

const stripLocaleFromPath = (adapter: SurrealDBAdapter, path: string): string => {
  const { localization } = adapter.payload.config
  const lastDot = path.lastIndexOf('.')

  if (!localization || lastDot === -1) {
    return path
  }

  return localization.localeCodes.includes(path.slice(lastDot + 1)) ? path.slice(0, lastDot) : path
}

/** The name of the unique index `error` says is violated, or undefined when it is not that error. */
export const uniqueIndexName = (error: unknown): string | undefined =>
  error instanceof InternalError ? UNIQUE_INDEX_MESSAGE.exec(error.message)?.[1] : undefined

/** The Payload path a unique violation is about, or null when `error` is not one. */
const uniqueViolationPath = (adapter: SurrealDBAdapter, error: unknown): null | string => {
  if (error instanceof AlreadyExistsError) {
    return 'id'
  }

  const indexName = uniqueIndexName(error)

  if (indexName === undefined) {
    return null
  }

  // An index that was not defined by this adapter has no known field, so the path stays empty.
  return stripLocaleFromPath(adapter, adapter.uniqueIndexPaths.get(indexName) ?? '')
}

/** Rethrows `error`, as a `ValidationError` on the field when it is a unique violation. */
export const handleError = ({
  adapter,
  collection,
  error,
  global,
  req,
}: {
  adapter: SurrealDBAdapter
  collection?: string | undefined
  error: unknown
  global?: string | undefined
  req?: Partial<PayloadRequest> | undefined
}): never => {
  const path = uniqueViolationPath(adapter, error)

  if (path === null) {
    throw error
  }

  throw new ValidationError(
    {
      ...(collection !== undefined && { collection }),
      errors: [
        {
          message: req?.t ? req.t('error:valueMustBeUnique') : 'Value must be unique',
          path,
        },
      ],
      ...(global !== undefined && { global }),
    },
    req?.t,
  )
}
