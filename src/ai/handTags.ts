// Taggar som någon har satt för hand sprids till liknande bilder, direkt när
// ändringen sparas. Bilderna som fick taggen för hand är exempel, och bilder
// där någon har tagit bort taggen får den aldrig, inte heller bilder som är
// nästan likadana (SAME_MOTIF). Ändringarna läses från app-data/edits/, så
// ingen gemensam fil skrivs.

import type { TagEdit } from '../catalog/edits.ts'
import { wordKey } from '../catalog/vocabulary.ts'
import type { Vectors } from './embeddings.ts'
import { hasExamples, isBlocked, override, similarity, type BankConfig } from './tagConfig.ts'

// Vektorerna för bilderna, efter id. Bilder utan vektor hoppas över.
function vectorsOf(ids: string[], imageVectors: Vectors): Map<string, Float32Array> {
  return new Map(ids.flatMap((id) => (imageVectors.has(id) ? [[id, imageVectors.get(id)!] as const] : [])))
}

// Lägsta likhet med någon av bilderna som fick taggen för hand. I testbilderna
// når en bild den gränsen för ett par procent av de andra bilderna. Har taggen
// exempelbilder i config.json gäller taggens egen gräns.
export const HAND_THRESHOLD = 0.87

// Taggarna som varje bild får från andras taggar, efter id.
export function spreadHandTags(
  imageVectors: Vectors,
  tagEdits: Map<string, Map<string, TagEdit>>,
  config: BankConfig,
): Map<string, string[]> {
  const byKey = new Map<string, { tag: string; on: string[]; off: string[] }>()
  for (const [id, edits] of tagEdits) {
    for (const [key, edit] of edits) {
      const entry = byKey.get(key) ?? { tag: edit.tag, on: [], off: [] }
      entry[edit.on ? 'on' : 'off'].push(id)
      byKey.set(key, entry)
    }
  }
  const result = new Map<string, string[]>()
  for (const [key, { tag, on, off }] of byKey) {
    if (!on.length) continue
    const aiTag = config.aiTags.find((other) => wordKey(other.tag) === key)
    const threshold = aiTag && hasExamples(aiTag) ? aiTag.threshold : HAND_THRESHOLD
    const examples = [...vectorsOf([...on, ...(aiTag?.examples ?? [])], imageVectors).values()]
    const rule = { excluded: vectorsOf([...off, ...(aiTag?.excluded ?? [])], imageVectors), included: new Map() }
    const own = new Set([...on, ...off])
    for (const [id, vector] of imageVectors) {
      if (own.has(id) || isBlocked(override(rule, id, vector))) continue
      if (examples.some((example) => similarity(example, vector) >= threshold)) {
        result.set(id, [...(result.get(id) ?? []), aiTag?.tag ?? tag])
      }
    }
  }
  return result
}
