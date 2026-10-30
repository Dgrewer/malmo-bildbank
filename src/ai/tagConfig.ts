// AI-taggar: app-data/config.json listar taggarna, var och en med en engelsk
// prompt till textmodellen eller exempelbilder, och ett tröskelvärde. En bild
// får taggen när likheten mellan bildens vektor och taggens är minst
// tröskelvärdet. Beskrivs i docs/index-format.md.

import { readFile, writeFile } from '../fs/folder.ts'
import defaults from './defaultConfig.json'

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
}

export interface BankConfig {
  version: 1
  // En bild som inte når någon tagg får ändå den tagg den ligger närmast.
  atLeastOneTag: boolean
  aiTags: AiTag[]
}

// Tröskelvärden för taggar med prompt och taggar med exempelbilder.
export const TEXT_RANGE = { min: 0, max: 0.15, step: 0.0025, start: 0.05 }
export const EXAMPLE_RANGE = { min: 0.5, max: 1, step: 0.005, start: 0.8 }

export const hasExamples = (tag: AiTag) => !!tag.examples?.length

export const DEFAULT_CONFIG = defaults as BankConfig

export class ConfigError extends Error {}

// En tagg ur config.json, städad, eller null om något saknas.
function cleanTag(value: unknown): AiTag | null {
  const tag = value as Partial<AiTag> | null
  if (!tag || typeof tag.tag !== 'string' || !tag.tag.trim()) return null
  if (typeof tag.threshold !== 'number' || !Number.isFinite(tag.threshold)) return null
  const prompt = typeof tag.prompt === 'string' ? tag.prompt.trim() : ''
  const examples = Array.isArray(tag.examples) ? tag.examples.filter((id) => typeof id === 'string') : []
  if (!prompt && !examples.length) return null
  return { tag: tag.tag.trim(), prompt, threshold: tag.threshold, ...(examples.length && { examples }) }
}

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
  return {
    config: { version: 1, atLeastOneTag: parsed.atLeastOneTag !== false, aiTags },
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
    config.aiTags.map(({ tag, prompt, threshold, examples }) => [tag, prompt, threshold, examples ?? []]),
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
}

// Taggarna som bilden får, i samma ordning som i config.json. Med atLeastOne
// får en bild som inte når någon gräns den tagg den ligger närmast.
export function tagsFor(image: Float32Array, tags: TagVector[], atLeastOne = false): string[] {
  const result = tags.filter((tag) => similarity(tag.vector, image) >= tag.threshold).map((tag) => tag.tag)
  if (result.length || !atLeastOne || !tags.length) return result
  let best = tags[0]
  let bestMargin = margin(best, image)
  for (const tag of tags) {
    const value = margin(tag, image)
    if (value > bestMargin) [best, bestMargin] = [tag, value]
  }
  return [best.tag]
}
