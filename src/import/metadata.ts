import exifr from 'exifr'

// Uppgifter som läses ur bildfilens EXIF, IPTC och XMP.
export interface Metadata {
  byline: string
  takenAt: string | null
  tags: string[]
  description: string
  // Storleken enligt metadata, efter EXIF-rotation. 0 om den saknas.
  width: number
  height: number
  orientation: number | null
}

// exifr:s resultat har inga typer. Fälten nedan är de som används.
type Tags = Record<string, unknown>

// "2016:09:13 14:05:00" -> "2016-09-13T14:05:00". EXIF saknar tidszon, så
// tiden lagras som lokal tid utan zon.
export function exifDate(value: unknown): string | null {
  if (typeof value !== 'string') return null
  const match = value.match(/^(\d{4}):(\d{2}):(\d{2})[ T](\d{2}):(\d{2}):(\d{2})/)
  if (!match || match[1] === '0000') return null
  return `${match[1]}-${match[2]}-${match[3]}T${match[4]}:${match[5]}:${match[6]}`
}

// IPTC-text är ofta UTF-8 utan att filen säger det, och exifr läser den då som
// Latin-1 ("MalmÃ¶"). Avkoda om, men bara om resultatet är giltig UTF-8.
export function fixEncoding(value: string): string {
  if (!/[Â-ô][\u0080-¿]/.test(value)) return value
  if ([...value].some((char) => char.charCodeAt(0) > 0xff)) return value
  const bytes = Uint8Array.from(value, (char) => char.charCodeAt(0))
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes)
  } catch {
    return value
  }
}

// Texter som kameror och program skriver in automatiskt och som inte beskriver bilden.
const CAMERA_DEFAULTS = /^(default|OLYMPUS DIGITAL CAMERA|SONY DSC|DCIM[\\/].*|[\w-]+\.jpe?g)$/i

export function text(value: unknown): string {
  if (typeof value === 'string') {
    const cleaned = fixEncoding(value).replace(/\r\n?/g, '\n').trim()
    return CAMERA_DEFAULTS.test(cleaned) ? '' : cleaned
  }
  if (Array.isArray(value)) return text(value[0])
  if (value && typeof value === 'object' && 'value' in value) return text(value.value)
  return ''
}

export function list(value: unknown): string[] {
  const values = Array.isArray(value) ? value : value ? [value] : []
  return [...new Set(values.map(text).filter(Boolean))]
}

function number(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? Math.round(value) : 0
}

// exifr översätter EXIF-orienteringen till text, t.ex. "Rotate 90 CW". Här
// översätts den tillbaka till EXIF-värdet 1–8.
const ORIENTATIONS = [
  'Horizontal (normal)',
  'Mirror horizontal',
  'Rotate 180',
  'Mirror vertical',
  'Mirror horizontal and rotate 270 CW',
  'Rotate 90 CW',
  'Mirror horizontal and rotate 90 CW',
  'Rotate 270 CW',
]

function orientationValue(value: unknown): number | null {
  if (typeof value === 'string') return ORIENTATIONS.indexOf(value) + 1 || null
  return number(value) || null
}

// I webbläsaren en Blob, så att exifr bara läser början av filen. I Node (testerna) byte-data.
type Source = Blob | Uint8Array

async function parse(file: Source): Promise<Tags | null> {
  try {
    return (await exifr.parse(file, { iptc: true, xmp: true, reviveValues: false, mergeOutput: true })) ?? null
  } catch {
    return null
  }
}

// Läser metadata ur originalet. Saknar originalet metadata, t.ex. en RAW-fil som
// exifr inte kan läsa, används JPG:en bredvid den.
export async function readMetadata(file: Source, companion?: Source): Promise<Metadata> {
  const tags = (await parse(file)) ?? (companion ? await parse(companion) : null) ?? {}
  const orientation = orientationValue(tags.Orientation)
  let width = number(tags.ExifImageWidth) || number(tags.PixelXDimension) || number(tags.ImageWidth)
  let height = number(tags.ExifImageHeight) || number(tags.PixelYDimension) || number(tags.ImageHeight)
  // Orientering 5–8 betyder att bilden ska vridas 90 grader.
  if (orientation && orientation >= 5) [width, height] = [height, width]
  return {
    byline: text(tags.Byline) || text(tags.Artist) || text(tags.creator),
    takenAt: exifDate(tags.DateTimeOriginal) ?? exifDate(tags.CreateDate),
    tags: list(tags.Keywords ?? tags.subject),
    description: text(tags.Caption) || text(tags.ImageDescription) || text(tags.description),
    width,
    height,
    orientation,
  }
}
