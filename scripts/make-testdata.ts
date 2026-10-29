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
// Format:
// - JPG (även .jfif), PNG, TIFF, WebP, AVIF och GIF läses med sharp.
// - HEIC/HEIF avkodas med heic-decode.
// - RAW (cr2, cr3, nef, arw, dng) avkodas inte. En JPG med samma namn i samma
//   mapp blir förhandsbild, och paret blir en bild med RAW-filen som original
//   och JPG:en i alternates. Utan JPG används den största JPG som är inbäddad i
//   RAW-filen. Finns ingen av dem hoppas filen över med en varning.
// - Video (mp4, mov, m4v) spelas inte upp. ffmpeg (ffmpeg-static) tar ut en
//   bildruta som blir miniatyr och förhandsbild, och läser längd och inspelningstid.
//
// Villkor, rättighetsdatum, samtycke och spärr finns inte i bildfilerna. Skriptet
// fyller i varierade testvärden så att varningarna i appen kan testas.

import { execFile } from 'node:child_process'
import { existsSync } from 'node:fs'
import fs from 'node:fs/promises'
import path from 'node:path'
import { promisify } from 'node:util'
import exifr from 'exifr'
import ffmpegPath from 'ffmpeg-static'
import heicDecode from 'heic-decode'
import sharp, { type Sharp } from 'sharp'
import { extension, HEIC_EXTENSIONS, RAW_EXTENSIONS, VIDEO_EXTENSIONS } from '../src/catalog/fileFormat.ts'
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

const SHARP_EXTENSIONS = new Set(['jpg', 'jpeg', 'jfif', 'png', 'webp', 'avif', 'gif', 'tif', 'tiff'])
// JPG föredras som förhandsbild till en RAW-fil, i den här ordningen.
const RAW_COMPANIONS = ['jpg', 'jpeg', 'jfif', 'tif', 'tiff', 'png', 'heic', 'heif']
// Systemfiler hoppas över utan varning.
const SYSTEM_FILES = new Set(['desktop.ini', 'thumbs.db', '.ds_store'])

async function findDirectory(parent: string, name: string): Promise<string> {
  const entries = await fs.readdir(parent, { withFileTypes: true })
  const match = entries.find((entry) => entry.isDirectory() && entry.name.toLowerCase() === name)
  if (!match) throw new Error(`Hittar inte ${path.join(parent, name)}`)
  return path.join(parent, match.name)
}

interface SourceFile {
  file: string
  path: string
}

interface Source extends SourceFile {
  photographer: string
  // Andra filer av samma bild, t.ex. JPG:en till en RAW-fil.
  alternates: SourceFile[]
}

function baseName(name: string): string {
  return name.slice(0, name.length - path.extname(name).length).normalize('NFC').toLowerCase()
}

