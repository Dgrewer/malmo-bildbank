import { useEffect, useRef, useState, type ReactNode } from 'react'
import { findDirectory } from '../fs/folder.ts'
import { loadOriginalsFolder, saveOriginalsFolder } from '../fs/folderStore.ts'
import type { FromWorker, ImportResult, Phase, ScanSummary, ToWorker } from '../import/protocol.ts'

interface Props {
  // Bildbankens mapp, den som innehåller original och app-data.
  bank: FileSystemDirectoryHandle
  onClose: (changed: boolean) => void
}

type Originals =
  | { kind: 'none' }
  | { kind: 'reconnect'; handle: FileSystemDirectoryHandle }
  | { kind: 'ready'; handle: FileSystemDirectoryHandle; inBank: boolean }

type State =
  | { kind: 'idle'; error?: string }
  | { kind: 'running'; phase: Phase; done: number; total: number; stopping: boolean }
  | { kind: 'preview'; summary: ScanSummary }
  | { kind: 'aborted'; phase: Phase; done: number; total: number }
  | { kind: 'done'; result: ImportResult }

const PHASE_TEXT: Record<Phase, string> = {
  scan: 'Letar efter bilder',
  hash: 'Räknar fingeravtryck',
  import: 'Importerar',
  save: 'Sparar index',
}

const count = (n: number) => n.toLocaleString('sv-SE')

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function PathList({ title, items, render }: { title: string; items: unknown[]; render?: (item: never) => ReactNode }) {
  if (items.length === 0) return null
  return (
    <details className="change-list">
      <summary>
        {title}: {count(items.length)}
      </summary>
      <ul>
        {items.slice(0, 500).map((item, n) => (
          <li key={n}>{render ? render(item as never) : String(item)}</li>
        ))}
        {items.length > 500 && <li>… och {count(items.length - 500)} till</li>}
      </ul>
    </details>
  )
}

// Adminläget: välj originalmapp, se vad som har ändrats och kör importen.
// Allt tungt arbete sker i en Web Worker (src/import/worker.ts).
export function AdminView({ bank, onClose }: Props) {
  const [originals, setOriginals] = useState<Originals>({ kind: 'none' })
  const [state, setState] = useState<State>({ kind: 'idle' })
  const [changed, setChanged] = useState(false)
  const worker = useRef<Worker | null>(null)

  useEffect(() => {
    loadOriginalsFolder().then(async (handle) => {
      if (!handle) return
      const permission = await handle.queryPermission({ mode: 'read' })
      setOriginals(permission === 'granted' ? { kind: 'ready', handle, inBank: false } : { kind: 'reconnect', handle })
    })
  }, [])

  useEffect(() => {
    const instance = new Worker(new URL('../import/worker.ts', import.meta.url), { type: 'module' })
    instance.onmessage = (event: MessageEvent<FromWorker>) => {
      const message = event.data
      if (message.type === 'progress') {
        setState((current) => ({
          kind: 'running',
          phase: message.phase,
          done: message.done,
          total: message.total,
          stopping: current.kind === 'running' && current.stopping,
        }))
      } else if (message.type === 'scanned') setState({ kind: 'preview', summary: message.summary })
      else if (message.type === 'aborted') {
        setState({ kind: 'aborted', phase: message.phase, done: message.done, total: message.total })
      } else if (message.type === 'imported') {
        setChanged(true)
        setState({ kind: 'done', result: message.result })
      } else setState({ kind: 'idle', error: message.message })
    }
    instance.onerror = (event) => setState({ kind: 'idle', error: `Importen stannade: ${event.message}` })
    worker.current = instance
    return () => instance.terminate()
  }, [])

  function send(message: ToWorker) {
    worker.current!.postMessage(message)
  }

  async function chooseOriginals() {
    try {
      const handle = await window.showDirectoryPicker({ id: 'original', mode: 'read' })
      await saveOriginalsFolder(handle)
      setOriginals({ kind: 'ready', handle, inBank: false })
    } catch (error) {
      if (error instanceof DOMException && error.name === 'AbortError') return
      setState({ kind: 'idle', error: `Mappen kunde inte öppnas: ${errorText(error)}` })
    }
  }

  async function reconnectOriginals(handle: FileSystemDirectoryHandle) {
    if ((await handle.requestPermission({ mode: 'read' })) === 'granted') {
      setOriginals({ kind: 'ready', handle, inBank: false })
    }
  }

  async function useBankOriginals() {
    const handle = await findDirectory(bank, 'original')
    if (handle) setOriginals({ kind: 'ready', handle, inBank: true })
    else setState({ kind: 'idle', error: `Bildbankens mapp ”${bank.name}” saknar undermappen original.` })
  }

  function scan() {
    if (originals.kind !== 'ready') return
    setState({ kind: 'running', phase: 'scan', done: 0, total: 0, stopping: false })
    send({ type: 'scan', bank, originals: originals.handle })
  }

  function startImport() {
    setState({ kind: 'running', phase: 'import', done: 0, total: 0, stopping: false })
    send({ type: 'import' })
  }

  function abort() {
    setState((current) => (current.kind === 'running' ? { ...current, stopping: true } : current))
    send({ type: 'abort' })
  }

  const busy = state.kind === 'running'

  return (
    <main className="admin">
      <div className="admin-header">
        <h2>Importera bilder</h2>
        <button type="button" disabled={busy} onClick={() => onClose(changed)}>
          Tillbaka till bildbanken
        </button>
      </div>

      <section className="admin-folders">
        <div>
          <h3>Bildbanksmapp</h3>
          <p>
            <strong>{bank.name}</strong>. Index, miniatyrer och förhandsbilder sparas i app-data.
          </p>
        </div>
        <div>
          <h3>Originalmapp</h3>
          {originals.kind === 'ready' && (
            <p>
              <strong>{originals.inBank ? `${bank.name}/original` : originals.handle.name}</strong>. Varje mapp här
              är en fotograf.
            </p>
          )}
          {originals.kind === 'none' && <p>Välj mappen med fotografernas mappar, t.ex. på G: eller lokalt.</p>}
          <div className="actions">
            {originals.kind === 'reconnect' && (
              <button type="button" className="primary" disabled={busy} onClick={() => reconnectOriginals(originals.handle)}>
                Återanslut {originals.handle.name}
              </button>
            )}
            <button type="button" disabled={busy} onClick={chooseOriginals}>
              Välj originalmapp
            </button>
            <button type="button" disabled={busy} onClick={useBankOriginals}>
              Använd bildbankens original
            </button>
          </div>
        </div>
      </section>

      {state.kind === 'idle' && state.error && (
        <p className="error" role="alert">
          {state.error}
        </p>
      )}

      {(state.kind === 'idle' || state.kind === 'done') && (
        <div className="actions">
          <button type="button" className="primary" disabled={originals.kind !== 'ready'} onClick={scan}>
            Sök efter ändringar
          </button>
        </div>
      )}

      {state.kind === 'running' && (
        <section className="import-progress" aria-live="polite">
          <p>
            {PHASE_TEXT[state.phase]}
            {state.total > 0 ? ` – ${count(state.done)} av ${count(state.total)}` : state.done > 0 ? ` – ${count(state.done)} hittade` : '…'}
          </p>
          <progress
            aria-label={PHASE_TEXT[state.phase]}
            max={state.total || undefined}
            value={state.total ? state.done : undefined}
          />
          <div className="actions">
            <button type="button" disabled={state.stopping || state.phase === 'save'} onClick={abort}>
              {state.stopping ? 'Avbryter…' : 'Avbryt'}
            </button>
          </div>
        </section>
      )}

      {state.kind === 'preview' && <Preview summary={state.summary} onImport={startImport} onRescan={scan} />}

      {state.kind === 'aborted' && (
        <section className="import-result">
          <p role="status">
            {state.phase === 'import'
              ? `Importen avbröts efter ${count(state.done)} av ${count(state.total)} bilder. Det som är klart är sparat och fortsätter nästa gång.`
              : 'Sökningen avbröts. Inget har ändrats.'}
          </p>
          <div className="actions">
            <button type="button" className="primary" onClick={scan}>
              Fortsätt
            </button>
          </div>
        </section>
      )}

      {state.kind === 'done' && (
        <p className="import-result" role="status">
          Importen är klar. {count(state.result.processed)} bilder importerades eller uppdaterades. Bildbanken har{' '}
          {count(state.result.total)} bilder.
        </p>
      )}
    </main>
  )
}

