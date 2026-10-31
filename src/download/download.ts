// Nedladdning till mappen Hämtade bilder, som användaren väljer en gång per
// dator. Originalen kopieras som de är, i originalets format. En fil som redan
// finns i mappen skrivs aldrig över. Spärrade bilder laddas inte ner.

import { fileName } from '../catalog/fileFormat.ts'
import type { ImageRecord } from '../catalog/types.ts'
import { findFile, readFile, writeFile } from '../fs/folder.ts'
import { loadDownloadFolder, saveDownloadFolder } from '../fs/folderStore.ts'

// "MB-000022_IMG_0012.CR2"
export const downloadName = (id: string, path: string) => `${id}_${fileName(path)}`

export interface DownloadResult {
  // Filnamnen i Hämtade bilder.
  saved: string[]
  existed: string[]
  // Original som inte fanns i bildbankens mapp.
  missing: string[]
  // Id:n för spärrade bilder som inte laddades ner.
  blocked: string[]
}

// Mappen Hämtade bilder. Första gången, eller med choose, får användaren välja den.
// null om användaren avbröt eller inte gav tillstånd.
export async function downloadFolder(choose = false): Promise<FileSystemDirectoryHandle | null> {
  const saved = choose ? null : await loadDownloadFolder()
  if (saved) {
    if ((await saved.queryPermission({ mode: 'readwrite' })) === 'granted') return saved
    if ((await saved.requestPermission({ mode: 'readwrite' })) === 'granted') return saved
    return null
  }
  try {
    const handle = await window.showDirectoryPicker({ id: 'hamtade-bilder', mode: 'readwrite', startIn: 'downloads' })
    await saveDownloadFolder(handle)
    return handle
  } catch (error) {
    if (error instanceof DOMException && error.name === 'AbortError') return null
    throw error
  }
}

// Laddar ner originalen, och för ett RAW+JPG-par båda filerna. Med only bara
// den filen, t.ex. JPG:en i ett RAW+JPG-par.
export async function downloadImages(
  bank: FileSystemDirectoryHandle,
  target: FileSystemDirectoryHandle,
  images: ImageRecord[],
  only?: string,
): Promise<DownloadResult> {
  const result: DownloadResult = { saved: [], existed: [], missing: [], blocked: [] }
  for (const image of images) {
    if (image.blocked) {
      result.blocked.push(image.id)
      continue
    }
    for (const path of [image.path, ...image.alternates].filter((path) => !only || path === only)) {
      const name = downloadName(image.id, path)
      if (await findFile(target, name)) {
        result.existed.push(name)
        continue
      }
      const file = await readFile(bank, path)
      if (!file) {
        result.missing.push(path)
        continue
      }
      await writeFile(target, name, file)
      result.saved.push(name)
    }
  }
  return result
}

// "2 bilder hämtades till Hämtade bilder. 1 fanns redan."
export function resultText(result: DownloadResult, folder: string): string {
  const files = (n: number) => (n === 1 ? '1 fil' : `${n} filer`)
  const parts = []
  if (result.saved.length) parts.push(`${files(result.saved.length)} hämtades till ${folder}.`)
  if (result.existed.length) {
    parts.push(
      result.existed.length === 1 && !result.saved.length
        ? `${result.existed[0]} finns redan i ${folder}.`
        : `${files(result.existed.length)} fanns redan och hämtades inte igen.`,
    )
  }
  if (result.blocked.length) parts.push(`${result.blocked.length === 1 ? '1 spärrad bild' : `${result.blocked.length} spärrade bilder`} hämtades inte.`)
  if (result.missing.length) parts.push(`${files(result.missing.length)} saknas i bildbankens original-mapp: ${result.missing.join(', ')}.`)
  return parts.join(' ') || 'Inget att hämta.'
}
