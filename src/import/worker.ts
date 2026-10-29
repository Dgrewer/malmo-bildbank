// Importens tunga arbete körs här, utanför sidans huvudtråd, så att
// gränssnittet inte fryser. Mapphandtagen skickas hit från adminvyn.
//
//   scan    läser originalmappen, räknar fingeravtryck och jämför med indexet
//   import  läser metadata, skapar miniatyrer och förhandsbilder och skriver indexet
//   abort   avbryter efter den fil som håller på. Det som är klart sparas.

import { findDuplicates } from '../catalog/duplicates.ts'
import { extension, isVideo, RAW_EXTENSIONS, TIFF_EXTENSIONS } from '../catalog/fileFormat.ts'
import { readIndexFile } from '../catalog/loadIndex.ts'
import { idNumber, INDEX_VERSION, type IndexDuplicate, type ImageRecord, type IndexFile } from '../catalog/types.ts'
import { ensureDirectory, findDirectory, readFile, removeFile, writeFile } from '../fs/folder.ts'
import { combinedHash, quickHash } from './hash.ts'
import {
  decodeImage,
  PREVIEW_SIZE,
  PreviewProblem,
  THUMB_SIZE,
  toWebp,
  VIDEO_UNREADABLE,
  type Decoded,
} from './images.ts'
import { recoverIndexFiles, writeIndexFile } from './indexFiles.ts'
import { Journal, readJournal } from './journal.ts'
import { readMetadata } from './metadata.ts'
import { buildPlan, type ImportPlan, type PlanItem } from './plan.ts'
import type { FromWorker, Phase, ScanSummary, ToWorker } from './protocol.ts'
import { scanOriginals, type ScannedFile } from './scan.ts'
import { readVideoInfo } from './video.ts'

interface HashedScannedFile extends ScannedFile {
  hash: string
}

interface Session {
  bank: FileSystemDirectoryHandle
  originals: FileSystemDirectoryHandle
  // Id:n i indexet före importen. Övriga bilder är nya, även de som blev klara
  // i en avbruten import.
  indexed: Set<string>
  thumbs: FileSystemDirectoryHandle
  previews: FileSystemDirectoryHandle
  plan: ImportPlan<HashedScannedFile>
  journal: Journal
  // Poster från en avbruten import, efter id.
  resumed: Map<string, ImageRecord>
  // Dubbletter med samma namn och tagningstid som tidigare importer har valt bort.
  duplicates: IndexDuplicate[]
  // Id:n från en avbruten import som inte hör till den här originalmappen.
  // Deras miniatyrer tas bort när indexet är sparat, om id:t inte har delats ut igen.
  foreign: Set<string>
}

const scope = self as unknown as {
  postMessage(message: FromWorker): void
  onmessage: ((event: MessageEvent<ToWorker>) => void) | null
}

let session: Session | null = null
let aborted = false

class Aborted extends Error {
  phase: Phase
  done: number
  total: number

  constructor(phase: Phase, done: number, total: number) {
    super('Avbruten')
    this.phase = phase
    this.done = done
    this.total = total
  }
}

function post(message: FromWorker) {
  scope.postMessage(message)
}

// Förloppet skickas högst tio gånger i sekunden, och alltid när en fas är klar.
let progressSentAt = 0
function progress(phase: Phase, done: number, total: number) {
  if (aborted) throw new Aborted(phase, done, total)
  const now = Date.now()
  if (done < total && now - progressSentAt < 100) return
  progressSentAt = now
  post({ type: 'progress', phase, done, total })
}

// Släpper fram väntande meddelanden, t.ex. Avbryt, högst var 50:e millisekund.
// Utan det når meddelandena inte workern förrän en fas är klar.
let breathedAt = 0
async function breathe() {
  if (Date.now() - breathedAt < 50) return
  await new Promise((resolve) => setTimeout(resolve, 0))
  breathedAt = Date.now()
}

// Stillbilder ur filmer tas i sidans huvudtråd, eftersom en worker inte har
// något video-element. Sidan svarar med en ImageBitmap, eller null om filmen
// inte gick att läsa.
type FrameAnswer = Extract<ToWorker, { type: 'frame' }>
const frameRequests = new Map<number, (answer: FrameAnswer) => void>()
let nextFrameRequest = 0

async function videoFrame(file: File): Promise<Decoded> {
  const requestId = nextFrameRequest++
  const answer = await new Promise<FrameAnswer>((resolve) => {
    frameRequests.set(requestId, resolve)
    post({ type: 'frame-request', requestId, file })
  })
  frameRequests.delete(requestId)
  if (!answer.bitmap) throw new PreviewProblem(VIDEO_UNREADABLE)
  return { image: answer.bitmap, width: answer.bitmap.width, height: answer.bitmap.height }
}