function Preview({ summary, onImport, onRescan }: { summary: ScanSummary; onImport: () => void; onRescan: () => void }) {
  const work = summary.new.length + summary.changed.length + summary.moved.length
  const nothing = work === 0 && summary.removed.length === 0
  return (
    <section className="import-preview">
      <h3>Det här händer vid importen</h3>
      {summary.resumed > 0 && (
        <p className="note">
          {count(summary.resumed)} bilder blev klara i en avbruten import och behöver inte göras om.
        </p>
      )}
      <ul className="change-counts">
        <li data-change="new">
          <strong>{count(summary.new.length)}</strong> nya
        </li>
        <li data-change="changed">
          <strong>{count(summary.changed.length)}</strong> ändrade
        </li>
        <li data-change="moved">
          <strong>{count(summary.moved.length)}</strong> flyttade eller omdöpta
        </li>
        <li data-change="removed">
          <strong>{count(summary.removed.length)}</strong> borttagna
        </li>
        <li data-change="unchanged">
          <strong>{count(summary.unchanged)}</strong> oförändrade
        </li>
      </ul>
      <PathList title="Nya" items={summary.new} />
      <PathList title="Ändrade" items={summary.changed} />
      <PathList
        title="Flyttade eller omdöpta, behåller sitt id"
        items={summary.moved}
        render={(item: { from: string; to: string }) => `${item.from} → ${item.to}`}
      />
      <PathList title="Borttagna, tas bort ur bildbanken" items={summary.removed} />
      <PathList
        title="Dubbletter med exakt samma innehåll, importeras inte"
        items={summary.exactDuplicates}
        render={(item: { path: string; sameAs: string }) => `${item.path} (samma som ${item.sameAs})`}
      />
      <PathList title="Inte bilder eller video, hoppas över" items={summary.skipped} />
      <div className="actions">
        <button type="button" className="primary" onClick={onImport}>
          {summary.resumed > 0 ? 'Fortsätt importen' : nothing ? 'Uppdatera index' : 'Starta import'}
        </button>
        <button type="button" onClick={onRescan}>
          Sök igen
        </button>
      </div>
    </section>
  )
}
