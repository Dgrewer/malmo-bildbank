// Importen bakar in användarnas ändringar i index.json, så att indexet stämmer
// även utan appen. Ändringsfilerna i app-data/edits/ ligger kvar och gäller
// fortfarande, så att kollegor som har en äldre kopia av indexet ser samma sak.
// Värdena från filen innan ändringarna sparas i unedited, så att en ändring
// går att ångra och så att nästa import kan baka in ändringarna på nytt.

import { applyEdits, FIELDS, type Edits } from './edits.ts'
import type { ImageRecord } from './types.ts'
import { wordKey } from './vocabulary.ts'

// Bilden utan inbakade ändringar.
export function unbake(image: ImageRecord): ImageRecord {
  if (!image.unedited) return image
  const { unedited, ...rest } = image
  return { ...rest, ...unedited }
}

export function bakeEdits(image: ImageRecord, edits: Edits): ImageRecord {
  const plain = unbake(image)
  const edited = applyEdits(plain, edits)
  const unedited: NonNullable<ImageRecord['unedited']> = {}
  for (const field of FIELDS) {
    if (JSON.stringify(edited[field]) !== JSON.stringify(plain[field])) Object.assign(unedited, { [field]: plain[field] })
  }
  let { tags, aiTags } = plain
  for (const [key, edit] of edits.tags.get(image.id) ?? []) {
    const has = (list: string[]) => list.some((tag) => wordKey(tag) === key)
    if (edit.on && !has(tags)) tags = [...tags, edit.tag]
    if (!edit.on) {
      tags = tags.filter((tag) => wordKey(tag) !== key)
      aiTags = aiTags.filter((tag) => wordKey(tag) !== key)
    }
  }
  if (tags !== plain.tags) unedited.tags = plain.tags
  if (aiTags !== plain.aiTags) unedited.aiTags = plain.aiTags
  if (!Object.keys(unedited).length) return plain
  return { ...edited, tags, aiTags, unedited }
}
