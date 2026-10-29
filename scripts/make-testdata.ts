// Skapar testdata/app-data/ från testdata/original/<fotograf>/:
//
//   index.json             ett indexformat enligt docs/index-format.md
//   thumbs/<id>.webp       miniatyrer, längsta sidan 400 px
//   previews/<id>.webp     förhandsbilder, längsta sidan 1600 px
//
//   npm run make-testdata              skapar bara det som saknas eller är äldre än originalet
//   npm run make-testdata -- --force   skapar om alla bilder
//
// Id:n behålls för sökvägar som redan finns i index.json, så att taggningar
// som pekar på ett id fortsätter att gälla.
//
// Villkor, rättighetsdatum, samtycke och spärr finns inte i bildfilerna. Skriptet
// fyller i varierade testvärden så att varningarna i appen kan testas.

import fs from 'node:fs/promises'
import path from 'node:path'
import exifr from 'exifr'
import sharp from 'sharp'
import {
  formatId,
  INDEX_VERSION,
  normalizePath,
  previewPath,
  thumbPath,
  type Consent,
  type ImageRecord,
  type IndexFile,
} from '../src/catalog/types.ts'

const ROOT = path.resolve(import.meta.dirname, '..', 'testdata')
const THUMB_SIZE = 400
const PREVIEW_SIZE = 1600
const CONCURRENCY = 4
const force = process.argv.includes('--force')

// Format som sharp kan läsa. RAW (cr2, cr3, nef, arw, dng) och HEIC/HEIF
// stöds inte av sharps förbyggda paket och hoppas över med en varning.
const READABLE = new Set(['.jpg', '.jpeg', '.png', '.webp', '.gif', '.tif', '.tiff'])

async function findDirectory(parent: string, name: string): Promise<string> {
  const entries = await fs.readdir(parent, { withFileTypes: true })
  const match = entries.find((entry) => entry.isDirectory() && entry.name.toLowerCase() === name)
  if (!match) throw new Error(`Hittar inte ${path.join(parent, name)}`)
  return path.join(parent, match.name)
}

interface Source {
  file: string
  path: string
  photographer: string
}

async function findSources(originalDir: string): Promise<Source[]> {
  const sources: Source[] = []
  for (const photographerDir of await fs.readdir(originalDir, { withFileTypes: true })) {
    if (!photographerDir.isDirectory()) continue
    const photographer = photographerDir.name.normalize('NFC')
    const dir = path.join(originalDir, photographerDir.name)
    for (const entry of await fs.readdir(dir, { withFileTypes: true })) {
      if (!entry.isFile()) continue
      if (!READABLE.has(path.extname(entry.name).toLowerCase())) {
        console.warn(`  Hoppar över ${photographer}/${entry.name}: formatet kan inte läsas`)
        continue
      }
      sources.push({
        file: path.join(dir, entry.name),
        path: normalizePath(`original/${photographer}/${entry.name}`),
        photographer,
      })
    }
  }
  return sources.sort((a, b) => a.path.localeCompare(b.path, 'sv'))
}

async function readIndex(file: string): Promise<IndexFile | null> {
  try {
    return JSON.parse(await fs.readFile(file, 'utf8'))
  } catch {
    return null
  }
}

async function isUpToDate(output: string, sourceTime: number): Promise<boolean> {
  if (force) return false
  try {
    return (await fs.stat(output)).mtimeMs >= sourceTime
  } catch {
    return false
  }
}

async function writeWebp(source: Buffer, output: string, size: number, quality: number) {
  await sharp(source)
    .rotate()
    .resize({ width: size, height: size, fit: 'inside', withoutEnlargement: true })
    .webp({ quality })
    .toFile(output)
}

// "2016:09:13 14:05:00" -> "2016-09-13T14:05:00". EXIF saknar tidszon, så
// tiden lagras som lokal tid utan zon.
function exifDate(value: unknown): string | null {
  if (typeof value !== 'string') return null
  const match = value.match(/^(\d{4}):(\d{2}):(\d{2})[ T](\d{2}):(\d{2}):(\d{2})/)
  return match ? `${match[1]}-${match[2]}-${match[3]}T${match[4]}:${match[5]}:${match[6]}` : null
}

// IPTC-text är ofta UTF-8 utan att filen säger det, och exifr läser den då som
// Latin-1 ("MalmÃ¶"). Avkoda om, men bara om resultatet är giltig UTF-8.
function fixEncoding(value: string): string {
  if (!/[Â-ô][\u0080-¿]/.test(value)) return value
  const decoded = Buffer.from(value, 'latin1').toString('utf8')
  return decoded.includes('�') ? value : decoded
}

