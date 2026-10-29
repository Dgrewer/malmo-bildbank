// Formatet för app-data/index.json. Beskrivs i docs/index-format.md.

export const INDEX_VERSION = 1

export interface IndexFile {
  version: typeof INDEX_VERSION
  generatedAt: string
  // Högsta id-numret som någonsin delats ut. Nya bilder får nästa nummer, så
  // ett id återanvänds aldrig, inte ens om bilden har tagits bort.
  lastId?: number
  images: ImageRecord[]
  // Filer som importen har valt bort som dubbletter (samma namn och tagningstid
  // som en bild med högre upplösning). De importeras inte igen.
  duplicates?: IndexDuplicate[]
}

export interface IndexDuplicate {
  path: string
  hash: string
  // Bilden som behölls i stället.
  keptId: string
}

// given: samtycke finns. missing: samtycke behövs men saknas.
// not-required: inga identifierbara personer, samtycke behövs inte.
export type Consent = 'given' | 'missing' | 'not-required'

export interface ImageRecord {
  id: string
  path: string
  photographer: string
  byline: string
  terms: string
  rightsUntil: string | null
  consent: Consent
  blocked: boolean
  width: number
  height: number
  takenAt: string | null
  tags: string[]
  description: string
  alternates: string[]
  durationSeconds: number | null
  // Varför förhandsbilden saknas, eller null om den finns.
  previewProblem: string | null
  // Snabbt fingeravtryck av originalet (se src/import/hash.ts), dess storlek i
  // byte och ändringstid i millisekunder. Används för att känna igen flyttade
  // och omdöpta filer och för att slippa läsa oförändrade filer.
  hash: string | null
  fileSize: number | null
  fileModified: number | null
}

export function formatId(n: number): string {
  return `MB-${String(n).padStart(6, '0')}`
}

export function idNumber(id: string): number {
  return Number(id.slice(3)) || 0
}

export function thumbPath(id: string): string {
  return `app-data/thumbs/${id}.webp`
}

export function previewPath(id: string): string {
  return `app-data/previews/${id}.webp`
}

// Sökvägar lagras med / och i NFC, eftersom Mac och Windows lagrar å, ä och ö olika.
export function normalizePath(path: string): string {
  return path.replaceAll('\\', '/').normalize('NFC')
}
