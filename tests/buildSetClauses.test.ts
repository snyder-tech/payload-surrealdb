import { describe, expect, test } from 'vitest'

import { ParamBag } from '../src/queries/sql.js'
import { buildSetClauses } from '../src/utilities/buildSetClauses.js'
import { createAtomicOperations } from '../src/utilities/transform.js'

describe('buildSetClauses', () => {
  test('does not write a container that only an atomic operation emptied', () => {
    const atomic = createAtomicOperations()
    atomic.$inc['meta.score'] = 4
    atomic.$inc['a.b.n'] = 1
    const params = new ParamBag()

    const sets = buildSetClauses({
      atomic,
      params,
      row: { a: { b: undefined }, meta: undefined, title: 'kept' },
    })

    expect(sets).toEqual(['`title` = $p0', '`meta`.`score` += $p1', '`a`.`b`.`n` += $p2'])
  })

  test('still clears a field that no atomic operation touches', () => {
    const sets = buildSetClauses({
      atomic: createAtomicOperations(),
      params: new ParamBag(),
      row: { meta: undefined },
    })

    expect(sets).toEqual(['`meta` = NONE'])
  })

  test('still writes a date next to an atomic operation on another key', () => {
    const atomic = createAtomicOperations()
    atomic.$inc['meta.score'] = 1
    const params = new ParamBag()

    buildSetClauses({ atomic, params, row: { when: new Date(0) } })

    expect(params.vars['p0']).toEqual(new Date(0))
  })
})
