import { readFile } from '../fs/folder.ts'
import { INDEX_VERSION, type ImageRecord, type IndexFile } from './types.ts'

export class IndexError extends Error {}

// Tolkar innehållet i en indexfil. Kastar IndexError om det inte är ett
// giltigt index, t.ex. en tom eller halvskriven fil.
export function parseIndex(text: string, name = 'app-data/index.json'): IndexFile {
  let index: IndexFile
  try {
    index = JSON.parse(text)
  } catch (error) {
    throw new IndexError(`${name} går inte att läsa: ${error instanceof Error ? error.message : error}`)
  }
  if (!index || typeof index !== 'object' || !Array.isArray(index.images)) {
    throw new IndexError(`${name} är inte ett index.`)
  }
  if (index.version !== INDEX_VERSION) {
    throw new IndexError(
      `Indexet har version ${index.version}, men appen kan bara läsa version ${INDEX_VERSION}. Uppdatera appen.`,
    )
  }
  // Fälten nedan kom till efter version 1 och saknas i äldre index.
  return {
    ...index,
    images: index.images.map((image) => ({
      ...image,
      alternates: image.alternates ?? [],
      aiTags: image.aiTags ?? [],
      durationSeconds: image.durationSeconds ?? null,
      previewProblem: image.previewProblem ?? null,
      hash: image.hash ?? null,
      fileSize: image.fileSize ?? null,
      fileModified: image.fileModified ?? null,
    })),
  }
}

export function isValidIndex(text: string): boolean {
  try {
    parseIndex(text)
    return true
  } catch {
    return false
  }
}

// Läser app-data/index.json, eller null om bildbanken inte har indexerats än.
export async function readIndexFile(root: FileSystemDirectoryHandle): Promise<IndexFile | null> {
  const file = await readFile(root, 'app-data/index.json')
  return file ? parseIndex(await file.text()) : null
}

export async function loadIndex(root: FileSystemDirectoryHandle): Promise<ImageRecord[]> {
  const index = await readIndexFile(root)
  if (!index) {
    throw new IndexError('Hittar inte app-data/index.json. Bildbanken har inte indexerats än. Välj Importera.')
  }
  return index.images
}
