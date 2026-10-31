// Kör appen i headless Chrome mot testdata/ via testkroken ?testdata.
//
//   npm run test:e2e            alla tester
//   npm run test:e2e -- 3.4     bara tester vars namn börjar med 3.4
//
// Använder den Chrome som redan är installerad (CHROME_PATH kan sätta en annan).
// Om Chrome inte tillåter fjärrstyrning (organisationspolicyn
// RemoteDebuggingAllowed) används Edge, som har samma Chromium-motor.
// Testet underkänns om sidan gör ett enda anrop utanför localhost, om CSP:n
// blockerar något eller om sidan kastar ett fel.

import { existsSync, openAsBlob } from 'node:fs'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import puppeteer, { type Browser, type Page } from 'puppeteer-core'
import { build, createServer } from 'vite'
import { decodeVectors } from '../src/ai/embeddings.ts'
import { MODEL } from '../src/ai/modelInfo.ts'
import { findDuplicates } from '../src/catalog/duplicates.ts'
import {
  extension,
  fileFormat,
  fileName,
  formatDuration,
  formatResolution,
  isSupported,
  isSystemDirectory,
  isSystemFile,
  isVideo,
  RAW_COMPANIONS,
  RAW_EXTENSIONS,
} from '../src/catalog/fileFormat.ts'
import { combinedHash, quickHash } from '../src/import/hash.ts'
import { readMetadata } from '../src/import/metadata.ts'
import { placeAt, placeWithTags } from '../src/catalog/places.ts'
import { readVideoInfo } from '../src/import/video.ts'
import UTIF from 'utif2'
import { formatTaken } from '../src/catalog/rights.ts'
import type { ImageRecord, IndexFile } from '../src/catalog/types.ts'
import type { BankConfig } from '../src/ai/tagConfig.ts'

const PORT = 5199
const ORIGIN = `http://localhost:${PORT}`
const filter = process.argv[2] ?? ''

const BROWSERS = [
  process.env.CHROME_PATH,
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
  '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
].filter((candidate): candidate is string => !!candidate && existsSync(candidate))

async function launchBrowser(userDataDir: string): Promise<Browser> {
  for (const executablePath of BROWSERS) {
    try {
      const profile = path.join(userDataDir, path.basename(executablePath, path.extname(executablePath)))
      const launched = await puppeteer.launch({ executablePath, headless: true, userDataDir: profile, timeout: 15_000 })
      console.log(`Webbläsare: ${(await launched.version())} (${path.basename(executablePath)})\n`)
      return launched
    } catch {
      console.log(`${path.basename(executablePath)} gick inte att styra, provar nästa.`)
    }
  }
  throw new Error('Hittar ingen Chrome eller Edge som går att styra. Sätt CHROME_PATH.')
}

const problems: string[] = []
let failed = 0

async function test(name: string, run: () => Promise<void>) {
  if (!name.startsWith(filter)) return
  try {
    await run()
    console.log(`  ✓ ${name}`)
  } catch (error) {
    failed++
    // Raden i testet där felet uppstod, om den finns i stacken.
    const where = error instanceof Error ? error.stack?.match(/e2e\.ts:\d+/)?.[0] : undefined
    console.log(`  ✗ ${name}\n      ${error instanceof Error ? error.message : error}${where ? ` (${where})` : ''}`)
  }
}

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message)
}

let browser: Browser

async function openPage(url: string, setup?: (page: Page) => Promise<unknown>): Promise<Page> {
  const page = await browser.newPage()
  await page.setViewport({ width: 1280, height: 900 })
  page.on('request', (request) => {
    const target = request.url()
    if (!target.startsWith(ORIGIN) && !target.startsWith('blob:') && !target.startsWith('data:')) {
      problems.push(`Externt anrop: ${target}`)
    }
  })
  page.on('response', (response) => {
    if (response.status() >= 400) problems.push(`HTTP ${response.status()}: ${response.url()}`)
  })
  page.on('pageerror', (error) => problems.push(`Sidfel: ${error}`))
  page.on('console', (message) => {
    // Misslyckade anrop rapporteras med URL via 'response' ovan.
    if (message.type() === 'error' && !message.text().startsWith('Failed to load resource')) {
      problems.push(`Konsolfel: ${message.text()}`)
    }
  })
  await page.evaluateOnNewDocument(() => {
    document.addEventListener('securitypolicyviolation', (event) =>
      console.error(`CSP blockerade ${event.blockedURI} (${event.violatedDirective})`),
    )
  })
  await setup?.(page)
  await page.goto(ORIGIN + url)
  return page
}

async function waitForText(page: Page, text: string, timeout = 30_000) {
  await page
    .waitForFunction((t) => document.body.innerText.includes(t), { timeout }, text)
    .catch(async () => {
      // Felmeddelanden på sidan gör det lättare att se varför.
      const alerts = await page
        .evaluate(() =>
          [...document.querySelectorAll('[role="alert"], [role="status"], .error, .import-progress')]
            .map((element) => element.textContent?.trim())
            .join(' | '),
        )
        .catch(() => '')
      throw new Error(`Texten "${text}" syntes inte${alerts ? `. Sidan visar: ${alerts}` : ''}`)
    })
}

async function bodyText(page: Page): Promise<string> {
  return page.evaluate(() => document.body.innerText)
}

// SCREENSHOTS=<mapp> sparar skärmbilder för manuell granskning.
async function screenshot(page: Page, name: string) {
  if (!process.env.SCREENSHOTS) return
  await fs.mkdir(process.env.SCREENSHOTS, { recursive: true })
  await page.screenshot({ path: path.join(process.env.SCREENSHOTS, `${name}.png`) })
}

// Skärmbild av bara ett element, t.ex. formuläret utan fotot.
async function elementScreenshot(page: Page, selector: string, name: string) {
  if (!process.env.SCREENSHOTS) return
  await fs.mkdir(process.env.SCREENSHOTS, { recursive: true })
  await (await page.$(selector))!.screenshot({ path: path.join(process.env.SCREENSHOTS, `${name}.png`) })
}

// Lägger till vilket steg som misslyckades i felet.
async function step<T>(label: string, promise: Promise<T>): Promise<T> {
  try {
    return await promise
  } catch (error) {
    throw new Error(`${label}: ${error instanceof Error ? error.message : error}`)
  }
}

async function clickButton(page: Page, text: string) {
  await step(`Knappen "${text}"`, page.locator(`button::-p-text(${text})`).click())
}

// Körs i sidan före appen: räknar object-URL:er som skapas och frigörs.
function countObjectUrls() {
  const live = new Set<string>()
  const stats = { created: 0, revoked: 0, live }
  ;(window as unknown as { __urlStats: typeof stats }).__urlStats = stats
  const create = URL.createObjectURL.bind(URL)
  const revoke = URL.revokeObjectURL.bind(URL)
  URL.createObjectURL = (object) => {
    const url = create(object)
    stats.created++
    live.add(url)
    return url
  }
  URL.revokeObjectURL = (url) => {
    stats.revoked++
    live.delete(url)
    revoke(url)
  }
}

async function galleryState(page: Page) {
  return page.evaluate(() => {
    const stats = (window as unknown as { __urlStats: { created: number; revoked: number; live: Set<string> } })
      .__urlStats
    const cells = [...document.querySelectorAll<HTMLElement>('.gallery-cell')]
    const images = [...document.querySelectorAll<HTMLImageElement>('.gallery-cell img')]
    return {
      cells: cells.length,
      loaded: images.filter((image) => image.complete && image.naturalWidth > 0).length,
      lastIndex: Math.max(...cells.map((cell) => Number(cell.dataset.index))),
      created: stats.created,
      revoked: stats.revoked,
      live: stats.live.size,
    }
  })
}

// Väntar tills rutnätet har ritat rutor inom den synliga ytan och varje ruta har
// en inläst miniatyr (eller visar att den saknas).
async function waitForThumbnails(page: Page) {
  await page.waitForFunction(
    () => {
      const gallery = document.querySelector('.gallery')
      if (!gallery) return false
      const view = gallery.getBoundingClientRect()
      const cells = [...document.querySelectorAll('.gallery-cell')]
      return (
        cells.some((cell) => {
          const rect = cell.getBoundingClientRect()
          return rect.top >= view.top && rect.bottom <= view.bottom
        }) &&
        cells.every((cell) => {
          const image = cell.querySelector('img')
          return cell.querySelector('.thumb-missing, .thumb-problem') || (image && image.complete && image.naturalWidth > 0)
        })
      )
    },
    { timeout: 30_000 },
  )
}

// Går igenom originalmappen med samma regler som importen: systemfiler hoppas
// över, en RAW-fil och en JPG med samma namn är en bild, filer med samma
// innehåll räknas en gång, och av filer med samma namn och tagningstid behålls
// den med högst upplösning. Metadata läses med exifr i Node, från hela filen.
async function expectedImport(root: string) {
  const files: string[][] = []
  const skipped: string[] = []
  const rawPairs: { path: string; companion: string }[] = []
  const toIndexPath = (file: string) => 'original/' + path.relative(root, file).replaceAll('\\', '/').normalize('NFC')
  async function walk(directory: string) {
    const entries = await fs.readdir(directory, { withFileTypes: true })
    const names = entries.filter((entry) => entry.isFile() && !isSystemFile(entry.name)).map((entry) => entry.name)
    const base = (name: string) => name.slice(0, name.lastIndexOf('.')).normalize('NFC').toLowerCase()
    const companions = new Map<string, string>()
    for (const name of names.filter((name) => RAW_EXTENSIONS.has(extension(name)))) {
      const companion = names
        .filter((other) => base(other) === base(name) && RAW_COMPANIONS.includes(extension(other)))
        .sort((a, b) => RAW_COMPANIONS.indexOf(extension(a)) - RAW_COMPANIONS.indexOf(extension(b)))[0]
      if (!companion) continue
      companions.set(name, companion)
      rawPairs.push({ path: toIndexPath(path.join(directory, name)), companion: toIndexPath(path.join(directory, companion)) })
    }
    for (const entry of entries) {
      const full = path.join(directory, entry.name)
      if (entry.isDirectory()) {
        if (!isSystemDirectory(entry.name)) await walk(full)
      } else if (isSystemFile(entry.name) || [...companions.values()].includes(entry.name)) continue
      else if (!isSupported(entry.name)) skipped.push(toIndexPath(full))
      else files.push([full, ...(companions.has(entry.name) ? [path.join(directory, companions.get(entry.name)!)] : [])])
    }
  }
  await walk(root)
  const byHash = new Map<string, string[]>()
  for (const parts of files.sort((a, b) => toIndexPath(a[0]).localeCompare(toIndexPath(b[0]), 'sv'))) {
    const hash = await combinedHash(await Promise.all(parts.map(async (part) => quickHash(await openAsBlob(part)))))
    if (!byHash.has(hash)) byHash.set(hash, parts)
  }
  const records: ImageRecord[] = []
  for (const [hash, [file, companion]] of byHash) {
    const id = `MB-${String(records.length + 1).padStart(6, '0')}`
    const photographer = toIndexPath(file).split('/')[1]
    const base = { ...(await testRecord(id, toIndexPath(file), photographer)), hash }
    if (isVideo(file)) records.push({ ...base, byline: `Foto: ${photographer}`, ...(await readVideoInfo(await openAsBlob(file))) })
    else {
      const metadata = await readMetadata(await fs.readFile(file), companion ? await fs.readFile(companion) : undefined)
      const { orientation: _, ...fields } = metadata
      records.push({ ...base, ...fields, byline: metadata.byline || `Foto: ${photographer}` })
    }
  }
  const dropped = findDuplicates(records)
  return {
    unique: byHash.size,
    duplicates: files.length - byHash.size,
    skipped,
    rawPairs,
    kept: records.filter((record) => !dropped.has(record)),
    droppedRecords: [...dropped],
  }
}

async function testRecord(id: string, file: string, photographer: string): Promise<ImageRecord> {
  return {
    id, path: file, photographer, byline: '', terms: '', rightsUntil: null, consent: 'not-required', blocked: false,
    width: 0, height: 0, takenAt: null, tags: [], aiTags: [], description: '', alternates: [], durationSeconds: null, place: null,
    previewProblem: null, hash: null, fileSize: null, fileModified: null,
  }
}

async function readPreview(page: Page) {
  return page.evaluate(() => {
    const number = (text: string | null | undefined) => Number((text ?? '').replace(/\s/g, ''))
    const counts = Object.fromEntries(
      [...document.querySelectorAll<HTMLElement>('.change-counts li')].map((item) => [
        item.dataset.change!,
        number(item.querySelector('strong')?.textContent),
      ]),
    ) as Record<'new' | 'changed' | 'moved' | 'removed' | 'unchanged', number>
    const lists = Object.fromEntries(
      [...document.querySelectorAll('.change-list')].map((list) => [
        list.querySelector('summary')!.textContent!.split(':')[0],
        [...list.querySelectorAll('li')].map((item) => item.textContent!),
      ]),
    ) as Record<string, string[]>
    return { counts, lists }
  })
}

// Kontrollerar att en bildbank i OPFS är hel: index.json och index.prev.json är
// giltiga om de finns, index.tmp.json finns inte, och varje bild i indexet och
// i en pågående import har miniatyr och förhandsbild (utom de med previewProblem).
async function bankProblems(page: Page, bank: string) {
  return page.evaluate(async (bank) => {
    const problems: string[] = []
    const appData = await (await (await navigator.storage.getDirectory()).getDirectoryHandle(bank)).getDirectoryHandle('app-data')
    const text = async (directory: FileSystemDirectoryHandle, name: string) => {
      try {
        return await (await (await directory.getFileHandle(name)).getFile()).text()
      } catch {
        return null
      }
    }
    const names = async (folder: string) => {
      const result = new Set<string>()
      for await (const name of (await appData.getDirectoryHandle(folder, { create: true })).keys()) result.add(name)
      return result
    }
    const [thumbs, previews] = [await names('thumbs'), await names('previews')]
    type Record = { id: string; previewProblem: string | null }
    const checkImages = (records: Record[], source: string) => {
      for (const record of records) {
        if (record.previewProblem) continue
        if (!thumbs.has(`${record.id}.webp`)) problems.push(`${source}: ${record.id} saknar miniatyr`)
        if (!previews.has(`${record.id}.webp`)) problems.push(`${source}: ${record.id} saknar förhandsbild`)
      }
    }
    const parse = (value: string | null, name: string): { images: Record[] } | null => {
      if (value === null) return null
      try {
        const parsed = JSON.parse(value)
        if (Array.isArray(parsed.images)) return parsed
      } catch {
        // Rapporteras nedan.
      }
      problems.push(`${name} är inte ett giltigt index`)
      return null
    }
    const index = parse(await text(appData, 'index.json'), 'index.json')
    parse(await text(appData, 'index.prev.json'), 'index.prev.json')
    if ((await text(appData, 'index.tmp.json')) !== null) problems.push('index.tmp.json ligger kvar')
    if (index) checkImages(index.images, 'index.json')
    let journal: Record[] = []
    try {
      const log = await text(await appData.getDirectoryHandle('import'), 'pagaende.jsonl')
      journal = (log ?? '').split('\n').filter(Boolean).map((line) => JSON.parse(line))
    } catch {
      // Ingen pågående import.
    }
    checkImages(journal, 'pagaende.jsonl')
    return { problems, index: !!index, journal: journal.length }
  }, bank)
}

// En TIFF på 300×200 med röd vänsterhalva och blå högerhalva, som base64.
function tiffFixture(orientation: number): string {
  const [width, height] = [300, 200]
  const rgba = new Uint8Array(width * height * 4)
  for (let n = 0; n < width * height; n++) {
    const left = n % width < width / 2
    rgba.set(left ? [220, 20, 20, 255] : [20, 20, 220, 255], n * 4)
  }
  const tiff = UTIF.encodeImage(rgba, width, height, { t274: [orientation] } as unknown as UTIF.IFD)
  return Buffer.from(tiff).toString('base64')
}

// Bredd och höjd för miniatyrer och förhandsbilder i OPFS. Saknas en fil, eller
// är den inte WebP, saknas bilden i svaret.
async function imageSizes(page: Page, bank: string, ids: string[]) {
  return page.evaluate(
    async (bank, ids) => {
      const appData = await (await (await navigator.storage.getDirectory()).getDirectoryHandle(bank)).getDirectoryHandle('app-data')
      const result: Record<string, { thumb: number[]; preview: number[] }> = {}
      async function size(folder: string, id: string) {
        const file = await (await (await appData.getDirectoryHandle(folder)).getFileHandle(`${id}.webp`)).getFile()
        const header = new TextDecoder().decode(await file.slice(0, 12).arrayBuffer())
        if (!header.startsWith('RIFF') || !header.endsWith('WEBP')) throw new Error('inte WebP')
        const bitmap = await createImageBitmap(file)
        const dimensions = [bitmap.width, bitmap.height]
        bitmap.close()
        return dimensions
      }
      for (const id of ids) {
        try {
          result[id] = { thumb: await size('thumbs', id), preview: await size('previews', id) }
        } catch {
          // Saknas i svaret.
        }
      }
      return result
    },
    bank,
    ids,
  )
}

// Färgen i förhandsbildens vänstra och högra kant (plain) och övre och nedre kant (turned).
async function previewColors(page: Page, bank: string, plain: string, turned: string) {
  return page.evaluate(
    async (bank, plain, turned) => {
      const previews = await (await (await (await navigator.storage.getDirectory()).getDirectoryHandle(bank)).getDirectoryHandle('app-data')).getDirectoryHandle('previews')
      async function colors(id: string, points: (w: number, h: number) => [number, number][]) {
        const bitmap = await createImageBitmap(await (await previews.getFileHandle(`${id}.webp`)).getFile())
        const canvas = new OffscreenCanvas(bitmap.width, bitmap.height)
        const context = canvas.getContext('2d')!
        context.drawImage(bitmap, 0, 0)
        return points(bitmap.width, bitmap.height)
          .map(([x, y]) => {
            const [r, , b] = context.getImageData(x, y, 1, 1).data
            return r > 150 && b < 100 ? 'röd' : b > 150 && r < 100 ? 'blå' : `rgb(${r},?,${b})`
          })
          .join(',')
      }
      return {
        plain: await colors(plain, (w, h) => [[10, h / 2], [w - 10, h / 2]]),
        turned: await colors(turned, (w, h) => [[w / 2, 10], [w / 2, h - 10]]),
      }
    },
    bank,
    plain,
    turned,
  )
}

const DUPLICATES_TITLE = 'Dubbletter med samma namn och tagningstid, togs inte med'

async function readPreviewLists(page: Page) {
  return (await readPreview(page)).lists
}

async function waitForPreview(page: Page) {
  await page.waitForSelector('.import-preview', { timeout: 120_000 })
  return readPreview(page)
}

// Bilderna i en fotografmapp, med en vanlig JPG som original.
function pick(index: IndexFile, photographer: string, n = 0): ImageRecord {
  const images = index.images.filter(
    (image) => image.photographer === photographer && /\.jpe?g$/i.test(image.path) && !image.alternates.length,
  )
  assert(images.length > n, `Testdata har för få JPG-bilder i ${photographer}`)
  return images[n]
}

