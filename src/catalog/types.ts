// Formatet för app-data/index.json. Beskrivs i docs/index-format.md.

import type { Gps, Place } from './places.ts'

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
  // AI-vektorerna i app-data/embeddings.bin. Saknas om ingen bild har en vektor.
  embeddings?: IndexEmbeddings
  // Hur bildernas aiTags sattes. Saknas om inga AI-taggar har satts.
  aiTagging?: IndexAiTagging
}

export interface IndexAiTagging {
  model: string
  // Fingeravtryck av taggarna i app-data/config.json (src/ai/tagConfig.ts).
  // Ändras taggarna sätts AI-taggarna om för alla bilder.
  config: string
  // Prompterna i ordning och filen i app-data/ med deras textvektorer, en rad
  // per prompt. Saknas i index från före adminvyn AI-taggar.
  prompts?: string[]
  file?: string
}

export interface IndexEmbeddings {
  file: 'embeddings.bin'
  // Modellens namn, mappen i app-data/models/. Byts modellen räknas alla vektorer om.
  model: string
  dimensions: number
  count: number
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
  // Används inte längre. Finns kvar så att äldre index går att läsa.
  rightsUntil: string | null
  consent: Consent
  blocked: boolean
  width: number
  height: number
  takenAt: string | null
  tags: string[]
  // Taggar som AI-modellen har satt, skilda från tags. Kan vara fel.
  aiTags: string[]
  description: string
  alternates: string[]
  durationSeconds: number | null
  // GPS-positionen ur EXIF, eller null om den saknas. Saknas fältet helt
  // (index från före platserna) läser nästa import positionen ur filen.
  gps?: Gps | null
  // Upplösningen i dpi ur EXIF, eller null om den saknas. Saknas fältet helt
  // (index från före upplösningen) läser nästa import den ur filen.
  dpi?: number | null
  // Stadsområde och delområde, uträknade från gps vid varje import. null utan
  // GPS eller utanför Malmö.
  place: Place | null
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
