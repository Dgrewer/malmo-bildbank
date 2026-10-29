import exifr from 'exifr'
import {
  BROWSER_IMAGE_EXTENSIONS,
  extension,
  HEIC_EXTENSIONS,
  RAW_EXTENSIONS,
  TIFF_EXTENSIONS,
} from '../catalog/fileFormat.ts'

// Avkodar originalen och skapar miniatyrer och förhandsbilder som WebP.
// Körs i importens Web Worker, med OffscreenCanvas.

export const THUMB_SIZE = 400
export const PREVIEW_SIZE = 1600

// Ett fel som förklarar för användaren varför förhandsbilden saknas. Meddelandet
// visas i appen som det är. Andra fel får ett allmänt inledande meddelande.
export class PreviewProblem extends Error {}

export const RAW_WITHOUT_PREVIEW =
  'RAW-filen saknar förhandsbild. Det finns ingen JPG med samma namn i mappen, och ingen JPG inbäddad i ' +
  'filen. Lägg en JPG med samma namn bredvid RAW-filen och kör importen igen.'

export const VIDEO_UNREADABLE =
  'Filmen kunde inte läsas av webbläsaren. Den är troligen kodad i ett format som den här datorn saknar stöd ' +
  'för, t.ex. HEVC (H.265). Spara en kopia i H.264, t.ex. med HandBrake, lägg den i mappen och kör importen igen.'

// En avkodad bild, rättvänd enligt EXIF.
export interface Decoded {
  image: CanvasImageSource
  width: number
  height: number
}

function canvas(width: number, height: number) {
  const result = new OffscreenCanvas(width, height)
  const context = result.getContext('2d')!
  context.imageSmoothingQuality = 'high'
  return { canvas: result, context }
}

// Vrider och speglar en bild enligt EXIF-orienteringen 1–8.
function orient(image: ImageBitmap, orientation: number | null): Decoded {
  if (!orientation || orientation === 1) return { image, width: image.width, height: image.height }
  const turned = orientation >= 5
  const width = turned ? image.height : image.width
  const height = turned ? image.width : image.height
  const { canvas: result, context } = canvas(width, height)
  const transforms: Record<number, [number, number, number, number, number, number]> = {
    2: [-1, 0, 0, 1, width, 0],
    3: [-1, 0, 0, -1, width, height],
    4: [1, 0, 0, -1, 0, height],
    5: [0, 1, 1, 0, 0, 0],
    6: [0, 1, -1, 0, width, 0],
    7: [0, -1, -1, 0, width, height],
    8: [0, -1, 1, 0, 0, height],
  }
  context.setTransform(...transforms[orientation])
  context.drawImage(image, 0, 0)
  image.close()
  return { image: result, width, height }
}

// JPG, PNG, WebP, AVIF och GIF. Webbläsaren vänder bilden enligt dess egen EXIF.
async function decodeBrowser(file: Blob): Promise<Decoded> {
  const image = await createImageBitmap(file, { imageOrientation: 'from-image' })
  return { image, width: image.width, height: image.height }
}

// TIFF kan innehålla flera bilder, t.ex. en miniatyr. Den största används.
async function decodeTiff(file: Blob, orientation: number | null): Promise<Decoded> {
  const UTIF = (await import('utif2')).default
  const buffer = await file.arrayBuffer()
  const pages = UTIF.decode(buffer)
  const area = (page: (typeof pages)[number]) => Number(page.t256 ?? 0) * Number(page.t257 ?? 0)
  const page = pages.sort((a, b) => area(b) - area(a))[0]
  if (!page) throw new Error('TIFF-filen innehåller ingen bild')
  UTIF.decodeImage(buffer, page)
  const rgba = UTIF.toRGBA8(page)
  const image = await createImageBitmap(new ImageData(new Uint8ClampedArray(rgba.buffer as ArrayBuffer, rgba.byteOffset, rgba.byteLength), page.width, page.height))
  return orient(image, orientation)
}

// libheif tillämpar HEIC-filens egen rotation, så pixlarna är redan rättvända.
// WebAssembly-filen är inbakad i biblioteket och laddas först när den behövs.
async function decodeHeic(file: Blob): Promise<Decoded> {
  const factory = (await import('libheif-js/libheif-wasm/libheif-bundle.mjs')).default
  const libheif = factory()
  const decoder = new libheif.HeifDecoder()
  const images = decoder.decode(new Uint8Array(await file.arrayBuffer()))
  try {
    if (!images.length) throw new Error('HEIC-filen innehåller ingen bild')
    const first = images[0]
    const width = first.get_width()
    const height = first.get_height()
    const pixels = await new Promise<ImageData>((resolve, reject) => {
      const target = new ImageData(width, height)
      first.display(target, (result: ImageData | null) =>
        result ? resolve(result) : reject(new Error('HEIC-filen kunde inte avkodas')),
      )
    })
    const image = await createImageBitmap(pixels)
    return { image, width, height }
  } finally {
    for (const image of images) image.free()
    decoder.decoder.delete()
  }
}

