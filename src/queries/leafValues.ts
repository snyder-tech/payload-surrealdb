import type { PathAnalysis } from './analyzePath.js'

/**
 * Every non-null leaf reachable through nested arrays, which is how Mongo reads a path such as
 * `{ 'a.b.c': v }`: it matches at any depth. SurrealQL has no such traversal, and the inside of a
 * json value has no config to say how deep the arrays go, so a recursive function does the walk.
 * It is defined once per database when the adapter connects.
 */
export const DEFINE_PVALS = `DEFINE FUNCTION OVERWRITE fn::pvals($v: any) -> array {
  IF type::is_array($v) { RETURN array::flatten($v.map(|$x| fn::pvals($x))) }
  ELSE IF $v = NONE OR $v = NULL { RETURN [] }
  ELSE { RETURN [$v] }
};`

/** A list of the leaf values of `idiom`, or undefined when `analysis` says the path holds one value. */
export const leafValues = ({
  analysis,
  idiom,
  isList,
}: {
  analysis: PathAnalysis
  idiom: string
  /** The field the path ends on holds a list, such as a hasMany field. */
  isList: boolean
}): string | undefined => {
  if (analysis.inJson) {
    return `fn::pvals(${idiom})`
  }

  // A path through `n` arrays yields `n` levels of lists. When the shape is known from the config,
  // one flatten per extra level does what `fn::pvals` does, without calling a function per row.
  const levels = analysis.arrayLevels + (isList ? 1 : 0)

  if (levels === 0) {
    return undefined
  }

  let values = `(${idiom} ?? [])`

  for (let level = 1; level < levels; level++) {
    values = `array::flatten(${values})`
  }

  return values
}
