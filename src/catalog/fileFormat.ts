// Filformat för originalen. Delas av indexeringen och appen.

export const RAW_EXTENSIONS = new Set(['cr2', 'cr3', 'nef', 'arw', 'dng'])
export const HEIC_EXTENSIONS = new Set(['heic', 'heif'])

const NAMES: Record<string, string> = {
  jpg: 'JPG',
  jpeg: 'JPG',
  jfif: 'JPG',
  avif: 'AVIF',
  png: 'PNG',
  tif: 'TIFF',
  tiff: 'TIFF',
  heic: 'HEIC',
  heif: 'HEIF',
  webp: 'WebP',
  gif: 'GIF',
}

export function extension(path: string): string {
  const name = path.split('/').pop() ?? ''
  const dot = name.lastIndexOf('.')
  return dot > 0 ? name.slice(dot + 1).toLowerCase() : ''
}

// "original/A/IMG_1.CR2" -> "RAW (CR2)", "bild.jpeg" -> "JPG"
export function fileFormat(path: string): string {
  const ext = extension(path)
  if (RAW_EXTENSIONS.has(ext)) return `RAW (${ext.toUpperCase()})`
  return NAMES[ext] ?? (ext.toUpperCase() || 'Okänt format')
}

export function fileName(path: string): string {
  return path.split('/').pop() ?? path
}