async function names(directory: FileSystemDirectoryHandle): Promise<Set<string>> {
  const result = new Set<string>()
  for await (const name of directory.keys()) result.add(name)
  return result
}

// Id:n för dubbletter som indexeringen tidigare flyttade bort får inte återanvändas.
async function movedDuplicateIds(bank: FileSystemDirectoryHandle): Promise<number> {
  const log = await readFile(bank, 'app-data/dubbletter/flyttade.jsonl')
  if (!log) return 0
  let highest = 0
  for (const line of (await log.text()).split('\n')) {
    const id = line.match(/"id":"(MB-\d+)"/)?.[1]
    if (id) highest = Math.max(highest, idNumber(id))
  }
  return highest
}

async function scan(bank: FileSystemDirectoryHandle, originals: FileSystemDirectoryHandle): Promise<ScanSummary> {
  // Först städas det som en avbruten import kan ha lämnat efter sig.
  const recovery = await recoverIndexFiles(bank)
  const index = await readIndexFile(bank)
  const journal = await readJournal(bank)
  const resumed = new Map(journal.records.map((record) => [record.id, record]))
  if (journal.broken) {
    recovery.push(`${journal.broken} rader i den avbrutna importens logg var ofullständiga. De bilderna görs om.`)
  }
  // Bilder som blev klara i en avbruten import räknas som redan importerade.
  const previous = [
    ...(index?.images ?? []).filter((record) => !resumed.has(record.id)),
    ...resumed.values(),
  ]
  const lastId = Math.max(index?.lastId ?? 0, await movedDuplicateIds(bank))

  progress('scan', 0, 0)
  const scanned = await scanOriginals(originals, (found) => progress('scan', found, 0))

  const byPath = new Map(previous.map((record) => [record.path, record]))
  const hashed: HashedScannedFile[] = []
  for (const file of scanned.files) {
    await breathe()
    progress('hash', hashed.length, scanned.files.length)
    const known = byPath.get(file.path)
    // En oförändrad fil (samma storlek och ändringstid) behöver inte läsas.
    // Ett RAW-par läses alltid, eftersom indexet bara har RAW-filens storlek och tid.
    const hash =
      known?.hash && !file.alternates.length && known.fileSize === file.size && known.fileModified === file.modified
        ? known.hash
        : await combinedHash(
            await Promise.all([file, ...file.alternates].map(async (part) => quickHash(await part.handle.getFile()))),
          )
    hashed.push({ ...file, hash })
  }
  progress('hash', hashed.length, hashed.length)

  // En fil som en tidigare import valde bort som dubblett importeras inte igen,
  // så länge bilden som behölls finns kvar.
  const found = new Set(hashed.map((file) => file.hash))
  const alive = new Map(previous.filter((record) => record.hash && found.has(record.hash)).map((r) => [r.id, r]))
  const duplicates = (index?.duplicates ?? []).filter((duplicate) => alive.has(duplicate.keptId) && found.has(duplicate.hash))
  const skippedHashes = new Set(duplicates.map((duplicate) => duplicate.hash))

  const files = hashed.filter((file) => !skippedHashes.has(file.hash))
  const indexed = new Set((index?.images ?? []).map((record) => record.id))
  // Bilder i en avbruten import som inte finns i originalmappen, t.ex. för att
  // importen gjordes från en annan mapp, har aldrig varit i indexet. De kastas
  // i stället för att räknas som borttagna, och deras id kan delas ut igen
  // eftersom ingen har kunnat tagga dem.
  const foreign = new Set(
    buildPlan(files, previous, lastId)
      .removed.filter((record) => !indexed.has(record.id))
      .map((record) => record.id),
  )
  for (const id of foreign) resumed.delete(id)
  const plan = buildPlan(
    files,
    previous.filter((record) => !foreign.has(record.id)),
    lastId,
  )
  if (foreign.size) {
    recovery.push(
      `${foreign.size} bilder i den avbrutna importen finns inte i den här originalmappen. De togs inte med.`,
    )
  }
  // En bild vars miniatyr eller förhandsbild saknas görs om, t.ex. efter en
  // import som avbröts eller om någon har tagit bort filerna.
  const thumbs = await ensureDirectory(bank, 'app-data/thumbs')
  const previews = await ensureDirectory(bank, 'app-data/previews')
  const [thumbNames, previewNames] = [await names(thumbs), await names(previews)]
  let redone = 0
  for (const item of plan.items) {
    const name = `${item.id}.webp`
    const missing = !(thumbNames.has(name) && previewNames.has(name))
    if (item.change === 'unchanged' && !item.previous?.previewProblem && missing) {
      item.change = 'changed'
      redone++
    }
  }
  if (redone) recovery.push(`${redone} bilder saknade miniatyr eller förhandsbild. De görs om.`)
  const pending = new Journal(bank, journal.records)
  pending.drop(foreign)
  session = { bank, originals, indexed, thumbs, previews, plan, journal: pending, resumed, duplicates, foreign }
  const paths = (change: PlanItem<HashedScannedFile>['change']) =>
    plan.items.filter((item) => item.change === change)
  return {
    new: paths('new').map((item) => item.file.path),
    changed: paths('changed').map((item) => item.file.path),
    moved: paths('moved').map((item) => ({ from: item.previous!.path, to: item.file.path })),
    removed: plan.removed.map((record) => record.path),
    unchanged: paths('unchanged').length,
    exactDuplicates: plan.exactDuplicates,
    nameDuplicates: duplicates.map((duplicate) => ({ path: duplicate.path, sameAs: alive.get(duplicate.keptId)!.path })),
    skipped: scanned.skipped,
    resumed: plan.items.filter((item) => resumed.has(item.id) && item.change === 'unchanged').length,
    recovery,
  }
}