// Storlek och antal färgkanaler för en JPG, ur rubrikerna, utan att avkoda den.
// Bara vanliga JPG (baseline och progressive) räknas. Själva RAW-datan kan också
// vara kodad som förlustfri JPEG och väljs bort.
function jpegSize(data: Uint8Array, start: number): number {
  let offset = start + 2
  while (offset + 9 < data.length) {
    if (data[offset] !== 0xff) return 0
    const marker = data[offset + 1]
    const length = (data[offset + 2] << 8) | data[offset + 3]
    if (marker === 0xc0 || marker === 0xc1 || marker === 0xc2) {
      const height = (data[offset + 5] << 8) | data[offset + 6]
      const width = (data[offset + 7] << 8) | data[offset + 8]
      return data[offset + 9] === 3 ? width * height : 0
    }
    if (marker === 0xda || length < 2) return 0
    offset += 2 + length
  }
  return 0
}

// Den största vanliga JPG-bilden inuti en RAW-fil.
export function embeddedJpeg(data: Uint8Array): Uint8Array | null {
  let best: { start: number; pixels: number } | null = null
  for (let offset = 0, found = 0; offset < data.length - 3 && found < 64; offset++) {
    if (data[offset] !== 0xff || data[offset + 1] !== 0xd8 || data[offset + 2] !== 0xff) continue
    found++
    const pixels = jpegSize(data, offset)
    if (pixels > (best?.pixels ?? 0)) best = { start: offset, pixels }
  }
  return best ? data.subarray(best.start) : null
}

// En JPG inbäddad i en RAW-fil saknar ofta egen orientering. Då gäller RAW-filens.
async function decodeRaw(file: Blob, orientation: number | null): Promise<Decoded> {
  const jpeg = embeddedJpeg(new Uint8Array(await file.arrayBuffer()))
  if (!jpeg) throw new PreviewProblem(RAW_WITHOUT_PREVIEW)
  const blob = new Blob([jpeg as Uint8Array<ArrayBuffer>], { type: 'image/jpeg' })
  const own = await exifr.orientation(blob).catch(() => undefined)
  const image = await createImageBitmap(blob, { imageOrientation: 'from-image' })
  return own ? { image, width: image.width, height: image.height } : orient(image, orientation)
}

// Avkodar en bildfil. RAW-filer avkodas inte. I stället används JPG:en bredvid
// dem (companion), och annars den JPG som är inbäddad i filen.
export async function decodeImage(
  file: File,
  orientation: number | null,
  companion?: File,
  companionOrientation: number | null = null,
): Promise<Decoded> {
  const ext = extension(file.name)
  if (RAW_EXTENSIONS.has(ext)) {
    return companion ? decodeImage(companion, companionOrientation) : decodeRaw(file, orientation)
  }
  if (HEIC_EXTENSIONS.has(ext)) return decodeHeic(file)
  if (TIFF_EXTENSIONS.has(ext)) return decodeTiff(file, orientation)
  if (BROWSER_IMAGE_EXTENSIONS.has(ext)) return decodeBrowser(file)
  throw new Error(`Formatet .${ext} kan inte läsas`)
}

// Skalar ner i steg om högst hälften, så att förminskningen blir skarp.
// Bilder förstoras aldrig.
export async function toWebp(decoded: Decoded, maxSide: number, quality: number): Promise<Blob> {
  const scale = Math.min(1, maxSide / Math.max(decoded.width, decoded.height))
  const width = Math.max(1, Math.round(decoded.width * scale))
  const height = Math.max(1, Math.round(decoded.height * scale))
  let source = decoded.image
  let [currentWidth, currentHeight] = [decoded.width, decoded.height]
  while (currentWidth / 2 > width) {
    currentWidth = Math.round(currentWidth / 2)
    currentHeight = Math.round(currentHeight / 2)
    const step = canvas(currentWidth, currentHeight)
    step.context.drawImage(source, 0, 0, currentWidth, currentHeight)
    source = step.canvas
  }
  const result = canvas(width, height)
  result.context.drawImage(source, 0, 0, width, height)
  return result.canvas.convertToBlob({ type: 'image/webp', quality })
}