// Texter som kameror och program skriver in automatiskt och som inte beskriver bilden.
const CAMERA_DEFAULTS = /^(default|OLYMPUS DIGITAL CAMERA|SONY DSC|DCIM[\\/].*|[\w-]+\.jpe?g)$/i

function text(value: unknown): string {
  if (typeof value === 'string') {
    const cleaned = fixEncoding(value).replace(/\r\n?/g, '\n').trim()
    return CAMERA_DEFAULTS.test(cleaned) ? '' : cleaned
  }
  if (value && typeof value === 'object' && 'value' in value) return text(value.value)
  return ''
}

function list(value: unknown): string[] {
  const values = Array.isArray(value) ? value : value ? [value] : []
  return [...new Set(values.map(text).filter(Boolean))]
}

const TEST_TERMS = [
  'Fri användning i Malmö stads egna kanaler. Fotografens namn ska anges.',
  'Endast redaktionell användning. Får inte användas i annonser.',
  'Får användas i trycksaker och på webben under avtalstiden.',
]
const TEST_CONSENT: Consent[] = ['given', 'not-required', 'missing', 'given']

// Testvärden som varierar med bildens plats i listan, så att alla varningar förekommer.
function testRights(n: number) {
  return {
    terms: TEST_TERMS[n % TEST_TERMS.length],
    rightsUntil: [`2024-12-31`, null, '2028-06-30', '2030-12-31', '2027-03-31'][n % 5],
    consent: TEST_CONSENT[n % TEST_CONSENT.length],
    blocked: n % 10 === 3,
  }
}

async function makeRecord(source: Source, id: string, n: number): Promise<ImageRecord> {
  const sourceTime = (await fs.stat(source.file)).mtimeMs
  const outputs: [string, number, number][] = [
    [path.join(ROOT, thumbPath(id)), THUMB_SIZE, 75],
    [path.join(ROOT, previewPath(id)), PREVIEW_SIZE, 82],
  ]
  // Filen läses en gång. exifr lämnar annars filhandtag öppna, vilket är ett fel i Node 26.
  const data = await fs.readFile(source.file)
  for (const [output, size, quality] of outputs) {
    if (!(await isUpToDate(output, sourceTime))) await writeWebp(data, output, size, quality)
  }

  const meta = await sharp(data).metadata()
  const rotated = (meta.orientation ?? 1) >= 5
  const tags = await exifr
    .parse(data, { iptc: true, xmp: true, reviveValues: false, mergeOutput: true })
    .catch(() => null)

  return {
    id,
    path: source.path,
    photographer: source.photographer,
    byline: text(tags?.Byline) || text(tags?.Artist) || text(tags?.creator) || `Foto: ${source.photographer}`,
    ...testRights(n),
    width: (rotated ? meta.height : meta.width) ?? 0,
    height: (rotated ? meta.width : meta.height) ?? 0,
    takenAt: exifDate(tags?.DateTimeOriginal) ?? exifDate(tags?.CreateDate),
    tags: list(tags?.Keywords ?? tags?.subject),
    description: text(tags?.Caption) || text(tags?.ImageDescription) || text(tags?.description),
  }
}

async function main() {
  const originalDir = await findDirectory(ROOT, 'original')
  const appData = path.join(ROOT, 'app-data')
  const indexFile = path.join(appData, 'index.json')
  await fs.mkdir(path.join(appData, 'thumbs'), { recursive: true })
  await fs.mkdir(path.join(appData, 'previews'), { recursive: true })

  const previous = await readIndex(indexFile)
  const ids = new Map(previous?.images.map((image) => [image.path, image.id]))
  let nextId = Math.max(0, ...[...ids.values()].map((id) => Number(id.slice(3)))) + 1

  const sources = await findSources(originalDir)
  console.log(`Hittade ${sources.length} bilder i ${path.relative(process.cwd(), originalDir)}`)
  const jobs = sources.map((source) => ({ source, id: ids.get(source.path) ?? formatId(nextId++) }))

  const images: ImageRecord[] = new Array(jobs.length)
  let done = 0
  async function worker(queue: number[]) {
    for (let n = queue.shift(); n !== undefined; n = queue.shift()) {
      images[n] = await makeRecord(jobs[n].source, jobs[n].id, n)
      process.stdout.write(`\r  ${++done}/${jobs.length}`)
    }
  }
  const queue = jobs.map((_, n) => n)
  await Promise.all(Array.from({ length: CONCURRENCY }, () => worker(queue)))

  const index: IndexFile = { version: INDEX_VERSION, generatedAt: new Date().toISOString(), images }
  await fs.writeFile(indexFile, JSON.stringify(index, null, 2) + '\n')
  console.log(`\nSkrev ${path.relative(process.cwd(), indexFile)} med ${images.length} bilder`)
}

await main()
