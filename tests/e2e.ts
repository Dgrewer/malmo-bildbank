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

async function clickButton(page: Page, text: string) {
  await page.locator(`button::-p-text(${text})`).click()
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
