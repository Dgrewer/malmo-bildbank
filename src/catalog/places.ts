// Bildens plats i Malmö: stadsområde, delområde och torg eller park, uträknade
// från GPS-positionen mot Malmö stads områden (src/places/malmo-areas.json, se
// scripts/make-places.ts).

export interface Gps {
  latitude: number
  longitude: number
}

export interface Place {
  // Stadsområde, t.ex. Norr.
  district: string
  // Delområde, t.ex. Gamla Staden. null om positionen inte ligger i något.
  subdistrict: string | null
  // Torg, park eller annan namngiven plats, t.ex. Stortorget. Saknas eller null
  // om bilden inte är tagen vid någon.
  name?: string | null
}

interface Area {
  name: string
  code: string
  rings: number[][]
  // För ett delområde eller en namngiven plats: stadsområdet det ligger i.
  district?: string
  // För en namngiven plats: delområdet, och sorten, t.ex. Torg eller Park.
  subdistrict?: string | null
  kind?: string
}

export interface Areas {
  districts: Area[]
  subdistricts: Area[]
  named: Area[]
}

// En bild tagen så här nära ett torg eller en park räknas som tagen där.
export const NEAR_METERS = 30

// En GPS-position ur EXIF, eller null om den saknas eller är orimlig.
export function gpsFrom(latitude: unknown, longitude: unknown): Gps | null {
  if (typeof latitude !== 'number' || typeof longitude !== 'number') return null
  if (!Number.isFinite(latitude) || !Number.isFinite(longitude)) return null
  if (Math.abs(latitude) > 90 || Math.abs(longitude) > 180 || (latitude === 0 && longitude === 0)) return null
  return { latitude: Math.round(latitude * 1e6) / 1e6, longitude: Math.round(longitude * 1e6) / 1e6 }
}

// Jämn-udda-regeln över alla ringar, så att hål och områden i flera delar blir rätt.
function inside(area: Area, x: number, y: number): boolean {
  let hit = false
  for (const ring of area.rings) {
    for (let i = 0, j = ring.length - 2; i < ring.length; j = i, i += 2) {
      const [xi, yi, xj, yj] = [ring[i], ring[i + 1], ring[j], ring[j + 1]]
      if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) hit = !hit
    }
  }
  return hit
}

// Meter per grad i Malmö. Räcker för avstånd på några hundra meter.
const METERS_PER_LAT = 111_320
const metersPerLon = (latitude: number) => METERS_PER_LAT * Math.cos((latitude * Math.PI) / 180)

// Kortaste avståndet i meter från punkten till områdets kant.
function distance(area: Area, x: number, y: number): number {
  const kx = metersPerLon(y)
  let best = Infinity
  for (const ring of area.rings) {
    for (let i = 2; i < ring.length; i += 2) {
      const [ax, ay, bx, by] = [(ring[i - 2] - x) * kx, (ring[i - 1] - y) * METERS_PER_LAT, (ring[i] - x) * kx, (ring[i + 1] - y) * METERS_PER_LAT]
      const [dx, dy] = [bx - ax, by - ay]
      const t = dx || dy ? Math.max(0, Math.min(1, -(ax * dx + ay * dy) / (dx * dx + dy * dy))) : 0
      best = Math.min(best, Math.hypot(ax + t * dx, ay + t * dy))
    }
  }
  return best
}

// Områdets yttre gränser och ungefärliga storlek, uträknade en gång.
const bounds = new WeakMap<Area, { minX: number; maxX: number; minY: number; maxY: number; size: number }>()
function boundsOf(area: Area) {
  let box = bounds.get(area)
  if (!box) {
    box = { minX: Infinity, maxX: -Infinity, minY: Infinity, maxY: -Infinity, size: 0 }
    for (const ring of area.rings) {
      for (let i = 0; i < ring.length; i += 2) {
        box.minX = Math.min(box.minX, ring[i])
        box.maxX = Math.max(box.maxX, ring[i])
        box.minY = Math.min(box.minY, ring[i + 1])
        box.maxY = Math.max(box.maxY, ring[i + 1])
      }
    }
    box.size = (box.maxX - box.minX) * (box.maxY - box.minY)
    bounds.set(area, box)
  }
  return box
}

// Torget eller parken där bilden är tagen: den minsta som positionen ligger i,
// annars den närmaste inom NEAR_METERS.
function namedAt(named: Area[], x: number, y: number): Area | null {
  const marginX = NEAR_METERS / metersPerLon(y)
  const marginY = NEAR_METERS / METERS_PER_LAT
  let within: Area | null = null
  let nearest: { area: Area; meters: number } | null = null
  for (const area of named) {
    const box = boundsOf(area)
    if (x < box.minX - marginX || x > box.maxX + marginX || y < box.minY - marginY || y > box.maxY + marginY) continue
    if (inside(area, x, y)) {
      if (!within || box.size < boundsOf(within).size) within = area
    } else if (!within) {
      const meters = distance(area, x, y)
      if (meters <= NEAR_METERS && (!nearest || meters < nearest.meters)) nearest = { area, meters }
    }
  }
  return within ?? nearest?.area ?? null
}

export function placeAt(gps: Gps | null | undefined, areas: Areas): Place | null {
  if (!gps) return null
  const { longitude: x, latitude: y } = gps
  const district = areas.districts.find((area) => inside(area, x, y))
  if (!district) return null
  return {
    district: district.name,
    subdistrict: areas.subdistricts.find((area) => inside(area, x, y))?.name ?? null,
    name: namedAt(areas.named, x, y)?.name ?? null,
  }
}

// Platsen med hjälp av bildens taggar, t.ex. Malmö rådhus som anger Stortorget.
// GPS går före: en bild utan plats får taggens plats, och en bild med GPS i
// samma delområde men utan torg eller park får platsens namn.
export function placeWithTags(place: Place | null, fromTags: Place[]): Place | null {
  if (!fromTags.length) return place
  if (!place) return fromTags[0]
  if (place.name) return place
  const same = fromTags.find((tagPlace) => tagPlace.subdistrict && tagPlace.subdistrict === place.subdistrict)
  return same ? { ...place, name: same.name } : place
}

// Platsens delar från den minsta till den största, t.ex. Stortorget, Gamla Staden, Norr.
// En park som heter som sitt delområde, t.ex. Pildammsparken, står en gång.
export function placeParts(place: Place): string[] {
  return [...new Set([place.name, place.subdistrict, place.district].filter((part): part is string => !!part))]
}
