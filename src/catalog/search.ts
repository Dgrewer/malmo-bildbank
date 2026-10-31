// Sökningen i galleriet. Sökrutan letar i taggar (med ordlistans andra ord,
// även engelska), plats, fotograf, filnamn, beskrivning och id. Svenska
// böjningar och sammansättningar räknas som samma ord: cyklar hittar cykel och
// båt hittar segelbåt. Bilder där alla sökord finns kommer först. Därefter
// kommer AI-sökets träffar, bilder som AI:n tycker liknar söktexten.

import { similarity } from '../ai/tagConfig.ts'
import { fileName } from './fileFormat.ts'
import { placeParts } from './places.ts'
import type { ImageRecord } from './types.ts'
import { wordKey, type ShownTag, type Vocabulary } from './vocabulary.ts'

export type Rights = 'all' | 'usable' | 'missing' | 'blocked'

export interface Filters {
  photographer: string
  place: string
  year: string
  rights: Rights
}

export const NO_FILTERS: Filters = { photographer: '', place: '', year: '', rights: 'all' }

export const RIGHTS_TEXT: Record<Rights, string> = {
  all: 'Alla rättigheter',
  usable: 'Kan användas',
  missing: 'Samtycke saknas',
  blocked: 'Spärrade',
}

export function year(image: ImageRecord): string {
  return image.takenAt?.match(/^\d{4}/)?.[0] ?? ''
}

export function matchesFilters(image: ImageRecord, filters: Filters): boolean {
  if (filters.photographer && image.photographer !== filters.photographer) return false
  if (filters.place && !(image.place && placeParts(image.place).includes(filters.place))) return false
  if (filters.year && year(image) !== filters.year) return false
  if (filters.rights === 'usable' && (image.blocked || image.consent === 'missing')) return false
  if (filters.rights === 'missing' && image.consent !== 'missing') return false
  if (filters.rights === 'blocked' && !image.blocked) return false
  return true
}

// Vanliga svenska böjningsändelser. n räknas bara efter en vokal (bron,
// skolan), så att barn inte blir bar.
const SUFFIXES = ['arnas', 'ernas', 'ornas', 'arna', 'erna', 'orna', 'ande', 'ens', 'ets', 'are', 'an', 'en', 'et', 'ar', 'er', 'or', 'na', 'a', 'e', 's']
const VOWEL_N = /[aeiouyåäö]n$/

// Ordets möjliga stammar: "cyklarna" -> cyklarna, cykl, ... och "cykel" -> cykel, cykl.
// Två ord är samma ord om de har en stam gemensamt.
export function stems(word: string): Set<string> {
  const key = wordKey(word)
  const result = new Set([key])
  for (const suffix of SUFFIXES) {
    if (key.length - suffix.length >= 3 && key.endsWith(suffix)) result.add(key.slice(0, -suffix.length))
  }
  if (key.length >= 4 && VOWEL_N.test(key)) result.add(key.slice(0, -1))
  // cykel/cyklar, fågel/fåglar, segel/seglen: e:et faller bort i böjningen.
  for (const value of [...result]) result.add(value.replace(/([^aeiouyåäö])el$/, '$1l'))
  return result
}

// Sammansättningar räknas för sökord med minst så många tecken, så att "is"
// inte hittar "kallbadhus". Ett sökord som är början på ett ord måste vara
// längre: båt hittar segelbåt men sol hittar inte solglasögon.
const MIN_LAST_PART = 3
const MIN_FIRST_PART = 4

// Är sökordet samma ord som word, en böjning av det eller en del av en sammansättning?
export function matchesWord(query: string, word: string): boolean {
  const key = wordKey(query)
  if (!key) return false
  const queryStems = stems(query)
  const parts = new Set([word, ...word.split(/[\s\-_]+/)])
  for (const part of parts) {
    const other = wordKey(part)
    if (!other) continue
    if (other === key || [...stems(part)].some((value) => queryStems.has(value))) return true
    for (const value of queryStems) {
      if (value.length >= MIN_LAST_PART && other.endsWith(value)) return true
      if (value.length >= MIN_FIRST_PART && other.startsWith(value)) return true
    }
  }
  return false
}

