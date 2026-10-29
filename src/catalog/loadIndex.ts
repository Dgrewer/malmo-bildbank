import { readFile } from '../fs/folder.ts'
import { INDEX_VERSION, type ImageRecord, type IndexFile } from './types.ts'

export class IndexError extends Error {}

// Läser app-data/index.json, eller null om bildbanken inte har indexerats än.
export async function readIndexFile(root: FileSystemDirectoryHandle): Promise<IndexFile | null> {
  const file = await readFile(root, 'app-data/index.json')
  if (!file) return null
  let index: IndexFile
  try {
    index = JSON.parse(await file.text())
  } catch (error) {
    throw new IndexError(`app-data/index.json går inte att läsa: ${error instanceof Error ? error.message : error}`)
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
      durationSeconds: image.durationSeconds ?? null,
      previewProblem: image.previewProblem ?? null,
      hash: image.hash ?? null,
      fileSize: image.fileSize ?? null,
      fileModified: image.fileModified ?? null,
    })),
  }
}

export async function loadIndex(root: FileSystemDirectoryHandle): Promise<ImageRecord[]> {
  const index = await readIndexFile(root)
  if (!index) {
    throw new IndexError('Hittar inte app-data/index.json. Bildbanken har inte indexerats än. Välj Importera.')
  }
  return index.images
}
