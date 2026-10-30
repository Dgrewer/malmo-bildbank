// AI-taggar: app-data/config.json listar taggarna, var och en med en engelsk
// prompt till textmodellen och ett tröskelvärde. En bild får taggen när
// likheten mellan bildens och promptens vektorer är minst tröskelvärdet.
// Beskrivs i docs/index-format.md.

import { readFile, writeFile } from '../fs/folder.ts'
import defaults from './defaultConfig.json'

export interface AiTag {
  // Taggen som den visas i appen, på svenska.
  tag: string
  // Det textmodellen jämför bilden med, på engelska.
  prompt: string
  // Lägsta likhet (skalärprodukt mellan normaliserade vektorer) för att bilden ska få taggen.
  threshold: number
}

export interface BankConfig {
  version: 1
  aiTags: AiTag[]
}

export const DEFAULT_CONFIG = defaults as BankConfig

export class ConfigError extends Error {}

function isTag(value: unknown): value is AiTag {
  const tag = value as AiTag
  return (
    !!tag &&
    typeof tag.tag === 'string' &&
    tag.tag.trim() !== '' &&
    typeof tag.prompt === 'string' &&
    tag.prompt.trim() !== '' &&
    typeof tag.threshold === 'number' &&
    Number.isFinite(tag.threshold)
  )
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
    if (!isTag(value) || seen.has(value.tag.trim())) continue
    seen.add(value.tag.trim())
    aiTags.push({ tag: value.tag.trim(), prompt: value.prompt.trim(), threshold: value.threshold })
  }
  return { config: { version: 1, aiTags }, skipped: parsed.aiTags.length - aiTags.length }
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
  const text = JSON.stringify(config.aiTags.map(({ tag, prompt, threshold }) => [tag, prompt, threshold]))
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text))
  return [...new Uint8Array(digest).slice(0, 8)].map((byte) => byte.toString(16).padStart(2, '0')).join('')
}

export interface TagVector {
  tag: string
  threshold: number
  vector: Float32Array
}

// Taggarna som bilden får, i samma ordning som i config.json.
export function tagsFor(image: Float32Array, tags: TagVector[]): string[] {
  const result: string[] = []
  for (const { tag, threshold, vector } of tags) {
    let similarity = 0
    for (let i = 0; i < vector.length; i++) similarity += vector[i] * image[i]
    if (similarity >= threshold) result.push(tag)
  }
  return result
}
