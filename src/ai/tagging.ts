// Sätter AI-taggar på bilderna. Används av importen och av adminvyn AI-taggar.
//
// Taggarnas textvektorer sparas i app-data/ai-taggar-<fingeravtryck>.bin,
// en rad per prompt i samma ordning som index.aiTagging.prompts. Filen byter
// namn när taggarna ändras, så att ett index aldrig läser vektorer som hör
// till andra prompter. Gamla filer tas bort när det nya indexet är sparat.

import { formatId, type ImageRecord, type IndexAiTagging } from '../catalog/types.ts'
import { readFile, removeFile, writeFile } from '../fs/folder.ts'
import { decodeVectors, encodeVectors, type Vectors } from './embeddings.ts'
import { textEmbeddings } from './model.ts'
import { MODEL } from './modelInfo.ts'
import { configKey, tagsFor, type BankConfig } from './tagConfig.ts'

export type PromptVectors = Map<string, Float32Array>

// Textvektorerna som sparades när AI-taggarna senast sattes, efter prompt.
export async function storedPromptVectors(
  appData: FileSystemDirectoryHandle,
  tagging: IndexAiTagging | undefined,
): Promise<PromptVectors> {
  const result: PromptVectors = new Map()
  if (tagging?.model !== MODEL.name || !tagging.file || !tagging.prompts) return result
  const file = await readFile(appData, tagging.file)
  const rows = file && decodeVectors(await file.arrayBuffer(), MODEL.dimensions)
  if (!rows || rows.size !== tagging.prompts.length) return result
  tagging.prompts.forEach((prompt, n) => {
    const vector = rows.get(formatId(n + 1))
    if (vector) result.set(prompt, vector)
  })
  return result
}

// Textvektorer för alla prompter. De som inte redan finns räknas ut med
// textmodellen, några åt gången. onProgress kan kasta för att avbryta.
export async function promptVectors(
  bank: FileSystemDirectoryHandle,
  prompts: string[],
  known: PromptVectors,
  onProgress: (done: number, total: number) => Promise<void> | void = () => {},
): Promise<PromptVectors> {
  const result: PromptVectors = new Map()
  const missing: string[] = []
  for (const prompt of new Set(prompts)) {
    const vector = known.get(prompt)
    if (vector) result.set(prompt, vector)
    else missing.push(prompt)
  }
  for (let start = 0; start < missing.length; start += 16) {
    await onProgress(start, missing.length)
    const chunk = missing.slice(start, start + 16)
    const vectors = await textEmbeddings(bank, chunk)
    chunk.forEach((prompt, n) => result.set(prompt, vectors[n]))
  }
  await onProgress(missing.length, missing.length)
  return result
}

// Sätter aiTags på bilderna. Bilder utan AI-vektor får inga AI-taggar.
export function applyTags(images: ImageRecord[], imageVectors: Vectors, config: BankConfig, vectors: PromptVectors) {
  const tags = config.aiTags.map((tag) => ({ tag: tag.tag, threshold: tag.threshold, vector: vectors.get(tag.prompt)! }))
  for (const image of images) {
    const vector = imageVectors.get(image.id)
    image.aiTags = vector && !image.previewProblem ? tagsFor(vector, tags) : []
  }
}

// Sparar textvektorerna och returnerar det som ska stå i index.aiTagging.
export async function saveTagVectors(
  appData: FileSystemDirectoryHandle,
  config: BankConfig,
  vectors: PromptVectors,
): Promise<IndexAiTagging> {
  const key = await configKey(config)
  const prompts = [...new Set(config.aiTags.map((tag) => tag.prompt))]
  const file = `ai-taggar-${key}.bin`
  const rows: Vectors = new Map(prompts.map((prompt, n) => [formatId(n + 1), vectors.get(prompt)!]))
  await writeFile(appData, file, new Blob([encodeVectors(rows, MODEL.dimensions)]))
  return { model: MODEL.name, config: key, prompts, file }
}

// Tar bort textvektorer som det sparade indexet inte längre använder.
export async function removeOldTagVectors(appData: FileSystemDirectoryHandle, keep: string | undefined) {
  const old: string[] = []
  for await (const name of appData.keys()) {
    if (/^ai-taggar.*\.bin$/.test(name) && name !== keep) old.push(name)
  }
  for (const name of old) await removeFile(appData, name)
}
