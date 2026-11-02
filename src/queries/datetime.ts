/**
 * SurrealDB 3.3.2-3.3.5 mishandles an indexed datetime when whole-second and fractional-second
 * values mix: a range comparison on it drops rows (`u >= 15s` misses 15.5s), and an index-ordered
 * scan puts a whole second after the fractions of that same second. A function over the column
 * keeps the planner off that index, so every datetime comparison and sort goes through here.
 * Equality, `IN` and `!=` were checked against a scan and are not affected.
 */

/** Compares two datetime expressions as nanoseconds. Neither may be NONE or NULL: guard the column first. */
export const dateCompare = (left: string, symbol: '<' | '<=' | '>' | '>=', right: string): string =>
  `time::nano(${left}) ${symbol} time::nano(${right})`

/**
 * What a datetime column sorts by. A missing value stays as it is, because `time::nano` throws on
 * NONE and NULL, and both sort below every number as they do below every datetime.
 */
export const dateSortKey = (idiom: string): string =>
  `(IF type::is_datetime(${idiom}) { time::nano(${idiom}) } ELSE { ${idiom} })`