// Hjälpfunktioner för filerna i OPFS. Sökvägar i indexformat (original/...)
// pekar på testdatats mapp Original.
async function readOpfs(page: Page, file: string): Promise<string | null> {
  return page.evaluate(async (file) => {
    let directory = await navigator.storage.getDirectory()
    const parts = file.split('/')
    const name = parts.pop()!
    try {
      for (const part of parts) directory = await directory.getDirectoryHandle(part)
      return await (await (await directory.getFileHandle(name)).getFile()).text()
    } catch {
      return null
    }
  }, file)
}

type OpfsOperation = 'read' | 'write' | 'append' | 'delete'

// Läser (som base64), skriver, lägger till eller tar bort en fil i en bildbank i OPFS.
async function opfs(page: Page, bank: string, file: string, operation: OpfsOperation, ...args: string[]) {
  return page.evaluate(
    async (bank, file, operation, args) => {
      const parts = ['Original', ...file.split('/').slice(1)]
      const name = parts.pop()!
      let directory = await (await navigator.storage.getDirectory()).getDirectoryHandle(bank)
      for (const part of parts) directory = await directory.getDirectoryHandle(part, { create: true })
      if (operation === 'delete') return void (await directory.removeEntry(name))
      const handle = await directory.getFileHandle(name, { create: operation === 'write' })
      if (operation === 'read') {
        let text = ''
        for (const byte of new Uint8Array(await (await handle.getFile()).arrayBuffer())) text += String.fromCharCode(byte)
        return btoa(text)
      }
      const writable = await handle.createWritable({ keepExistingData: operation === 'append' })
      if (operation === 'append') await writable.seek((await handle.getFile()).size)
      else await writable.write(Uint8Array.from(atob(args[0]), (char) => char.charCodeAt(0)))
      await writable.write(args.at(-1)!)
      await writable.close()
    },
    bank,
    file,
    operation,
    args,
  )
}

const opfsDelete = (page: Page, bank: string, file: string) => opfs(page, bank, file, 'delete')
const opfsAppend = (page: Page, bank: string, file: string, text: string) => opfs(page, bank, file, 'append', text)

// Skriver en textfil i OPFS, t.ex. "importtest/app-data/config.json".
async function writeOpfs(page: Page, path: string, text: string) {
  await page.evaluate(
    async (path, text) => {
      const parts = path.split('/')
      const name = parts.pop()!
      let directory = await navigator.storage.getDirectory()
      for (const part of parts) directory = await directory.getDirectoryHandle(part, { create: true })
      const writable = await (await directory.getFileHandle(name, { create: true })).createWritable()
      await writable.write(text)
      await writable.close()
    },
    path,
    text,
  )
}

// Filerna med taggarnas textvektorer i en bildbanks app-data.
async function tagVectorFiles(page: Page, bank: string): Promise<string[]> {
  return page.evaluate(async (bank) => {
    const appData = await (await (await navigator.storage.getDirectory()).getDirectoryHandle(bank)).getDirectoryHandle('app-data')
    const names: string[] = []
    for await (const name of appData.keys()) if (name.startsWith('ai-taggar')) names.push(name)
    return names.sort()
  }, bank)
}

// Läser en fil i OPFS som bytes, t.ex. "importtest/app-data/embeddings.bin".
async function readOpfsBytes(page: Page, path: string): Promise<Buffer | null> {
  const base64 = await page.evaluate(async (path) => {
    const parts = path.split('/')
    const name = parts.pop()!
    try {
      let directory = await navigator.storage.getDirectory()
      for (const part of parts) directory = await directory.getDirectoryHandle(part)
      const bytes = new Uint8Array(await (await (await directory.getFileHandle(name)).getFile()).arrayBuffer())
      let text = ''
      for (let i = 0; i < bytes.length; i += 0x8000) text += String.fromCharCode(...bytes.subarray(i, i + 0x8000))
      return btoa(text)
    } catch {
      return null
    }
  }, path)
  return base64 === null ? null : Buffer.from(base64, 'base64')
}

function toArrayBuffer(buffer: Buffer): ArrayBuffer {
  return buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + buffer.byteLength) as ArrayBuffer
}

// Kopierar en fil. Med extra läggs text till på slutet, så att innehållet blir ett annat.
async function opfsCopy(page: Page, bank: string, from: string, to: string, extra = '') {
  await opfs(page, bank, to, 'write', (await opfs(page, bank, from, 'read')) as string, extra)
}

async function opfsMove(page: Page, bank: string, from: string, to: string) {
  await opfsCopy(page, bank, from, to)
  await opfsDelete(page, bank, from)
}

const server = await createServer({ server: { port: PORT, strictPort: true }, logLevel: 'error' })
await server.listen()
const userDataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'bildbank-e2e-'))
browser = await launchBrowser(userDataDir)

