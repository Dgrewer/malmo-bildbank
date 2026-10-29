// Formatet för app-data/index.json. Beskrivs i docs/index-format.md.

export const INDEX_VERSION = 1

export interface IndexFile {
  version: typeof INDEX_VERSION
  generatedAt: string
  images: ImageRecord[]
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
}

export function formatId(n: number): string {
  return `MB-${String(n).padStart(6, '0')}`
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
