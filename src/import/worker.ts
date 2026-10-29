// Importens tunga arbete körs här, utanför sidans huvudtråd, så att
// gränssnittet inte fryser. Mapphandtagen skickas hit från adminvyn.
//
//   scan    läser originalmappen, räknar fingeravtryck och jämför med indexet
//   import  skapar poster för nya, ändrade och flyttade bilder och skriver indexet
//   abort   avbryter efter den fil som håller på. Det som är klart sparas.

import { readIndexFile } from '../catalog/loadIndex.ts'
import { idNumber, INDEX_VERSION, type ImageRecord, type IndexFile } from '../catalog/types.ts'
import { ensureDirectory, readFile, writeIndexFile } from '../fs/folder.ts'
import { combinedHash, quickHash } from './hash.ts'
import { Journal, readJournal } from './journal.ts'
import { buildPlan, type ImportPlan, type PlanItem } from './plan.ts'
import type { FromWorker, Phase, ScanSummary, ToWorker } from './protocol.ts'
import { scanOriginals, type ScannedFile } from './scan.ts'

interface HashedScannedFile extends ScannedFile {
  hash: string
}

interface Session {
  bank: FileSystemDirectoryHandle
  plan: ImportPlan<HashedScannedFile>
  journal: Journal
  // Poster från en avbruten import, efter id.
  resumed: Map<string, ImageRecord>
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
  const index = await readIndexFile(bank)
  const journal = await readJournal(bank)
  const resumed = new Map(journal.map((record) => [record.id, record]))
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

  const plan = buildPlan(hashed, previous, lastId)
  session = { bank, plan, journal: new Journal(bank, journal), resumed }
  const paths = (change: PlanItem<HashedScannedFile>['change']) =>
    plan.items.filter((item) => item.change === change)
  return {
    new: paths('new').map((item) => item.file.path),
    changed: paths('changed').map((item) => item.file.path),
    moved: paths('moved').map((item) => ({ from: item.previous!.path, to: item.file.path })),
    removed: plan.removed.map((record) => record.path),
    unchanged: paths('unchanged').length,
    exactDuplicates: plan.exactDuplicates,
    skipped: scanned.skipped,
    resumed: plan.items.filter((item) => resumed.has(item.id)).length,
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

async function makeRecord(item: PlanItem<HashedScannedFile>): Promise<ImageRecord> {
  return baseRecord(item)
}

async function runImport(current: Session) {
  const { bank, plan, journal } = current
  const work = plan.items.filter((item) => item.change !== 'unchanged')
  const records = new Map<string, ImageRecord>()
  try {
    for (const item of work) {
      await breathe()
      progress('import', records.size, work.length)
      const record = await makeRecord(item)
      records.set(item.id, record)
      await journal.add(record)
    }
  } catch (error) {
    await journal.flush()
    throw error
  }
  progress('import', work.length, work.length)

  post({ type: 'progress', phase: 'save', done: 0, total: 1 })
  const images = plan.items
    .map((item) => records.get(item.id) ?? baseRecord(item))
    .sort((a, b) => idNumber(a.id) - idNumber(b.id))
  const index: IndexFile = { version: INDEX_VERSION, generatedAt: new Date().toISOString(), lastId: plan.lastId, images }
  await writeIndexFile(await ensureDirectory(bank, 'app-data'), JSON.stringify(index, null, 2))
  await journal.remove()
  session = null
  return { processed: work.length, total: images.length }
}

async function handle(message: ToWorker) {
  if (message.type === 'abort') {
    aborted = true
    return
  }
  aborted = false
  try {
    if (message.type === 'scan') {
      post({ type: 'scanned', summary: await scan(message.bank, message.originals) })
    } else {
      if (!session) throw new Error('Sök efter ändringar först.')
      post({ type: 'imported', result: await runImport(session) })
    }
  } catch (error) {
    if (error instanceof Aborted) post({ type: 'aborted', phase: error.phase, done: error.done, total: error.total })
    else post({ type: 'error', message: error instanceof Error ? error.message : String(error) })
  }
}

scope.onmessage = (event) => void handle(event.data)
