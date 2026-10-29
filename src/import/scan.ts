import {
  extension,
  isSupported,
  isSystemDirectory,
  isSystemFile,
  RAW_COMPANIONS,
  RAW_EXTENSIONS,
} from '../catalog/fileFormat.ts'
import { normalizePath } from '../catalog/types.ts'

export interface FoundFile {
  // Sökväg i indexformat: original/<fotograf>/<undermappar>/<fil>
  path: string
  handle: FileSystemFileHandle
  size: number
  modified: number
}

export interface ScannedFile extends FoundFile {
  photographer: string
  // Andra filer av samma bild, t.ex. JPG:en till en RAW-fil.
  alternates: FoundFile[]
}

export interface ScanResult {
  files: ScannedFile[]
  // Filer som inte är bilder eller video, och filer utanför en fotografmapp.
  skipped: string[]
}

function baseName(name: string): string {
  const dot = name.lastIndexOf('.')
  return (dot > 0 ? name.slice(0, dot) : name).normalize('NFC').toLowerCase()
}

async function found(handle: FileSystemFileHandle, path: string): Promise<FoundFile> {
  const file = await handle.getFile()
  return { path, handle, size: file.size, modified: file.lastModified }
}

// Går igenom en mapp och dess undermappar. En RAW-fil och en JPG med samma
// namn i samma mapp blir en bild med RAW-filen som original.
async function scanDirectory(
  directory: FileSystemDirectoryHandle,
  prefix: string,
  photographer: string,
  result: ScanResult,
  onFile: () => void,
) {
  const files: FileSystemFileHandle[] = []
  for await (const entry of directory.values()) {
    const path = `${prefix}/${entry.name}`
    if (entry.kind === 'directory') {
      if (!isSystemDirectory(entry.name)) await scanDirectory(entry, path, photographer, result, onFile)
    } else if (!isSystemFile(entry.name)) files.push(entry)
  }

  const names = files.map((file) => file.name)
  const companions = new Map<string, string>()
  for (const name of names) {
    if (!RAW_EXTENSIONS.has(extension(name))) continue
    const companion = names
      .filter((other) => baseName(other) === baseName(name) && RAW_COMPANIONS.includes(extension(other)))
      .sort((a, b) => RAW_COMPANIONS.indexOf(extension(a)) - RAW_COMPANIONS.indexOf(extension(b)))[0]
    if (companion) companions.set(name, companion)
  }
  const paired = new Set(companions.values())

  for (const handle of files) {
    const path = normalizePath(`${prefix}/${handle.name}`)
    if (paired.has(handle.name)) continue
    if (!isSupported(handle.name)) {
      result.skipped.push(path)
      continue
    }
    const companion = companions.get(handle.name)
    const companionHandle = files.find((file) => file.name === companion)
    result.files.push({
      ...(await found(handle, path)),
      photographer,
      alternates: companionHandle ? [await found(companionHandle, normalizePath(`${prefix}/${companion}`))] : [],
    })
    onFile()
  }
}

// Originalmappen innehåller en mapp per fotograf. Under fotografmappen kan
// bilder ligga direkt eller i undermappar i flera nivåer.
export async function scanOriginals(
  root: FileSystemDirectoryHandle,
  onProgress: (found: number) => void,
): Promise<ScanResult> {
  const result: ScanResult = { files: [], skipped: [] }
  for await (const entry of root.values()) {
    if (entry.kind === 'directory') {
      if (isSystemDirectory(entry.name)) continue
      const photographer = entry.name.normalize('NFC')
      await scanDirectory(entry, `original/${photographer}`, photographer, result, () =>
        onProgress(result.files.length),
      )
    } else if (!isSystemFile(entry.name)) {
      result.skipped.push(normalizePath(`original/${entry.name}`))
    }
  }
  result.files.sort((a, b) => a.path.localeCompare(b.path, 'sv'))
  result.skipped.sort((a, b) => a.localeCompare(b, 'sv'))
  return result
}
