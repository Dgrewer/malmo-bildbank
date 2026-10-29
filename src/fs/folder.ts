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
