// app-data/importer.jsonl: en rad per import med bilderna som lades till och
// togs bort, och vem som importerade. Visas i Admin, fliken Logg. Importen
// körs av en person åt gången, så alla skriver till samma fil.

export const IMPORT_LOG = 'app-data/importer.jsonl'

export interface ImportLogItem {
  id: string
  path: string
}

export interface ImportRun {
  at: string
  by: string
  added: ImportLogItem[]
  removed: ImportLogItem[]
}

const isItems = (value: unknown): value is ImportLogItem[] =>
  Array.isArray(value) && value.every((item) => typeof item?.id === 'string' && typeof item?.path === 'string')

export function parseImportLog(text: string): ImportRun[] {
  const runs: ImportRun[] = []
  for (const line of text.split('\n')) {
    if (!line.trim()) continue
    try {
      const run = JSON.parse(line)
      if (typeof run.at === 'string' && typeof run.by === 'string' && isItems(run.added) && isItems(run.removed)) runs.push(run)
    } catch {
      // En halvskriven rad hoppas över.
    }
  }
  return runs
}
