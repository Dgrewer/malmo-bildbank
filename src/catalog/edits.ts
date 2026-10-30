// Ändringar som användarna gör i appen. Varje användare skriver bara till sin
// egen fil, app-data/edits/<namn>.jsonl, en ändring per rad. Appen läser alla
// filer och slår ihop dem: den senaste ändringen av samma sak gäller.
// Formatet beskrivs i docs/index-format.md.

import { ensureDirectory, findDirectory } from '../fs/folder.ts'
import type { Place } from './places.ts'
import type { Consent, ImageRecord } from './types.ts'
import { wordKey, type ShownTag } from './vocabulary.ts'

export interface FieldValues {
  photographer: string
  byline: string
  terms: string
  rightsUntil: string | null
  consent: Consent
  blocked: boolean
  place: Place | null
}

export type Field = keyof FieldValues
export const FIELDS: Field[] = ['photographer', 'byline', 'terms', 'rightsUntil', 'consent', 'blocked', 'place']

export type Edit = { at: string; by: string; id: string } & (
  | { [F in Field]: { field: F; value: FieldValues[F] } }[Field]
  | { tag: string; on: boolean }
)

// En tagg som någon har lagt till (on) eller tagit bort från en bild.
export interface TagEdit {
  tag: string
  on: boolean
}

export interface Edits {
  // Bildernas fält efter ändringarna, efter id.
  fields: Map<string, Partial<FieldValues>>
  // Taggarna som har ändrats, efter id och ordlistans nyckel.
  tags: Map<string, Map<string, TagEdit>>
}

const CONSENTS: Consent[] = ['given', 'missing', 'not-required']

function validValue(field: string, value: unknown): boolean {
  switch (field) {
    case 'photographer':
    case 'byline':
    case 'terms':
      return typeof value === 'string'
    case 'rightsUntil':
      return value === null || (typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value))
    case 'consent':
      return CONSENTS.includes(value as Consent)
    case 'blocked':
      return typeof value === 'boolean'
    case 'place':
      return (
        value === null ||
        (typeof value === 'object' &&
          typeof (value as Place).district === 'string' &&
          ((value as Place).subdistrict === null || typeof (value as Place).subdistrict === 'string'))
      )
    default:
      return false
  }
}

// En rad ur en ändringsfil, eller null om den inte går att använda.
export function parseEdit(line: string): Edit | null {
  let edit: Record<string, unknown>
  try {
    edit = JSON.parse(line)
  } catch {
    return null
  }
  if (!edit || typeof edit.at !== 'string' || typeof edit.id !== 'string' || typeof edit.by !== 'string') return null
  if (typeof edit.tag === 'string' && typeof edit.on === 'boolean' && edit.tag.trim()) return edit as unknown as Edit
  if (typeof edit.field === 'string' && validValue(edit.field, edit.value)) return edit as unknown as Edit
  return null
}

// Slår ihop ändringarna. Den senaste ändringen av samma fält eller tagg gäller.
export function mergeEdits(all: Edit[]): Edits {
  const edits: Edits = { fields: new Map(), tags: new Map() }
  for (const edit of [...all].sort((a, b) => a.at.localeCompare(b.at))) {
    if ('tag' in edit) {
      const tags = edits.tags.get(edit.id) ?? new Map<string, TagEdit>()
      tags.set(wordKey(edit.tag), { tag: edit.tag.trim(), on: edit.on })
      edits.tags.set(edit.id, tags)
    } else {
      const fields = edits.fields.get(edit.id) ?? {}
      edits.fields.set(edit.id, { ...fields, [edit.field]: edit.value })
    }
  }
  return edits
}

export function applyEdits(image: ImageRecord, edits: Edits): ImageRecord {
  const fields = edits.fields.get(image.id)
  return fields ? { ...image, ...fields } : image
}

// Bildens taggar efter ändringarna: borttagna försvinner, tillagda kommer sist.
export function editedTags(shown: ShownTag[], edits: Map<string, TagEdit> | undefined): ShownTag[] {
  if (!edits) return shown
  const kept = shown.filter((tag) => edits.get(wordKey(tag.tag))?.on !== false)
  const present = new Set(kept.map((tag) => wordKey(tag.tag)))
  const added = [...edits.values()].filter((edit) => edit.on && !present.has(wordKey(edit.tag)))
  return [...kept, ...added.map((edit) => ({ tag: edit.tag, ai: false }))]
}

// Läser alla användares ändringar. Rader som inte går att läsa hoppas över.
export async function loadEdits(root: FileSystemDirectoryHandle): Promise<Edit[]> {
  const appData = await findDirectory(root, 'app-data')
  const directory = appData && (await findDirectory(appData, 'edits'))
  if (!directory) return []
  const all: Edit[] = []
  for await (const entry of directory.values()) {
    if (entry.kind !== 'file' || !entry.name.toLowerCase().endsWith('.jsonl')) continue
    const text = await (await (entry as FileSystemFileHandle).getFile()).text()
    for (const line of text.split('\n')) {
      const edit = line.trim() && parseEdit(line)
      if (edit) all.push(edit)
    }
  }
  return all
}

// Filnamnet för användarens ändringar. Tecken som inte får finnas i filnamn byts ut.
export function editFileName(user: string): string {
  const name = user.normalize('NFC').trim().replace(/[\\/:*?"<>|\u0000-\u001f]/g, '-').replace(/^\.+/, '')
  return `${name || 'okänd'}.jsonl`
}

// Lägger till ändringarna sist i användarens egen fil.
export async function appendEdits(root: FileSystemDirectoryHandle, user: string, edits: Edit[]): Promise<void> {
  if (!edits.length) return
  const directory = await ensureDirectory(root, 'app-data/edits')
  const handle = await directory.getFileHandle(editFileName(user), { create: true })
  const size = (await handle.getFile()).size
  const writable = await handle.createWritable({ keepExistingData: true })
  try {
    await writable.seek(size)
    await writable.write(edits.map((edit) => JSON.stringify(edit)).join('\n') + '\n')
  } finally {
    await writable.close()
  }
}
