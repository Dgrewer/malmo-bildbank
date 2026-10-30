// Ordlistan: taggarna i app-data/config.json med andra ord för samma sak
// (synonymer, engelska ord, felstavningar) och taggar som hör ihop. Används
// för att visa bildens taggar på svenska, filtrera galleriet och föreslå en
// befintlig tagg när någon skriver en ny. Beskrivs i docs/index-format.md.

import type { BankConfig } from '../ai/tagConfig.ts'
import type { ImageRecord } from './types.ts'

export interface Vocabulary {
  // Ordets nyckel (wordKey) till taggens namn.
  byWord: Map<string, string>
  // Taggens namn till alla taggar i samma grupp, även den själv.
  groups: Map<string, string[]>
  // Nyckelord som inte ska visas.
  hidden: Set<string>
  // Alla taggnamn.
  names: string[]
}

export interface ShownTag {
  tag: string
  // Sant om taggen bara kommer från AI:n, inte från bildfilens nyckelord.
  ai: boolean
}

// Samma nyckel för "Turning Torso", "turning-torso" och "turningtorso".
export const wordKey = (word: string) =>
  word
    .normalize('NFC')
    .toLowerCase()
    .replace(/[\s\-_.,:;'’"()/]+/g, '')

// Utan å, ä, ö och andra accenter. Används bara för förslag.
const looseKey = (word: string) =>
  wordKey(word)
    .normalize('NFD')
    .replace(/\p{M}/gu, '')

export function buildVocabulary(config: BankConfig): Vocabulary {
  const byWord = new Map<string, string>()
  for (const tag of config.aiTags) byWord.set(wordKey(tag.tag), tag.tag)
  // Ett taggnamn går före en synonym till en annan tagg.
  for (const tag of config.aiTags) {
    for (const word of tag.synonyms ?? []) if (!byWord.has(wordKey(word))) byWord.set(wordKey(word), tag.tag)
  }

  // Taggar som hör ihop bildar grupper, även i flera led: hör slott ihop med
  // fästning och fästning med borg hör alla tre ihop.
  const parent = new Map<string, string>()
  const find = (name: string): string => {
    const up = parent.get(name)
    if (!up || up === name) return name
    const root = find(up)
    parent.set(name, root)
    return root
  }
  for (const tag of config.aiTags) {
    for (const other of tag.related ?? []) {
      const name = byWord.get(wordKey(other))
      if (name && name !== tag.tag) parent.set(find(name), find(tag.tag))
    }
  }
  const members = new Map<string, string[]>()
  for (const tag of config.aiTags) {
    const root = find(tag.tag)
    members.set(root, [...(members.get(root) ?? []), tag.tag])
  }
  const groups = new Map<string, string[]>()
  for (const tag of config.aiTags) {
    const group = members.get(find(tag.tag))!
    if (group.length > 1) groups.set(tag.tag, group)
  }

  return {
    byWord,
    groups,
    hidden: new Set((config.hiddenKeywords ?? []).map(wordKey)),
    names: config.aiTags.map((tag) => tag.tag),
  }
}

// Bildens taggar som de visas: nyckelorden från filen, översatta via
// ordlistan, och AI-taggarna. Samma tagg visas en gång, och taggar som hör
// ihop med en av dem läggs till.
export function shownTags(image: Pick<ImageRecord, 'tags' | 'aiTags'>, vocabulary: Vocabulary): ShownTag[] {
  const result = new Map<string, ShownTag>()
  const add = (word: string, ai: boolean) => {
    const key = wordKey(word)
    if (!key || (!ai && vocabulary.hidden.has(key))) return
    const tag = vocabulary.byWord.get(key) ?? word.trim()
    const known = result.get(wordKey(tag))
    if (known) known.ai &&= ai
    else result.set(wordKey(tag), { tag, ai })
  }
  for (const word of image.tags) add(word, false)
  for (const word of image.aiTags) add(word, true)
  for (const shown of [...result.values()]) {
    for (const member of vocabulary.groups.get(shown.tag) ?? []) {
      if (!result.has(wordKey(member))) result.set(wordKey(member), { tag: member, ai: shown.ai })
    }
  }
  return [...result.values()]
}

// Nyckelord som inte finns i ordlistan och inte är dolda, med antal bilder.
export function unknownKeywords(images: ImageRecord[], vocabulary: Vocabulary): { word: string; count: number }[] {
  const counts = new Map<string, { word: string; count: number }>()
  for (const image of images) {
    const seen = new Set<string>()
    for (const word of image.tags) {
      const key = wordKey(word)
      if (!key || seen.has(key) || vocabulary.byWord.has(key) || vocabulary.hidden.has(key)) continue
      seen.add(key)
      const known = counts.get(key)
      if (known) known.count++
      else counts.set(key, { word: word.trim(), count: 1 })
    }
  }
  return [...counts.values()].sort((a, b) => b.count - a.count || a.word.localeCompare(b.word, 'sv'))
}

function distance(a: string, b: string): number {
  if (Math.abs(a.length - b.length) > 2) return 3
  let previous = Array.from({ length: b.length + 1 }, (_, n) => n)
  for (let i = 1; i <= a.length; i++) {
    const row = [i]
    for (let j = 1; j <= b.length; j++) {
      row[j] = Math.min(previous[j] + 1, row[j - 1] + 1, previous[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1))
    }
    previous = row
  }
  return previous[b.length]
}

// Befintliga taggar som ett nytt ord kan vara menat som. exact är taggen om
// ordet redan finns i ordlistan, t.ex. "turningtorso" för Turning Torso. near
// är taggar som stavas nästan likadant.
export function suggestTags(word: string, vocabulary: Vocabulary): { exact: string | null; near: string[] } {
  const key = wordKey(word)
  const exact = vocabulary.byWord.get(key) ?? null
  if (exact || key.length < 3) return { exact, near: [] }
  const loose = looseKey(word)
  const allowed = key.length >= 8 ? 2 : 1
  const near = new Set<string>()
  for (const [other, tag] of vocabulary.byWord) {
    const otherLoose = other.normalize('NFD').replace(/\p{M}/gu, '')
    if (otherLoose === loose || distance(loose, otherLoose) <= allowed) near.add(tag)
  }
  return { exact, near: [...near].slice(0, 5) }
}
