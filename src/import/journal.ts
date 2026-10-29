import type { ImageRecord } from '../catalog/types.ts'
import { ensureDirectory, findDirectory, readFile, removeFile, writeFile } from '../fs/folder.ts'

// Bilder som blir klara under en import sparas löpande i
// app-data/import/pagaende.jsonl, en post per rad. Avbryts importen, eller
// stängs fliken, fortsätter nästa import med dem i stället för att göra om
// arbetet. Filen tas bort när indexet har skrivits.

const PATH = 'app-data/import/pagaende.jsonl'
const FLUSH_EVERY_MS = 2_000

export async function readJournal(bank: FileSystemDirectoryHandle): Promise<ImageRecord[]> {
  const file = await readFile(bank, PATH)
  if (!file) return []
  return (await file.text())
    .split('\n')
    .filter((line) => line.trim())
    .flatMap((line) => {
      try {
        return [JSON.parse(line) as ImageRecord]
      } catch {
        // En rad som inte skrevs klart hoppas över. Bilden görs om.
        return []
      }
    })
}

export class Journal {
  private records: ImageRecord[]
  private flushedAt = Date.now()
  private bank: FileSystemDirectoryHandle

  constructor(bank: FileSystemDirectoryHandle, records: ImageRecord[]) {
    this.bank = bank
    this.records = [...records]
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
