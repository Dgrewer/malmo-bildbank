// AI-taggar: app-data/config.json listar taggarna, var och en med en engelsk
// prompt till textmodellen eller exempelbilder, och ett tröskelvärde. En bild
// får taggen när likheten mellan bildens vektor och taggens är minst
// tröskelvärdet. Beskrivs i docs/index-format.md.

import { readFile, writeFile } from '../fs/folder.ts'
import defaults from './defaultConfig.json' with { type: 'json' }
import type { Place } from '../catalog/places.ts'

export interface AiTag {
  // Taggen som den visas i appen, på svenska.
  tag: string
  // Det textmodellen jämför bilden med, på engelska. Får vara tom om taggen har exempelbilder.
  prompt: string
  // Lägsta likhet (skalärprodukt mellan normaliserade vektorer) för att bilden ska få taggen.
  threshold: number
  // Id för bilder som visar motivet. Finns de jämförs bilderna med dem i stället
  // för med prompten. Likheten mellan två bilder är mycket högre än mellan en
  // bild och en text, så tröskelvärdet ligger då runt 0,8.
  examples?: string[]
  // Id för bilder som någon har markerat att taggen inte stämmer på. De får
  // aldrig taggen, och inte heller bilder som är nästan likadana (SAME_MOTIF).
  excluded?: string[]
  // Id för bilder som någon har gett taggen för hand. De får alltid taggen,
  // och bilder som är nästan likadana får den också.
  included?: string[]
  // Andra ord för samma sak: synonymer, engelska ord och felstavningar.
  // Nyckelord i bildfilerna som är något av orden visas som taggen.
  synonyms?: string[]
  // Taggar som hör ihop, t.ex. restaurang och kafé. Har en bild en av dem
  // visas den med alla. Påverkar inte vilka AI-taggar bilderna får.
  related?: string[]
  // Platsen där motivet finns, t.ex. Stortorget för Malmö rådhus. Bilder med
  // taggen som saknar GPS får platsen. Påverkar inte vilka AI-taggar bilderna får.
  place?: Place
}

export interface BankConfig {
  version: 1
  // En bild som inte når någon tagg får ändå den tagg den ligger närmast.
  atLeastOneTag: boolean
  aiTags: AiTag[]
  // Nyckelord från bildfilerna som inte ska visas som taggar.
  hiddenKeywords?: string[]
}

// Tröskelvärden för taggar med prompt och taggar med exempelbilder.
export const TEXT_RANGE = { min: 0, max: 0.15, step: 0.0025, start: 0.05 }
export const EXAMPLE_RANGE = { min: 0.5, max: 1, step: 0.005, start: 0.8 }

// Bilder som är minst så här lika är i stort sett samma bild, t.ex. flera
// bilder i en serie från samma plats. Ligger runt 0,95–1 i testbilderna, medan
// olika bilder av samma byggnad ligger runt 0,9.
export const SAME_MOTIF = 0.95

export const hasExamples = (tag: AiTag) => !!tag.examples?.length

export const DEFAULT_CONFIG = defaults as BankConfig

export class ConfigError extends Error {}

// En tagg ur config.json, städad, eller null om något saknas.
function cleanTag(value: unknown): AiTag | null {
  const tag = value as Partial<AiTag> | null
  if (!tag || typeof tag.tag !== 'string' || !tag.tag.trim()) return null
  if (typeof tag.threshold !== 'number' || !Number.isFinite(tag.threshold)) return null
  const prompt = typeof tag.prompt === 'string' ? tag.prompt.trim() : ''
  const ids = (list: unknown) => (Array.isArray(list) ? list.filter((id) => typeof id === 'string') : [])
  const examples = ids(tag.examples)
  const excluded = ids(tag.excluded).filter((id) => !examples.includes(id))
  const included = ids(tag.included).filter((id) => !examples.includes(id) && !excluded.includes(id))
  const synonyms = words(tag.synonyms)
  const related = words(tag.related)
  if (!prompt && !examples.length) return null
  const place = tag.place
  const validPlace =
    place && typeof place.name === 'string' && typeof place.district === 'string' && (place.subdistrict === null || typeof place.subdistrict === 'string')
  return {
    tag: tag.tag.trim(),
    prompt,
    threshold: tag.threshold,
    ...(examples.length && { examples }),
    ...(excluded.length && { excluded }),
    ...(included.length && { included }),
    ...(synonyms.length && { synonyms }),
    ...(related.length && { related }),
    ...(validPlace && { place: { district: place.district, subdistrict: place.subdistrict, name: place.name } }),
  }
}

// Ord ur config.json, utan tomma och dubbletter.
const words = (list: unknown) =>
  Array.isArray(list)
    ? [...new Set(list.filter((word) => typeof word === 'string').map((word: string) => word.trim()))].filter(Boolean)
    : []

