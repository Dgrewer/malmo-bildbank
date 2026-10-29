import { fileName } from './fileFormat.ts'
import type { ImageRecord } from './types.ts'

// Två poster är dubbletter om filnamnet är detsamma (oavsett fotografmapp, versaler
// och Unicode-form) och tagningstiden är densamma när båda har en. Två olika bilder
// som råkar heta IMG_0001.jpg skiljs alltså åt av tagningstiden.
function sameName(image: ImageRecord): string {
  return fileName(image.path).normalize('NFC').toLowerCase()
}

function sameMoment(a: ImageRecord, b: ImageRecord): boolean {
  return a.takenAt === null || b.takenAt === null || a.takenAt === b.takenAt
}

// Den med högst upplösning behålls. Vid lika upplösning behålls den som
// indexerades först (lägst id), så att taggningar och rättigheter finns kvar.
function better(a: ImageRecord, b: ImageRecord): number {
  return b.width * b.height - a.width * a.height || a.id.localeCompare(b.id)
}

// Returnerar varje dubblett som ska bort, och posten som behålls i stället.
export function findDuplicates(images: ImageRecord[]): Map<ImageRecord, ImageRecord> {
  const groups = new Map<string, ImageRecord[]>()
  for (const image of images) {
    const group = groups.get(sameName(image))
    if (group) group.push(image)
    else groups.set(sameName(image), [image])
  }

  const duplicates = new Map<ImageRecord, ImageRecord>()
  for (const group of groups.values()) {
    if (group.length < 2) continue
    const keepers: ImageRecord[] = []
    for (const image of group.sort(better)) {
      const keeper = keepers.find((kept) => sameMoment(kept, image))
      if (keeper) duplicates.set(image, keeper)
      else keepers.push(image)
    }
  }
  return duplicates
}
