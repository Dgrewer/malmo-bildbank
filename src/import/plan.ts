import { formatId, idNumber, type ImageRecord } from '../catalog/types.ts'

// En fil i originalmappen med sitt fingeravtryck.
export interface HashedFile {
  path: string
  hash: string
}

// new: ny bild. changed: samma sökväg men nytt innehåll, eller förra försöket
// gav ingen förhandsbild. moved: samma innehåll på ny sökväg (flyttad eller
// omdöpt). unchanged: inget att göra.
export type Change = 'new' | 'changed' | 'moved' | 'unchanged'

export interface PlanItem<T extends HashedFile> {
  file: T
  id: string
  change: Change
  previous: ImageRecord | null
}

export interface ImportPlan<T extends HashedFile> {
  items: PlanItem<T>[]
  // Bilder i det förra indexet vars fil inte finns kvar.
  removed: ImageRecord[]
  // Filer med exakt samma innehåll som en annan fil. Bara en av dem importeras.
  exactDuplicates: { path: string; sameAs: string }[]
  lastId: number
}

// Jämför originalmappen med det förra indexet. Bilder matchas i första hand på
// fingeravtryck, så att flyttade och omdöpta filer behåller sitt id, och annars
// på sökväg. Befintliga id ändras aldrig, och nya bilder får nästa lediga id.
export function buildPlan<T extends HashedFile>(files: T[], previous: ImageRecord[], lastId = 0): ImportPlan<T> {
  const byHash = new Map<string, ImageRecord>()
  const byPath = new Map<string, ImageRecord>()
  for (const record of previous) {
    if (record.hash) byHash.set(record.hash, record)
    byPath.set(record.path, record)
    lastId = Math.max(lastId, idNumber(record.id))
  }

  // Av filer med samma innehåll behålls den som redan finns i indexet på samma
  // sökväg, annars den första i bokstavsordning.
  const sorted = [...files].sort((a, b) => a.path.localeCompare(b.path, 'sv'))
  const groups = new Map<string, T[]>()
  for (const file of sorted) groups.set(file.hash, [...(groups.get(file.hash) ?? []), file])
  const kept: T[] = []
  const exactDuplicates: { path: string; sameAs: string }[] = []
  for (const group of groups.values()) {
    const keeper = group.find((file) => byHash.get(file.hash)?.path === file.path) ?? group[0]
    kept.push(keeper)
    for (const file of group) if (file !== keeper) exactDuplicates.push({ path: file.path, sameAs: keeper.path })
  }
  kept.sort((a, b) => a.path.localeCompare(b.path, 'sv'))

  const used = new Set<ImageRecord>()
  const items: PlanItem<T>[] = []
  for (const file of kept) {
    const sameContent = byHash.get(file.hash)
    const samePath = byPath.get(file.path)
    if (sameContent && !used.has(sameContent)) {
      used.add(sameContent)
      const change = sameContent.previewProblem ? 'changed' : sameContent.path === file.path ? 'unchanged' : 'moved'
      items.push({ file, id: sameContent.id, change, previous: sameContent })
    } else if (samePath && !used.has(samePath)) {
      used.add(samePath)
      // Ett index från före fingeravtrycken saknar hash. Då räknas filen som oförändrad.
      const change = samePath.hash && samePath.hash !== file.hash ? 'changed' : 'unchanged'
      items.push({ file, id: samePath.id, change: samePath.previewProblem ? 'changed' : change, previous: samePath })
    } else {
      items.push({ file, id: formatId(++lastId), change: 'new', previous: null })
    }
  }

  return { items, removed: previous.filter((record) => !used.has(record)), exactDuplicates, lastId }
}
