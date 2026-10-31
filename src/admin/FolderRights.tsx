import { useEffect, useMemo, useState } from 'react'
import { folderId, mergeEdits, type Edit, type FolderField } from '../catalog/edits.ts'
import { CONSENT_TEXT } from '../catalog/rights.ts'
import type { Consent, ImageRecord } from '../catalog/types.ts'
import { loadUserName, saveUserName } from '../fs/folderStore.ts'

interface Props {
  // Bilderna som de står i indexet.
  images: ImageRecord[]
  edits: Edit[]
  onSave: (user: string, edits: Edit[]) => Promise<void>
}

// Mappens inställning för ett fält, eller null om bilderna har sina egna.
type Values = { terms: string | null; consent: Consent | null; blocked: boolean | null }

const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b)

// Admin, fliken Rättigheter: villkor, samtycke och spärr för en hel
// fotografmapp i ett svep. En bild som har en egen inställning behåller den.
export function FolderRights({ images, edits, onSave }: Props) {
  const merged = useMemo(() => mergeEdits(edits), [edits])
  const folders = useMemo(() => {
    const counts = new Map<string, { name: string; count: number; own: number }>()
    for (const image of images) {
      const id = folderId(image.path)
      const entry = counts.get(id) ?? { name: image.path.split('/')[1], count: 0, own: 0 }
      entry.count++
      const fields = merged.fields.get(image.id)
      if (fields && ('terms' in fields || 'consent' in fields || 'blocked' in fields)) entry.own++
      counts.set(id, entry)
    }
    return [...counts].sort((a, b) => a[1].name.localeCompare(b[1].name, 'sv'))
  }, [images, merged])
  const [user, setUser] = useState<string | null>(null)
  useEffect(() => {
    loadUserName().then(setUser, () => setUser(''))
  }, [])

  return (
    <section className="folder-rights">
      <p>
        Ställ in villkor, samtycke och spärr för alla bilder i en fotografmapp. En bild som har en egen inställning
        under Redigera behåller den.
      </p>
      {user !== null && !user && (
        <label className="user-name">
          Ditt namn
          <input type="text" autoComplete="name" onBlur={(event) => event.target.value.trim() && saveUserName(event.target.value.trim()).then(() => setUser(event.target.value.trim()))} />
          <small>Ändringarna sparas med ditt namn.</small>
        </label>
      )}
      {folders.map(([id, folder]) => (
        <FolderForm
          key={id}
          id={id}
          name={folder.name}
          count={folder.count}
          own={folder.own}
          saved={{
            terms: merged.fields.get(id)?.terms ?? null,
            consent: merged.fields.get(id)?.consent ?? null,
            blocked: merged.fields.get(id)?.blocked ?? null,
          }}
          user={user ?? ''}
          onSave={onSave}
        />
      ))}
    </section>
  )
}

interface FormProps {
  id: string
  name: string
  count: number
  own: number
  saved: Values
  user: string
  onSave: Props['onSave']
}

function FolderForm({ id, name, count, own, saved, user, onSave }: FormProps) {
  const [values, setValues] = useState<Values>(saved)
  const [busy, setBusy] = useState(false)
  const [message, setMessage] = useState<string | null>(null)
  useEffect(() => setValues(saved), [JSON.stringify(saved)])
  const changed = (Object.keys(values) as FolderField[]).filter((field) => !same(values[field], saved[field]))

  async function save() {
    setBusy(true)
    setMessage(null)
    const at = new Date().toISOString()
    try {
      await onSave(
        user,
        changed.map((field) => ({ at, by: user, id, field, value: values[field] }) as Edit),
      )
      setMessage('Sparat.')
    } catch (problem) {
      setMessage(`Sparades inte: ${problem instanceof Error ? problem.message : problem}`)
    } finally {
      setBusy(false)
    }
  }

  return (
    <form
      className="folder-form"
      aria-label={name}
      onSubmit={(event) => {
        event.preventDefault()
        save()
      }}
    >
      <h3>
        {name} <small>{count === 1 ? '1 bild' : `${count.toLocaleString('sv-SE')} bilder`}{own > 0 && `, ${own} med egen inställning`}</small>
      </h3>
      <label>
        Villkor
        <select
          value={values.terms === null ? '' : 'set'}
          onChange={(event) => setValues({ ...values, terms: event.target.value ? values.terms ?? '' : null })}
        >
          <option value="">Som i bilderna</option>
          <option value="set">Samma för hela mappen</option>
        </select>
        {values.terms !== null && (
          <textarea rows={2} value={values.terms} onChange={(event) => setValues({ ...values, terms: event.target.value })} />
        )}
      </label>
      <label>
        Samtycke
        <select
          value={values.consent ?? ''}
          onChange={(event) => setValues({ ...values, consent: (event.target.value || null) as Consent | null })}
        >
          <option value="">Som i bilderna</option>
          {(Object.keys(CONSENT_TEXT) as Consent[]).map((consent) => (
            <option key={consent} value={consent}>
              {CONSENT_TEXT[consent]}
            </option>
          ))}
        </select>
      </label>
      <label>
        Spärr
        <select
          value={values.blocked === null ? '' : String(values.blocked)}
          onChange={(event) => setValues({ ...values, blocked: event.target.value ? event.target.value === 'true' : null })}
        >
          <option value="">Som i bilderna</option>
          <option value="true">Spärrade</option>
          <option value="false">Inte spärrade</option>
        </select>
      </label>
      <div className="actions">
        <button type="submit" className="primary" disabled={busy || !changed.length || !user}>
          {busy ? 'Sparar…' : 'Spara'}
        </button>
        {message && <span role="status">{message}</span>}
      </div>
    </form>
  )
}