// Posten för en bild. Fält som går att ändra i appen, t.ex. rättigheter, följer
// med från den förra posten. Fil, plats och fingeravtryck kommer från filen.
function baseRecord(item: PlanItem<HashedScannedFile>): ImageRecord {
  const { file, previous } = item
  return {
    byline: '',
    terms: '',
    rightsUntil: null,
    consent: 'not-required',
    blocked: false,
    width: 0,
    height: 0,
    takenAt: null,
    tags: [],
    description: '',
    durationSeconds: null,
    previewProblem: null,
    ...previous,
    id: item.id,
    path: file.path,
    photographer: file.photographer,
    alternates: file.alternates.map((alternate) => alternate.path),
    hash: file.hash,
    fileSize: file.size,
    fileModified: file.modified,
  }
}

// Metadata läses och bilder skapas för nya och ändrade filer. En flyttad fil
// har samma innehåll och behåller sina uppgifter och bilder.
async function makeRecord(current: Session, item: PlanItem<HashedScannedFile>): Promise<ImageRecord> {
  const record = baseRecord(item)
  if (item.change === 'moved') return record
  const file = await item.file.handle.getFile()
  if (isVideo(file.name)) {
    const video = await readVideoInfo(file)
    const updated = { ...record, byline: record.byline || `Foto: ${record.photographer}`, ...video }
    return withImages(current, updated, () => videoFrame(file))
  }
  const companion = item.file.alternates[0] && (await item.file.alternates[0].handle.getFile())
  // exifr läser annars bara början av filen. I TIFF och TIFF-baserade RAW-filer
  // kan uppgifterna ligga längre in.
  const ext = extension(file.name)
  const whole = RAW_EXTENSIONS.has(ext) || TIFF_EXTENSIONS.has(ext)
  const metadata = await readMetadata(whole ? new Uint8Array(await file.arrayBuffer()) : file, companion)
  const updated = {
    ...record,
    byline: metadata.byline || `Foto: ${record.photographer}`,
    takenAt: metadata.takenAt,
    tags: metadata.tags,
    description: metadata.description,
  }
  return withImages(current, updated, () => decodeImage(file, metadata.orientation, companion))
}

// Skapar miniatyr och förhandsbild. Storleken blir den avkodade bildens, efter
// rotation. Går det inte kommer bilden ändå med, med en förklaring i previewProblem.
async function withImages(current: Session, record: ImageRecord, decode: () => Promise<Decoded>): Promise<ImageRecord> {
  const name = `${record.id}.webp`
  try {
    const decoded = await decode()
    try {
      await writeFile(current.thumbs, name, await toWebp(decoded, THUMB_SIZE, 0.75))
      await writeFile(current.previews, name, await toWebp(decoded, PREVIEW_SIZE, 0.82))
    } finally {
      if (decoded.image instanceof ImageBitmap) decoded.image.close()
    }
    return { ...record, width: decoded.width, height: decoded.height, previewProblem: null }
  } catch (error) {
    // Eventuella gamla bildfiler tas bort först när det nya indexet är sparat.
    const problem =
      error instanceof PreviewProblem
        ? error.message
        : `Förhandsbilden kunde inte skapas: ${error instanceof Error ? error.message : error}`
    return { ...record, width: 0, height: 0, previewProblem: problem }
  }
}

async function removeImages(current: Session, id: string) {
  await removeFile(current.thumbs, `${id}.webp`)
  await removeFile(current.previews, `${id}.webp`)
}

