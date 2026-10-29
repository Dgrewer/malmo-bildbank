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

import { existsSync } from 'node:fs'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import puppeteer, { type Browser, type Page } from 'puppeteer-core'
import { build, createServer } from 'vite'
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
          return cell.querySelector('.thumb-missing') || (image && image.complete && image.naturalWidth > 0)
        })
      )
    },
    { timeout: 30_000 },
  )
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
      const fields = ['id', 'path', 'photographer', 'byline', 'terms', 'rightsUntil', 'consent', 'blocked']
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
  const find = (match: (image: ImageRecord) => boolean) => index.images.findIndex(match)
  const cases = [
    { name: 'spärrad bild', index: find((i) => i.blocked), expect: ['Spärrad.', 'Bilden får inte användas'] },
    {
      name: 'utgångna rättigheter',
      index: find((i) => rightsExpired(i) && !i.blocked),
      expect: ['Rättigheterna gick ut'],
    },
    {
      name: 'samtycke saknas',
      index: find((i) => i.consent === 'missing' && !i.blocked && !rightsExpired(i)),
      expect: ['Samtycke saknas från personerna på bilden'],
    },
    {
      name: 'bild utan anmärkningar',
      index: find((i) => !i.blocked && !rightsExpired(i) && i.consent !== 'missing'),
      expect: [],
    },
  ]
  const WARNINGS = ['Spärrad.', 'Rättigheterna gick ut', 'Samtycke saknas']

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
      for (const value of [image.id, image.photographer, image.byline, image.terms, rights, ...testCase.expect]) {
        assert(detail.text.includes(value), `Detaljvyn saknar "${value}"`)
      }
      for (const warning of WARNINGS.filter((w) => !testCase.expect.some((e) => e.startsWith(w)))) {
        assert(!detail.text.includes(warning), `Detaljvyn visar "${warning}" i onödan`)
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
  await (detailPage as Page | null)?.close()
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
