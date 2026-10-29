import { isValidIndex } from '../catalog/loadIndex.ts'
import { findDirectory, findFile, removeFile, writeFile } from '../fs/folder.ts'

// Skrivning av app-data/index.json, och uppstädning efter en import som
// avbröts medan indexet skrevs.
//
// Ordningen vid en import är alltid: miniatyrer och förhandsbilder först,
// sedan indexet, sist borttagning av filer som det nya indexet inte längre
// pekar på. Ett index pekar därför aldrig på bildfiler som saknas.

async function readText(directory: FileSystemDirectoryHandle, name: string): Promise<string | null> {
  const handle = await findFile(directory, name)
  return handle ? (await handle.getFile()).text() : null
}

// Skriver index.json säkert: först till index.tmp.json, sedan sparas den
// nuvarande versionen som index.prev.json och den nya filen byter namn till
// index.json. Går något fel finns alltid en hel version kvar.
export async function writeIndexFile(appData: FileSystemDirectoryHandle, text: string) {
  if (!isValidIndex(text)) throw new Error('Det nya indexet är inte giltigt och sparades inte.')
  await writeFile(appData, 'index.tmp.json', text)
  // index.prev.json skrivs bara över med ett giltigt index, aldrig med en tom
  // eller trasig fil.
  const previous = await readText(appData, 'index.json')
  if (previous !== null && isValidIndex(previous)) await writeFile(appData, 'index.prev.json', previous)
  try {
    await (await appData.getFileHandle('index.tmp.json')).move('index.json')
  } catch {
    // Mappar på disken (inte webbläsarens egna) kan sakna namnbyte. Då skrivs
    // index.json direkt. createWritable byter ändå ut filen först när allt är skrivet.
    await writeFile(appData, 'index.json', text)
    await removeFile(appData, 'index.tmp.json')
  }
}

// Letar efter filer som en avbruten indexskrivning har lämnat kvar och ser
// till att index.json är helt. Returnerar en mening per åtgärd, för att visas
// för användaren.
export async function recoverIndexFiles(bank: FileSystemDirectoryHandle): Promise<string[]> {
  const appData = await findDirectory(bank, 'app-data')
  if (!appData) return []
  const notes: string[] = []
  const index = await readText(appData, 'index.json')
  const temporary = await readText(appData, 'index.tmp.json')
  const previous = await readText(appData, 'index.prev.json')
  let indexValid = index !== null && isValidIndex(index)

  if (temporary !== null) {
    if (indexValid) {
      notes.push(
        'En tidigare import avbröts medan indexet sparades. index.json var helt och används. ' +
          'Den halvfärdiga index.tmp.json togs bort.',
      )
    } else if (isValidIndex(temporary)) {
      await writeFile(appData, 'index.json', temporary)
      indexValid = true
      notes.push(
        'En tidigare import avbröts medan indexet sparades. index.tmp.json var komplett och sparades som index.json.',
      )
    } else {
      notes.push('En tidigare import lämnade en trasig index.tmp.json. Den togs bort.')
    }
    await removeFile(appData, 'index.tmp.json')
  }

  const previousValid = previous !== null && isValidIndex(previous)
  if (index !== null && !indexValid && previousValid) {
    await writeFile(appData, 'index.json', previous)
    notes.push('index.json var trasig. Föregående version, index.prev.json, återställdes.')
  }
  if (previous !== null && !previousValid) {
    await removeFile(appData, 'index.prev.json')
    notes.push('index.prev.json var tom eller trasig och togs bort.')
  }
  return notes
}
