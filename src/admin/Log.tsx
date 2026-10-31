import { useContext, useEffect, useState } from 'react'
import { loadEdits } from '../catalog/edits.ts'
import { readFile } from '../fs/folder.ts'
import { editText, formatTime } from '../detail/History.tsx'
import { parseImportLog, IMPORT_LOG } from '../import/importLog.ts'
import { OpenImage } from './openImage.ts'

interface Entry {
  at: string
  by: string
  text: string
  ids: string[]
}

// Så många händelser visas, de senaste först.
const SHOWN = 500

async function loadLog(bank: FileSystemDirectoryHandle): Promise<Entry[]> {
  const entries: Entry[] = (await loadEdits(bank)).map((edit) => ({
    at: edit.at,
    by: edit.by,
    text: `${edit.id.endsWith('/') ? `Mappen ${edit.id}` : edit.id}: ${editText(edit)}`,
    ids: edit.id.endsWith('/') ? [] : [edit.id],
  }))
  const file = await readFile(bank, IMPORT_LOG)
  for (const run of parseImportLog(file ? await file.text() : '')) {
    const parts = []
    if (run.added.length) parts.push(`${run.added.length === 1 ? '1 ny bild' : `${run.added.length} nya bilder`}`)
    if (run.removed.length) parts.push(`${run.removed.length === 1 ? '1 bild togs bort' : `${run.removed.length} bilder togs bort`}`)
    if (!parts.length) continue
    entries.push({
      at: run.at,
      by: run.by || 'Okänd',
      text: `Import: ${parts.join(', ')}. ${[...run.added.map((item) => `+ ${item.id} ${item.path}`), ...run.removed.map((item) => `− ${item.id} ${item.path}`)].slice(0, 20).join(' · ')}${run.added.length + run.removed.length > 20 ? ' …' : ''}`,
      ids: run.added.map((item) => item.id),
    })
  }
  return entries.sort((a, b) => b.at.localeCompare(a.at))
}

// Admin, fliken Logg: alla ändringar från app-data/edits/ och vad importerna
// har lagt till och tagit bort, med vem och när.
export function Log({ bank }: { bank: FileSystemDirectoryHandle }) {
  const [entries, setEntries] = useState<Entry[] | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [who, setWho] = useState('')
  const openImage = useContext(OpenImage)
  useEffect(() => {
    loadLog(bank).then(setEntries, (problem) => setError(problem instanceof Error ? problem.message : String(problem)))
  }, [bank])

  if (error) return <p className="error" role="alert">Loggen gick inte att läsa: {error}</p>
  if (!entries) return <p className="status">Läser loggen…</p>
  const people = [...new Set(entries.map((entry) => entry.by))].sort((a, b) => a.localeCompare(b, 'sv'))
  const shown = entries.filter((entry) => !who || entry.by === who)
  return (
    <section className="admin-log">
      <p>
        Ändringar i bilderna och vad importerna har lagt till och tagit bort, de senaste först. Klicka på ett id för att
        öppna bilden.
      </p>
      <label>
        Visa{' '}
        <select value={who} onChange={(event) => setWho(event.target.value)}>
          <option value="">alla</option>
          {people.map((name) => (
            <option key={name}>{name}</option>
          ))}
        </select>
      </label>
      {shown.length ? (
        <ul className="log-list">
          {shown.slice(0, SHOWN).map((entry, n) => (
            <li key={n}>
              <span className="history-when">
                {formatTime(entry.at)} · {entry.by}
              </span>
              <span>
                {entry.ids.length === 1 && entry.text.startsWith(entry.ids[0]) ? (
                  <>
                    <button type="button" className="link" onClick={() => openImage?.(entry.ids[0], [entry.ids[0]])}>
                      {entry.ids[0]}
                    </button>
                    {entry.text.slice(entry.ids[0].length)}
                  </>
                ) : (
                  entry.text
                )}
              </span>
            </li>
          ))}
          {shown.length > SHOWN && <li>… och {(shown.length - SHOWN).toLocaleString('sv-SE')} äldre</li>}
        </ul>
      ) : (
        <p className="note">Inget har ändrats än.</p>
      )}
    </section>
  )
}
