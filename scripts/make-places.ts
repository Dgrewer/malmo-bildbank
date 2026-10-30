// Gör om Malmö stads öppna data (CC0) till src/places/malmo-areas.json, som
// följer med appen. Kör när områdena har ändrats:
//   node scripts/make-places.ts <stadsomraden_4326.geojson> <delomraden_epsg4326.json>
// Filerna hämtas från https://opendata-api.malmo.se, datamängderna
// "Stadsområden" (GeoJSON 4326) och "Delområden" (TopoJSON 4326).
import fs from 'node:fs'

type Ring = number[][]
interface Area {
  name: string
  code: string
  // Alla ringar i området, även hål, som [lon, lat, lon, lat, …].
  rings: number[][]
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

const [districtFile, subdistrictFile] = process.argv.slice(2)
if (!districtFile || !subdistrictFile) throw new Error('Ange stadsområden (GeoJSON) och delområden (TopoJSON).')

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

const out = {
  source: 'Malmö stad, öppna data (CC0): Stadsområden och Delområden, https://opendata-api.malmo.se',
  districts,
  subdistricts,
}
fs.mkdirSync('src/places', { recursive: true })
fs.writeFileSync('src/places/malmo-areas.json', JSON.stringify(out))
console.log(`${districts.length} stadsområden, ${subdistricts.length} delområden, ${fs.statSync('src/places/malmo-areas.json').size} byte`)
