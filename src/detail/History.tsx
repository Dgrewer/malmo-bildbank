import { useEffect, useState } from 'react'
import { editKey, type Edit, type FieldValues } from '../catalog/edits.ts'
import { placeParts } from '../catalog/places.ts'
import { CONSENT_TEXT } from '../catalog/rights.ts'
import type { ImageRecord } from '../catalog/types.ts'
import { loadUserName } from '../fs/folderStore.ts'

const FIELD_TEXT: Record<keyof FieldValues, string> = {
  photographer: 'Fotograf',
  byline: 'Byline',
  terms: 'Villkor',
  consent: 'Samtycke',
  blocked: 'Spärr',
  place: 'Plats',
}

function valueText(field: keyof FieldValues, value: unknown): string {
  // En fotografmapps inställning som har tagits bort.
  if (value === null && field !== 'place') return 'Som i bilderna'
  if (field === 'consent') return CONSENT_TEXT[value as FieldValues['consent']]
  if (field === 'blocked') return value ? 'Spärrad' : 'Inte spärrad'
  if (field === 'place') return value ? placeParts(value as NonNullable<FieldValues['place']>).join(', ') : 'Ingen plats'
  return String(value) || 'Tomt'
}

// "La till taggen bro", "Samtycke: Finns".
export function editText(edit: Edit): string {
  if ('tag' in edit) return `${edit.on ? 'La till' : 'Tog bort'} taggen ${edit.tag}`
  return `${FIELD_TEXT[edit.field]}: ${valueText(edit.field, edit.value)}`
}

// "31 okt. 2026 02:10"
export const formatTime = (at: string) =>
  new Date(at).toLocaleString('sv-SE', { day: 'numeric', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' })

// Ändringen som tar tillbaka edit: för ett fält värdet före ändringen, för en
// tagg tvärtom (en felaktigt tillagd tagg tas bort).
export function undoEdit(edit: Edit, earlier: Edit[], image: ImageRecord, by: string): Edit {
  const base = { at: new Date().toISOString(), by, id: edit.id }
  if ('tag' in edit) return { ...base, tag: edit.tag, on: !edit.on }
  const before = earlier.filter((other) => !('tag' in other) && other.field === edit.field).at(-1)
  // Utan tidigare ändring: värdet från filen, före det som importen har bakat in.
  const value =
    before && !('tag' in before)
      ? before.value
      : image.unedited && edit.field in image.unedited
        ? image.unedited[edit.field]
        : image[edit.field]
  return { ...base, field: edit.field, value } as Edit
}

interface Props {
  // Bilden som den står i indexet, före ändringarna.
  indexed: ImageRecord
  // Alla ändringar av bilden, från alla användare.
  edits: Edit[]
  onSave: (user: string, edits: Edit[]) => Promise<void>
}

// Ändringshistoriken, den senaste först. Den ändring som gäller för ett fält
// eller en tagg går att ångra. Ångra sparas som en ny ändring i användarens fil.
export function History({ indexed, edits, onSave }: Props) {
  const [user, setUser] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  useEffect(() => {
    loadUserName().then(setUser, () => setUser(''))
  }, [])

  const sorted = [...edits].sort((a, b) => a.at.localeCompare(b.at))
  const current = new Map(sorted.map((edit) => [editKey(edit), edit]))

  async function undo(edit: Edit) {
    setBusy(true)
    setError(null)
    try {
      await onSave(user, [undoEdit(edit, sorted.slice(0, sorted.indexOf(edit)), indexed, user)])
    } catch (problem) {
      setError(`Det gick inte att ångra: ${problem instanceof Error ? problem.message : problem}`)
    } finally {
      setBusy(false)
    }
  }

  return (
    <details className="history">
      <summary>Ändringar ({edits.length})</summary>
      <ul>
        {[...sorted].reverse().map((edit, n) => (
          <li key={n}>
            <span className="history-when">
              {formatTime(edit.at)} · {edit.by}
            </span>
            <span>{editText(edit)}</span>
            {current.get(editKey(edit)) === edit && user && (
              <button type="button" className="link" disabled={busy} onClick={() => undo(edit)}>
                Ångra
              </button>
            )}
          </li>
        ))}
      </ul>
      {!user && <small>Du kan ångra en ändring när du har skrivit ditt namn under Redigera.</small>}
      {error && (
        <p className="error" role="alert">
          {error}
        </p>
      )}
    </details>
  )
}
