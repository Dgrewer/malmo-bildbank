// Meddelanden mellan adminvyn och importens Web Worker (src/import/worker.ts).

export type ToWorker =
  | { type: 'scan'; bank: FileSystemDirectoryHandle; originals: FileSystemDirectoryHandle }
  | { type: 'import' }
  | { type: 'abort' }

export type Phase = 'scan' | 'hash' | 'import' | 'save'

export interface ScanSummary {
  new: string[]
  changed: string[]
  moved: { from: string; to: string }[]
  removed: string[]
  unchanged: number
  // Filer med exakt samma innehåll som en annan fil. Bara en av dem importeras.
  exactDuplicates: { path: string; sameAs: string }[]
  // Filer med samma namn och tagningstid som en bild med högre upplösning. Valdes
  // bort vid en tidigare import och importeras inte.
  nameDuplicates: { path: string; sameAs: string }[]
  // Filer som inte är bilder eller video.
  skipped: string[]
  // Bilder som redan blev klara i en avbruten import.
  resumed: number
}

export interface ImportResult {
  processed: number
  total: number
  // Filer med samma namn och tagningstid som en annan bild, som inte togs med.
  duplicates: { path: string; sameAs: string }[]
}

export type FromWorker =
  | { type: 'progress'; phase: Phase; done: number; total: number }
  | { type: 'scanned'; summary: ScanSummary }
  | { type: 'imported'; result: ImportResult }
  | { type: 'aborted'; phase: Phase; done: number; total: number }
  | { type: 'error'; message: string }
