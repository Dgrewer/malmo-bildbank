// Namn jämförs utan hänsyn till versaler och Unicode-form. Mappen kan heta
// "Original" i SharePoint, och Mac lagrar å, ä och ö i en annan form (NFD)
// än Windows (NFC).
function sameName(a: string, b: string): boolean {
  return a.normalize('NFC').toLocaleLowerCase('sv') === b.normalize('NFC').toLocaleLowerCase('sv')
}

function isNotFound(error: unknown): boolean {
  return error instanceof DOMException && (error.name === 'NotFoundError' || error.name === 'TypeMismatchError')
}

export async function findDirectory(
  parent: FileSystemDirectoryHandle,
  name: string,
): Promise<FileSystemDirectoryHandle | null> {
  try {
    return await parent.getDirectoryHandle(name)
  } catch (error) {
    if (!isNotFound(error)) throw error
  }
  for await (const entry of parent.values()) {
    if (entry.kind === 'directory' && sameName(entry.name, name)) return entry
  }
  return null
}

async function findFile(parent: FileSystemDirectoryHandle, name: string): Promise<FileSystemFileHandle | null> {
  try {
    return await parent.getFileHandle(name)
  } catch (error) {
    if (!isNotFound(error)) throw error
  }
  for await (const entry of parent.values()) {
    if (entry.kind === 'file' && sameName(entry.name, name)) return entry
  }
  return null
}

// Läser en fil med en sökväg i indexformat, t.ex. "app-data/thumbs/MB-000001.webp".
export async function readFile(root: FileSystemDirectoryHandle, path: string): Promise<File | null> {
  const parts = path.split('/')
  const fileName = parts.pop()!
  let directory: FileSystemDirectoryHandle | null = root
  for (const part of parts) {
    directory = await findDirectory(directory, part)
    if (!directory) return null
  }
  const handle = await findFile(directory, fileName)
  return handle ? handle.getFile() : null
}

// Öppnar en mapp med en sökväg i indexformat, t.ex. "app-data/thumbs", och
// skapar den om den saknas.
export async function ensureDirectory(root: FileSystemDirectoryHandle, path: string): Promise<FileSystemDirectoryHandle> {
  let directory = root
  for (const part of path.split('/')) {
    directory = (await findDirectory(directory, part)) ?? (await directory.getDirectoryHandle(part, { create: true }))
  }
  return directory
}

// createWritable skriver till en temporär fil och byter ut originalet först
// när skrivningen är klar, så en avbruten skrivning lämnar den gamla filen orörd.
export async function writeFile(directory: FileSystemDirectoryHandle, name: string, data: Blob | string) {
  const writable = await (await directory.getFileHandle(name, { create: true })).createWritable()
  try {
    await writable.write(data)
    await writable.close()
  } catch (error) {
    await writable.abort().catch(() => {})
    throw error
  }
}

export async function removeFile(directory: FileSystemDirectoryHandle, name: string) {
  await directory.removeEntry(name).catch((error) => {
    if (!isNotFound(error)) throw error
  })
}

// Skriver index.json säkert: först till index.tmp.json, sedan sparas den
// nuvarande versionen som index.prev.json och den nya filen byter namn till
// index.json. Går något fel finns alltid en hel version kvar.
export async function writeIndexFile(appData: FileSystemDirectoryHandle, text: string) {
  await writeFile(appData, 'index.tmp.json', text)
  const current = await findFile(appData, 'index.json')
  if (current) await writeFile(appData, 'index.prev.json', await current.getFile())
  const temporary = await appData.getFileHandle('index.tmp.json')
  try {
    await temporary.move('index.json')
  } catch {
    // Vissa filsystem byter inte namn till ett namn som redan finns.
    await removeFile(appData, 'index.json')
    await temporary.move('index.json')
  }
}

const REQUIRED_DIRECTORIES = ['original', 'app-data']

// Returnerar ett felmeddelande om mappen inte är bildbankens huvudmapp.
export async function checkRoot(root: FileSystemDirectoryHandle): Promise<string | null> {
  const missing: string[] = []
  try {
    for (const name of REQUIRED_DIRECTORIES) {
      if (!(await findDirectory(root, name))) missing.push(name)
    }
  } catch (error) {
    if (isNotFound(error)) {
      return `Mappen ”${root.name}” hittades inte. Den kan ha flyttats, bytt namn eller tagits bort. Välj mappen igen.`
    }
    throw error
  }
  if (missing.length === 2) {
    return (
      `Mappen ”${root.name}” är inte bildbankens mapp. Den saknar undermapparna original och app-data. ` +
      'Välj den synkade SharePoint-mappen som innehåller dem.'
    )
  }
  if (missing.length === 1) {
    return (
      `Mappen ”${root.name}” saknar undermappen ${missing[0]}. ` +
      'Välj bildbankens huvudmapp, den som innehåller både original och app-data.'
    )
  }
  return null
}
