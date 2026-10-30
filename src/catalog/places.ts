// Bildens plats i Malmö: stadsområde och delområde, uträknade från GPS-positionen
// mot Malmö stads områden (src/places/malmo-areas.json, se scripts/make-places.ts).

export interface Gps {
  latitude: number
  longitude: number
}

export interface Place {
  // Stadsområde, t.ex. Innerstaden.
  district: string
  // Delområde, t.ex. Davidshall. null om positionen inte ligger i något.
  subdistrict: string | null
}

interface Area {
  name: string
  code: string
  rings: number[][]
}

export interface Areas {
  districts: Area[]
  subdistricts: Area[]
}

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

export function placeAt(gps: Gps | null | undefined, areas: Areas): Place | null {
  if (!gps) return null
  const { longitude: x, latitude: y } = gps
  const district = areas.districts.find((area) => inside(area, x, y))
  if (!district) return null
  return { district: district.name, subdistrict: areas.subdistricts.find((area) => inside(area, x, y))?.name ?? null }
}
