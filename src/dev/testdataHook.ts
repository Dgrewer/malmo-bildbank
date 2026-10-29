// Testkrok som bara finns i dev-läge. Mappdialogen går inte att automatisera,
// så ?testdata kopierar testdata/ från utvecklingsservern till webbläsarens
// privata filsystem (OPFS) och ger appen en riktig FileSystemDirectoryHandle.
//
//   ?testdata               hela testdata/
//   ?testdata=Original      en undermapp, t.ex. för att testa felmeddelanden
//   &skip=app-data          hoppa över en mapp på översta nivån
//   &repeat=3000            upprepa indexets poster till 3 000 bilder
//
// Utvecklingsservern lägger in den här filen som ett eget skript före appen
// (se testdataServer i vite.config.ts). Appen importerar den aldrig, så den
// kan inte hamna i produktionsbygget.
//
// Originalbilderna kopieras inte (appen läser dem inte än), bara mapparna.

declare global {
  interface Window {
    __bildbankTestFolder?: Promise<FileSystemDirectoryHandle>
    __bildbankTestRepeat?: number
  }
}

interface Entry {
  name: string
  kind: 'file' | 'directory'
}

async function list(path: string): Promise<Entry[]> {
  const response = await fetch(`/__testdata/list?path=${encodeURIComponent(path)}`)
  if (!response.ok) throw new Error(`Testdata saknas: ${path}`)
  return response.json()
}

async function copy(source: string, target: FileSystemDirectoryHandle, skip: string | null, depth: number) {
  for (const entry of await list(source)) {
    if (depth === 0 && entry.name === skip) continue
    const path = source ? `${source}/${entry.name}` : entry.name
    if (entry.kind === 'directory') {
      await copy(path, await target.getDirectoryHandle(entry.name, { create: true }), skip, depth + 1)
    } else if (!/(^|\/)original\//i.test(path)) {
      const response = await fetch(`/__testdata/file?path=${encodeURIComponent(path)}`)
      const writable = await (await target.getFileHandle(entry.name, { create: true })).createWritable()
      await response.body!.pipeTo(writable)
    }
  }
}

async function loadTestdataFolder(params: URLSearchParams): Promise<FileSystemDirectoryHandle> {
  const source = params.get('testdata') ?? ''
  const name = source.split('/').pop() || 'testdata'
  const opfs = await navigator.storage.getDirectory()
  await opfs.removeEntry(name, { recursive: true }).catch(() => {})
  const root = await opfs.getDirectoryHandle(name, { create: true })
  await copy(source, root, params.get('skip'), 0)
  return root
}

const params = new URLSearchParams(location.search)
if (params.has('testdata')) window.__bildbankTestFolder = loadTestdataFolder(params)
if (params.has('repeat')) window.__bildbankTestRepeat = Number(params.get('repeat'))

export {}