async function findSources(originalDir: string): Promise<Source[]> {
  const sources: Source[] = []
  for (const photographerDir of await fs.readdir(originalDir, { withFileTypes: true })) {
    if (!photographerDir.isDirectory()) continue
    const photographer = photographerDir.name.normalize('NFC')
    const dir = path.join(originalDir, photographerDir.name)
    const names = (await fs.readdir(dir, { withFileTypes: true })).filter((e) => e.isFile()).map((e) => e.name)
    const toSource = (name: string): SourceFile => ({
      file: path.join(dir, name),
      path: normalizePath(`original/${photographer}/${name}`),
    })

    const companions = new Map<string, string>()
    for (const name of names) {
      if (!RAW_EXTENSIONS.has(extension(name))) continue
      const companion = names
        .filter((other) => baseName(other) === baseName(name) && RAW_COMPANIONS.includes(extension(other)))
        .sort((a, b) => RAW_COMPANIONS.indexOf(extension(a)) - RAW_COMPANIONS.indexOf(extension(b)))[0]
      if (companion) companions.set(name, companion)
    }
    const paired = new Set(companions.values())

    for (const name of names) {
      if (paired.has(name) || SYSTEM_FILES.has(name.toLowerCase())) continue
      const ext = extension(name)
      const known = [SHARP_EXTENSIONS, HEIC_EXTENSIONS, RAW_EXTENSIONS, VIDEO_EXTENSIONS].some((set) => set.has(ext))
      if (!known) {
        console.warn(`  Hoppar över ${photographer}/${name}: inte en bildfil som stöds`)
        continue
      }
      const companion = companions.get(name)
      sources.push({ ...toSource(name), photographer, alternates: companion ? [toSource(companion)] : [] })
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

// En avkodad bild: image() ger en ny sharp-pipeline, redan roterad rätt.
interface Decoded {
  image: () => Sharp
  width: number
  height: number
}

const ROTATION: Record<number, number> = { 3: 180, 6: 90, 8: 270 }

async function decodeWithSharp(data: Buffer, orientation?: number): Promise<Decoded> {
  const meta = await sharp(data).metadata()
  // En JPG inbäddad i en RAW-fil saknar ofta egen orientering. Då gäller RAW-filens.
  const own = meta.orientation
  const angle = own ? undefined : ROTATION[orientation ?? 1]
  const turned = own ? own >= 5 : angle === 90 || angle === 270
  return {
    image: () => (angle ? sharp(data).rotate(angle) : sharp(data).rotate()),
    width: (turned ? meta.height : meta.width) ?? 0,
    height: (turned ? meta.width : meta.height) ?? 0,
  }
}

// heic-decode tillämpar HEIC-filens egen rotation, så pixlarna är redan rättvända.
async function decodeHeic(data: Buffer): Promise<Decoded> {
  const { width, height, data: pixels } = await heicDecode({ buffer: data })
  const raw = Buffer.from(pixels.buffer, pixels.byteOffset, pixels.byteLength)
  return { image: () => sharp(raw, { raw: { width, height, channels: 4 } }), width, height }
}

const JPEG_START = Buffer.from([0xff, 0xd8, 0xff])

// Den största vanliga JPG-bilden inuti en RAW-fil. Själva RAW-datan kan också
// vara kodad som JPEG (förlustfri, inte tre färgkanaler) och väljs bort.
async function embeddedJpeg(data: Buffer): Promise<Buffer | null> {
  let best: { jpeg: Buffer; pixels: number } | null = null
  for (let offset = data.indexOf(JPEG_START), tries = 0; offset !== -1 && tries < 64; tries++) {
    const jpeg = data.subarray(offset)
    try {
      const meta = await sharp(jpeg).metadata()
      const pixels = (meta.width ?? 0) * (meta.height ?? 0)
      if (meta.format === 'jpeg' && meta.channels === 3 && pixels > (best?.pixels ?? 0)) {
        await sharp(jpeg).resize(8).toBuffer()
        best = { jpeg, pixels }
      }
    } catch {
      // Inte en JPG som går att avkoda, sök vidare.
    }
    offset = data.indexOf(JPEG_START, offset + JPEG_START.length)
  }
  return best?.jpeg ?? null
}

const run = promisify(execFile)

interface VideoInfo {
  durationSeconds: number | null
  takenAt: string | null
}

// ffmpeg utan utfil skriver filens uppgifter till stderr och avslutar med fel.
async function probeVideo(file: string): Promise<VideoInfo> {
  const output = await run(ffmpegPath!, ['-hide_banner', '-i', file]).then(
    (result) => result.stderr,
    (error: { stderr?: string }) => error.stderr ?? '',
  )
  const duration = output.match(/Duration: (\d+):(\d{2}):(\d{2}(?:\.\d+)?)/)
  const created = output.match(/creation_time\s*:\s*(\S+)/)
  // creation_time är i UTC. Lagras som lokal tid utan zon, som EXIF-tiderna.
  const date = created ? new Date(created[1]) : null
  const pad = (n: number) => String(n).padStart(2, '0')
  return {
    durationSeconds: duration ? Number(duration[1]) * 3600 + Number(duration[2]) * 60 + Number(duration[3]) : null,
    takenAt:
      date && !Number.isNaN(date.getTime())
        ? `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T` +
          `${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`
        : null,
  }
}

// En bildruta en sekund in (eller mitt i korta filmer), så att den inte blir svart.
// ffmpeg vänder bildrutan enligt filmens rotation.
async function videoFrame(file: string, at: number): Promise<Buffer> {
  const { stdout } = await run(
    ffmpegPath!,
    ['-hide_banner', '-loglevel', 'error', '-ss', String(at), '-i', file]
      .concat(['-map', '0:v:0', '-frames:v', '1', '-f', 'image2pipe', '-c:v', 'png', '-']),
    { encoding: 'buffer', maxBuffer: 256 * 1024 * 1024 },
  )
  if (!stdout.length) throw new Error('ffmpeg gav ingen bildruta')
  return stdout
}

async function decodeVideo(file: string) {
  if (!ffmpegPath || !existsSync(ffmpegPath)) {
    throw new Error('ffmpeg saknas. Kör npm install-scripts approve ffmpeg-static och sedan npm install.')
  }
  const video = await probeVideo(file)
  const frame = await videoFrame(file, Math.min(1, (video.durationSeconds ?? 0) / 2))
  return { decoded: await decodeWithSharp(frame), tags: null, video }
}

async function parseTags(data: Buffer) {
  return exifr.parse(data, { iptc: true, xmp: true, reviveValues: false, mergeOutput: true }).catch(() => null)
}

// Filerna läses hela. exifr lämnar annars filhandtag öppna, vilket är ett fel i Node 26.
async function decode(source: Source): Promise<{ decoded: Decoded; tags: any; video?: VideoInfo }> {
  const ext = extension(source.file)
  if (VIDEO_EXTENSIONS.has(ext)) return decodeVideo(source.file)
  const data = await fs.readFile(source.file)
  const companion = source.alternates[0] ? await fs.readFile(source.alternates[0].file) : null
  const tags = (await parseTags(data)) ?? (companion ? await parseTags(companion) : null)

  if (HEIC_EXTENSIONS.has(ext)) return { decoded: await decodeHeic(data), tags }
  if (!RAW_EXTENSIONS.has(ext)) return { decoded: await decodeWithSharp(data), tags }
  if (companion) {
    const companionExt = extension(source.alternates[0].file)
    const decoded = HEIC_EXTENSIONS.has(companionExt) ? await decodeHeic(companion) : await decodeWithSharp(companion)
    return { decoded, tags }
  }
  const jpeg = await embeddedJpeg(data)
  if (!jpeg) throw new Error('RAW-filen saknar både JPG med samma namn och inbäddad förhandsbild')
  const orientation = typeof tags?.Orientation === 'number' ? tags.Orientation : undefined
  return { decoded: await decodeWithSharp(jpeg, orientation), tags }
}

async function writeWebp(decoded: Decoded, output: string, size: number, quality: number) {
  await decoded
    .image()
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
  const times = await Promise.all([source, ...source.alternates].map(async (s) => (await fs.stat(s.file)).mtimeMs))
  const sourceTime = Math.max(...times)
  const { decoded, tags, video } = await decode(source)
  const outputs: [string, number, number][] = [
    [path.join(ROOT, thumbPath(id)), THUMB_SIZE, 75],
    [path.join(ROOT, previewPath(id)), PREVIEW_SIZE, 82],
  ]
  for (const [output, size, quality] of outputs) {
    if (!(await isUpToDate(output, sourceTime))) await writeWebp(decoded, output, size, quality)
  }

  return {
    id,
    path: source.path,
    photographer: source.photographer,
    byline: text(tags?.Byline) || text(tags?.Artist) || text(tags?.creator) || `Foto: ${source.photographer}`,
    ...testRights(n),
    width: decoded.width,
    height: decoded.height,
    takenAt: video?.takenAt ?? exifDate(tags?.DateTimeOriginal) ?? exifDate(tags?.CreateDate),
    tags: list(tags?.Keywords ?? tags?.subject),
    description: text(tags?.Caption) || text(tags?.ImageDescription) || text(tags?.description),
    alternates: source.alternates.map((alternate) => alternate.path),
    durationSeconds: video?.durationSeconds ?? null,
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
  // En JPG som får en RAW-fil bredvid sig behåller sitt id.
  const jobs = sources.map((source) => ({
    source,
    id: [source, ...source.alternates].map((s) => ids.get(s.path)).find(Boolean) ?? formatId(nextId++),
  }))

  const results: (ImageRecord | null)[] = new Array(jobs.length).fill(null)
  const failures: string[] = []
  let done = 0
  async function worker(queue: number[]) {
    for (let n = queue.shift(); n !== undefined; n = queue.shift()) {
      try {
        results[n] = await makeRecord(jobs[n].source, jobs[n].id, n)
      } catch (error) {
        failures.push(`  Hoppar över ${jobs[n].source.path}: ${error instanceof Error ? error.message : error}`)
      }
      process.stdout.write(`\r  ${++done}/${jobs.length}`)
    }
  }
  const queue = jobs.map((_, n) => n)
  await Promise.all(Array.from({ length: CONCURRENCY }, () => worker(queue)))
  if (failures.length) console.warn(`\n${failures.join('\n')}`)

  const images = results.filter((image): image is ImageRecord => image !== null)
  const index: IndexFile = { version: INDEX_VERSION, generatedAt: new Date().toISOString(), images }
  await fs.writeFile(indexFile, JSON.stringify(index, null, 2) + '\n')
  console.log(`\nSkrev ${path.relative(process.cwd(), indexFile)} med ${images.length} bilder`)
}

await main()
