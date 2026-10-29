// Meddelanden mellan adminvyn och importens Web Worker (src/import/worker.ts).

export type ToWorker =
  | { type: 'scan'; bank: FileSystemDirectoryHandle; originals: FileSystemDirectoryHandle }
  // copyOriginals: kopiera nya original till bildbankens original/.
  | { type: 'import'; copyOriginals: boolean }
  | { type: 'abort' }
  // Svar på frame-request: en stillbild ur filmen, eller null om den inte gick att läsa.
  | { type: 'frame'; requestId: number; bitmap: ImageBitmap | null }

export type Phase = 'scan' | 'hash' | 'import' | 'ai' | 'copy' | 'save'

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
  // Vad som städades upp eller ska göras om efter en tidigare import som avbröts.
  recovery: string[]
  // model: finns AI-modellen i app-data/models/. missing: bilder som behöver en AI-vektor.
  ai: { model: boolean; missing: number }
}

export interface ImportResult {
  processed: number
  total: number
  // Filer med samma namn och tagningstid som en annan bild, som inte togs med.
  duplicates: { path: string; sameAs: string }[]
  // Kopieringen till bildbankens original/, eller null om den inte valdes.
  // notOverwritten: filer som redan fanns med annat innehåll och inte skrevs över.
  copied: { copied: number; notOverwritten: string[] } | null
  // computed: nya AI-vektorer. total: bilder med vektor. problem: varför vektorer saknas.
  // device: webgpu (grafikkortet) eller wasm, null om inga vektorer räknades ut.
  ai: { model: boolean; computed: number; total: number; problem: string | null; device: 'webgpu' | 'wasm' | null }
}

export type FromWorker =
  | { type: 'progress'; phase: Phase; done: number; total: number }
  | { type: 'scanned'; summary: ScanSummary }
  | { type: 'imported'; result: ImportResult }
  | { type: 'aborted'; phase: Phase; done: number; total: number }
  | { type: 'error'; message: string }
  // Workern ber sidan ta en stillbild ur en film.
  | { type: 'frame-request'; requestId: number; file: File }