// Tolkar config.json. Taggar som saknar något fält hoppas över, och finns samma
// tagg flera gånger gäller den första.
export function parseConfig(text: string): { config: BankConfig; skipped: number } {
  let parsed: Partial<BankConfig>
  try {
    parsed = JSON.parse(text)
  } catch (error) {
    throw new ConfigError(`app-data/config.json går inte att läsa: ${error instanceof Error ? error.message : error}`)
  }
  if (!parsed || typeof parsed !== 'object' || !Array.isArray(parsed.aiTags)) {
    throw new ConfigError('app-data/config.json saknar listan aiTags.')
  }
  const seen = new Set<string>()
  const aiTags: AiTag[] = []
  for (const value of parsed.aiTags) {
    const tag = cleanTag(value)
    if (!tag || seen.has(tag.tag)) continue
    seen.add(tag.tag)
    aiTags.push(tag)
  }
  const hiddenKeywords = words(parsed.hiddenKeywords)
  return {
    config: {
      version: 1,
      atLeastOneTag: parsed.atLeastOneTag !== false,
      aiTags,
      ...(hiddenKeywords.length && { hiddenKeywords }),
    },
    skipped: parsed.aiTags.length - aiTags.length,
  }
}

// Läser app-data/config.json. Saknas filen skapas den med de förvalda taggarna,
// så att den går att ändra.
export async function readConfig(
  bank: FileSystemDirectoryHandle,
  appData: FileSystemDirectoryHandle,
): Promise<{ config: BankConfig; skipped: number; created: boolean }> {
  const file = await readFile(bank, 'app-data/config.json')
  if (file) return { ...parseConfig(await file.text()), created: false }
  await writeFile(appData, 'config.json', `${JSON.stringify(DEFAULT_CONFIG, null, 2)}\n`)
  return { config: DEFAULT_CONFIG, skipped: 0, created: true }
}

// Ett fingeravtryck av taggarna. Ändras taggarna sätts AI-taggarna om för alla bilder.
export async function configKey(config: BankConfig): Promise<string> {
  const text = JSON.stringify([
    config.atLeastOneTag,
    config.aiTags.map(({ tag, prompt, threshold, examples, excluded, included }) => [
      tag,
      prompt,
      threshold,
      examples ?? [],
      excluded ?? [],
      included ?? [],
    ]),
  ])
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text))
  return [...new Uint8Array(digest).slice(0, 8)].map((byte) => byte.toString(16).padStart(2, '0')).join('')
}

export function similarity(a: Float32Array, b: Float32Array): number {
  let sum = 0
  for (let i = 0; i < a.length; i++) sum += a[i] * b[i]
  return sum
}

// Hur långt över (eller under) taggens gräns bilden ligger, i andelar av
// reglagets omfång. Gör taggar med prompt och med exempelbilder jämförbara.
export function margin(tag: TagVector, image: Float32Array): number {
  const range = tag.examples ? EXAMPLE_RANGE : TEXT_RANGE
  return (similarity(tag.vector, image) - tag.threshold) / (range.max - range.min)
}

export interface TagVector {
  tag: string
  threshold: number
  vector: Float32Array
  // Sant om vektorn kommer från exempelbilder.
  examples: boolean
  // Bilder som inte ska ha taggen, och bilder som har fått den för hand, med sina vektorer.
  excluded: Map<string, Float32Array>
  included: Map<string, Float32Array>
}

// Rättningar för hand går före värdet. 'excluded' och 'included' gäller
// bilden själv, 'like-excluded' och 'like-included' en nästan likadan bild.
export type Override = 'excluded' | 'included' | 'like-excluded' | 'like-included' | null

export function override(tag: Pick<TagVector, 'excluded' | 'included'>, id: string, image: Float32Array): Override {
  if (tag.excluded.has(id)) return 'excluded'
  if (tag.included.has(id)) return 'included'
  for (const other of tag.excluded.values()) if (similarity(other, image) >= SAME_MOTIF) return 'like-excluded'
  for (const other of tag.included.values()) if (similarity(other, image) >= SAME_MOTIF) return 'like-included'
  return null
}

export const isBlocked = (value: Override) => value === 'excluded' || value === 'like-excluded'

// Får bilden taggen? score är likheten mellan taggen och bilden.
export function decide(value: Override, score: number, threshold: number): boolean {
  return value ? !isBlocked(value) : score >= threshold
}

export const matches = (tag: TagVector, id: string, image: Float32Array) =>
  decide(override(tag, id, image), similarity(tag.vector, image), tag.threshold)

// Taggarna som bilden får, i samma ordning som i config.json. Med atLeastOne
// får en bild som inte når någon gräns den tagg den ligger närmast, bland
// taggarna som den inte är markerad som fel för.
export function tagsFor(id: string, image: Float32Array, tags: TagVector[], atLeastOne = false): string[] {
  const result = tags.filter((tag) => matches(tag, id, image)).map((tag) => tag.tag)
  if (result.length || !atLeastOne) return result
  let best: TagVector | null = null
  let bestMargin = -Infinity
  for (const tag of tags) {
    if (isBlocked(override(tag, id, image))) continue
    const value = margin(tag, image)
    if (value > bestMargin) [best, bestMargin] = [tag, value]
  }
  return best ? [best.tag] : []
}
