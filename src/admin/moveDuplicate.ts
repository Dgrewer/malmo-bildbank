import { ensureDirectory, findDirectory, findFile, writeFile } from '../fs/folder.ts'

// Flyttar en fil ur originalmappen till app-data/dubbletter/ med samma sökväg
// som i original/, och loggar flytten i app-data/dubbletter/flyttade.jsonl så
// att den går att ångra (formatet i docs/index-format.md). Filen skrivs först
// och tas bort ur originalmappen först när kopian finns. Returnerar målet.
export async function moveDuplicate(
  bank: FileSystemDirectoryHandle,
  originals: FileSystemDirectoryHandle,
  move: { id: string; path: string },
  kept: { id: string; path: string },
): Promise<string> {
  const parts = move.path.replace(/^original\//, '').split('/')
  const name = parts.pop()!
  let folder: FileSystemDirectoryHandle | null = originals
  for (const part of parts) folder = folder && (await findDirectory(folder, part))
  const handle = folder && (await findFile(folder, name))
  if (!folder || !handle) throw new Error(`${move.path} finns inte längre.`)

  const to = `app-data/dubbletter/${move.path}`
  const target = await ensureDirectory(bank, to.slice(0, to.lastIndexOf('/')))
  if (await findFile(target, name)) throw new Error(`${to} finns redan. Töm app-data/dubbletter/ eller byt namn på filen där.`)
  const file = await handle.getFile()
  await writeFile(target, name, file)
  const copy = await (await findFile(target, name))!.getFile()
  if (copy.size !== file.size) throw new Error(`Kopian av ${move.path} blev inte hel. Originalet ligger kvar.`)
  await folder.removeEntry(handle.name)

  const log = await ensureDirectory(bank, 'app-data/dubbletter')
  const logFile = await log.getFileHandle('flyttade.jsonl', { create: true })
  const size = (await logFile.getFile()).size
  const writable = await logFile.createWritable({ keepExistingData: true })
  try {
    await writable.seek(size)
    const line = { movedAt: new Date().toISOString(), id: move.id, from: move.path, to, keptId: kept.id, keptPath: kept.path }
    await writable.write(`${JSON.stringify(line)}\n`)
  } finally {
    await writable.close()
  }
  return to
}
