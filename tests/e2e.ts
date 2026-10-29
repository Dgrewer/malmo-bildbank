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
import { findDuplicates } from '../src/catalog/duplicates.ts'
import {
  extension,
  fileFormat,
  fileName,
  formatDuration,
  isSupported,
  isSystemDirectory,
  isSystemFile,
  isVideo,
  RAW_COMPANIONS,
  RAW_EXTENSIONS,
} from '../src/catalog/fileFormat.ts'
import { combinedHash, quickHash } from '../src/import/hash.ts'
import { readMetadata } from '../src/import/metadata.ts'
import { readVideoInfo } from '../src/import/video.ts'
import UTIF from 'utif2'
import { formatDate, rightsExpired } from '../src/catalog/rights.ts'
import type { ImageRecord, IndexFile } from '../src/catalog/types.ts'

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
    console.log(`  ✗ ${name}\n      ${error instanceof Error ? error.message : error}`)
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
    .catch(() => {
      throw new Error(`Texten "${text}" syntes inte`)
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

async function clickButton(page: Page, text: string) {
  await page.locator(`button::-p-text(${text})`).click()
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
    dropped: [...dropped].map(([record, kept]) => `${record.path} (behåller ${kept.path})`),
  }
}

async function testRecord(id: string, file: string, photographer: string): Promise<ImageRecord> {
  return {
    id, path: file, photographer, byline: '', terms: '', rightsUntil: null, consent: 'not-required', blocked: false,
    width: 0, height: 0, takenAt: null, tags: [], description: '', alternates: [], durationSeconds: null,
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
    description: '',
    alternates: [],
    durationSeconds: null,
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
    { name: 'utgångna rättigheter', index: find((i) => rightsExpired(i) && !i.blocked) },
    { name: 'samtycke saknas', index: find((i) => i.consent === 'missing' && !i.blocked && !rightsExpired(i)) },
    { name: 'bild utan anmärkningar', index: find((i) => !i.blocked && !rightsExpired(i) && i.consent !== 'missing') },
    { name: 'RAW med JPG visar båda formaten', index: find((i) => isRaw(i) && i.alternates.length > 0) },
    { name: 'RAW med inbäddad förhandsbild', index: find((i) => isRaw(i) && i.alternates.length === 0) },
    { name: 'video visas som stillbild med längd', index: find((i) => isVideo(i.path)) },
  ]
  // Varje varning ska synas om och endast om bildens data kräver det.
  const warnings = (image: ImageRecord): [string, boolean][] => [
    ['Spärrad. Bilden får inte användas', image.blocked],
    ['Rättigheterna gick ut', rightsExpired(image)],
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
      const rights = image.rightsUntil ? formatDate(image.rightsUntil) : 'Inget slutdatum'
      const formats = [image.path, ...image.alternates].map((file) => `${fileFormat(file)} ${fileName(file)}`)
      if (image.durationSeconds !== null) formats.push(formatDuration(image.durationSeconds))
      for (const value of [image.id, image.photographer, image.byline, image.terms, rights, ...formats]) {
        assert(detail.text.includes(value), `Detaljvyn saknar "${value}"`)
      }
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
    assert((await heading()) === index.images[2].id, `Högerpil två gånger gav ${await heading()}`)
    await previewLoaded()
    await page.keyboard.press('ArrowLeft')
    assert((await heading()) === index.images[1].id, `Vänsterpil gav ${await heading()}`)

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

    await page.keyboard.press('Escape')
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
    await waitForText(page, 'Hittar inte app-data/index.json', 600_000)
    await clickButton(page, 'Importera')
    await clickButton(page, 'Använd bildbankens original')
    await waitForText(page, `${bank}/original`)
    await clickButton(page, 'Sök efter ändringar')
    await waitForText(page, 'Räknar fingeravtryck')
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
    await waitForText(page, 'bilder blev klara i en avbruten import')
    await clickButton(page, 'Fortsätt importen')
    // Första importen skapar miniatyrer och förhandsbilder för alla bilder.
    await waitForText(page, 'Importen är klar', 900_000)
    console.log(`      Första importen tog ${Math.round((Date.now() - started) / 1000)} s, med avbrott`)
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
    const dropped = (await readPreviewLists(page))[DUPLICATES_TITLE] ?? []
    assert(
      JSON.stringify(dropped.sort()) === JSON.stringify(expected.dropped.sort()),
      `Fel dubbletter med samma namn: ${dropped.join(', ')}`,
    )
    assert(firstIndex.duplicates?.length === expected.dropped.length, 'Indexet saknar de bortvalda dubbletterna')
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
    assert(skippedAgain.length === expected.dropped.length, 'Bortvalda dubbletter visas inte vid nästa sökning')
  })

  await test('4.2 metadata läses ur EXIF, IPTC och XMP', async () => {
    // Storleken kommer från den avkodade bilden och kontrolleras i 4.3.
    const fields = ['byline', 'takenAt', 'tags', 'description', 'durationSeconds'] as const
    const differences: string[] = []
    for (const wanted of expected.kept) {
      const actual = firstIndex!.images.find((image) => image.path === wanted.path)
      for (const field of fields) {
        if (JSON.stringify(actual?.[field]) !== JSON.stringify(wanted[field])) {
          differences.push(`${wanted.path} ${field}: ${JSON.stringify(actual?.[field])}, väntade ${JSON.stringify(wanted[field])}`)
        }
      }
    }
    assert(!differences.length, differences.slice(0, 5).join('\n      '))
    const texts = firstIndex!.images.flatMap((image) => [image.byline, image.description, ...image.tags]).join('\n')
    assert(!/Ã|Â/.test(texts), 'Felkodade tecken finns kvar')
    assert(firstIndex!.images.some((image) => image.tags.length), 'Ingen bild fick nyckelord')
    assert(firstIndex!.images.some((image) => image.description), 'Ingen bild fick bildtext')
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
    await waitForText(page, '1 bilder blev klara i en avbruten import')
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
    const page = await openPage('/?testdata&fresh&name=kopiabank')
    await waitForText(page, 'Hittar inte app-data/index.json', 120_000)
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
    await clickButton(page, 'Importera')
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
    await clickButton(page, 'Välj originalmapp')
    await waitForText(page, '”kopiabank” är bildbankens mapp')
    await clickButton(page, 'Välj originalmapp')
    await waitForText(page, 'externa')
    await clickButton(page, 'Sök efter ändringar')
    const { counts } = await waitForPreview(page)
    assert(counts.new === 2, `Väntade 2 nya bilder: ${JSON.stringify(counts)}`)
    const checkbox = 'label.copy-originals input[type="checkbox"]'
    assert(!(await page.$eval(checkbox, (input) => (input as HTMLInputElement).checked)), 'Kryssrutan är ikryssad från början')
    await page.locator(checkbox).click()
    await screenshot(page, '4.7-kopiera-original')
    await clickButton(page, 'Starta import')
    await waitForText(page, 'Importen är klar', 120_000)
    await waitForText(page, '2 original kopierades till bildbankens original/.')
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
    await clickButton(page, 'Använd bildbankens original')
    await clickButton(page, 'Sök efter ändringar')
    await waitForPreview(page)
    assert(!(await page.$(checkbox)), 'Kryssrutan visas fast originalmappen är bildbankens egen')
    await page.close()
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