// Kopierar de nya bildernas original, och JPG:en till ett RAW-par, till
// bildbankens original/ med samma sökväg. En fil som redan finns skrivs aldrig
// över. Har den samma storlek räknas den som redan kopierad, annars rapporteras den.
async function copyOriginals(current: Session, images: ImageRecord[]) {
  const files = new Map(current.plan.items.flatMap((item) => [item.file, ...item.file.alternates]).map((f) => [f.path, f]))
  const paths = images.filter((image) => !current.indexed.has(image.id)).flatMap((image) => [image.path, ...image.alternates])
  const result = { copied: 0, notOverwritten: [] as string[] }
  for (const [n, path] of paths.entries()) {
    await breathe()
    progress('copy', n, paths.length)
    const source = files.get(path)
    if (!source) continue
    const existing = await readFile(current.bank, path)
    if (existing) {
      if (existing.size !== source.size) result.notOverwritten.push(path)
      continue
    }
    const directory = await ensureDirectory(current.bank, path.slice(0, path.lastIndexOf('/')))
    const name = path.slice(path.lastIndexOf('/') + 1)
    const writable = await (await directory.getFileHandle(name, { create: true })).createWritable()
    await (await source.handle.getFile()).stream().pipeTo(writable)
    result.copied++
  }
  progress('copy', paths.length, paths.length)
  return result
}

async function runImport(current: Session, copy: boolean) {
  const { bank, plan, journal } = current
  const work = plan.items.filter((item) => item.change !== 'unchanged')
  const records = new Map<string, ImageRecord>()
  try {
    for (const item of work) {
      await breathe()
      progress('import', records.size, work.length)
      const record = await makeRecord(current, item)
      records.set(item.id, record)
      await journal.add(record)
    }
  } catch (error) {
    await journal.flush()
    throw error
  }
  progress('import', work.length, work.length)

  const all = plan.items
    .map((item) => records.get(item.id) ?? baseRecord(item))
    .sort((a, b) => idNumber(a.id) - idNumber(b.id))
  // Av filer med samma namn och tagningstid behålls den med högst upplösning.
  // De andra tas inte med i indexet, men filerna ligger kvar i originalmappen.
  const dropped = findDuplicates(all)
  const images = all.filter((image) => !dropped.has(image))
  // Är originalmappen bildbankens egen original/ finns inget att kopiera.
  const bankOriginals = await findDirectory(bank, 'original')
  const inBank = bankOriginals ? await bankOriginals.isSameEntry(current.originals) : false
  const copied = copy && !inBank ? await copyOriginals(current, images) : null

  post({ type: 'progress', phase: 'save', done: 0, total: 1 })
  const duplicates: IndexDuplicate[] = [
    ...current.duplicates,
    ...[...dropped].map(([image, kept]) => ({ path: image.path, hash: image.hash!, keptId: kept.id })),
  ]
  const index: IndexFile = {
    version: INDEX_VERSION,
    generatedAt: new Date().toISOString(),
    lastId: plan.lastId,
    images,
    duplicates,
  }
  await writeIndexFile(await ensureDirectory(bank, 'app-data'), JSON.stringify(index, null, 2))
  await journal.remove()
  // Bilder som inte finns kvar i bildbanken behöver inga miniatyrer. De tas
  // bort först när det nya indexet är sparat, så att inget försvinner om
  // skrivningen misslyckas.
  const kept = new Set(images.map((image) => image.id))
  for (const id of [...plan.removed, ...dropped.keys()].map((record) => record.id).concat([...current.foreign])) {
    if (!kept.has(id)) await removeImages(current, id)
  }
  for (const image of images) if (image.previewProblem) await removeImages(current, image.id)
  session = null
  return {
    processed: work.length,
    total: images.length,
    duplicates: [...dropped].map(([image, kept]) => ({ path: image.path, sameAs: kept.path })),
    copied,
  }
}

async function handle(message: ToWorker) {
  if (message.type === 'abort') {
    aborted = true
    return
  }
  if (message.type === 'frame') {
    frameRequests.get(message.requestId)?.(message)
    return
  }
  aborted = false
  try {
    if (message.type === 'scan') {
      post({ type: 'scanned', summary: await scan(message.bank, message.originals) })
    } else {
      if (!session) throw new Error('Sök efter ändringar först.')
      post({ type: 'imported', result: await runImport(session, message.copyOriginals) })
    }
  } catch (error) {
    if (error instanceof Aborted) post({ type: 'aborted', phase: error.phase, done: error.done, total: error.total })
    else post({ type: 'error', message: error instanceof Error ? error.message : String(error) })
  }
}

scope.onmessage = (event) => void handle(event.data)
