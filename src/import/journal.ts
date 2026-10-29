import { decodeVectors, encodeVectors, type Vectors } from '../ai/embeddings.ts'
import { MODEL } from '../ai/modelInfo.ts'
import type { ImageRecord } from '../catalog/types.ts'
import { ensureDirectory, findDirectory, readFile, removeFile, writeFile } from '../fs/folder.ts'

// Bilder som blir klara under en import sparas löpande i
// app-data/import/pagaende.jsonl, en post per rad, och deras AI-vektorer i
// app-data/import/pagaende.bin. Avbryts importen, eller stängs fliken,
// fortsätter nästa import med dem i stället för att göra om arbetet. Filerna
// tas bort när indexet har skrivits.

const DIRECTORY = 'app-data/import'
const RECORDS = 'pagaende.jsonl'
const VECTORS = 'pagaende.bin'
const FLUSH_EVERY_MS = 2_000

export interface JournalContents {
  records: ImageRecord[]
  // Rader som inte skrevs klart eller inte är en bildpost. Bilderna görs om.
  broken: number
  vectors: Vectors
}

function isRecord(value: unknown): value is ImageRecord {
  const record = value as ImageRecord
  return (
    !!record &&
    typeof record.id === 'string' &&
    /^MB-\d{6}$/.test(record.id) &&
    typeof record.path === 'string' &&
    record.path.startsWith('original/') &&
    typeof record.hash === 'string'
  )
}

export async function readJournal(bank: FileSystemDirectoryHandle): Promise<JournalContents> {
  const result: JournalContents = { records: [], broken: 0, vectors: new Map() }
  const vectors = await readFile(bank, `${DIRECTORY}/${VECTORS}`)
  // En trasig vektorfil ignoreras. Vektorerna räknas om.
  if (vectors) result.vectors = decodeVectors(await vectors.arrayBuffer(), MODEL.dimensions) ?? new Map()
  const file = await readFile(bank, `${DIRECTORY}/${RECORDS}`)
  if (!file) return result
  for (const line of (await file.text()).split('\n').filter((line) => line.trim())) {
    try {
      const record = JSON.parse(line)
      if (isRecord(record)) result.records.push(record)
      else result.broken++
    } catch {
      result.broken++
    }
  }
  return result
}

export class Journal {
  private records: ImageRecord[]
  private vectors: Vectors
  private flushedAt = Date.now()
  private bank: FileSystemDirectoryHandle

  constructor(bank: FileSystemDirectoryHandle, records: ImageRecord[], vectors: Vectors) {
    this.bank = bank
    this.records = [...records]
    this.vectors = new Map(vectors)
  }

  // Poster som inte hör till den här importen, t.ex. från en annan originalmapp.
  drop(ids: Set<string>) {
    this.records = this.records.filter((record) => !ids.has(record.id))
    for (const id of ids) this.vectors.delete(id)
  }

  async add(record: ImageRecord) {
    this.records.push(record)
    await this.flushIfDue()
  }

  async addVector(id: string, vector: Float32Array) {
    this.vectors.set(id, vector)
    await this.flushIfDue()
  }

  private async flushIfDue() {
    if (Date.now() - this.flushedAt > FLUSH_EVERY_MS) await this.flush()
  }

  async flush() {
    const directory = await ensureDirectory(this.bank, DIRECTORY)
    // Vektorerna skrivs först. En post utan vektor får en ny vektor nästa gång.
    await writeFile(directory, VECTORS, new Blob([encodeVectors(this.vectors, MODEL.dimensions)]))
    await writeFile(directory, RECORDS, this.records.map((record) => JSON.stringify(record) + '\n').join(''))
    this.flushedAt = Date.now()
  }

  async remove() {
    const directory = await findDirectory(this.bank, 'app-data')
    const imports = directory && (await findDirectory(directory, 'import'))
    if (!imports) return
    await removeFile(imports, RECORDS)
    await removeFile(imports, VECTORS)
  }
}
