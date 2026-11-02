import { APIError, createArrayFromCommaDelineated } from 'payload'
import { Geometry, GeometryPoint } from 'surrealdb'

/** The distances are in metres. Either bound can be missing, but a `near` value always has a point. */
export type NearValue = {
  max?: number | undefined
  min?: number | undefined
  point: GeometryPoint
}

export const isNearValue = (value: unknown): value is NearValue =>
  typeof value === 'object' &&
  value !== null &&
  'point' in value &&
  value.point instanceof GeometryPoint

/**
 * The shapes the SDK's `Geometry.fromJSON` accepts. It checks nothing itself: an unknown `type` or
 * a ring of strings still gives a value, which then silently matches nothing.
 */
type GeoJson = Parameters<typeof Geometry.fromJSON>[0]
type Coordinates<T extends Exclude<GeoJson['type'], 'GeometryCollection'>> = Extract<
  GeoJson,
  { type: T }
>['coordinates']

const isPosition = (value: unknown): value is Coordinates<'Point'> =>
  Array.isArray(value) &&
  value.length === 2 &&
  value.every((each) => typeof each === 'number' && Number.isFinite(each))

const isLine = (value: unknown): value is Coordinates<'LineString'> =>
  Array.isArray(value) && value.length >= 2 && value.every(isPosition)

const isPolygon = (value: unknown): value is Coordinates<'Polygon'> =>
  Array.isArray(value) && value.length >= 1 && value.every(isLine)

const isMultiPoint = (value: unknown): value is Coordinates<'MultiPoint'> =>
  Array.isArray(value) && value.length >= 1 && value.every(isPosition)

const isMultiLine = (value: unknown): value is Coordinates<'MultiLineString'> =>
  Array.isArray(value) && value.length >= 1 && value.every(isLine)

const isMultiPolygon = (value: unknown): value is Coordinates<'MultiPolygon'> =>
  Array.isArray(value) && value.length >= 1 && value.every(isPolygon)

/** Coordinates nest at most four deep, in a MultiPolygon: polygons, rings, positions, numbers. */
const MAX_COORDINATE_DEPTH = 4

/**
 * A query string carries every number as text, which Mongoose cast for Mongo. Anything nested deeper
 * than a MultiPolygon is left as it is, for the shape check to reject, so that hostile input costs no recursion.
 */
const numbersFromText = (value: unknown, depth = 1): unknown => {
  if (Array.isArray(value)) {
    return depth > MAX_COORDINATE_DEPTH
      ? value
      : value.map((each) => numbersFromText(each, depth + 1))
  }

  return typeof value === 'string' && value.trim() !== '' ? Number(value) : value
}

const toGeoJson = (type: unknown, coordinates: unknown): GeoJson | undefined => {
  switch (type) {
    case 'LineString':
      return isLine(coordinates) ? { type, coordinates } : undefined
    case 'MultiLineString':
      return isMultiLine(coordinates) ? { type, coordinates } : undefined
    case 'MultiPoint':
      return isMultiPoint(coordinates) ? { type, coordinates } : undefined
    case 'MultiPolygon':
      return isMultiPolygon(coordinates) ? { type, coordinates } : undefined
    case 'Point':
      return isPosition(coordinates) ? { type, coordinates } : undefined
    case 'Polygon':
      return isPolygon(coordinates) ? { type, coordinates } : undefined
    default:
      return undefined
  }
}

/**
 * The geometry a `within` or `intersects` query is made against, from the GeoJSON in the query.
 * SurrealDB compares geometry values only: a plain object makes `INSIDE` return false silently.
 */
export const parseGeometry = (operator: 'intersects' | 'within', value: unknown): Geometry => {
  const geoJson =
    typeof value === 'object' && value !== null && 'type' in value && 'coordinates' in value
      ? toGeoJson(value.type, numbersFromText(value.coordinates))
      : undefined

  if (!geoJson) {
    throw new APIError(
      `The "${operator}" operator needs a GeoJSON geometry with numeric coordinates.`,
      400,
    )
  }

  return Geometry.fromJSON(geoJson)
}

// `geo::distance` measures on a sphere of this radius (the mean Earth radius), Mongo's 2dsphere on the equatorial one.
const SURREAL_EARTH_RADIUS = 6_371_008.8
const MONGO_EARTH_RADIUS = 6_378_100

/** SQL for the distance in metres between two points, as Mongo measures it, so that `maxDistance` and `minDistance` cut at the same place. */
export const mongoDistance = (from: string, to: string): string =>
  `geo::distance(${from}, ${to}) * ${MONGO_EARTH_RADIUS / SURREAL_EARTH_RADIUS}`

// Mongo ignores a distance that is 0, empty or not a number, and so does this.
const toDistance = (value: unknown): number | undefined =>
  value && !Number.isNaN(Number(value)) ? Number(value) : undefined

/**
 * `near` as Payload sends it: `[lng, lat, maxDistance, minDistance]` or the same as one comma
 * separated string. Returns undefined, so that the condition is dropped as Mongo does, when there
 * is no point or no distance at all.
 */
export const parseNear = (value: unknown): NearValue | undefined => {
  const parts = Array.isArray(value)
    ? value
    : typeof value === 'string'
      ? createArrayFromCommaDelineated(value)
      : []
  const [lng, lat, maxDistance, minDistance] = parts

  if (lng == null || lat == null || (maxDistance == null && minDistance == null)) {
    return undefined
  }

  const coordinates = [parseFloat(String(lng)), parseFloat(String(lat))]

  if (!isPosition(coordinates)) {
    throw new APIError('The "near" operator needs a numeric longitude and latitude.', 400)
  }

  return {
    max: toDistance(maxDistance),
    min: toDistance(minDistance),
    point: new GeometryPoint(coordinates),
  }
}
