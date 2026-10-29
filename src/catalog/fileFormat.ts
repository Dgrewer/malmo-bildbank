// Filformat för originalen. Delas av indexeringen och appen.

export const RAW_EXTENSIONS = new Set(['cr2', 'cr3', 'nef', 'arw', 'dng'])
export const HEIC_EXTENSIONS = new Set(['heic', 'heif'])
export const VIDEO_EXTENSIONS = new Set(['mp4', 'mov', 'm4v'])

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

export function isVideo(path: string): boolean {
  return VIDEO_EXTENSIONS.has(extension(path))
}

// "original/A/IMG_1.CR2" -> "RAW (CR2)", "bild.jpeg" -> "JPG", "film.MP4" -> "Video (MP4)"
export function fileFormat(path: string): string {
  const ext = extension(path)
  if (RAW_EXTENSIONS.has(ext)) return `RAW (${ext.toUpperCase()})`
  if (VIDEO_EXTENSIONS.has(ext)) return `Video (${ext.toUpperCase()})`
  return NAMES[ext] ?? (ext.toUpperCase() || 'Okänt format')
}

// 6.4 -> "0:06", 3725 -> "1:02:05"
export function formatDuration(seconds: number): string {
  const total = Math.round(seconds)
  const pad = (n: number) => String(n).padStart(2, '0')
  const [h, m, s] = [Math.floor(total / 3600), Math.floor((total % 3600) / 60), total % 60]
  return h ? `${h}:${pad(m)}:${pad(s)}` : `${m}:${pad(s)}`
}

export function fileName(path: string): string {
  return path.split('/').pop() ?? path
}
