import type { ImageRecord } from '../catalog/types.ts'
import { ensureDirectory, findDirectory, readFile, removeFile, writeFile } from '../fs/folder.ts'

// Bilder som blir klara under en import sparas löpande i
// app-data/import/pagaende.jsonl, en post per rad. Avbryts importen, eller
// stängs fliken, fortsätter nästa import med dem i stället för att göra om
// arbetet. Filen tas bort när indexet har skrivits.

const PATH = 'app-data/import/pagaende.jsonl'
const FLUSH_EVERY_MS = 2_000

export interface JournalContents {
  records: ImageRecord[]
  // Rader som inte skrevs klart eller inte är en bildpost. Bilderna görs om.
  broken: number
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
  const file = await readFile(bank, PATH)
  const result: JournalContents = { records: [], broken: 0 }
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
  private flushedAt = Date.now()
  private bank: FileSystemDirectoryHandle

  constructor(bank: FileSystemDirectoryHandle, records: ImageRecord[]) {
    this.bank = bank
    this.records = [...records]
  }

  // Poster som inte hör till den här importen, t.ex. från en annan originalmapp.
  drop(ids: Set<string>) {
    this.records = this.records.filter((record) => !ids.has(record.id))
  }

  async add(record: ImageRecord) {
    this.records.push(record)
    if (Date.now() - this.flushedAt > FLUSH_EVERY_MS) await this.flush()
  }

  async flush() {
    const directory = await ensureDirectory(this.bank, 'app-data/import')
    await writeFile(directory, 'pagaende.jsonl', this.records.map((record) => JSON.stringify(record) + '\n').join(''))
    this.flushedAt = Date.now()
  }

  async remove() {
    const directory = await findDirectory(this.bank, 'app-data')
    const imports = directory && (await findDirectory(directory, 'import'))
    if (imports) await removeFile(imports, 'pagaende.jsonl')
  }
}
