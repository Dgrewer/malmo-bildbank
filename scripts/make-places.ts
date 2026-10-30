// Gör om Malmö stads öppna data (CC0) till src/places/malmo-areas.json, som
// följer med appen. Kör när områdena har ändrats:
//   node scripts/make-places.ts <stadsomraden_4326.geojson> <delomraden_epsg4326.json> <park_torg.geojson>
// Filerna hämtas från https://opendata-api.malmo.se, datamängderna
// "Stadsområden" (GeoJSON 4326), "Delområden" (TopoJSON 4326) och
// "Parker och Torg" (GeoJSON 4326).
import fs from 'node:fs'
import { placeAt } from '../src/catalog/places.ts'

type Ring = number[][]
interface Area {
  name: string
  code: string
  // Alla ringar i området, även hål, som [lon, lat, lon, lat, …].
  rings: number[][]
  // För ett delområde eller en namngiven plats: stadsområdet det ligger i.
  district?: string
  // För en namngiven plats: delområdet och sorten, t.ex. Torg eller Park.
  subdistrict?: string | null
  kind?: string
}

// "VÄSTRA HAMNEN" -> "Västra Hamnen"
function title(name: string): string {
  return name.toLocaleLowerCase('sv').replace(/(^|[\s-])(\p{L})/gu, (_, before, letter) => before + letter.toLocaleUpperCase('sv'))
}

// Avrundat till ungefär en meter, vilket räcker för att avgöra området. Punkter
// som då hamnar på samma ställe tas bort.
function flat(ring: Ring): number[] {
  const out: number[] = []
  for (const [lon, lat] of ring) {
    const [x, y] = [Math.round(lon * 1e5) / 1e5, Math.round(lat * 1e5) / 1e5]
    if (out.length && out[out.length - 2] === x && out[out.length - 1] === y) continue
    out.push(x, y)
  }
  return out
}

function ringsOf(geometry: { type: string; coordinates: unknown }): Ring[] {
  if (geometry.type === 'Polygon') return geometry.coordinates as Ring[]
  if (geometry.type === 'MultiPolygon') return (geometry.coordinates as Ring[][]).flat()
  throw new Error(`Okänd geometri: ${geometry.type}`)
}

const [districtFile, subdistrictFile, parkFile] = process.argv.slice(2)
if (!districtFile || !subdistrictFile || !parkFile) {
  throw new Error('Ange stadsområden (GeoJSON), delområden (TopoJSON) och parker och torg (GeoJSON).')
}

const geojson = JSON.parse(fs.readFileSync(districtFile, 'utf8'))
const districts: Area[] = geojson.features.map((feature: { properties: Record<string, string>; geometry: never }) => ({
  name: title(feature.properties.sof_namn),
  code: feature.properties.sof_kod,
  rings: ringsOf(feature.geometry).map(flat),
}))

// TopoJSON: bågarna är delta-kodade heltal som räknas om med transform. En
// ring är en lista med bågar, där ~i betyder båge i baklänges.
const topo = JSON.parse(fs.readFileSync(subdistrictFile, 'utf8'))
const [[sx, sy], [tx, ty]] = [topo.transform.scale, topo.transform.translate]
const arcs: Ring[] = topo.arcs.map((arc: number[][]) => {
  let [x, y] = [0, 0]
  return arc.map(([dx, dy]) => {
    x += dx
    y += dy
    return [x * sx + tx, y * sy + ty]
  })
})
function ring(indexes: number[]): Ring {
  const points: Ring = []
  for (const index of indexes) {
    const arc = index < 0 ? [...arcs[~index]].reverse() : arcs[index]
    points.push(...(points.length ? arc.slice(1) : arc))
  }
  return points
}
const collection = Object.values(topo.objects)[0] as {
  geometries: { type: string; arcs: number[][] | number[][][]; properties: Record<string, string | number> }[]
}
const subdistricts: Area[] = collection.geometries.map((geometry) => ({
  name: title(String(geometry.properties.delomr)),
  code: String(geometry.properties.do_kod),
  rings: (geometry.type === 'Polygon' ? (geometry.arcs as number[][]) : (geometry.arcs as number[][][]).flat()).map(
    (indexes) => flat(ring(indexes)),
  ),
}))

// Området som de flesta av ytans hörn ligger i.
function mostOf(area: Area, pick: (longitude: number, latitude: number) => string | null | undefined): string | null {
  const votes = new Map<string, number>()
  for (const ring of area.rings) {
    for (let i = 0; i < ring.length; i += 2) {
      const name = pick(ring[i], ring[i + 1])
      if (name) votes.set(name, (votes.get(name) ?? 0) + 1)
    }
  }
  return [...votes].sort((a, b) => b[1] - a[1])[0]?.[0] ?? null
}

for (const subdistrict of subdistricts) {
  const at = (longitude: number, latitude: number) => placeAt({ longitude, latitude }, { districts, subdistricts: [], named: [] })
  subdistrict.district = mostOf(subdistrict, (longitude, latitude) => at(longitude, latitude)?.district) ?? ''
  if (!subdistrict.district) console.warn(`${subdistrict.name} ligger inte i något stadsområde`)
}

// Parker och torg med namn. Ytor med samma namn och sort blir en plats, t.ex.
// Pildammsparken som består av tre ytor.
const parks = JSON.parse(fs.readFileSync(parkFile, 'utf8'))
const byName = new Map<string, Area>()
for (const feature of parks.features as { properties: Record<string, string>; geometry: never }[]) {
  const name = feature.properties.Namn?.trim()
  if (!name || !feature.geometry) continue
  const kind = feature.properties.Detaljplan_kategori || 'Plats'
  const key = `${name}\n${kind}`
  const place = byName.get(key) ?? { name, code: String(feature.properties.ObjectID), kind, rings: [] }
  place.rings.push(...ringsOf(feature.geometry).map(flat))
  byName.set(key, place)
}
const named = [...byName.values()]
for (const place of named) {
  const at = (longitude: number, latitude: number) => placeAt({ longitude, latitude }, { districts, subdistricts, named: [] })
  place.district = mostOf(place, (longitude, latitude) => at(longitude, latitude)?.district) ?? ''
  place.subdistrict = mostOf(place, (longitude, latitude) => at(longitude, latitude)?.subdistrict)
}

const out = {
  source: 'Malmö stad, öppna data (CC0): Stadsområden och Delområden, https://opendata-api.malmo.se',
  districts,
  subdistricts,
  named: named.filter((place) => place.district),
}
fs.mkdirSync('src/places', { recursive: true })
fs.writeFileSync('src/places/malmo-areas.json', JSON.stringify(out))
console.log(`${districts.length} stadsområden, ${subdistricts.length} delområden, ${out.named.length} parker och torg, ${fs.statSync('src/places/malmo-areas.json').size} byte`)
