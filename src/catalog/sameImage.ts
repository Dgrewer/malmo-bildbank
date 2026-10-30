// Filer med exakt samma innehåll men olika namn. Dubblettregeln i CLAUDE.md
// gäller bara samma filnamn, så de här listas i Admin och flyttas aldrig.

export interface FileHash {
  // Bilden som filen hör till. En RAW-fil och dess JPG hör till samma bild.
  id: string
  path: string
  hash: string
}

const fileName = (path: string) => path.split('/').pop()!.toLocaleLowerCase('sv')

// Grupper av filer med samma fingeravtryck som hör till minst två bilder och
// inte alla heter likadant. Grupperna sorteras efter lägsta id.
export function sameContent(files: FileHash[]): FileHash[][] {
  const byHash = new Map<string, FileHash[]>()
  for (const file of files) byHash.set(file.hash, [...(byHash.get(file.hash) ?? []), file])
  return [...byHash.values()]
    .filter((group) => new Set(group.map((file) => file.id)).size > 1 && new Set(group.map((file) => fileName(file.path))).size > 1)
    .map((group) => [...group].sort((a, b) => a.id.localeCompare(b.id) || a.path.localeCompare(b.path)))
    .sort((a, b) => a[0].id.localeCompare(b[0].id))
}
