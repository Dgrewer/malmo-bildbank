import { readFile } from '../fs/folder.ts'
import { INDEX_VERSION, type ImageRecord, type IndexFile } from './types.ts'

export class IndexError extends Error {}

export async function loadIndex(root: FileSystemDirectoryHandle): Promise<ImageRecord[]> {
  const file = await readFile(root, 'app-data/index.json')
  if (!file) {
    throw new IndexError('Hittar inte app-data/index.json. Bildbanken har inte indexerats än.')
  }
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
  // alternates kom till efter version 1 och saknas i äldre index.
  return index.images.map((image) => ({ ...image, alternates: image.alternates ?? [] }))
}
