// Laddar ner AI-modellen till en bildbanks app-data/models/.
//
//   npm run download-model                      till testdata/
//   npm run download-model -- "D:\OneDrive\Bildbank"
//
// Modellen är SigLIP 2 base (google/siglip2-base-patch16-224) i ONNX-format
// från onnx-community, med 8-bitars text- och bildmodell. Versionen är låst
// till en bestämd commit, och varje fil kontrolleras mot sin kontrollsumma.
// Filer som redan finns och stämmer laddas inte ner igen.
//
// Det här är det enda steget som hämtar något från internet. Appen läser
// sedan modellen från bildbankens mapp och gör inga externa anrop.

import { createHash } from 'node:crypto'
import fs from 'node:fs/promises'
import path from 'node:path'
import { MODEL } from '../src/ai/modelInfo.ts'

const REPOSITORY = 'onnx-community/siglip2-base-patch16-224-ONNX'
const REVISION = 'ba1f3b0843f24bc5417d38e19c37b287d719b2f4'
const FILES = [
  'README.md',
  'config.json',
  'preprocessor_config.json',
  'special_tokens_map.json',
  'tokenizer.json',
  'tokenizer_config.json',
  `onnx/${MODEL.textFile}.onnx`,
  `onnx/${MODEL.visionFile}.onnx`,
]

interface TreeEntry {
  type: string
  path: string
  size: number
  oid: string
  lfs?: { oid: string; size: number }
}

// Stora filer har en SHA-256 (lfs.oid). Små filer har git:s SHA-1 över
// "blob <storlek>\0<innehåll>".
function matches(entry: TreeEntry, content: Buffer): boolean {
  if (entry.lfs) return content.length === entry.lfs.size && createHash('sha256').update(content).digest('hex') === entry.lfs.oid
  const blob = createHash('sha1').update(`blob ${content.length}\0`).update(content).digest('hex')
  return blob === entry.oid
}

async function tree(): Promise<Map<string, TreeEntry>> {
  const url = `https://huggingface.co/api/models/${REPOSITORY}/tree/${REVISION}?recursive=1`
  const response = await fetch(url)
  if (!response.ok) throw new Error(`Kunde inte läsa fillistan (${response.status}): ${url}`)
  const entries = (await response.json()) as TreeEntry[]
  return new Map(entries.filter((entry) => entry.type === 'file').map((entry) => [entry.path, entry]))
}

async function existing(file: string): Promise<Buffer | null> {
  try {
    return await fs.readFile(file)
  } catch {
    return null
  }
}

async function download(entry: TreeEntry, target: string) {
  const url = `https://huggingface.co/${REPOSITORY}/resolve/${REVISION}/${entry.path}`
  const response = await fetch(url)
  if (!response.ok || !response.body) throw new Error(`Kunde inte ladda ner ${entry.path} (${response.status})`)
  const total = entry.lfs?.size ?? entry.size
  const parts: Buffer[] = []
  let received = 0
  let shown = -1
  for await (const chunk of response.body) {
    parts.push(Buffer.from(chunk))
    received += chunk.length
    const percent = Math.floor((received / total) * 100)
    if (percent !== shown && total > 10_000_000) {
      process.stdout.write(`\r  ${entry.path}: ${percent} %`)
      shown = percent
    }
  }
  if (shown >= 0) process.stdout.write('\n')
  const content = Buffer.concat(parts)
  if (!matches(entry, content)) throw new Error(`${entry.path} stämmer inte med kontrollsumman. Försök igen.`)
  // Skrivs först till en tillfällig fil, så att en avbruten nedladdning
  // aldrig lämnar en halv modellfil efter sig.
  await fs.mkdir(path.dirname(target), { recursive: true })
  await fs.writeFile(`${target}.part`, content)
  await fs.rename(`${target}.part`, target)
}

async function main() {
  const bank = path.resolve(process.argv[2] ?? 'testdata')
  try {
    await fs.access(path.join(bank, 'original'))
  } catch {
    throw new Error(`${bank} är ingen bildbanksmapp (original/ saknas).`)
  }
  const directory = path.join(bank, 'app-data', 'models', MODEL.name)
  console.log(`Laddar ner ${MODEL.name} till ${directory}`)
  const entries = await tree()
  for (const name of FILES) {
    const entry = entries.get(name)
    if (!entry) throw new Error(`${name} finns inte i ${REPOSITORY}@${REVISION}`)
    const target = path.join(directory, ...name.split('/'))
    const content = await existing(target)
    if (content && matches(entry, content)) {
      console.log(`  ${name}: finns redan`)
      continue
    }
    await download(entry, target)
    console.log(`  ${name}: klar`)
  }
  console.log('Modellen är nedladdad.')
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error)
  process.exit(1)
})
