// Testkrok som bara finns i dev-läge. Mappdialogen går inte att automatisera,
// så ?testdata kopierar testdata/ från utvecklingsservern till webbläsarens
// privata filsystem (OPFS) och ger appen en riktig FileSystemDirectoryHandle.
//
//   ?testdata               hela testdata/, utan originalbilderna
//   ?testdata=Original      en undermapp, t.ex. för att testa felmeddelanden
//   &skip=app-data          hoppa över en mapp på översta nivån
//   &repeat=3000            upprepa indexets poster till 3 000 bilder
//   &originals              kopiera också originalbilderna
//   &fresh                  tom app-data, som en bildbank som aldrig har importerats
//   &keep                   använd mappen som den är sedan förra sidladdningen
//   &name=importtest        mappens namn i OPFS (standard: källmappens namn)
//
// Originalen ligger kvar i OPFS mellan sidladdningar och kopieras bara om de
// saknas eller har en annan storlek. Filer som inte finns i testdata/ tas bort.
//
// Utvecklingsservern lägger in den här filen som ett eget skript före appen
// (se testdataServer i vite.config.ts). Appen importerar den aldrig, så den
// kan inte hamna i produktionsbygget.

declare global {
  interface Window {
    __bildbankTestFolder?: Promise<FileSystemDirectoryHandle>
    __bildbankTestRepeat?: number
  }
}

interface Entry {
  name: string
  kind: 'file' | 'directory'
  size?: number
}

interface Options {
  skip: string | null
  originals: boolean
  fresh: boolean
}

async function list(path: string): Promise<Entry[]> {
  const response = await fetch(`/__testdata/list?path=${encodeURIComponent(path)}`)
  if (!response.ok) throw new Error(`Testdata saknas: ${path}`)
  return response.json()
}

const isOriginal = (name: string) => name.toLowerCase() === 'original'
const isAppData = (name: string) => name.toLowerCase() === 'app-data'

async function copy(source: string, target: FileSystemDirectoryHandle, options: Options, depth: number) {
  const entries = (await list(source)).filter((entry) => !(depth === 0 && entry.name === options.skip))
  const wanted = new Set(entries.map((entry) => entry.name))
  for await (const existing of target.keys()) {
    if (!wanted.has(existing)) await target.removeEntry(existing, { recursive: true })
  }
  for (const entry of entries) {
    const path = source ? `${source}/${entry.name}` : entry.name
    const inOriginals = /(^|\/)original\//i.test(path)
    if (entry.kind === 'directory') {
      const directory = await target.getDirectoryHandle(entry.name, { create: true })
      // app-data finns kvar men är tom med &fresh.
      if (!(depth === 0 && isAppData(entry.name) && options.fresh)) await copy(path, directory, options, depth + 1)
      continue
    }
    // Utan &originals skapas bara mapparna, inte bildfilerna.
    if (inOriginals && !options.originals) continue
    const handle = await target.getFileHandle(entry.name, { create: true })
    if (inOriginals && (await handle.getFile()).size === entry.size) continue
    const response = await fetch(`/__testdata/file?path=${encodeURIComponent(path)}`)
    await response.body!.pipeTo(await handle.createWritable())
  }
}

async function loadTestdataFolder(params: URLSearchParams): Promise<FileSystemDirectoryHandle> {
  const source = params.get('testdata') ?? ''
  const name = params.get('name') || source.split('/').pop() || 'testdata'
  const opfs = await navigator.storage.getDirectory()
  const root = await opfs.getDirectoryHandle(name, { create: true })
  if (params.has('keep')) return root
  const options = { skip: params.get('skip'), originals: params.has('originals'), fresh: params.has('fresh') }
  // Allt utom originalen tas bort och kopieras på nytt.
  for await (const existing of root.keys()) {
    if (!(isOriginal(existing) && options.originals)) await root.removeEntry(existing, { recursive: true })
  }
  await copy(source, root, options, 0)
  return root
}

const params = new URLSearchParams(location.search)
if (params.has('testdata')) window.__bildbankTestFolder = loadTestdataFolder(params)
if (params.has('repeat')) window.__bildbankTestRepeat = Number(params.get('repeat'))

export {}