try {
  console.log('3.2 Mappväljare')

  await test('3.2 andra webbläsare får ett meddelande', async () => {
    const page = await openPage('/', (p) =>
      p.evaluateOnNewDocument(() => {
        delete (Window.prototype as unknown as Record<string, unknown>).showDirectoryPicker
        delete (window as unknown as Record<string, unknown>).showDirectoryPicker
      }),
    )
    await waitForText(page, 'Den här webbläsaren stöds inte')
    await page.close()
  })

  await test('3.2 första start visar Välj mapp', async () => {
    const page = await openPage('/')
    await waitForText(page, 'Välj bildbankens mapp')
    const text = await bodyText(page)
    assert(text.includes('Välj mapp'), 'Knappen Välj mapp saknas')
    assert(!text.includes('Återanslut'), 'Återanslut ska inte visas utan sparad mapp')
    await page.close()
  })

  await test('3.2 mapp utan original och app-data ger felmeddelande', async () => {
    const page = await openPage('/?testdata=Original')
    await waitForText(page, 'saknar undermapparna original och app-data')
    await screenshot(page, '3.2-fel-mapp')
    await page.close()
  })

  await test('3.2 mapp utan app-data ger felmeddelande', async () => {
    const page = await openPage('/?testdata&skip=app-data')
    await waitForText(page, 'Mappen ”testdata” saknar undermappen app-data')
    await page.close()
  })

  await test('3.2 felaktig mapp sparas inte', async () => {
    const page = await openPage('/')
    await waitForText(page, 'Välj bildbankens mapp')
    assert(!(await bodyText(page)).includes('Återanslut'), 'En ogiltig mapp sparades')
    await page.close()
  })

  await test('3.2 giltig mapp ansluts (original med stort O godkänns)', async () => {
    const page = await openPage('/?testdata')
    await page.waitForSelector('.topbar', { timeout: 30_000 })
    assert((await bodyText(page)).includes('testdata'), 'Mappnamnet visas inte')
    await page.close()
  })

  await test('3.2 vid ny start visas Återanslut testdata och ansluter', async () => {
    const page = await openPage('/')
    await waitForText(page, 'Återanslut testdata')
    await clickButton(page, 'Återanslut testdata')
    await page.waitForSelector('.topbar', { timeout: 10_000 })
    await page.close()
  })

  await test('3.2 testkroken finns inte i produktionsbygget', async () => {
    const outDir = path.join(userDataDir, 'dist')
    await build({ logLevel: 'error', build: { outDir, emptyOutDir: true } })
    const files = await fs.readdir(path.join(outDir, 'assets'))
    for (const file of files) {
      const content = await fs.readFile(path.join(outDir, 'assets', file), 'utf8')
      assert(!content.includes('__testdata'), `${file} innehåller testkroken`)
    }
    const html = await fs.readFile(path.join(outDir, 'index.html'), 'utf8')
    assert(html.includes(`content="default-src 'self';`), 'CSP saknas i bygget')
  })

  console.log('3.3 Testdata')

  await test('3.3 index.json, miniatyrer och förhandsbilder går att läsa i webbläsaren', async () => {
    const page = await openPage('/?testdata')
    await page.waitForSelector('.topbar', { timeout: 30_000 })
    const errors = await page.evaluate(async () => {
      const errors: string[] = []
      const root = await (window as unknown as { __bildbankTestFolder: Promise<FileSystemDirectoryHandle> })
        .__bildbankTestFolder
      const appData = await root.getDirectoryHandle('app-data')
      const index = JSON.parse(await (await (await appData.getFileHandle('index.json')).getFile()).text())
      if (index.version !== 1) errors.push(`version är ${index.version}`)
      if (!Array.isArray(index.images) || index.images.length === 0) return ['images saknas']

      const ids = new Set<string>()
      const fields = ['id', 'path', 'photographer', 'byline', 'terms', 'rightsUntil', 'consent', 'blocked', 'alternates', 'durationSeconds', 'previewProblem']
        .concat(['width', 'height', 'takenAt', 'tags', 'description'])
      for (const image of index.images) {
        const where = image.id ?? JSON.stringify(image).slice(0, 40)
        const missing = fields.filter((field) => !(field in image))
        if (missing.length) errors.push(`${where} saknar ${missing.join(', ')}`)
        if (!/^MB-\d{6}$/.test(image.id)) errors.push(`${where}: felaktigt id`)
        if (ids.has(image.id)) errors.push(`${where}: id finns två gånger`)
        ids.add(image.id)
        if (image.path !== image.path.normalize('NFC') || image.path.includes('\\')) {
          errors.push(`${where}: sökvägen är inte NFC med /`)
        }
        if (!image.path.startsWith(`original/${image.photographer}/`)) errors.push(`${where}: fel fotograf i sökvägen`)
        if (!['given', 'missing', 'not-required'].includes(image.consent)) errors.push(`${where}: consent`)
        if (image.rightsUntil !== null && !/^\d{4}-\d{2}-\d{2}$/.test(image.rightsUntil)) {
          errors.push(`${where}: rightsUntil`)
        }
        if (typeof image.blocked !== 'boolean' || !Array.isArray(image.tags)) errors.push(`${where}: typer`)

        if (image.previewProblem) continue
        for (const [folder, size] of [['thumbs', 400], ['previews', 1600]] as const) {
          const file = await (await (await appData.getDirectoryHandle(folder)).getFileHandle(`${image.id}.webp`))
            .getFile()
          const bitmap = await createImageBitmap(file)
          const longest = Math.max(bitmap.width, bitmap.height)
          const expected = Math.min(size, Math.max(image.width, image.height))
          if (Math.abs(longest - expected) > 1) errors.push(`${where} ${folder}: ${longest} px, väntade ${expected}`)
          const landscape = image.width >= image.height
          if (bitmap.width >= bitmap.height !== landscape) errors.push(`${where} ${folder}: fel orientering`)
          bitmap.close()
        }
      }
      return errors
    })
    assert(errors.length === 0, errors.join('\n      '))
    await page.close()
  })

  console.log('Dubbletter')

  const record = (id: string, folder: string, width: number, takenAt: string | null = null): ImageRecord => ({
    id,
    path: `original/${folder}/IMG_0001.jpg`,
    photographer: folder,
    byline: '',
    terms: '',
    rightsUntil: null,
    consent: 'given',
    blocked: false,
    width,
    height: width,
    takenAt,
    tags: [],
    aiTags: [],
    description: '',
    alternates: [],
    durationSeconds: null,
    place: null,
    previewProblem: null,
    hash: null,
    fileSize: null,
    fileModified: null,
  })

  await test('Dubbletter: den med högst upplösning behålls', async () => {
    const [small, large] = [record('MB-000001', 'A', 1000), record('MB-000002', 'B', 4000)]
    const duplicates = findDuplicates([small, large])
    assert(duplicates.get(small) === large && !duplicates.has(large), 'Fel bild behölls')
  })

  await test('Dubbletter: vid lika upplösning behålls lägst id', async () => {
    const [first, second] = [record('MB-000001', 'A', 2000), record('MB-000002', 'B', 2000)]
    const duplicates = findDuplicates([second, first])
    assert(duplicates.get(second) === first && duplicates.size === 1, 'Fel bild behölls')
  })

  await test('Dubbletter: samma namn men olika tagningstid är olika bilder', async () => {
    const images = [
      record('MB-000001', 'A', 2000, '2024-01-01T10:00:00'),
      record('MB-000002', 'B', 1000, '2025-06-01T12:00:00'),
      record('MB-000003', 'C', 500, null),
    ]
    const duplicates = findDuplicates(images)
    assert(duplicates.size === 1 && duplicates.get(images[2]) === images[0], 'Olika tagningstid räknades som dubblett')
  })

  await test('Dubbletter: indexet saknar dubbletter och de flyttade filerna finns kvar', async () => {
    const current: IndexFile = JSON.parse(await fs.readFile('testdata/app-data/index.json', 'utf8'))
    assert(findDuplicates(current.images).size === 0, 'Indexet innehåller dubbletter')
    const log = await fs.readFile('testdata/app-data/dubbletter/flyttade.jsonl', 'utf8').catch(() => '')
    const ids = new Set(current.images.map((image) => image.id))
    for (const line of log.split('\n').filter(Boolean)) {
      const moved = JSON.parse(line)
      assert(existsSync(path.join('testdata', moved.to)), `${moved.to} saknas`)
      assert(!ids.has(moved.id), `${moved.id} är flyttad men finns i indexet`)
      assert(ids.has(moved.keptId), `${moved.keptId}, som behölls, saknas i indexet`)
    }
  })

  console.log('3.4 Galleri')

  await test('3.4 rutnätet visar 3 000 bilder men bara de synliga finns i DOM:en', async () => {
    const page = await openPage('/?testdata&repeat=3000', (p) => p.evaluateOnNewDocument(countObjectUrls))
    await page.waitForFunction(() => /3\s000 bilder/.test(document.body.innerText), { timeout: 30_000 })
    await waitForThumbnails(page)
    await screenshot(page, '3.4-galleri')
    const start = await galleryState(page)
    assert(start.cells > 0 && start.cells < 200, `${start.cells} rutor i DOM:en`)
    assert(start.created <= start.cells * 2, `${start.created} object-URL:er skapade för ${start.cells} rutor`)
    assert(start.live === start.loaded, `${start.live} levande URL:er men ${start.loaded} visade miniatyrer`)

    for (const fraction of [0.25, 0.5, 0.75, 1]) {
      await page.evaluate((f) => {
        const gallery = document.querySelector('.gallery')!
        gallery.scrollTop = f * (gallery.scrollHeight - gallery.clientHeight)
      }, fraction)
      await waitForThumbnails(page)
      const state = await galleryState(page)
      assert(state.cells < 200, `${state.cells} rutor i DOM:en vid ${fraction * 100} %`)
      assert(state.live === state.loaded, `Läcka vid ${fraction * 100} %: ${state.live} URL:er, ${state.loaded} miniatyrer`)
    }
    const end = await galleryState(page)
    assert(end.lastIndex === 2999, `Sista rutan är ${end.lastIndex}, inte 2999`)
    assert(end.revoked > 0, 'Inga object-URL:er frigjordes')
    console.log(
      `      ${end.cells} rutor i DOM:en, ${end.created} URL:er skapade, ${end.revoked} frigjorda, ${end.live} levande`,
    )
    await page.close()
  })

  console.log('3.5 Detaljvy')

  const index: IndexFile = JSON.parse(await fs.readFile('testdata/app-data/index.json', 'utf8'))
  const find = (match: (image: ImageRecord) => boolean) => index.images.findIndex((i) => !i.previewProblem && match(i))
  const isRaw = (i: ImageRecord) => fileFormat(i.path).startsWith('RAW')
  const cases = [
    { name: 'spärrad bild', index: find((i) => i.blocked) },
    { name: 'bild med fotodatum', index: find((i) => !!i.takenAt && !i.blocked) },
    { name: 'samtycke saknas', index: find((i) => i.consent === 'missing' && !i.blocked) },
    { name: 'bild utan anmärkningar', index: find((i) => !i.blocked && i.consent !== 'missing') },
    { name: 'RAW med JPG visar båda formaten', index: find((i) => isRaw(i) && i.alternates.length > 0) },
    { name: 'RAW med inbäddad förhandsbild', index: find((i) => isRaw(i) && i.alternates.length === 0) },
    { name: 'video visas som stillbild med längd', index: find((i) => isVideo(i.path)) },
  ]
  // Varje varning ska synas om och endast om bildens data kräver det.
  const warnings = (image: ImageRecord): [string, boolean][] => [
    ['Spärrad. Bilden får inte användas', image.blocked],
    ['Samtycke saknas från personerna på bilden', image.consent === 'missing'],
    ['Videon kan inte spelas upp i bildbanken', isVideo(image.path)],
  ]

  let detailPage: Page | null = null
  for (const testCase of cases) {
    await test(`3.5 ${testCase.name}`, async () => {
      assert(testCase.index >= 0, 'Testdata saknar en sådan bild')
      if (!detailPage) {
        detailPage = await openPage('/?testdata', (p) => p.evaluateOnNewDocument(countObjectUrls))
        await waitForThumbnails(detailPage)
      }
      const page = detailPage
      const image = index.images[testCase.index]
      // Rutnätet är virtuellt: scrolla tills rutan har ritats.
      await page.waitForFunction(
        (n) => {
          const cell = document.querySelector(`.gallery-cell[data-index="${n}"]`)
          if (cell) return true
          document.querySelector('.gallery')!.scrollTop += 200
          return false
        },
        { timeout: 10_000, polling: 50 },
        testCase.index,
      )
      await page.locator(`.gallery-cell[data-index="${testCase.index}"]`).click()
      await page.waitForFunction(
        () => {
          const image = document.querySelector<HTMLImageElement>('dialog.detail[open] .detail-preview img')
          return image && image.complete && image.naturalWidth > 0
        },
        { timeout: 15_000 },
      )
      await screenshot(page, `3.5-${testCase.name.replaceAll(' ', '-')}`)

      const detail = await page.evaluate(() => {
        const dialog = document.querySelector<HTMLDialogElement>('dialog.detail[open]')!
        const preview = dialog.querySelector<HTMLImageElement>('.detail-preview img')!
        return { text: dialog.innerText, width: preview.naturalWidth, height: preview.naturalHeight }
      })
      const taken = image.takenAt ? formatTaken(image.takenAt) : 'Okänt, filen saknar datum'
      const formats = [image.path, ...image.alternates].map((file) => `${fileFormat(file)} ${fileName(file)}`)
      if (image.durationSeconds !== null) formats.push(formatDuration(image.durationSeconds))
      const resolution = formatResolution(image)
      for (const value of [image.id, image.photographer, image.byline, image.terms, taken, resolution, ...formats]) {
        assert(detail.text.includes(value), `Detaljvyn saknar "${value}"`)
      }
      assert(!/Rättighet/.test(detail.text), 'Detaljvyn visar rättighetsdatum')
      for (const [warning, shown] of warnings(image)) {
        assert(detail.text.includes(warning) === shown, `Varningen "${warning}" ${shown ? 'saknas' : 'visas i onödan'}`)
      }
      const expected = Math.min(1600, Math.max(image.width, image.height))
      assert(Math.max(detail.width, detail.height) === expected, `Förhandsbilden är ${detail.width}×${detail.height}`)
      if (image.blocked) {
        const badge = await page.$(`.gallery-cell[data-index="${testCase.index}"] .badge-blocked`)
        assert(badge, 'Spärrad bild är inte markerad i rutnätet')
      }

      await page.keyboard.press('Escape')
      await page.waitForFunction(() => !document.querySelector('dialog.detail'), { timeout: 5_000 })
      const state = await galleryState(page)
      assert(state.live === state.loaded, `Förhandsbildens URL frigjordes inte (${state.live} levande)`)
    })
  }

  await test('3.5 piltangenterna bläddrar mellan bilderna', async () => {
    const page = detailPage!
    const heading = () => page.$eval('dialog.detail[open] h2', (element) => element.textContent)
    const position = () => page.$eval('dialog.detail[open] .detail-position', (element) => element.textContent)
    const previewLoaded = async () =>
      page.waitForFunction(
        (id) => {
          const dialog = document.querySelector('dialog.detail[open]')
          const image = dialog?.querySelector<HTMLImageElement>('.detail-preview img')
          return dialog?.querySelector('h2')?.textContent === id && image?.complete && image.naturalWidth > 0
        },
        { timeout: 10_000 },
        index.images[Number((await position())!.split(' ')[0]) - 1].id,
      )
    const last = index.images.length - 1

    await page.evaluate(() => (document.querySelector('.gallery')!.scrollTop = 0))
    await page.locator('.gallery-cell[data-index="0"]').click()
    await page.waitForSelector('dialog.detail[open]')
    assert((await heading()) === index.images[0].id, 'Fel bild öppnades')
    assert((await position()) === `1 av ${index.images.length}`, `Räknaren visar "${await position()}"`)

    await page.keyboard.press('ArrowLeft')
    assert((await heading()) === index.images[0].id, 'Vänsterpil på första bilden bytte bild')
    await page.keyboard.press('ArrowRight')
    await page.keyboard.press('ArrowRight')
    assert((await heading()) === index.images[2].id, `Högerpil två gånger gav ${await heading()}, fokus på ${await page.evaluate(() => document.activeElement!.tagName + '.' + document.activeElement!.className)}`)
    await previewLoaded()
    await page.keyboard.press('ArrowLeft')
    const focus = () => page.evaluate(() => { const e = document.activeElement!; return `${e.tagName}.${e.className} ${e.textContent?.slice(0, 20)}` })
    assert((await heading()) === index.images[1].id, `Vänsterpil gav ${await heading()}, fokus på ${await focus()}`)

    await page.locator('button[aria-label="Nästa bild"]').click()
    assert((await heading()) === index.images[2].id, 'Knappen Nästa bild bytte inte bild')
    for (let n = 2; n < last; n++) await page.keyboard.press('ArrowRight')
    assert((await heading()) === index.images[last].id, `Sista bilden nåddes inte, visar ${await heading()}`)
    await page.keyboard.press('ArrowRight')
    assert((await heading()) === index.images[last].id, 'Högerpil på sista bilden bytte bild')
    assert(
      await page.$eval('button[aria-label="Nästa bild"]', (button) => (button as HTMLButtonElement).disabled),
      'Knappen Nästa bild är inte avstängd på sista bilden',
    )
    await screenshot(page, '3.5-bläddra')

    // Mushjulet över fotot bläddrar, och ett klick på fotot stänger bilden.
    const box = (await page.$eval('dialog.detail[open] .detail-preview', (element) => {
      const rect = element.getBoundingClientRect()
      return { x: rect.x + rect.width / 2, y: rect.y + rect.height / 2 }
    }))!
    await page.mouse.move(box.x, box.y)
    await page.mouse.wheel({ deltaY: -100 })
    await page.waitForFunction((id) => document.querySelector('dialog.detail[open] h2')?.textContent === id, { timeout: 5_000 }, index.images[last - 1].id)
    await new Promise((resolve) => setTimeout(resolve, 300))
    await page.mouse.wheel({ deltaY: 100 })
    await page.waitForFunction((id) => document.querySelector('dialog.detail[open] h2')?.textContent === id, { timeout: 5_000 }, index.images[last].id)
    await page.mouse.click(box.x, box.y)
    await page.waitForFunction(() => !document.querySelector('dialog.detail'), { timeout: 5_000 })
    const state = await galleryState(page)
    assert(state.live === state.loaded, `Förhandsbilder frigjordes inte vid bläddring (${state.live} levande URL:er)`)
  })

  // Om testdatat har en fil utan förhandsbild, t.ex. en RAW-fil utan JPG eller en
  // video när ffmpeg saknas (FFMPEG_PATH=saknas npm run make-testdata).
  const problemIndex = index.images.findIndex((i) => i.previewProblem)
  await test('3.5 fil utan förhandsbild visar !-ikon och förklaring', async () => {
    assert(problemIndex >= 0, 'Testdata saknar en fil utan förhandsbild')
    const page = detailPage!
    const image = index.images[problemIndex]
    await page.waitForFunction(
      (n) => {
        if (document.querySelector(`.gallery-cell[data-index="${n}"]`)) return true
        document.querySelector('.gallery')!.scrollTop += 200
        return false
      },
      { timeout: 10_000, polling: 50 },
      problemIndex,
    )
    const cell = `.gallery-cell[data-index="${problemIndex}"]`
    const title = await page.$eval(cell, (element) => element.getAttribute('title'))
    assert(await page.$(`${cell} .thumb-problem .problem-icon`), 'Rutan saknar !-ikonen')
    assert(title === image.previewProblem, 'Rutan förklarar inte problemet när man håller musen över den')
    await page.locator(cell).click()
    await page.waitForSelector('dialog.detail[open] .problem', { timeout: 5_000 })
    await screenshot(page, '3.5-utan-forhandsbild')
    const text = await page.$eval('dialog.detail[open] .problem', (element) => (element as HTMLElement).innerText)
    assert(text.includes(image.previewProblem!), 'Detaljvyn visar inte förklaringen')
    await page.keyboard.press('Escape')
    await page.waitForFunction(() => !document.querySelector('dialog.detail'), { timeout: 5_000 })
  })
  await (detailPage as Page | null)?.close()

  console.log('4.1 Import')

  // Vad importen borde hitta i testdata/Original, räknat här i Node.
  const expected = await expectedImport('testdata/Original')
  let importPage: Page | null = null
  const bank = 'importtest'

  await test('4.1 sökningen kan avbrytas och fortsätta', async () => {
    importPage = await openPage(`/?testdata&originals&fresh&name=${bank}`)
    const page = importPage
    await waitForText(page, 'Bildbanken har inga bilder än', 600_000)
    await clickButton(page, 'Admin')
    // Bildbankens egen mapp väljs automatiskt.
    await waitForText(page, `Bildbankens egen mapp ${bank} › Original`)
    assert(!(await page.$('::-p-text(Använd bildbankens egen mapp)')), 'Knappen för bildbankens egen mapp visas fast den redan är vald')
    await clickButton(page, 'Sök efter ändringar')
    await waitForText(page, 'Jämför filerna')
    await clickButton(page, 'Avbryt')
    await waitForText(page, 'Sökningen avbröts. Inget har ändrats.')
    await clickButton(page, 'Fortsätt')
    await page.waitForSelector('.import-preview', { timeout: 120_000 })
  })

  await test('4.1 förhandsvisningen visar nya filer, dubbletter och filer som hoppas över', async () => {
    const page = importPage!
    await screenshot(page, '4.1-forhandsvisning')
    const { counts, lists } = await readPreview(page)
    assert(counts.new === expected.unique, `${counts.new} nya, väntade ${expected.unique}`)
    for (const key of ['changed', 'moved', 'removed', 'unchanged'] as const) {
      assert(counts[key] === 0, `${counts[key]} ${key}, väntade 0`)
    }
    const duplicates = lists['Dubbletter med exakt samma innehåll, importeras inte'] ?? []
    assert(
      duplicates.length === expected.duplicates,
      `${duplicates.length} dubbletter, väntade ${expected.duplicates}`,
    )
    const skipped = lists['Inte bilder eller video, hoppas över'] ?? []
    assert(
      JSON.stringify(skipped.sort()) === JSON.stringify(expected.skipped.sort()),
      `Fel filer hoppas över: ${skipped.join(', ')}`,
    )
    const all = Object.values(lists).flat().join('\n')
    assert(!/__MACOSX|\/\._/.test(all), 'Macens systemfiler syns i förhandsvisningen')
    for (const raw of expected.rawPairs) {
      assert(!(lists['Nya'] ?? []).includes(raw.companion), `${raw.companion} visas som en egen bild`)
    }
  })

  let firstIndex: IndexFile | null = null
  let firstIndexText = ''

  await test('4.1 en import som avbryts mitt i lämnar mappen hel och kan fortsätta', async () => {
    const page = importPage!
    const started = Date.now()
    await clickButton(page, 'Starta import')
    // Vänta tills minst 20 bilder är klara, och avbryt sedan.
    await page.waitForFunction(
      () => {
        const match = document.querySelector('.import-progress p')?.textContent?.match(/Importerar – (\d+) av/)
        return match && Number(match[1]) >= 20
      },
      { timeout: 300_000, polling: 100 },
    )
    await clickButton(page, 'Avbryt')
    await waitForText(page, 'Importen avbröts efter', 60_000)
    const afterAbort = await bankProblems(page, bank)
    assert(!afterAbort.problems.length, afterAbort.problems.slice(0, 5).join('\n      '))
    assert(afterAbort.journal >= 20, `Bara ${afterAbort.journal} bilder sparades i pagaende.jsonl`)
    assert(!afterAbort.index, 'index.json skrevs fast importen avbröts')

    await clickButton(page, 'Fortsätt')
    await waitForPreview(page)
    await waitForText(page, 'i en avbruten import och behöver inte göras om')
    await clickButton(page, 'Fortsätt importen')
    // Avbryt igen när AI:n har analyserat minst 10 bilder.
    await page.waitForFunction(
      () => {
        const match = document.querySelector('.import-progress p')?.textContent?.match(/AI:n analyserar bilderna – (\d+) av/)
        return match && Number(match[1]) >= 10
      },
      { timeout: 600_000, polling: 100 },
    )
    await clickButton(page, 'Avbryt')
    await waitForText(page, 'Importen avbröts när AI:n hade analyserat', 60_000)
    const afterAiAbort = await bankProblems(page, bank)
    assert(!afterAiAbort.problems.length, afterAiAbort.problems.slice(0, 5).join('\n      '))
    assert(!afterAiAbort.index, 'index.json skrevs fast importen avbröts')
    const pendingVectors = await readOpfsBytes(page, `${bank}/app-data/import/pagaende.bin`)
    const saved = pendingVectors && decodeVectors(toArrayBuffer(pendingVectors), MODEL.dimensions)
    assert(saved && saved.size >= 10, `Bara ${saved?.size ?? 0} AI-vektorer sparades i pagaende.bin`)
    await clickButton(page, 'Fortsätt')
    await waitForPreview(page)
    await clickButton(page, 'Fortsätt importen')
    // Första importen skapar miniatyrer, förhandsbilder och AI-vektorer för alla bilder.
    const aiFrom = Date.now()
    await waitForText(page, 'Importen är klar', 900_000)
    const missing = expected.kept.length - saved.size
    console.log(
      `      Första importen tog ${Math.round((Date.now() - started) / 1000)} s, med två avbrott. ` +
        `AI-vektorer för ${missing} bilder tog ${Math.round((Date.now() - aiFrom) / 1000)} s`,
    )
    const done = await bankProblems(page, bank)
    assert(!done.problems.length, done.problems.slice(0, 5).join('\n      '))
    assert(done.index && done.journal === 0, 'Indexet saknas eller pagaende.jsonl ligger kvar')
  })

  await test('4.1 importen skriver index med id och fingeravtryck', async () => {
    const page = importPage!
    firstIndexText = (await readOpfs(page, `${bank}/app-data/index.json`))!
    firstIndex = JSON.parse(firstIndexText) as IndexFile
    const ids = firstIndex.images.map((image) => image.id)
    assert(ids.length === expected.kept.length, `${ids.length} bilder i indexet, väntade ${expected.kept.length}`)
    assert(
      JSON.stringify(ids) === JSON.stringify(expected.kept.map((record) => record.id)),
      'Id:n är inte MB-000001 och framåt i sökvägsordning',
    )
    assert(firstIndex.lastId === expected.unique, `lastId är ${firstIndex.lastId}, väntade ${expected.unique}`)
    // Dubbletterna med samma namn och tagningstid flyttas till app-data/dubbletter/
    // och loggas i flyttade.jsonl.
    const dropped = (await readPreviewLists(page))[DUPLICATES_TITLE] ?? []
    const movedText = expected.droppedRecords.map(
      ([record, kept]) => `${record.path} (behåller ${kept.path}). Flyttad till app-data/dubbletter/${record.path}.`,
    )
    assert(
      JSON.stringify(dropped.sort()) === JSON.stringify(movedText.sort()),
      `Fel dubbletter med samma namn: ${dropped.join(', ')}`,
    )
    assert(!firstIndex.duplicates?.length, 'Indexet listar flyttade dubbletter')
    const movedLog = ((await readOpfs(page, `${bank}/app-data/dubbletter/flyttade.jsonl`)) ?? '').trim().split('\n').filter(Boolean).map((line) => JSON.parse(line))
    const keptIds = new Set(firstIndex.images.map((image) => image.id))
    console.log(`      ${expected.droppedRecords.length} dubbletter med samma namn och tagningstid flyttades`)
    for (const [record, kept] of expected.droppedRecords) {
      const inBank = `${bank}/Original/${record.path.replace(/^original\//, '')}`
      assert(!(await readOpfsBytes(page, inBank)), `${record.path} ligger kvar i originalmappen`)
      assert(await readOpfsBytes(page, `${bank}/app-data/dubbletter/${record.path}`), `${record.path} finns inte i app-data/dubbletter/`)
      const entry = movedLog.find((line) => line.from === record.path)
      assert(
        entry && entry.to === `app-data/dubbletter/${record.path}` && entry.keptPath === kept.path &&
          !keptIds.has(entry.id) && keptIds.has(entry.keptId) && entry.movedAt,
        `flyttade.jsonl saknar eller har fel rad för ${record.path}: ${JSON.stringify(entry)}`,
      )
    }
    assert(firstIndex.images.every((image) => /^q1-[0-9a-f]{64}$/.test(image.hash ?? '')), 'En bild saknar fingeravtryck')
    assert(firstIndex.images.every((image) => image.consent === 'not-required'), 'Samtycke är inte not-required')
    for (const raw of expected.rawPairs) {
      const record = firstIndex.images.find((image) => image.path === raw.path)
      assert(record?.alternates.includes(raw.companion), `${raw.path} saknar ${raw.companion} i alternates`)
    }
    assert(!(await readOpfs(page, `${bank}/app-data/index.tmp.json`)), 'index.tmp.json ligger kvar')
    assert(!(await readOpfs(page, `${bank}/app-data/import/pagaende.jsonl`)), 'pagaende.jsonl ligger kvar')

    await clickButton(page, 'Sök efter ändringar')
    const { counts, lists } = await waitForPreview(page)
    assert(
      counts.unchanged === expected.kept.length && counts.new === 0,
      `Andra sökningen: ${JSON.stringify(counts)} ${lists['Ändrade'] ?? ''}`,
    )
    const skippedAgain = (await readPreview(page)).lists[DUPLICATES_TITLE] ?? []
    assert(!skippedAgain.length, 'Flyttade dubbletter visas vid nästa sökning')
  })

  await test('4.4 AI-vektorerna sparas i embeddings.bin och modellen körs lokalt', async () => {
    const page = importPage!
    const withImage = firstIndex!.images.filter((image) => !image.previewProblem)
    const info = firstIndex!.embeddings
    assert(
      info?.model === MODEL.name && info.dimensions === MODEL.dimensions && info.count === withImage.length,
      `Fel embeddings i indexet: ${JSON.stringify(info)}, ${withImage.length} bilder har förhandsbild`,
    )
    const vectors = decodeVectors(toArrayBuffer((await readOpfsBytes(page, `${bank}/app-data/embeddings.bin`))!), MODEL.dimensions)
    assert(vectors, 'embeddings.bin går inte att läsa')
    assert(
      JSON.stringify([...vectors.keys()]) === JSON.stringify(withImage.map((image) => image.id)),
      'Raderna i embeddings.bin är inte bilderna med förhandsbild i indexets ordning',
    )
    for (const [id, vector] of vectors) {
      const length = Math.hypot(...vector)
      assert(Math.abs(length - 1) < 1e-3, `Vektorn för ${id} är inte normaliserad (${length})`)
    }
    // Text- och bildmodellen körs i sidan. Färgade bilder ska ligga närmast
    // texten med rätt färg, på svenska, och en sparad vektor ska gå att räkna
    // fram igen ur miniatyren.
    const firstId = withImage[0].id
    const result = await page.evaluate(
      async (bank, firstId) => {
        // Utvecklingsservern lämnar ut appens moduler, så modellkoden kan köras direkt.
        const url = '/src/ai/model.ts'
        const { imageEmbedding, textEmbeddings } = (await import(url)) as {
          imageEmbedding: (root: FileSystemDirectoryHandle, image: ImageData) => Promise<Float32Array>
          textEmbeddings: (root: FileSystemDirectoryHandle, texts: string[]) => Promise<Float32Array[]>
        }
        const root = await (await navigator.storage.getDirectory()).getDirectoryHandle(bank)
        const solid = (color: string) => {
          const canvas = new OffscreenCanvas(224, 224)
          const context = canvas.getContext('2d')!
          context.fillStyle = color
          context.fillRect(0, 0, 224, 224)
          return context.getImageData(0, 0, 224, 224)
        }
        const dot = (a: Float32Array, b: Float32Array) => a.reduce((sum, value, i) => sum + value * b[i], 0)
        const started = performance.now()
        const [red, blue] = await textEmbeddings(root, ['en röd bild', 'en blå bild'])
        const textMs = performance.now() - started
        const redImage = await imageEmbedding(root, solid('#d00'))
        const blueImage = await imageEmbedding(root, solid('#00d'))
        const thumb = await (await (await (await root.getDirectoryHandle('app-data')).getDirectoryHandle('thumbs')).getFileHandle(`${firstId}.webp`)).getFile()
        const bitmap = await createImageBitmap(thumb)
        const canvas = new OffscreenCanvas(bitmap.width, bitmap.height)
        const context = canvas.getContext('2d')!
        context.drawImage(bitmap, 0, 0)
        const again = await imageEmbedding(root, context.getImageData(0, 0, bitmap.width, bitmap.height))
        return {
          redRed: dot(redImage, red),
          redBlue: dot(redImage, blue),
          blueBlue: dot(blueImage, blue),
          blueRed: dot(blueImage, red),
          again: [...again],
          textMs,
        }
      },
      bank,
      firstId,
    )
    console.log(`      Textmodellen laddades och körde på ${Math.round(result.textMs)} ms`)
    assert(result.redRed > result.redBlue, `Röd bild: röd ${result.redRed}, blå ${result.redBlue}`)
    assert(result.blueBlue > result.blueRed, `Blå bild: blå ${result.blueBlue}, röd ${result.blueRed}`)
    const stored = vectors.get(firstId)!
    const same = result.again.reduce((sum, value, i) => sum + value * stored[i], 0)
    assert(same > 0.999, `Vektorn för ${firstId} blir inte densamma igen (${same})`)
  })

  await test('4.5 AI-taggar sätts från config.json, skilda från nyckelorden', async () => {
    const page = importPage!
    const defaults = JSON.parse(await fs.readFile('src/ai/defaultConfig.json', 'utf8')) as {
      aiTags: { tag: string; prompt: string; threshold: number }[]
    }
    const names = defaults.aiTags.map((tag) => tag.tag)
    assert(names.length >= 150 && new Set(names).size === names.length, `${names.length} förvalda taggar, eller dubbletter`)
    assert(
      defaults.aiTags.every((tag) => tag.prompt && typeof tag.threshold === 'number'),
      'En förvald tagg saknar prompt eller tröskelvärde',
    )
    for (const wanted of ['kvinna', 'man', 'kyrka', 'moské', 'rullstol', 'demonstration', 'solnedgång', 'soluppgång']) {
      assert(names.includes(wanted), `Taggen ${wanted} saknas bland de förvalda`)
    }
    // Det går inte att se skillnad på soluppgång och solnedgång, så bilderna får båda.
    const [sunset, sunrise] = ['solnedgång', 'soluppgång'].map((name) => defaults.aiTags.find((tag) => tag.tag === name)!)
    assert(
      sunset.prompt === sunrise.prompt && sunset.threshold === sunrise.threshold,
      'Solnedgång och soluppgång har olika beskrivning eller gräns',
    )

    // Första importen skapade config.json med de förvalda taggarna och satte AI-taggar.
    const config = JSON.parse((await readOpfs(page, `${bank}/app-data/config.json`))!)
    assert(JSON.stringify(config) === JSON.stringify(defaults), 'config.json är inte de förvalda taggarna')
    assert(firstIndex!.aiTagging?.model === MODEL.name, `aiTagging saknas: ${JSON.stringify(firstIndex!.aiTagging)}`)
    const known = new Set(names)
    for (const image of firstIndex!.images) {
      assert(Array.isArray(image.aiTags), `${image.id} saknar aiTags`)
      assert(image.aiTags.every((tag) => known.has(tag)), `${image.id} har okända AI-taggar: ${image.aiTags}`)
      if (image.previewProblem) assert(!image.aiTags.length, `${image.id} saknar förhandsbild men har AI-taggar`)
      assert(!image.aiTags.some((tag) => image.tags.includes(tag) && !known.has(tag)), 'AI-taggar blandas med nyckelord')
    }
    const tagged = firstIndex!.images.filter((image) => image.aiTags.length).length
    assert(tagged > 0, 'Ingen bild fick AI-taggar')

    // Ändrade taggar sätts om för alla bilder, utan att vektorerna räknas om.
    // Tröskeln -1 ger alla bilder taggen och 2 ingen. Den ofullständiga taggen hoppas över.
    const changed = {
      version: 1,
      aiTags: [
        { tag: 'alla', prompt: 'a photo', threshold: -1 },
        { tag: 'ingen', prompt: 'a photo', threshold: 2 },
        { tag: 'utan prompt', threshold: 0 },
      ],
    }
    await writeOpfs(page, `${bank}/app-data/config.json`, JSON.stringify(changed))
    // Sidan visar förhandsvisningen från 4.1.
    await clickButton(page, 'Sök igen')
    await waitForPreview(page)
    await waitForText(page, 'Alla bilder får nya AI-taggar')
    await clickButton(page, 'Starta import')
    await waitForText(page, 'AI-taggarna sattes med 2 taggar', 300_000)
    await waitForText(page, '1 AI-tagg i app-data/config.json saknar')
    const index = JSON.parse((await readOpfs(page, `${bank}/app-data/index.json`))!) as IndexFile
    assert(index.aiTagging && index.aiTagging.config !== firstIndex!.aiTagging!.config, 'aiTagging ändrades inte')
    // Båda taggarna har samma beskrivning, så det finns en textvektor.
    assert(JSON.stringify(index.aiTagging.prompts) === '["a photo"]', `prompts: ${index.aiTagging.prompts}`)
    const tagVectors = await readOpfsBytes(page, `${bank}/app-data/${index.aiTagging.file}`)
    const tagRows = tagVectors && decodeVectors(toArrayBuffer(tagVectors), MODEL.dimensions)
    assert(tagRows?.size === 1, `${index.aiTagging.file} har ${tagRows?.size} rader, väntade 1`)
    assert(
      JSON.stringify(await tagVectorFiles(page, bank)) === JSON.stringify([index.aiTagging.file]),
      `Gamla textvektorer ligger kvar: ${await tagVectorFiles(page, bank)}`,
    )
    for (const image of index.images) {
      const wanted = image.previewProblem ? [] : ['alla']
      assert(JSON.stringify(image.aiTags) === JSON.stringify(wanted), `${image.id} har ${image.aiTags}, väntade ${wanted}`)
      const before = firstIndex!.images.find((record) => record.id === image.id)!
      assert(JSON.stringify(image.tags) === JSON.stringify(before.tags), `${image.id}: nyckelorden ändrades`)
    }
    // Oförändrade taggar sätts inte om.
    await clickButton(page, 'Sök efter ändringar')
    await waitForPreview(page)
    assert(!(await page.$('::-p-text(Alla bilder får nya AI-taggar)')), 'AI-taggarna sätts om fast inget har ändrats')

    // Detaljvyn visar taggarna, AI-taggarna streckade. Ett klick på en tagg
    // visar bilderna med den i galleriet.
    const viewer = await openPage(`/?testdata&name=${bank}&keep`)
    try {
      await viewer.waitForSelector('.gallery-cell[data-index="0"]', { timeout: 60_000 })
      await viewer.locator('.gallery-cell[data-index="0"]').click()
      await viewer.waitForSelector('dialog.detail[open] .detail-tags button.ai', { timeout: 10_000 })
      const shown = await viewer.$eval('dialog.detail[open] .detail-tags', (element) => (element as HTMLElement).innerText)
      assert(shown.includes('alla') && shown.includes('Streckade taggar har satts automatiskt'), `Detaljvyn visar taggarna så här: ${shown}`)
      await screenshot(viewer, '4.5-ai-taggar')
      await step('Taggen alla i detaljvyn', viewer.locator('dialog.detail[open] .detail-tags button::-p-text(alla)').click())
      const withAll = index.images.filter((image) => image.aiTags.includes('alla')).length
      await waitForText(viewer, `Bilder med taggen alla · ${withAll.toLocaleString('sv-SE')} bilder`)
      assert(!(await viewer.$('dialog.detail[open]')), 'Detaljvyn är kvar efter klick på en tagg')
      await clickButton(viewer, 'Visa alla bilder')
      await viewer.waitForFunction(() => !document.querySelector('.filter-bar'), { timeout: 5_000 })

      // Platsen i detaljvyn: ett klick på delområdet visar bilderna därifrån.
      const placed = index.images.findIndex((image) => image.place?.subdistrict)
      assert(placed >= 0, 'Ingen bild har en plats')
      const subdistrict = index.images[placed].place!.subdistrict!
      await viewer.locator(`.gallery-cell[data-index="${placed}"]`).click()
      await step('Platsen i detaljvyn', viewer.locator(`dialog.detail[open] .detail-place button::-p-text(${subdistrict})`).click())
      const fromThere = index.images.filter((image) => image.place?.subdistrict === subdistrict).length
      await waitForText(viewer, `Bilder från ${subdistrict} · ${fromThere.toLocaleString('sv-SE')} ${fromThere === 1 ? 'bild' : 'bilder'}`)
      await clickButton(viewer, 'Visa alla bilder')

      // Redigera: ändringarna sparas i användarens egen fil och visas direkt.
      const edited = index.images[0]
      // Testprofilen sparar namnet mellan körningar. Börja utan namn.
      await viewer.evaluate(
        () =>
          new Promise<void>((resolve, reject) => {
            const open = indexedDB.open('malmo-bildbank', 1)
            open.onupgradeneeded = () => open.result.createObjectStore('settings')
            open.onerror = () => reject(open.error)
            open.onsuccess = () => {
              const transaction = open.result.transaction('settings', 'readwrite')
              transaction.objectStore('settings').delete('user')
              transaction.oncomplete = () => (open.result.close(), resolve())
              transaction.onerror = () => reject(transaction.error)
            }
          }),
      )
      const [removedTag] = await (async () => {
        await viewer.locator('.gallery-cell[data-index="0"]').click()
        await step('Redigera', clickButton(viewer, 'Redigera'))
        await viewer.waitForSelector('.edit-form .image-tag-chips .chip', { timeout: 10_000 })
        return viewer.$$eval('.edit-form .image-tag-chips .chip', (chips) => chips.map((chip) => chip.getAttribute('data-tag')!))
      })()
      await step('Namnfältet', viewer.waitForSelector('.edit-form label:has(> small) input', { timeout: 5_000 }))
      await viewer.type('.edit-form label:has(> small) input', 'Testare')
      const byline = viewer.locator('.edit-form label::-p-text(Byline) input')
      await byline.fill('Foto: Ändrad i test')
      await viewer.select('.edit-form label::-p-text(Samtycke) select', 'missing')
      const chip = `.edit-form .chip[data-tag="${removedTag}"]`
      await viewer.click(chip)
      await viewer.waitForSelector(`${chip}.armed`, { timeout: 5_000 })
      await viewer.click(chip)
      await viewer.waitForSelector(`${chip}.removed`, { timeout: 5_000 })
      await viewer.type('.edit-form .add-tag input', 'testtagg')
      await viewer.keyboard.press('Enter')
      await step('Ny tagg i formuläret', viewer.waitForSelector('.edit-form .chip[data-tag="testtagg"]', { timeout: 5_000 }))
      // Sätt på liknande bilder: panelen ligger över fotot, och Tillbaka går
      // tillbaka till redigeringen som den var.
      await viewer.click('.edit-form .similar-button')
      await step('Panelen för liknande bilder', viewer.waitForSelector('.similar-panel .tag-hits', { timeout: 30_000 }))
      const panel = await viewer.$eval('dialog.detail[open]', (dialog) => {
        const box = (selector: string) => JSON.stringify(dialog.querySelector(selector)!.getBoundingClientRect())
        return {
          example: dialog.querySelector('.similar-panel h4 + .tag-thumbs li')?.getAttribute('data-id'),
          overPreview: box('.similar-panel') === box('.detail-preview'),
          heading: dialog.querySelector('.similar-panel h3')!.textContent,
        }
      })
      assert(
        panel.example === edited.id && panel.overPreview && panel.heading === '”testtagg” på liknande bilder',
        `Panelen: ${JSON.stringify(panel)}`,
      )
      await clickButton(viewer, '← Tillbaka till redigeringen')
      await viewer.waitForFunction(() => !document.querySelector('.similar-panel'), { timeout: 5_000 })
      assert(
        (await viewer.$eval('.edit-form label::-p-text(Byline) input', (input) => (input as HTMLInputElement).value)) ===
          'Foto: Ändrad i test' && (await viewer.$('.detail-info.editing .edit-form .chip[data-tag="testtagg"]')),
        'Redigeringen var inte kvar efter Tillbaka',
      )
      await viewer.waitForSelector('.edit-form label::-p-text(Plats) select optgroup option', { timeout: 10_000 })
      const placeOption = await viewer.$eval('.edit-form label::-p-text(Plats) select optgroup option', (option) => (option as HTMLOptionElement).value)
      await viewer.select('.edit-form label::-p-text(Plats) select', placeOption)
      await elementScreenshot(viewer, 'dialog.detail[open] .detail-info', '4.8-redigera')
      // Redigeringsläget syns: röd ram runt uppgifterna och röd Redigera-knapp.
      const editLook = () =>
        viewer.$eval('dialog.detail[open] .detail-info', (info) => {
          const button = info.querySelector('.edit-toggle')!
          return [getComputedStyle(info).borderTopColor, getComputedStyle(button).backgroundColor, getComputedStyle(button).color].join(' | ')
        })
      const editingLook = await editLook()
      assert(editingLook === 'rgb(179, 38, 30) | rgb(179, 38, 30) | rgb(255, 255, 255)', `Redigeringsläget ser ut så här: ${editingLook}`)
      await clickButton(viewer, 'Spara')
      await step('Sparat', viewer.waitForSelector('dialog.detail[open] .detail-fields', { timeout: 10_000 }))
      const normalLook = await editLook()
      assert(normalLook === 'rgba(0, 0, 0, 0) | rgb(255, 255, 255) | rgb(0, 0, 0)', `Efter Spara ser det ut så här: ${normalLook}`)
      const fields = await viewer.$eval('dialog.detail[open] .detail-fields', (element) => (element as HTMLElement).innerText)
      const shownTags = await viewer.$$eval('dialog.detail[open] .detail-tags button', (buttons) => buttons.map((button) => button.textContent))
      const [district, sub] = JSON.parse(placeOption) as [string, string, null]
      assert(
        fields.includes('Foto: Ändrad i test') && shownTags.includes('testtagg') && !shownTags.includes(removedTag) && fields.includes(sub),
        `Detaljvyn efter Spara: ${fields}`,
      )
      const file = (await readOpfs(viewer, `${bank}/app-data/edits/Testare.jsonl`))!
      const lines = file.trim().split('\n').map((line) => JSON.parse(line))
      const field = (name: string) => lines.find((line) => line.field === name)?.value
      assert(
        lines.every((line) => line.id === edited.id && line.by === 'Testare') &&
          field('byline') === 'Foto: Ändrad i test' &&
          field('consent') === 'missing' &&
          JSON.stringify(field('place')) === JSON.stringify({ district, subdistrict: sub, name: null }) &&
          lines.some((line) => line.tag === removedTag && line.on === false) &&
          lines.some((line) => line.tag === 'testtagg' && line.on === true) &&
          !lines.some((line) => line.field === 'terms'),
        `Testare.jsonl: ${file}`,
      )
      // Efter omladdning läses ändringarna från filen.
      await viewer.reload()
      await viewer.waitForSelector('.gallery-cell[data-index="0"]', { timeout: 60_000 })
      await viewer.locator('.gallery-cell[data-index="0"]').click()
      await step('Ändringen finns kvar', waitForText(viewer, 'Foto: Ändrad i test'))
      await clickButton(viewer, 'Redigera')
      assert(!(await viewer.$('.edit-form label:has(> small)')), 'Namnet efterfrågas igen')

      // Spara AI-taggen: taggen hamnar i config.json med bilden som exempel,
      // bilderna får den, och redigeringen ligger kvar. Testbanken återställs efteråt.
      const configBefore = (await readOpfs(viewer, `${bank}/app-data/config.json`))!
      const indexBefore = (await readOpfs(viewer, `${bank}/app-data/index.json`))!
      try {
        await viewer.type('.edit-form .add-tag input', 'testlikt')
        await viewer.keyboard.press('Enter')
        await viewer.waitForSelector('.edit-form .similar-button', { timeout: 5_000 })
        await viewer.click('.edit-form .similar-button')
        await viewer.waitForSelector('.similar-panel .tag-hits', { timeout: 30_000 })
        await clickButton(viewer, 'Spara AI-taggen')
        await step('AI-taggen sparad', viewer.waitForFunction(() => !document.querySelector('.similar-panel'), { timeout: 60_000 }))
        const config = JSON.parse((await readOpfs(viewer, `${bank}/app-data/config.json`))!) as BankConfig
        const saved = config.aiTags.find((tag) => tag.tag === 'testlikt')
        assert(JSON.stringify(saved?.examples) === JSON.stringify([edited.id]), `config.json: ${JSON.stringify(saved)}`)
        const after = JSON.parse((await readOpfs(viewer, `${bank}/app-data/index.json`))!) as IndexFile
        assert(after.images.find((image) => image.id === edited.id)!.aiTags.includes('testlikt'), 'Bilden fick inte AI-taggen')
        await step('Redigeringen kvar', viewer.waitForSelector('.detail-info.editing .edit-form .chip.ai[data-tag="testlikt"]', { timeout: 10_000 }))
        assert(
          (await viewer.$$('.edit-form .chip[data-tag="testlikt"]')).length === 1 && !(await viewer.$('.edit-form .similar-button')),
          'Taggen visas två gånger, eller knappen finns kvar',
        )
      } finally {
        await writeOpfs(viewer, `${bank}/app-data/config.json`, configBefore)
        await writeOpfs(viewer, `${bank}/app-data/index.json`, indexBefore)
      }
    } finally {
      await viewer.close()
    }
  })

  await test('4.5 ordlistan översätter nyckelord, föreslår taggar och lägger till taggar som hör ihop', async () => {
    const { buildVocabulary, shownTags, suggestTags } = await import('../src/catalog/vocabulary.ts')
    const defaults = JSON.parse(await fs.readFile('src/ai/defaultConfig.json', 'utf8'))
    const vocabulary = buildVocabulary({ ...defaults, hiddenKeywords: ['ornament'] })
    const tags = shownTags({ tags: ['town hall', 'turningtorso', 'Västra hamnen', 'ornament'], aiTags: ['butik', 'rådhus'] }, vocabulary)
    const names = tags.map((tag) => tag.tag)
    assert(
      JSON.stringify(names) === JSON.stringify(['rådhus', 'Turning Torso', 'Västra hamnen', 'butik', 'affär']),
      `Taggarna blev ${names}`,
    )
    assert(!tags.find((tag) => tag.tag === 'rådhus')!.ai, 'rådhus kommer från ett nyckelord men visas som AI-tagg')
    assert(tags.find((tag) => tag.tag === 'affär')!.ai, 'affär hör ihop med AI-taggen butik och ska vara AI')
    assert(suggestTags('turning-torso', vocabulary).exact === 'Turning Torso', 'turning-torso hittar inte Turning Torso')
    const near = suggestTags('Turnig Torso', vocabulary)
    assert(!near.exact && near.near.includes('Turning Torso'), `Turnig Torso föreslår ${JSON.stringify(near)}`)
    assert(suggestTags('kafe', vocabulary).near.includes('kafé'), 'kafe föreslår inte kafé')
    assert(!suggestTags('Malmöhus', vocabulary).exact, 'Malmöhus får inte vara en annan tagg')

    // Ett ord under Hör ihop med som inte är en tagg blir en tagg i gruppen, åt båda hållen.
    const castle = { tag: 'slott', prompt: 'a photo of a castle', threshold: 0.05, related: ['Malmöhus', 'Malmö museum'] }
    const withCastle = buildVocabulary({ ...defaults, aiTags: [...defaults.aiTags.filter((tag: { tag: string }) => tag.tag !== 'slott'), castle] })
    const fromCastle = shownTags({ tags: [], aiTags: ['slott'] }, withCastle).map((tag) => tag.tag)
    assert(['slott', 'Malmöhus', 'Malmö museum'].every((tag) => fromCastle.includes(tag)), `slott ger ${fromCastle}`)
    const fromWord = shownTags({ tags: ['malmöhus'], aiTags: [] }, withCastle).map((tag) => tag.tag)
    assert(fromWord.includes('slott') && fromWord.includes('Malmöhus'), `Nyckelordet malmöhus ger ${fromWord}`)

    // En tagg som sätts för hand sprids till liknande bilder, men inte till bilder
    // där någon har tagit bort den, eller nästan likadana bilder.
    const { spreadHandTags, HAND_THRESHOLD } = await import('../src/ai/handTags.ts')
    const unit = (...values: number[]) => {
      const vector = Float32Array.from(values)
      const length = Math.hypot(...vector)
      return vector.map((value) => value / length)
    }
    const offset = Math.sqrt(1 - HAND_THRESHOLD ** 2) * 0.9
    const vectors = new Map([
      ['MB-1', unit(1, 0, 0)],
      ['MB-2', unit(1, offset, 0)],
      ['MB-3', unit(0, 1, 0)],
      ['MB-4', unit(1, 0, 0.1)],
      ['MB-5', unit(1, 0, 0.12)],
    ])
    const edits = new Map([
      ['MB-1', new Map([['öresund', { tag: 'Öresund', on: true }]])],
      ['MB-4', new Map([['öresund', { tag: 'Öresund', on: false }]])],
    ])
    const spread = spreadHandTags(vectors, edits, { version: 1, atLeastOneTag: false, aiTags: [] })
    assert(
      JSON.stringify([...spread]) === JSON.stringify([['MB-2', ['Öresund']]]),
      `Öresund spreds till ${JSON.stringify([...spread])}`,
    )
  })

  await test('4.5 Samma bild, olika namn listas i Admin', async () => {
    const { sameContent } = await import('../src/catalog/sameImage.ts')
    const groups = sameContent([
      { id: 'MB-1', path: 'original/A/a.jpg', hash: 'x' },
      { id: 'MB-2', path: 'original/B/b.jpg', hash: 'x' },
      // Samma namn i en annan mapp är en vanlig dubblett, och en bilds egna filer räknas inte.
      { id: 'MB-3', path: 'original/A/c.jpg', hash: 'y' },
      { id: 'MB-4', path: 'original/B/C.JPG', hash: 'y' },
      { id: 'MB-5', path: 'original/A/d.CR2', hash: 'z' },
      { id: 'MB-5', path: 'original/A/d.jpg', hash: 'z' },
    ])
    assert(JSON.stringify(groups.map((group) => group.map((file) => file.id))) === '[["MB-1","MB-2"]]', `Grupperna: ${JSON.stringify(groups)}`)

    const page = importPage!
    await clickButton(page, 'Samma bild')
    await step('Jämförelsen', page.waitForSelector('.same-images [role="status"]', { timeout: 60_000 }))
    const shown = await page.$$eval('.same-group', (lists) =>
      lists.map((list) => [...list.querySelectorAll('li')].map((item) => (item as HTMLElement).innerText.replace(/\s+/g, ' '))),
    )
    // Testdatat har RAW-par.jpg som en kopia av Knutssalen Rådhuset.jpg.
    assert(
      shown.some((group) => group.some((text) => text.includes('Knutssalen Rådhuset.jpg')) && group.some((text) => text.includes('RAW-par.jpg') && text.includes('JPG till RAW-par.CR2'))),
      `Samma bild visar: ${JSON.stringify(shown)}`,
    )
    await elementScreenshot(page, '.same-images > [role="status"]', '4.x-samma-bild')

    // En miniatyr öppnar bilden ovanpå Admin, med Redigera.
    const rawJpg = '.same-group li[data-path="original/Fotograf C/RAW-par.jpg"]'
    const pairId = await page.$eval(rawJpg, (item) => item.getAttribute('data-id')!)
    await page.click(`${rawJpg} .same-thumb`)
    await step('Bilden ovanpå Admin', page.waitForSelector('dialog.detail[open] .edit-toggle', { timeout: 10_000 }))
    assert((await page.$eval('dialog.detail[open] h2', (h2) => h2.textContent)) === pairId, 'Fel bild öppnades')
    await page.keyboard.press('Escape')
    await page.waitForFunction(() => !document.querySelector('dialog.detail'), { timeout: 5_000 })

    // Flytta bort: två klick, sedan ligger filen i app-data/dubbletter/ och flytten är loggad.
    const original = `${bank}/Original/Fotograf C/RAW-par.jpg`
    const moved = `${bank}/app-data/dubbletter/original/Fotograf C/RAW-par.jpg`
    const bytes = await readOpfsBytes(page, original)
    try {
      await page.click(`${rawJpg} .same-move`)
      await page.click(`${rawJpg} .same-move.armed`)
      await step('Flyttad', page.waitForSelector(`${rawJpg} .same-moved`, { timeout: 10_000 }))
      assert(!(await readOpfsBytes(page, original)) && (await readOpfsBytes(page, moved))?.equals(bytes!), 'Filen flyttades inte hel')
      const log = (await readOpfs(page, `${bank}/app-data/dubbletter/flyttade.jsonl`))!.trim().split('\n').map((line) => JSON.parse(line))
      const entry = log.at(-1)
      assert(
        entry.id === pairId && entry.from === 'original/Fotograf C/RAW-par.jpg' && entry.to === 'app-data/dubbletter/original/Fotograf C/RAW-par.jpg' && entry.keptPath === 'original/Fotograf A/Knutssalen Rådhuset.jpg',
        `flyttade.jsonl: ${JSON.stringify(entry)}`,
      )
    } finally {
      // Testbanken återställs: filen tillbaka och dubblettmappen bort.
      await page.evaluate(
        async (bank, base64) => {
          const root = await (await navigator.storage.getDirectory()).getDirectoryHandle(bank)
          const folder = await (await root.getDirectoryHandle('Original')).getDirectoryHandle('Fotograf C')
          const writable = await (await folder.getFileHandle('RAW-par.jpg', { create: true })).createWritable()
          await writable.write(Uint8Array.from(atob(base64), (char) => char.charCodeAt(0)))
          await writable.close()
          await (await root.getDirectoryHandle('app-data')).removeEntry('dubbletter', { recursive: true }).catch(() => {})
        },
        bank,
        bytes!.toString('base64'),
      )
    }

    await clickButton(page, 'Importera bilder')
  })

  await test('4.5 AI-taggarna går att ändra i Admin, AI-taggar', async () => {
    const page = importPage!
    await clickButton(page, 'AI-taggar')
    await waitForText(page, 'Välj en tagg i listan', 60_000)
    // En miniatyr öppnar bilden ovanpå Admin, med Redigera.
    await clickButton(page, 'Alla bilder och deras taggar')
    await page.waitForSelector('.tag-images-view .tag-thumb[role="button"]', { timeout: 60_000 })
    const firstId = await page.$eval('.tag-images-view li[data-id]', (item) => item.getAttribute('data-id')!)
    await page.click('.tag-images-view .tag-thumb[role="button"]')
    await step('Bilden från AI-taggar', page.waitForSelector('dialog.detail[open] .edit-toggle', { timeout: 10_000 }))
    assert((await page.$eval('dialog.detail[open] h2', (h2) => h2.textContent)) === firstId, 'Fel bild från AI-taggar')
    await page.keyboard.press('Escape')
    await page.waitForFunction(() => !document.querySelector('dialog.detail'), { timeout: 5_000 })

    // Osparade ändringar syns i spara-fältet och på fliken, och Admin frågar innan de försvinner.
    await page.click('.tag-option input')
    await step('Osparad ändring', waitForText(page, '1 osparad ändring'))
    await step('Pricken på fliken', page.waitForSelector('.admin-tabs .unsaved-dot', { timeout: 5_000 }))
    let question = ''
    page.once('dialog', (dialog) => {
      question = dialog.message()
      void dialog.dismiss()
    })
    await clickButton(page, 'Tillbaka till bildbanken')
    await page.waitForFunction(() => document.querySelector('.admin'), { timeout: 5_000 })
    assert(question.includes('1 osparad ändring under AI-taggar'), `Frågan: ${question}`)
    await clickButton(page, 'Ångra ändringar')
    await page.waitForFunction(() => !document.querySelector('.admin-tabs .unsaved-dot'), { timeout: 5_000 })
    const hits = async () => {
      await page.waitForFunction(() => /får taggen\.$/.test(document.querySelector('.tag-hits')?.textContent ?? ''), {
        timeout: 60_000,
      })
      const text = await page.$eval('.tag-hits', (element) => element.textContent!)
      return Number(text.match(/^([\d\s ]+) av/)![1].replace(/\D/g, ''))
    }
    const selectTag = async (name: string) => {
      await step(`Taggen ${name} i listan`, page.locator(`.tag-names button::-p-text(${name})`).click())
      await page.waitForSelector(`.tag-fields input[value="${name}"]`, { timeout: 5_000 })
    }

    // En ny tagg. Reglaget längst till vänster ger gränsen 0.
    await clickButton(page, '+ Ny tagg')
    const [tagInput, promptInput] = await page.$$('.tag-fields input')
    await tagInput.type('röd')
    await promptInput.click({ count: 3 })
    await promptInput.type('a red image')
    await page.focus('.tag-threshold input[type="range"]')
    await page.keyboard.press('Home')
    await waitForText(page, 'Gräns: 0,000')
    const red = await hits()
    assert(red > 0, 'Ingen bild får den nya taggen med gränsen 0')
    await screenshot(page, '4.5-ai-taggar-admin')

    // Gränsen längst till höger: inga bilder.
    await selectTag('alla')
    await page.focus('.tag-threshold input[type="range"]')
    await page.keyboard.press('End')
    await waitForText(page, 'Gräns: 0,150')
    assert((await hits()) === 0, 'Bilder får taggen med högsta gränsen')

    await selectTag('ingen')
    await clickButton(page, 'Ta bort taggen')
    await waitForText(page, 'Tas bort när du sparar: ingen')

    // Bilder som inte når någon gräns: de med negativt värde för röd.
    await clickButton(page, 'Bilder utan AI-taggar')
    await page.waitForFunction(() => /når inte gränsen/.test(document.querySelector('.tag-untagged .tag-hits')?.textContent ?? ''), {
      timeout: 60_000,
    })
    const [untagged, total] = (await page.$eval('.tag-untagged .tag-hits', (element) => element.textContent!))
      .match(/[\d\s ]+(?= av)|(?<=av )[\d\s ]+/g)!
      .map((value) => Number(value.replace(/\D/g, '')))
    assert(untagged === total - red, `${untagged} bilder utan taggar, väntade ${total - red}`)
    assert((await page.$$('.tag-untagged .tag-thumbs > li')).length === Math.min(untagged, 60), 'Fel antal bilder i listan')

    // Utan Minst en tagg per bild får de bilderna inga AI-taggar.
    await page.click('.tag-option input')
    await clickButton(page, 'Spara ändringar')
    await waitForText(page, 'Sparat.', 120_000)

    const config = JSON.parse((await readOpfs(page, `${bank}/app-data/config.json`))!)
    assert(
      config.atLeastOneTag === false &&
        JSON.stringify(config.aiTags) ===
          JSON.stringify([
            { tag: 'röd', prompt: 'a red image', threshold: 0 },
            { tag: 'alla', prompt: 'a photo', threshold: 0.15 },
          ]),
      `config.json: ${JSON.stringify(config)}`,
    )
    const index = JSON.parse((await readOpfs(page, `${bank}/app-data/index.json`))!) as IndexFile
    const withRed = index.images.filter((image) => image.aiTags.includes('röd')).length
    assert(withRed === red, `${withRed} bilder fick taggen röd, adminvyn sa ${red}`)
    assert(!index.images.some((image) => image.aiTags.some((tag) => tag !== 'röd')), 'Bilder har kvar borttagna taggar')
    assert(
      JSON.stringify(await tagVectorFiles(page, bank)) === JSON.stringify([index.aiTagging!.file]),
      `Gamla textvektorer ligger kvar: ${await tagVectorFiles(page, bank)}`,
    )

    // En exempelbild: taggen hittar bilder som liknar den, med gränsen på bildskalan.
    await selectTag('röd')
    await page.waitForSelector('.tag-images .tag-thumbs > li', { timeout: 30_000 })
    const example = await page.$eval('.tag-images .tag-thumbs > li', (element) => element.getAttribute('data-id')!)
    await page.click(`.tag-images .tag-thumbs > li[data-id="${example}"] button.example`)
    await waitForText(page, 'Gräns: 0,800')
    assert((await hits()) > 0, 'Ingen bild liknar exempelbilden')
    // Med Minst en tagg per bild får alla bilder en tagg.
    await page.click('.tag-option input')
    await clickButton(page, 'Spara ändringar')
    await waitForText(page, 'Sparat.', 120_000)
    const withExample = JSON.parse((await readOpfs(page, `${bank}/app-data/config.json`))!)
    const redTag = withExample.aiTags.find((tag: { tag: string }) => tag.tag === 'röd')
    assert(
      withExample.atLeastOneTag === true && redTag.threshold === 0.8 && JSON.stringify(redTag.examples) === JSON.stringify([example]),
      `config.json: ${JSON.stringify(withExample)}`,
    )
    const exampleIndex = JSON.parse((await readOpfs(page, `${bank}/app-data/index.json`))!) as IndexFile
    assert(
      exampleIndex.images.find((image) => image.id === example)!.aiTags.includes('röd'),
      'Exempelbilden fick inte taggen',
    )
    const withoutTags = exampleIndex.images.filter((image) => !image.previewProblem && !image.aiTags.length)
    assert(!withoutTags.length, `${withoutTags.length} bilder saknar AI-taggar fast Minst en tagg per bild är på`)

    // Inte rätt: bilden, och bilder som är nästan likadana, får inte taggen.
    await selectTag('röd')
    await page.focus('.tag-threshold input[type="range"]')
    await page.keyboard.press('Home')
    await waitForText(page, 'Gräns: 0,500')
    const before = await hits()
    await page.waitForSelector('.tag-images button.wrong', { timeout: 30_000 })
    const wrong = await page.$eval('.tag-images button.wrong', (element) => element.closest('li')!.getAttribute('data-id')!)
    await page.click(`.tag-images .tag-thumbs > li[data-id="${wrong}"] button.wrong`)
    await page.waitForSelector(`.tag-wrong li[data-id="${wrong}"]`, { timeout: 5_000 })
    const wrongCount = (await page.$$('.tag-wrong .tag-thumbs > li')).length
    assert((await hits()) === before - wrongCount, `${await hits()} bilder får taggen, väntade ${before - wrongCount}`)
    assert(!(await page.$(`.tag-images li[data-id="${wrong}"]`)), 'Bilden som inte är rätt visas fortfarande under Får taggen')
    await clickButton(page, 'Spara ändringar')
    await waitForText(page, 'Sparat.', 120_000)
    const withWrong = JSON.parse((await readOpfs(page, `${bank}/app-data/config.json`))!)
    assert(
      JSON.stringify(withWrong.aiTags.find((tag: { tag: string }) => tag.tag === 'röd').excluded) === JSON.stringify([wrong]),
      `config.json: ${JSON.stringify(withWrong)}`,
    )
    const wrongIndex = JSON.parse((await readOpfs(page, `${bank}/app-data/index.json`))!) as IndexFile
    const wrongImage = wrongIndex.images.find((image) => image.id === wrong)!
    assert(!wrongImage.aiTags.includes('röd') && wrongImage.aiTags.length > 0, `${wrong} har AI-taggarna ${wrongImage.aiTags}`)
    assert(
      wrongIndex.images.filter((image) => image.aiTags.includes('röd')).length === before - wrongCount,
      'Index och adminvy är oense om antalet bilder med röd',
    )
    // Ångra gör att bilden kan få taggen igen.
    await page.click(`.tag-wrong li[data-id="${wrong}"] button`)
    await page.waitForSelector(`.tag-images li[data-id="${wrong}"]`, { timeout: 5_000 })
    await waitForText(page, 'annars försvinner de när du lämnar Admin')
    await clickButton(page, 'Ångra ändringar')

    // Under en bild: ett klick på en tagg markerar den, ett klick till tar bort
    // den. En ny tagg som skrivs in får bilden som exempel.
    await step('Alla bilder', clickButton(page, 'Alla bilder och deras taggar'))
    await page.waitForSelector('.image-tags > li .chip', { timeout: 60_000 })
    const [first, firstTag] = await page.$eval('.image-tags > li:has(.chip:not(.fallback))', (element) => [
      element.getAttribute('data-id')!,
      element.querySelector('.chip:not(.fallback)')!.getAttribute('data-tag')!,
    ])
    const chip = `.image-tags > li[data-id="${first}"] .chip[data-tag="${firstTag}"]`
    await page.click(chip)
    await page.waitForSelector(`${chip}.armed`, { timeout: 5_000 })
    await page.click(chip)
    await step('överstruken tagg', page.waitForSelector(`${chip}.removed`, { timeout: 30_000 }))
    await page.type(`.image-tags > li[data-id="${first}"] .add-tag input`, 'nyplats')
    await page.keyboard.press('Enter')
    await step('ny tagg under bilden', page.waitForSelector(`.image-tags > li[data-id="${first}"] .chip[data-tag="nyplats"]:not(.removed)`, { timeout: 30_000 }))
    await waitForText(page, '3 taggar')
    await clickButton(page, 'Spara ändringar')
    await waitForText(page, 'Sparat.', 120_000)
    const byHand = JSON.parse((await readOpfs(page, `${bank}/app-data/config.json`))!)
    const tagNamed = (name: string) => byHand.aiTags.find((tag: { tag: string }) => tag.tag === name)
    assert(
      tagNamed(firstTag).excluded?.includes(first) && JSON.stringify(tagNamed('nyplats').examples) === JSON.stringify([first]),
      `config.json: ${JSON.stringify(byHand)}`,
    )
    const firstImage = (JSON.parse((await readOpfs(page, `${bank}/app-data/index.json`))!) as IndexFile).images.find(
      (image) => image.id === first,
    )!
    assert(
      firstImage.aiTags.includes('nyplats') && !firstImage.aiTags.includes(firstTag),
      `${first} har AI-taggarna ${firstImage.aiTags}`,
    )
    // Ångra borttagningen, och ta bort den nya taggen igen, utan att spara.
    await page.click(`${chip}.removed`)
    await step('ångrad tagg', page.waitForFunction((selector) => !document.querySelector(selector), { timeout: 30_000 }, `${chip}.removed`))
    await clickButton(page, 'Ångra ändringar')

    // Ett klick på den närmaste taggens namn behåller den, krysset tar bort
    // den. Bilden ligger kvar och visar valet tills man sparar.
    await clickButton(page, 'Bilder utan AI-taggar')
    await page.waitForFunction(() => /når inte gränsen/.test(document.querySelector('.tag-untagged .tag-hits')?.textContent ?? ''), {
      timeout: 60_000,
    })
    const nearest = await page.$eval('.image-tags', (list) => {
      const element = list.querySelector('.chip.fallback')
      return element && [element.closest('li[data-id]')!.getAttribute('data-id')!, element.getAttribute('data-tag')!]
    })
    if (nearest) {
      const nearestChip = `.image-tags > li[data-id="${nearest[0]}"] .chip[data-tag="${nearest[1]}"]`
      await page.click(`${nearestChip} .split-keep`)
      await step('vald närmaste tagg', page.waitForSelector(`${nearestChip}.chosen-keep`, { timeout: 30_000 }))
      // Det valda namnet ska synas: grön bakgrund och vit text, även med musen kvar över det.
      const keepStyle = await page.$eval(`${nearestChip} .split-keep`, (element) => {
        const style = getComputedStyle(element)
        return [style.backgroundColor, style.color, element.textContent]
      })
      assert(
        keepStyle[0] === 'rgb(31, 157, 69)' && keepStyle[1] === 'rgb(255, 255, 255)' && keepStyle[2] === nearest[1],
        `Det valda namnet syns inte: ${keepStyle}`,
      )
      await page.click(`${nearestChip} .split-remove`)
      await step('borttagen närmaste tagg', page.waitForSelector(`${nearestChip}.chosen-remove`, { timeout: 30_000 }))
      await page.click(`${nearestChip} .split-remove`)
      await step('ångrat val', page.waitForSelector(`${nearestChip}.fallback`, { timeout: 30_000 }))
      await page.click(`${nearestChip} .split-keep`)
      await step('behållen närmaste tagg', page.waitForSelector(`${nearestChip}.chosen-keep`, { timeout: 30_000 }))
      await waitForText(page, 'annars försvinner de när du lämnar Admin')
      await clickButton(page, 'Ångra ändringar')
      await step('ångrade ändringar', page.waitForSelector(`${nearestChip}.fallback`, { timeout: 30_000 }))
    } else {
      console.log('      Ingen bild fick en närmaste tagg, så valen under bilden testades inte')
    }

    // En tagg kan ange en plats: ett torg eller en park ur listan.
    await selectTag('alla')
    await page.waitForSelector('.tag-place datalist option', { timeout: 10_000 })
    await page.type('.tag-place input', 'Finns inte')
    await page.click('.tag-place button[type="submit"]')
    await step('okänd plats', waitForText(page, 'Hittar inget torg eller park'))
    await page.click('.tag-place input', { count: 3 })
    await page.type('.tag-place input', 'Stortorget')
    await page.click('.tag-place button[type="submit"]')
    await step('vald plats', waitForText(page, 'Stortorget · Gamla Staden · Norr'))
    await clickButton(page, 'Ångra ändringar')

    // Okända nyckelord: ett kopplas till taggen alla, ett döljs.
    await clickButton(page, 'Okända nyckelord')
    await page.waitForSelector('.keyword-rows li', { timeout: 30_000 })
    const [mapped, hiddenWord] = await page.$$eval('.keyword-rows li strong', (elements) =>
      elements.slice(0, 2).map((element) => element.textContent!),
    )
    const row = (word: string) => `.keyword-rows li[data-word=${JSON.stringify(word)}]`
    await page.type(`${row(mapped)} input`, 'alla')
    await page.click(`${row(mapped)} button[type="submit"]`)
    await page.click(`${row(hiddenWord)} > button`)
    await page.waitForFunction(
      (words) => ![...document.querySelectorAll('.keyword-rows li strong')].some((s) => words.includes(s.textContent!)),
      { timeout: 5_000 },
      [mapped, hiddenWord],
    )
    await clickButton(page, 'Spara ändringar')
    await waitForText(page, 'Sparat.', 120_000)
    const withWords = JSON.parse((await readOpfs(page, `${bank}/app-data/config.json`))!)
    assert(
      withWords.aiTags.find((tag: { tag: string }) => tag.tag === 'alla').synonyms?.includes(mapped) &&
        withWords.hiddenKeywords?.includes(hiddenWord),
      `config.json: synonymer ${JSON.stringify(withWords.aiTags.find((tag: { tag: string }) => tag.tag === 'alla'))}, dolda ${withWords.hiddenKeywords}`,
    )

    // De förvalda taggarna läggs till, och de egna taggarna röd, alla och nyplats finns kvar.
    const defaultCount = JSON.parse(await fs.readFile('src/ai/defaultConfig.json', 'utf8')).aiTags.length as number
    await clickButton(page, 'Återställ förvalda taggar')
    await waitForText(page, `0 taggar fick förvalda värden och ${defaultCount.toLocaleString('sv-SE')} lades till`)
    await waitForText(page, `${(defaultCount + 3).toLocaleString('sv-SE')} taggar`)
    await waitForText(page, 'annars försvinner de när du lämnar Admin')
    await clickButton(page, 'Ångra ändringar')
    await page.waitForFunction(() => document.querySelector('.tag-count')?.textContent === '3 taggar', { timeout: 5_000 })

    // Importen ser att taggarna redan är satta.
    await clickButton(page, 'Importera bilder')
    await clickButton(page, 'Sök efter ändringar')
    await waitForPreview(page)
    assert(!(await page.$('::-p-text(Alla bilder får nya AI-taggar)')), 'Importen vill sätta om taggarna som adminvyn satte')
  })

  await test('4.2 metadata läses ur EXIF, IPTC och XMP', async () => {
    // Storleken kommer från den avkodade bilden och kontrolleras i 4.3.
    const fields = ['byline', 'takenAt', 'tags', 'description', 'durationSeconds', 'dpi'] as const
    const differences: string[] = []
    for (const wanted of expected.kept) {
      const actual = firstIndex!.images.find((image) => image.path === wanted.path)
      for (const field of fields) {
        if (JSON.stringify(actual?.[field] ?? null) !== JSON.stringify(wanted[field] ?? null)) {
          differences.push(`${wanted.path} ${field}: ${JSON.stringify(actual?.[field])}, väntade ${JSON.stringify(wanted[field])}`)
        }
      }
    }
    assert(!differences.length, differences.slice(0, 5).join('\n      '))
    const texts = firstIndex!.images.flatMap((image) => [image.byline, image.description, ...image.tags]).join('\n')
    assert(!/Ã|Â/.test(texts), 'Felkodade tecken finns kvar')
    assert(firstIndex!.images.some((image) => image.tags.length), 'Ingen bild fick nyckelord')
    assert(firstIndex!.images.some((image) => image.description), 'Ingen bild fick bildtext')
    assert(firstIndex!.images.some((image) => image.dpi), 'Ingen bild fick dpi')
  })

  await test('4.6 platsen räknas ut från GPS mot Malmös områden', async () => {
    const areas = JSON.parse(await fs.readFile('src/places/malmo-areas.json', 'utf8'))
    const wrong: string[] = []
    for (const wanted of expected.kept) {
      const actual = firstIndex!.images.find((image) => image.path === wanted.path)!
      const place = placeAt(wanted.gps, areas)
      if (JSON.stringify(actual.gps ?? null) !== JSON.stringify(wanted.gps ?? null)) {
        wrong.push(`${wanted.path} gps: ${JSON.stringify(actual.gps)}, väntade ${JSON.stringify(wanted.gps)}`)
      }
      if (JSON.stringify(actual.place) !== JSON.stringify(place)) {
        wrong.push(`${wanted.path} plats: ${JSON.stringify(actual.place)}, väntade ${JSON.stringify(place)}`)
      }
    }
    assert(!wrong.length, wrong.slice(0, 5).join('\n      '))
    const placed = firstIndex!.images.filter((image) => image.place)
    assert(placed.length > 0 && placed.every((image) => image.place!.subdistrict), `${placed.length} bilder fick en plats`)
    assert(firstIndex!.images.every((image) => image.gps || !image.place), 'En bild utan GPS fick en plats')
    console.log(
      `      ${placed.length} av ${firstIndex!.images.length} bilder fick en plats, i ${new Set(placed.map((image) => image.place!.subdistrict)).size} delområden`,
    )
    // Kända punkter: Stortorget ligger i Gamla Staden i stadsområde Norr,
    // Turning Torso i Västra Hamnen och Hyllie station i Hyllievång i Väster.
    const at = (latitude: number, longitude: number) => placeAt({ latitude, longitude }, areas)
    const parts = (latitude: number, longitude: number) => {
      const place = at(latitude, longitude)
      return place && [place.name, place.subdistrict, place.district].join(' · ')
    }
    assert(parts(55.6056, 13.0006) === 'Stortorget · Gamla Staden · Norr', `Stortorget: ${parts(55.6056, 13.0006)}`)
    assert(at(55.6131, 12.9758)?.subdistrict === 'Västra Hamnen', `Turning Torso: ${parts(55.6131, 12.9758)}`)
    assert(at(55.5636, 12.9757)?.subdistrict === 'Hyllievång', `Hyllie: ${parts(55.5636, 12.9757)}`)
    // Taggar som anger en plats: GPS går före, men får namnet i samma delområde.
    const stortorget = { district: 'Norr', subdistrict: 'Gamla Staden', name: 'Stortorget' }
    const kyrkogatan = { district: 'Norr', subdistrict: 'Gamla Staden', name: null }
    const hyllie = { district: 'Väster', subdistrict: 'Hyllievång', name: null }
    assert(JSON.stringify(placeWithTags(null, [stortorget])) === JSON.stringify(stortorget), 'Utan GPS')
    assert(placeWithTags(kyrkogatan, [stortorget])?.name === 'Stortorget', 'GPS i samma delområde')
    assert(placeWithTags(hyllie, [stortorget]) === hyllie, 'GPS i ett annat delområde')
    assert(placeAt({ latitude: 59.3293, longitude: 18.0686 }, areas) === null, 'Stockholm fick en plats i Malmö')
    // Filmens längd och inspelningstid jämförs med vad ffmpeg gav (testdata/app-data).
    const old: IndexFile = JSON.parse(await fs.readFile('testdata/app-data/index.json', 'utf8'))
    for (const video of old.images.filter((image) => image.durationSeconds)) {
      const actual = firstIndex!.images.find((image) => image.path === video.path)
      assert(actual, `${video.path} saknas`)
      assert(Math.abs(actual.durationSeconds! - video.durationSeconds!) < 0.1, `${video.path} är ${actual.durationSeconds} s`)
      assert(actual.takenAt === video.takenAt, `${video.path} togs ${actual.takenAt}, ffmpeg säger ${video.takenAt}`)
    }
  })

  await test('4.3 miniatyrer och förhandsbilder skapas som WebP i rätt storlek', async () => {
    const page = importPage!
    const images = firstIndex!.images.filter((image) => !image.previewProblem)
    const sizes = await imageSizes(page, bank, images.map((image) => image.id))
    const wrong: string[] = []
    for (const image of images) {
      const size = sizes[image.id]
      if (!size) {
        wrong.push(`${image.path}: miniatyr eller förhandsbild saknas eller är inte WebP`)
        continue
      }
      const longest = Math.max(image.width, image.height)
      const [thumbLongest, previewLongest] = [Math.max(...size.thumb), Math.max(...size.preview)]
      if (Math.abs(thumbLongest - Math.min(400, longest)) > 1) wrong.push(`${image.path}: miniatyren är ${size.thumb.join('×')}`)
      if (Math.abs(previewLongest - Math.min(1600, longest)) > 1) wrong.push(`${image.path}: förhandsbilden är ${size.preview.join('×')}`)
      const ratio = image.width / image.height
      if (Math.abs(size.preview[0] / size.preview[1] - ratio) > 0.02 * ratio) {
        wrong.push(`${image.path}: förhandsbilden ${size.preview.join('×')} har inte formatet ${image.width}×${image.height}`)
      }
    }
    assert(!wrong.length, wrong.slice(0, 5).join('\n      '))

    // Storlek och rotation jämförs med vad sharp gav i testdata/app-data.
    const old: IndexFile = JSON.parse(await fs.readFile('testdata/app-data/index.json', 'utf8'))
    for (const before of old.images.filter((image) => !image.previewProblem)) {
      const now = firstIndex!.images.find((image) => image.path === before.path)
      if (!now) continue
      assert(
        now.width === before.width && now.height === before.height,
        `${before.path} är ${now.width}×${now.height}, sharp gav ${before.width}×${before.height}`,
      )
    }

    const broken = firstIndex!.images.find((image) => image.path.endsWith('/Trasig.DNG'))
    assert(broken?.previewProblem?.startsWith('RAW-filen saknar förhandsbild'), `Trasig.DNG: ${broken?.previewProblem}`)
    assert(!(await readOpfs(page, `${bank}/app-data/thumbs/${broken!.id}.webp`)), 'Trasig.DNG har en miniatyr')
    const video = firstIndex!.images.find((image) => image.durationSeconds)
    assert(video && !video.previewProblem && video.width > 0, `Filmen fick ingen stillbild: ${video?.previewProblem}`)
  })

  await test('4.3 TIFF läses och vrids enligt EXIF', async () => {
    const page = importPage!
    await opfs(page, bank, 'original/Fotograf C/Testbild.tif', 'write', tiffFixture(1), '')
    await opfs(page, bank, 'original/Fotograf C/Roterad.tif', 'write', tiffFixture(6), '')
    await clickButton(page, 'Sök igen')
    const { counts } = await waitForPreview(page)
    assert(counts.new === 2, `TIFF-filerna räknas inte som nya: ${JSON.stringify(counts)}`)
    await clickButton(page, 'Starta import')
    await waitForText(page, 'Importen är klar', 120_000)
    const index = JSON.parse((await readOpfs(page, `${bank}/app-data/index.json`))!) as IndexFile
    const plain = index.images.find((image) => image.path.endsWith('/Testbild.tif'))!
    const turned = index.images.find((image) => image.path.endsWith('/Roterad.tif'))!
    assert(!plain.previewProblem && !turned.previewProblem, `${plain.previewProblem ?? turned.previewProblem}`)
    assert(plain.width === 300 && plain.height === 200, `Testbild.tif är ${plain.width}×${plain.height}`)
    assert(turned.width === 200 && turned.height === 300, `Roterad.tif är ${turned.width}×${turned.height}`)
    // Vänster halva är röd. Efter 90 graders vridning medurs hamnar den överst.
    const colors = await previewColors(page, bank, plain.id, turned.id)
    assert(colors.plain === 'röd,blå', `Testbild.tif har ${colors.plain} i vänster och höger kant`)
    assert(colors.turned === 'röd,blå', `Roterad.tif har ${colors.turned} överst och nederst`)
    firstIndex = index
  })

  await test('4.1 flyttade och omdöpta filer behåller sitt id', async () => {
    const page = importPage!
    const [moved, renamed] = [pick(firstIndex!, 'Fotograf A'), pick(firstIndex!, 'Fotograf B')]
    await opfsMove(page, bank, moved.path, 'original/Fotograf C/Flyttad hit.jpg')
    await opfsMove(page, bank, renamed.path, renamed.path.replace(/[^/]+$/, 'Nytt namn.jpg'))
    // Ett index från före platserna saknar gps. Importen läser då positionen ur filerna.
    const withoutGps = JSON.parse((await readOpfs(page, `${bank}/app-data/index.json`))!) as IndexFile
    for (const image of withoutGps.images) {
      delete image.gps
      delete (image as Partial<ImageRecord>).place
    }
    await writeOpfs(page, `${bank}/app-data/index.json`, JSON.stringify(withoutGps, null, 2))
    await clickButton(page, 'Sök efter ändringar')
    const { counts, lists } = await waitForPreview(page)
    assert(counts.moved === 2 && counts.new === 0 && counts.removed === 0, `Efter flytt: ${JSON.stringify(counts)}`)
    assert(
      (lists['Flyttade eller omdöpta, behåller sitt id'] ?? []).includes(`${moved.path} → original/Fotograf C/Flyttad hit.jpg`),
      'Flytten visas inte som från → till',
    )
    const before = await readOpfs(page, `${bank}/app-data/index.json`)
    await clickButton(page, 'Starta import')
    await waitForText(page, 'Importen är klar', 120_000)
    const index = JSON.parse((await readOpfs(page, `${bank}/app-data/index.json`))!) as IndexFile
    const byId = new Map(index.images.map((image) => [image.id, image]))
    assert(byId.get(moved.id)?.path === 'original/Fotograf C/Flyttad hit.jpg', 'Den flyttade bilden bytte id')
    assert(byId.get(moved.id)?.photographer === 'Fotograf C', 'Fotografen följer inte med flytten')
    assert(byId.get(renamed.id)?.path.endsWith('/Nytt namn.jpg'), 'Den omdöpta bilden bytte id')
    assert(index.images.length === firstIndex!.images.length, 'Antalet bilder ändrades')
    const lostPlace = firstIndex!.images.filter(
      (image) => JSON.stringify(byId.get(image.id)?.place) !== JSON.stringify(image.place) || byId.get(image.id)?.gps === undefined,
    )
    assert(!lostPlace.length, `Platsen lästes inte om: ${lostPlace.slice(0, 3).map((image) => image.path)}`)
    assert((await readOpfs(page, `${bank}/app-data/index.prev.json`)) === before, 'index.prev.json är inte förra versionen')
    firstIndex = index
  })

  await test('4.1 ändrade, borttagna, nya och kopierade filer', async () => {
    const page = importPage!
    const [changed, removed, source] = [
      pick(firstIndex!, 'Fotograf A', 1),
      pick(firstIndex!, 'Fotograf B', 1),
      pick(firstIndex!, 'Fotograf A', 2),
    ]
    await opfsAppend(page, bank, changed.path, 'ändrad')
    await opfsDelete(page, bank, removed.path)
    await opfsCopy(page, bank, source.path, 'original/Fotograf C/Ny bild.jpg', 'ny')
    await opfsCopy(page, bank, source.path, 'original/Fotograf C/Kopia.jpg')
    await clickButton(page, 'Sök efter ändringar')
    const { counts, lists } = await waitForPreview(page)
    const summary = JSON.stringify(counts)
    assert(counts.new === 1 && counts.changed === 1 && counts.removed === 1 && counts.moved === 0, summary)
    assert(
      (lists['Dubbletter med exakt samma innehåll, importeras inte'] ?? []).some((line) =>
        line.startsWith('original/Fotograf C/Kopia.jpg'),
      ),
      'Kopian visas inte som dubblett',
    )
    // Borttagningen måste bekräftas innan importen kan starta.
    await waitForText(page, 'finns inte i originalmappen och tas bort ur bildbanken')
    const start = 'button::-p-text(Starta import)'
    assert(await page.$eval(start, (button) => (button as HTMLButtonElement).disabled), 'Importen kan starta utan bekräftelse')
    await page.click('.remove-warning input[type="checkbox"]')
    await page.waitForFunction(() => !document.querySelector<HTMLButtonElement>('.import-preview button.primary')!.disabled, {
      timeout: 5_000,
    })
    await screenshot(page, '4.1-bekrafta-borttagning')
    await clickButton(page, 'Starta import')
    await waitForText(page, 'Importen är klar', 120_000)
    const index = JSON.parse((await readOpfs(page, `${bank}/app-data/index.json`))!) as IndexFile
    const byPath = new Map(index.images.map((image) => [image.path, image]))
    const nextId = `MB-${String(firstIndex!.lastId! + 1).padStart(6, '0')}`
    assert(byPath.get('original/Fotograf C/Ny bild.jpg')?.id === nextId, `Den nya bilden fick inte ${nextId}`)
    assert(byPath.get(changed.path)?.id === changed.id, 'Den ändrade bilden bytte id')
    assert(byPath.get(changed.path)?.hash !== changed.hash, 'Den ändrade bilden fick inte nytt fingeravtryck')
    assert(!index.images.some((image) => image.id === removed.id), 'Den borttagna bilden finns kvar i indexet')
    assert(!byPath.has('original/Fotograf C/Kopia.jpg'), 'Kopian importerades')

    // Ett id återanvänds aldrig, inte ens när bilden har tagits bort.
    await opfsDelete(page, bank, 'original/Fotograf C/Ny bild.jpg')
    await opfsCopy(page, bank, source.path, 'original/Fotograf C/Ännu en.jpg', 'en till')
    await clickButton(page, 'Sök efter ändringar')
    await waitForPreview(page)
    await page.click('.remove-warning input[type="checkbox"]')
    await clickButton(page, 'Starta import')
    await waitForText(page, 'Importen är klar', 120_000)
    const after = JSON.parse((await readOpfs(page, `${bank}/app-data/index.json`))!) as IndexFile
    const reused = after.images.find((image) => image.path === 'original/Fotograf C/Ännu en.jpg')
    const expectedId = `MB-${String(firstIndex!.lastId! + 2).padStart(6, '0')}`
    assert(reused?.id === expectedId, `Den nya bilden fick ${reused?.id}, väntade ${expectedId}`)
    firstIndex = after
  })

  await test('4.1 en JPG som får en RAW-fil bredvid sig behåller sitt id', async () => {
    const page = importPage!
    const jpg = pick(firstIndex!, 'Fotograf A', 4)
    const raw = jpg.path.replace(/\.[^.]+$/, '.CR2')
    await opfsCopy(page, bank, 'original/Fotograf C/RAW-par.CR2', raw, jpg.id)
    await clickButton(page, 'Sök efter ändringar')
    const { counts } = await waitForPreview(page)
    assert(counts.changed === 1 && counts.new === 0 && counts.removed === 0, JSON.stringify(counts))
    await clickButton(page, 'Starta import')
    await waitForText(page, 'Importen är klar', 120_000)
    const index = JSON.parse((await readOpfs(page, `${bank}/app-data/index.json`))!) as IndexFile
    const record = index.images.find((image) => image.id === jpg.id)
    assert(record?.path === raw, `Paret fick inte JPG:ens id: ${record?.path}`)
    assert(JSON.stringify(record.alternates) === JSON.stringify([jpg.path]), 'JPG:en ligger inte i alternates')
    firstIndex = index
  })

  await test('4.1 en avbruten import fortsätter där den slutade', async () => {
    const page = importPage!
    const path = 'original/Fotograf C/Avbruten.jpg'
    const source = pick(firstIndex!, 'Fotograf A', 3)
    await opfsCopy(page, bank, source.path, path, 'avbruten')
    const id = `MB-${String(firstIndex!.lastId! + 1).padStart(6, '0')}`
    // Som om en import avbröts efter att den här bilden blev klar.
    await page.evaluate(
      async (bank, path, id, sourceId) => {
        const hashModule = '/src/import/hash.ts'
        const { quickHash }: typeof import('../src/import/hash.ts') = await import(hashModule)
        const opfs = await navigator.storage.getDirectory()
        let directory = await opfs.getDirectoryHandle(bank)
        for (const part of ['Original', ...path.split('/').slice(1, -1)]) directory = await directory.getDirectoryHandle(part)
        const file = await (await directory.getFileHandle(path.split('/').pop()!)).getFile()
        const record = { id, path, hash: await quickHash(file), fileSize: file.size, fileModified: file.lastModified, description: 'Klar före avbrottet', alternates: [], previewProblem: null }
        const imports = await (await opfs.getDirectoryHandle(bank)).getDirectoryHandle('app-data').then((d) => d.getDirectoryHandle('import', { create: true }))
        const writable = await (await imports.getFileHandle('pagaende.jsonl', { create: true })).createWritable()
        // En post från en import med en annan originalmapp, och en rad som inte skrevs klart.
        const foreign = { ...record, id: 'MB-999999', path: 'original/Annan mapp/finns-inte.jpg', hash: 'q1-annan' }
        await writable.write(JSON.stringify(record) + '\n' + JSON.stringify(foreign) + '\n{"trasig')
        await writable.close()
        // Som om sparandet av indexet också avbröts: en halvskriven index.tmp.json
        // och en tom index.prev.json.
        const app = await (await opfs.getDirectoryHandle(bank)).getDirectoryHandle('app-data')
        for (const [name, content] of [['index.tmp.json', '{"version":1,"ima'], ['index.prev.json', '']]) {
          const file = await (await app.getFileHandle(name, { create: true })).createWritable()
          await file.write(content)
          await file.close()
        }
        // Miniatyr och förhandsbild blev också klara före avbrottet.
        const appData = await (await opfs.getDirectoryHandle(bank)).getDirectoryHandle('app-data')
        for (const folder of ['thumbs', 'previews']) {
          const target = await appData.getDirectoryHandle(folder)
          const image = await (await target.getFileHandle(`${sourceId}.webp`)).getFile()
          const copy = await (await target.getFileHandle(`${id}.webp`, { create: true })).createWritable()
          await copy.write(image)
          await copy.close()
        }
      },
      bank,
      path,
      id,
      source.id,
    )
    await clickButton(page, 'Sök efter ändringar')
    const { counts } = await waitForPreview(page)
    await waitForText(page, '1 bild blev klar i en avbruten import')
    assert(counts.new === 0, `Den redan klara bilden räknas som ny: ${JSON.stringify(counts)}`)
    assert(counts.removed === 0, `Posten från en annan mapp räknas som borttagen: ${JSON.stringify(counts)}`)
    // Uppstädningen visas.
    for (const note of [
      'Den halvfärdiga index.tmp.json togs bort.',
      'index.prev.json var tom eller trasig och togs bort.',
      '1 rader i den avbrutna importens logg var ofullständiga.',
      '1 bilder i den avbrutna importen finns inte i den här originalmappen.',
    ]) {
      await waitForText(page, note, 5_000)
    }
    await screenshot(page, '4.1-uppstadning')
    const cleaned = await bankProblems(page, bank)
    assert(!cleaned.problems.length, cleaned.problems.join('\n      '))
    await clickButton(page, 'Fortsätt importen')
    await waitForText(page, 'Importen är klar', 120_000)
    const after = await bankProblems(page, bank)
    assert(!after.problems.length && after.journal === 0, after.problems.join('\n      '))
    assert(
      JSON.parse((await readOpfs(page, `${bank}/app-data/index.prev.json`))!).images.length > 0,
      'index.prev.json är inte ett helt index',
    )
    const index = JSON.parse((await readOpfs(page, `${bank}/app-data/index.json`))!) as IndexFile
    const record = index.images.find((image) => image.path === path)
    assert(record?.id === id && record.description === 'Klar före avbrottet', 'Bilden från den avbrutna importen gjordes om')
    assert(index.lastId === firstIndex!.lastId! + 1, `lastId är ${index.lastId}`)
    assert(!(await readOpfs(page, `${bank}/app-data/import/pagaende.jsonl`)), 'pagaende.jsonl ligger kvar')
    await clickButton(page, 'Tillbaka till bildbanken')
    await waitForText(page, `${index.images.length} bilder`)
  })
  await (importPage as Page | null)?.close()

  console.log('4.7 Original')

  await test('4.7 nya original kopieras till bildbanken utan att något skrivs över', async () => {
    // En tom bildbank och en egen originalmapp ("externa", som G:) med ett
    // RAW-par och en fil vars namn redan finns i bildbankens original/.
    // Utan AI-modell: importen fungerar ändå, utan AI-vektorer.
    const page = await openPage('/?testdata&fresh&nomodel&name=kopiabank')
    await waitForText(page, 'Bildbanken har inga bilder än', 120_000)
    await page.evaluate(async () => {
      const opfs = await navigator.storage.getDirectory()
      await opfs.removeEntry('externa', { recursive: true }).catch(() => {})
      const external = await opfs.getDirectoryHandle('externa', { create: true })
      async function write(directory: FileSystemDirectoryHandle, folder: string, name: string, data: Blob) {
        const target = await directory.getDirectoryHandle(folder, { create: true })
        const writable = await (await target.getFileHandle(name, { create: true })).createWritable()
        await writable.write(data)
        await writable.close()
      }
      const testFile = async (name: string) =>
        (await fetch(`/__testdata/file?path=${encodeURIComponent(`Original/Fotograf C/${name}`)}`)).blob()
      const jpg = await testFile('RAW-par.jpg')
      await write(external, 'Fotograf C', 'RAW-par.CR2', await testFile('RAW-par.CR2'))
      await write(external, 'Fotograf C', 'RAW-par.jpg', jpg)
      await write(external, 'Fotograf A', 'Krock.jpg', new Blob([jpg, 'annan bild']))
      const bankOriginals = await (await opfs.getDirectoryHandle('kopiabank')).getDirectoryHandle('Original')
      await write(bankOriginals, 'Fotograf A', 'Krock.jpg', new Blob(['finns redan']))
      // Mappväljaren går inte att automatisera. Den ger tillbaka den externa mappen.
      ;(window as unknown as { showDirectoryPicker: () => Promise<FileSystemDirectoryHandle> }).showDirectoryPicker =
        async () => external
    })
    await clickButton(page, 'Admin')
    // Bildbankens egen mapp går inte att välja som originalmapp.
    await page.evaluate(async () => {
      const bank = await (await navigator.storage.getDirectory()).getDirectoryHandle('kopiabank')
      const picker = window as unknown as { showDirectoryPicker: () => Promise<FileSystemDirectoryHandle> }
      const external = picker.showDirectoryPicker
      picker.showDirectoryPicker = async () => {
        picker.showDirectoryPicker = external
        return bank
      }
    })
    await clickButton(page, 'Välj en mapp utanför bildbanken')
    await waitForText(page, '”kopiabank” är bildbankens mapp')
    await clickButton(page, 'Välj en mapp utanför bildbanken')
    await waitForText(page, 'En mapp utanför bildbanken som heter externa')
    await clickButton(page, 'Sök efter ändringar')
    const { counts } = await waitForPreview(page)
    assert(counts.new === 2, `Väntade 2 nya bilder: ${JSON.stringify(counts)}`)
    await waitForText(page, 'AI-modellen saknas i app-data/models/')
    const checkbox = 'label.copy-originals input[type="checkbox"]'
    assert(!(await page.$eval(checkbox, (input) => (input as HTMLInputElement).checked)), 'Kryssrutan är ikryssad från början')
    await page.locator(checkbox).click()
    await screenshot(page, '4.7-kopiera-original')
    await clickButton(page, 'Starta import')
    await waitForText(page, 'Importen är klar', 120_000)
    await waitForText(page, '2 original kopierades till bildbankens original/.')
    const copiedIndex = JSON.parse((await readOpfs(page, 'kopiabank/app-data/index.json'))!) as IndexFile
    assert(!copiedIndex.embeddings, `Indexet har AI-vektorer fast modellen saknas: ${JSON.stringify(copiedIndex.embeddings)}`)
    assert(!(await readOpfs(page, 'kopiabank/app-data/embeddings.bin')), 'embeddings.bin skrevs fast modellen saknas')
    const notOverwritten = (await readPreviewLists(page))[
      'Fanns redan i bildbankens original/ med annat innehåll, skrevs inte över'
    ]
    assert(
      JSON.stringify(notOverwritten) === JSON.stringify(['original/Fotograf A/Krock.jpg']),
      `Filer som inte skrevs över: ${notOverwritten}`,
    )
    assert(
      (await readOpfs(page, 'kopiabank/Original/Fotograf A/Krock.jpg')) === 'finns redan',
      'Filen som redan fanns skrevs över',
    )
    for (const name of ['RAW-par.CR2', 'RAW-par.jpg']) {
      const copied = await readOpfs(page, `kopiabank/Original/Fotograf C/${name}`)
      const source = await fs.readFile(`testdata/Original/Fotograf C/${name}`, 'latin1')
      assert(copied !== null && copied.length > 0, `${name} kopierades inte`)
      assert((await opfs(page, 'kopiabank', `original/Fotograf C/${name}`, 'read')) === Buffer.from(source, 'latin1').toString('base64'), `${name} är inte en exakt kopia`)
    }

    // Med bildbankens egen original/ som originalmapp finns inget att kopiera.
    await clickButton(page, 'Använd bildbankens egen mapp')
    await waitForText(page, 'Bildbankens egen mapp kopiabank › Original')
    await clickButton(page, 'Sök efter ändringar')
    await waitForPreview(page)
    assert(!(await page.$(checkbox)), 'Kryssrutan visas fast originalmappen är bildbankens egen')
    await page.close()
  })

  console.log('5 Sökning, taggning och nedladdning')

  await test('5.1 sökorden hittar böjningar, sammansättningar och ordlistans andra ord', async () => {
    const { aiMatches, matchesWord, searchWords, textMatches } = await import('../src/catalog/search.ts')
    const { buildVocabulary } = await import('../src/catalog/vocabulary.ts')
    const pairs: [string, string, boolean][] = [
      ['cyklar', 'cykel', true], ['cykel', 'cykelbana', true], ['båtar', 'segelbåt', true], ['bron', 'bro', true],
      ['hamnen', 'småbåtshamn', true], ['kyrkan', 'kyrka', true], ['fåglar', 'fågel', true], ['torso', 'Turning Torso', true],
      ['parken', 'Pildammsparken', true], ['husen', 'tegelhus', true],
      ['barn', 'bar', false], ['is', 'kallbadhus', false], ['sol', 'solglasögon', false], ['man', 'människor', false],
    ]
    for (const [query, word, want] of pairs) assert(matchesWord(query, word) === want, `${query} ~ ${word} gav ${!want}`)
    const defaults = JSON.parse(await fs.readFile('src/ai/defaultConfig.json', 'utf8'))
    const vocabulary = buildVocabulary(defaults)
    assert(JSON.stringify(searchWords('turning  torso', vocabulary)) === '["turning  torso"]', 'turning torso delas i två ord')
    const image = async (id: string, fields: Partial<ImageRecord>) => ({ ...(await testRecord(id, `original/A/${id}.jpg`, 'Fotograf A')), ...fields })
    const items = [
      { image: await image('MB-000001', {}), tags: [{ tag: 'bro', ai: true }] },
      { image: await image('MB-000002', { photographer: 'Anna Berg' }), tags: [{ tag: 'cykel', ai: false }] },
      { image: await image('MB-000003', { path: 'original/A/Västra hamnen.jpg' }), tags: [] },
      { image: await image('MB-000004', { place: { district: 'Norr', subdistrict: 'Gamla Staden', name: 'Stortorget' } }), tags: [] },
    ]
    const ids = (text: string) => textMatches(items, text, vocabulary).map((item) => item.id).join(',')
    assert(ids('bridge') === 'MB-000001', `bridge hittar ${ids('bridge')}`)
    assert(ids('cyklar berg') === 'MB-000002', `cyklar berg hittar ${ids('cyklar berg')}`)
    assert(ids('västra') === 'MB-000003', `västra hittar ${ids('västra')}`)
    assert(ids('torget') === 'MB-000004', `torget hittar ${ids('torget')}`)
    assert(ids('cykel bro') === '', `cykel bro hittar ${ids('cykel bro')}`)

    // AI-söket tar bara bilder som sticker ut från resten.
    const vectors = new Map(Array.from({ length: 50 }, (_, n) => [`MB-${n}`, Float32Array.from([n === 7 ? 1 : 0.1 + (n % 5) * 0.01, 1])]))
    const hits = aiMatches(Float32Array.from([1, 0]), vectors, new Set(vectors.keys()))
    assert(JSON.stringify(hits) === '["MB-7"]', `AI-söket gav ${hits}`)
  })

  await test('5.1 sökrutan och filtren i galleriet', async () => {
    const { applyEdits, mergeEdits, parseEdit } = await import('../src/catalog/edits.ts')
    const index = JSON.parse(await fs.readFile('testdata/app-data/index.json', 'utf8')) as IndexFile
    const editLines = await Promise.all(
      (await fs.readdir('testdata/app-data/edits')).map((name) => fs.readFile(`testdata/app-data/edits/${name}`, 'utf8')),
    )
    const merged = mergeEdits(editLines.join('\n').split('\n').flatMap((line) => parseEdit(line) ?? []))
    const images = index.images.map((image) => applyEdits(image, merged))
    const page = await openPage('/?testdata')
    try {
      await page.waitForSelector('.gallery-cell[data-index="0"]', { timeout: 60_000 })
      const status = () => page.$eval('.filter-bar', (element) => (element as HTMLElement).innerText).catch(() => '')
      const shownIds = () =>
        page.$$eval('.gallery-cell', (cells) =>
          cells.sort((a, b) => Number((a as HTMLElement).dataset.index) - Number((b as HTMLElement).dataset.index)).map((cell) => cell.getAttribute('aria-label')!.split(',')[0]),
        )
      const count = (n: number) => `${n.toLocaleString('sv-SE')} ${n === 1 ? 'bild' : 'bilder'}`

      // Filter: fotograf och rättigheter.
      await page.select('select[aria-label="Fotograf"]', 'Fotograf B')
      const fromB = images.filter((image) => image.photographer === 'Fotograf B').length
      await waitForText(page, count(fromB))
      await page.select('select[aria-label="Rättigheter"]', 'blocked')
      const blockedB = images.filter((image) => image.photographer === 'Fotograf B' && image.blocked).length
      await page.waitForFunction((text) => document.querySelector('.filter-bar')?.textContent?.startsWith(text), { timeout: 5_000 }, count(blockedB))
      await clickButton(page, 'Rensa')
      await page.waitForFunction(() => !document.querySelector('.filter-bar'), { timeout: 5_000 })

      // År: bara rimliga år finns i listan.
      const years = await page.$$eval('select[aria-label="År"] option', (options) => options.map((option) => option.textContent))
      assert(!years.includes('0002') && years.includes('2024'), `Åren i listan: ${years}`)
      await page.select('select[aria-label="År"]', '2024')
      const from2024 = images.filter((image) => image.takenAt?.startsWith('2024')).length
      await page.waitForFunction((text) => document.querySelector('.filter-bar')?.textContent?.startsWith(text), { timeout: 5_000 }, count(from2024))
      await clickButton(page, 'Rensa')

      // Sökorden först, sedan AI-sökets träffar.
      await page.type('input[type="search"]', 'cyklar')
      await page.waitForFunction(() => /med sökorden/.test(document.querySelector('.filter-bar')?.textContent ?? '') && !/letar/.test(document.querySelector('.filter-bar')!.textContent!), { timeout: 120_000 })
      const text = await status()
      assert(!text.includes('fungerar inte'), `AI-söket: ${text}`)
      const exact = Number(text.match(/(\d+) med sökorden/)![1])
      assert(exact >= 2, `Bara ${exact} bilder med cykel: ${text}`)
      const first = await shownIds()
      assert(first.slice(0, exact).includes('MB-000012'), `MB-000012 (cykel) är inte bland sökordens träffar: ${first}`)
      await elementScreenshot(page, '.search-bar', '5.1-sokruta')

      // Påhittade ord ger inga träffar, inte heller från AI-söket.
      await page.click('input[type="search"]', { count: 3 })
      await page.type('input[type="search"]', 'xyzzyqwerty')
      await page.waitForFunction(() => document.querySelector('.filter-bar')?.textContent === '0 bilder · 0 med sökorden', { timeout: 60_000 })
      await clickButton(page, 'Rensa')
      await page.waitForFunction(() => !document.querySelector('.filter-bar') && !(document.querySelector('input[type="search"]') as HTMLInputElement).value, { timeout: 5_000 })
    } finally {
      await page.close()
    }
  })

  // Sparar en inställning i appens IndexedDB, t.ex. användarens namn. undefined tar bort den.
  async function setSetting(page: Page, key: string, value: unknown) {
    await page.evaluate(
      (key, value) =>
        new Promise<void>((resolve, reject) => {
          const open = indexedDB.open('malmo-bildbank', 1)
          open.onupgradeneeded = () => open.result.createObjectStore('settings')
          open.onerror = () => reject(open.error)
          open.onsuccess = () => {
            const transaction = open.result.transaction('settings', 'readwrite')
            const store = transaction.objectStore('settings')
            if (value === undefined) store.delete(key)
            else store.put(value, key)
            transaction.oncomplete = () => (open.result.close(), resolve())
            transaction.onerror = () => reject(transaction.error)
          }
        }),
      key,
      value as never,
    )
  }

  // Mappväljaren går inte att automatisera. Den ger tillbaka mappen name i OPFS.
  async function pickOpfsFolder(page: Page, name: string) {
    await page.evaluate(async (name) => {
      const opfs = await navigator.storage.getDirectory()
      await opfs.removeEntry(name, { recursive: true }).catch(() => {})
      const folder = await opfs.getDirectoryHandle(name, { create: true })
      ;(window as unknown as { showDirectoryPicker: () => Promise<FileSystemDirectoryHandle> }).showDirectoryPicker = async () => folder
    }, name)
  }

  async function opfsNames(page: Page, folder: string): Promise<string[]> {
    return page.evaluate(async (folder) => {
      const directory = await (await navigator.storage.getDirectory()).getDirectoryHandle(folder)
      const names: string[] = []
      for await (const name of directory.keys()) names.push(name)
      return names.sort()
    }, folder)
  }

  const testIndex = JSON.parse(await fs.readFile('testdata/app-data/index.json', 'utf8')) as IndexFile

  await test('5.2 liknande bilder i detaljvyn', async () => {
    const { similarTo } = await import('../src/catalog/search.ts')
    const vectors = decodeVectors(toArrayBuffer(await fs.readFile('testdata/app-data/embeddings.bin')), MODEL.dimensions)!
    const page = await openPage('/?testdata')
    try {
      await page.waitForSelector('.gallery-cell[data-index="0"]', { timeout: 60_000 })
      // Den första bilden med liknande bilder.
      const index = testIndex.images.findIndex((image) => similarTo(image.id, vectors).length > 0)
      const image = testIndex.images[index]
      const expected = similarTo(image.id, vectors)
      await page.locator(`.gallery-cell[data-index="${index}"]`).click()
      await page.waitForSelector('dialog.detail[open] .detail-similar .similar-thumb', { timeout: 10_000 })
      const shown = await page.$$eval('.detail-similar .similar-thumb', (items) => items.map((item) => item.getAttribute('aria-label')))
      assert(
        JSON.stringify(shown) === JSON.stringify(expected.slice(0, 8).map((id) => `Öppna ${id}`)),
        `Liknande bilder: ${shown}, väntade ${expected.slice(0, 8)}`,
      )
      await page.click('.detail-similar .similar-thumb')
      await waitForText(page, `Bilder som liknar ${image.id} · ${expected.length + 1} bilder`)
      await page.waitForFunction((id) => document.querySelector('#detail-title')?.textContent === id, { timeout: 5_000 }, expected[0])
      // Bilder utan liknande bilder säger det.
      const lonely = testIndex.images.find((other) => vectors.has(other.id) && !similarTo(other.id, vectors).length)
      if (lonely) assert(similarTo(lonely.id, vectors).length === 0, 'Väntade en bild utan liknande')
    } finally {
      await page.close()
    }
  })

  await test('5.4 ändringshistorik, ångra och kollegornas ändringar varje minut', async () => {
    const page = await openPage('/?testdata&edits=500')
    try {
      await page.waitForSelector('.gallery-cell[data-index="0"]', { timeout: 60_000 })
      await setSetting(page, 'user', 'Testare')
      const image = testIndex.images.find((other) => !other.blocked && !other.previewProblem)!
      const position = testIndex.images.indexOf(image)
      // En kollega spärrar bilden. Appen läser in det utan att sidan laddas om.
      const colleague = { at: new Date().toISOString(), by: 'Kollega', id: image.id, field: 'blocked', value: true }
      await writeOpfs(page, 'testdata/app-data/edits/Kollega.jsonl', JSON.stringify(colleague) + '\n')
      await step(
        'Spärren från kollegan',
        page.waitForSelector(`.gallery-cell[data-index="${position}"].is-blocked`, { timeout: 10_000 }),
      )
      await page.locator(`.gallery-cell[data-index="${position}"]`).click()
      await page.waitForSelector('dialog.detail[open] .history', { timeout: 5_000 })
      await page.click('.history summary')
      const history = await page.$eval('.history', (element) => (element as HTMLElement).innerText)
      assert(history.includes('Kollega') && history.includes('Spärr: Spärrad'), `Historiken: ${history}`)
      assert(await page.$('dialog.detail[open] .blocked-banner'), 'Detaljvyn visar inte spärren')
      assert(!(await page.$('dialog.detail[open] .download-row button.primary')), 'En spärrad bild går att ladda ner')
      await elementScreenshot(page, '.history', '5.4-historik')
      await page.click('.history button.link')
      await page.waitForFunction(() => !document.querySelector('dialog.detail[open] .blocked-banner'), { timeout: 5_000 })
      const own = await readOpfs(page, 'testdata/app-data/edits/Testare.jsonl')
      const undo = JSON.parse(own!.trim().split('\n').at(-1)!)
      assert(undo.by === 'Testare' && undo.field === 'blocked' && undo.value === false, `Ångra skrev ${own}`)
      assert((await readOpfs(page, 'testdata/app-data/edits/Kollega.jsonl'))!.trim() === JSON.stringify(colleague), 'Kollegans fil ändrades')

      // Loggen i Admin visar båda ändringarna.
      await page.keyboard.press('Escape')
      await clickButton(page, 'Admin')
      await clickButton(page, 'Logg')
      await page.waitForSelector('.log-list', { timeout: 10_000 })
      const log = await page.$eval('.log-list', (element) => (element as HTMLElement).innerText)
      assert(log.includes('Kollega') && log.includes('Testare') && log.includes(`${image.id}: Spärr: Inte spärrad`), `Loggen: ${log.slice(0, 400)}`)
    } finally {
      await page.close()
    }
  })

  await test('5.3 Admin, AI-taggar listar taggar satta för hand och gör dem till AI-taggar', async () => {
    const page = await openPage('/?testdata')
    try {
      await page.waitForSelector('.gallery-cell[data-index="0"]', { timeout: 60_000 })
      await clickButton(page, 'Admin')
      await clickButton(page, 'AI-taggar')
      await page.waitForSelector('.hand-tags button', { timeout: 30_000 })
      const names = await page.$$eval('.hand-tags button', (buttons) => buttons.map((button) => (button as HTMLElement).innerText))
      assert(names.some((name) => name.startsWith('Öresund')), `Taggar satta för hand: ${names}`)
      await page.locator('.hand-tags button::-p-text(Öresund)').click()
      await page.waitForFunction(() => !document.querySelector('.hand-tags')?.textContent?.includes('Öresund'), { timeout: 5_000 })
      await waitForText(page, '1 osparad ändring')
      await elementScreenshot(page, '.tag-sidebar', '5.3-handtaggar')
    } finally {
      await page.close()
    }
  })

  await test('5.5 nedladdning till Hämtade bilder, korgen och delade länkar', async () => {
    const { downloadName } = await import('../src/download/download.ts')
    assert(downloadName('MB-000022', 'original/A/IMG_0012.CR2') === 'MB-000022_IMG_0012.CR2', 'Fel filnamn')
    const page = await openPage('/?testdata')
    try {
      await page.waitForSelector('.gallery-cell[data-index="0"]', { timeout: 60_000 })
      await setSetting(page, 'basket', undefined)
      await setSetting(page, 'downloads', undefined)
      // Originalen kopieras inte till testbanken. Två små filer får stå för dem.
      const usable = testIndex.images.filter((image) => !image.blocked && !image.alternates.length && !image.previewProblem)
      const [first, second] = usable
      for (const image of [first, second]) {
        await writeOpfs(page, `testdata/Original/${image.path.split('/').slice(1).join('/')}`, `original ${image.id}`)
      }
      await pickOpfsFolder(page, 'hamtade')
      const position = testIndex.images.indexOf(first)
      const name = downloadName(first.id, first.path)

      // Ladda ner-ikonen syns bara när musen är över bilden.
      const action = `.gallery-slot:has(.gallery-cell[data-index="${position}"]) .cell-action.download`
      const opacity = () => page.$eval(action, (element) => getComputedStyle(element).opacity)
      assert((await opacity()) === '0', 'Ladda ner-ikonen syns utan mus')
      await page.hover(`.gallery-cell[data-index="${position}"]`)
      await page.waitForFunction((selector) => getComputedStyle(document.querySelector(selector)!).opacity === '1', { timeout: 5_000 }, action)
      await page.click(action)
      await waitForText(page, '1 fil hämtades till hamtade.')
      assert((await readOpfs(page, `hamtade/${name}`)) === `original ${first.id}`, 'Filen är inte originalet')
      await page.click('.toast button')

      // Andra gången hämtas inget. En raderad fil hämtas igen.
      await page.locator(`.gallery-cell[data-index="${position}"]`).click()
      await clickButton(page, 'Ladda ner')
      await waitForText(page, `${name} finns redan i hamtade.`)
      await page.evaluate(async (name) => (await (await navigator.storage.getDirectory()).getDirectoryHandle('hamtade')).removeEntry(name), name)
      await clickButton(page, 'Ladda ner')
      await waitForText(page, '1 fil hämtades till hamtade.')
      await elementScreenshot(page, '.detail-download', '5.5-detaljvy')

      // En spärrad bild har ingen Ladda ner och inga ikoner i rutnätet.
      const blocked = testIndex.images.findIndex((image) => image.blocked)
      if (blocked >= 0) assert(!(await page.$(`.gallery-slot:has(.gallery-cell[data-index="${blocked}"]) .cell-action`)), 'En spärrad bild har ikoner')

      // Korgen: Lägg i korgen i detaljvyn, och dra en bild dit från rutnätet.
      await clickButton(page, 'Lägg i korgen')
      await waitForText(page, 'Finns i korgen')
      await page.keyboard.press('Escape')
      await page.evaluate((id) => {
        const data = new DataTransfer()
        data.setData('application/x-bildbank-id', id)
        document.querySelector('.basket')!.dispatchEvent(new DragEvent('drop', { dataTransfer: data, bubbles: true, cancelable: true }))
      }, second.id)
      await page.waitForFunction(() => document.querySelectorAll('.basket-item').length === 2, { timeout: 5_000 })
      // Skärmbilderna visar bara knapparna, inte fotona.
      await page.addStyleTag({ content: 'img { visibility: hidden !important }' })
      await page.hover('.basket-item')
      await elementScreenshot(page, '.basket', '5.5-korg')
      await page.hover(`.gallery-cell[data-index="${position}"]`)
      await elementScreenshot(page, `.gallery-slot:has(.gallery-cell[data-index="${position}"])`, '5.5-ikoner')
      await page.evaluate(async (name) => (await (await navigator.storage.getDirectory()).getDirectoryHandle('hamtade')).removeEntry(name), name)
      await page.click('.basket [aria-label="Ladda ner alla"]')
      await waitForText(page, '2 filer hämtades till hamtade.')
      assert(
        JSON.stringify(await opfsNames(page, 'hamtade')) === JSON.stringify([name, downloadName(second.id, second.path)].sort()),
        `Hämtade bilder: ${await opfsNames(page, 'hamtade')}`,
      )
      await page.click('.basket [aria-label="Dela korgen"]')
      await waitForText(page, 'Länken till 2 bilder är kopierad').catch(() => waitForText(page, `#bilder=${first.id},${second.id}`))

      // Korgen finns kvar efter omladdning, och krysset tar bort en bild.
      await page.goto(`${ORIGIN}/?testdata&keep`)
      await page.waitForFunction(() => document.querySelectorAll('.basket-item').length === 2, { timeout: 30_000 })
      await page.hover('.basket-item')
      await page.click('.basket-item .basket-remove')
      await page.waitForFunction(() => document.querySelectorAll('.basket-item').length === 1, { timeout: 5_000 })

      // En delad länk visar bilderna.
      await page.goto(`${ORIGIN}/?testdata&keep#bilder=${first.id},${second.id}`)
      await waitForText(page, 'Delade bilder · 2 bilder', 30_000)
      await clickButton(page, 'Visa alla bilder')
      assert(!(await page.evaluate(() => location.hash)), 'Länken ligger kvar efter Visa alla bilder')
    } finally {
      await page.close()
    }
  })

  await test('5.6 Kopiera sökväg med bildbankens sökväg på den här datorn', async () => {
    const { localFilePath } = await import('../src/download/localPath.ts')
    assert(localFilePath('C:\\Bildbank\\', 'original/A/b.jpg') === 'C:\\Bildbank\\original\\A\\b.jpg', 'Windows-sökvägen blev fel')
    assert(localFilePath('/Users/x/Bildbank', 'original/A/å.jpg') === '/Users/x/Bildbank/original/A/å.jpg', 'Mac-sökvägen blev fel')
    const page = await openPage('/?testdata')
    try {
      await page.waitForSelector('.gallery-cell[data-index="0"]', { timeout: 60_000 })
      await setSetting(page, 'localPath', undefined)
      await clickButton(page, 'Admin')
      await clickButton(page, 'Den här datorn')
      await page.type('.local-path input', 'C:\\Bildbank')
      await clickButton(page, 'Spara')
      await waitForText(page, 'Sparat.')
      await clickButton(page, 'Tillbaka till bildbanken')
      await page.locator('.gallery-cell[data-index="0"]').click()
      await clickButton(page, 'Kopiera sökväg')
      const expected = localFilePath('C:\\Bildbank', testIndex.images[0].path)
      await waitForText(page, expected)
    } finally {
      await page.close()
    }
  })

  await test('5.7 ändringar och mappens rättigheter bakas in i indexet', async () => {
    const { applyEdits, mergeEdits, parseEdit } = await import('../src/catalog/edits.ts')
    const { bakeEdits, unbake } = await import('../src/catalog/bake.ts')
    const image = { ...(await testRecord('MB-000001', 'original/Fotograf A/a.jpg', 'Fotograf A')), tags: ['hav'], aiTags: ['bro'] }
    const other = await testRecord('MB-000002', 'original/Fotograf A/b.jpg', 'Fotograf A')
    const lines = [
      { at: '2026-01-01', by: 'A', id: 'original/Fotograf A/', field: 'terms', value: 'Mappens villkor' },
      { at: '2026-01-01', by: 'A', id: 'original/Fotograf A/', field: 'blocked', value: true },
      { at: '2026-01-02', by: 'B', id: 'MB-000001', field: 'blocked', value: false },
      { at: '2026-01-02', by: 'B', id: 'MB-000001', tag: 'bro', on: false },
      { at: '2026-01-02', by: 'B', id: 'MB-000001', tag: 'segelbåt', on: true },
      // Mappar kan bara få villkor, samtycke och spärr.
      { at: '2026-01-02', by: 'B', id: 'original/Fotograf A/', field: 'byline', value: 'x' },
    ]
    const edits = mergeEdits(lines.flatMap((line) => parseEdit(JSON.stringify(line)) ?? []))
    const own = applyEdits(image, edits)
    assert(own.terms === 'Mappens villkor' && own.blocked === false && own.byline === '', `Bilden: ${JSON.stringify(own)}`)
    assert(applyEdits(other, edits).blocked === true, 'Mappens spärr gäller inte den andra bilden')
    const baked = bakeEdits(image, edits)
    assert(JSON.stringify(baked.tags) === '["hav","segelbåt"]' && !baked.aiTags.length, `Taggarna: ${baked.tags} / ${baked.aiTags}`)
    assert(baked.terms === 'Mappens villkor' && baked.unedited?.terms === '', `Inbakat: ${JSON.stringify(baked)}`)
    assert(JSON.stringify(unbake(baked)) === JSON.stringify(image), 'unbake ger inte tillbaka bilden')
    assert(JSON.stringify(bakeEdits(baked, edits)) === JSON.stringify(baked), 'En andra inbakning ändrar bilden')
    // En mapps inställning tas bort med null.
    const cleared = mergeEdits([...lines, { at: '2026-01-03', by: 'A', id: 'original/Fotograf A/', field: 'blocked', value: null }].flatMap((line) => parseEdit(JSON.stringify(line)) ?? []))
    assert(applyEdits(other, cleared).blocked === false, 'Mappens spärr gick inte att ta bort')

    // Admin, Rättigheter: spärra en hel mapp i ett svep.
    const page = await openPage('/?testdata')
    try {
      await page.waitForSelector('.gallery-cell[data-index="0"]', { timeout: 60_000 })
      await setSetting(page, 'user', 'Testare')
      await clickButton(page, 'Admin')
      await clickButton(page, 'Rättigheter')
      const form = 'form.folder-form[aria-label="Fotograf C"]'
      await page.waitForSelector(form, { timeout: 10_000 })
      await page.select(`${form} label:nth-of-type(3) select`, 'true')
      await elementScreenshot(page, form, '5.7-mapprattigheter')
      await page.click(`${form} button[type="submit"]`)
      await page.waitForFunction((form) => document.querySelector(`${form} [role="status"]`)?.textContent === 'Sparat.', { timeout: 5_000 }, form)
      await clickButton(page, 'Tillbaka till bildbanken')
      await page.select('select[aria-label="Fotograf"]', 'Fotograf C')
      await page.select('select[aria-label="Rättigheter"]', 'blocked')
      const inC = testIndex.images.filter((image) => image.photographer === 'Fotograf C').length
      await page.waitForFunction((text) => document.querySelector('.filter-bar')?.textContent?.startsWith(text), { timeout: 5_000 }, `${inC} ${inC === 1 ? 'bild' : 'bilder'}`)
    } finally {
      await page.close()
    }
  })
} finally {
  await browser.close()
  await server.close()
  await fs.rm(userDataDir, { recursive: true, force: true }).catch(() => {})
}

if (problems.length) {
  failed++
  console.log('\nProblem under körningen:')
  for (const problem of new Set(problems)) console.log(`  ✗ ${problem}`)
}
console.log(failed ? `\n${failed} fel` : '\nAlla tester gick igenom, inga externa anrop.')
process.exit(failed ? 1 : 0)