export interface Searchable {
  image: ImageRecord
  tags: ShownTag[]
}

// Sökorden i texten. Hela texten räknas som ett ord om ordlistan känner igen
// den, t.ex. "turning torso".
export function searchWords(text: string, vocabulary: Vocabulary): string[] {
  const words = text.split(/\s+/).filter((word) => wordKey(word))
  if (words.length > 1 && vocabulary.byWord.has(wordKey(text))) return [text.trim()]
  return words
}

// Bilderna där varje sökord finns, i samma ordning som de kom.
export function textMatches(items: Searchable[], text: string, vocabulary: Vocabulary): ImageRecord[] {
  const words = searchWords(text, vocabulary)
  if (!words.length) return []
  const matchers = words.map((word) => wordMatcher(word, vocabulary))
  return items.filter((item) => matchers.every((matches) => matches(item))).map((item) => item.image)
}

function wordMatcher(word: string, vocabulary: Vocabulary): (item: Searchable) => boolean {
  const key = wordKey(word)
  // Ordlistans taggar som sökordet är ett annat ord för, t.ex. bridge -> bro.
  const tags = new Set<string>()
  for (const [other, tag] of vocabulary.byWord) if (other === key || matchesWord(word, other)) tags.add(wordKey(tag))
  // Samma tagg finns på många bilder, så svaret sparas per tagg.
  const known = new Map<string, boolean>()
  const tagMatches = (tag: string) => {
    let hit = known.get(tag)
    if (hit === undefined) known.set(tag, (hit = tags.has(wordKey(tag)) || matchesWord(word, tag)))
    return hit
  }
  return ({ image, tags: shown }) =>
    shown.some((tag) => tagMatches(tag.tag)) ||
    (!!image.place && placeParts(image.place).some(tagMatches)) ||
    tagMatches(image.photographer) ||
    image.description.split(/\s+/).some((part) => matchesWord(word, part)) ||
    (key.length >= 3 && (wordKey(fileName(image.path)).includes(key) || wordKey(image.id).includes(key)))
}

// Lägsta likhet för Liknande bilder. I testbilderna har en bild i mitten tio
// sådana bilder, och var åttonde bild har ingen.
export const SIMILAR = 0.8

// Bilderna som liknar bilden id mest, den mest lika först.
export function similarTo(id: string, vectors: Map<string, Float32Array>, limit = 100): string[] {
  const own = vectors.get(id)
  if (!own) return []
  const scores: [string, number][] = []
  for (const [other, vector] of vectors) {
    if (other === id) continue
    const score = similarity(own, vector)
    if (score >= SIMILAR) scores.push([other, score])
  }
  return scores
    .sort((a, b) => b[1] - a[1])
    .slice(0, limit)
    .map(([other]) => other)
}

// AI-sökets träffar räknas relativt alla bilder: en bild måste vara minst så
// många standardavvikelser mer lik söktexten än bilderna i genomsnitt. I
// testbilderna ger 3 några få rätta träffar för t.ex. "en cykel" och "snö",
// och inga för påhittade ord.
export const AI_SPREAD = 3
const AI_LIMIT = 200

// Bilderna som AI:n tycker liknar söktexten, den mest lika först.
export function aiMatches(text: Float32Array, vectors: Map<string, Float32Array>, ids: Set<string>): string[] {
  const scores: [string, number][] = []
  for (const [id, vector] of vectors) if (ids.has(id)) scores.push([id, similarity(text, vector)])
  if (scores.length < 2) return []
  const mean = scores.reduce((sum, [, score]) => sum + score, 0) / scores.length
  const spread = Math.sqrt(scores.reduce((sum, [, score]) => sum + (score - mean) ** 2, 0) / scores.length)
  if (!spread) return []
  return scores
    .filter(([, score]) => (score - mean) / spread >= AI_SPREAD)
    .sort((a, b) => b[1] - a[1])
    .slice(0, AI_LIMIT)
    .map(([id]) => id)
}
