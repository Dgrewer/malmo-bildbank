import { useEffect, useRef, useState, type ReactNode } from 'react'
import { findDirectory } from '../fs/folder.ts'
import { loadOriginalsFolder, saveOriginalsFolder } from '../fs/folderStore.ts'
import { MODEL } from '../ai/modelInfo.ts'
import type { FromWorker, ImportResult, Phase, ScanSummary, ToWorker } from '../import/protocol.ts'
import { captureFrame } from '../import/videoFrame.ts'
import { SameImages } from './SameImages.tsx'
import { TagEditor } from './TagEditor.tsx'

interface Props {
  // Bildbankens mapp, den som innehåller original och app-data.
  bank: FileSystemDirectoryHandle
  onClose: (changed: boolean) => void
  // Anropas när en import eller AI-taggarna har sparats, så att bilderna läses om.
  onSaved: () => Promise<void>
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
  ai: 'Räknar ut AI-vektorer',
  tags: 'Sätter AI-taggar',
  copy: 'Kopierar original',
  save: 'Sparar index',
}

const DUPLICATES_TITLE = 'Dubbletter med samma namn och tagningstid, togs inte med'

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

// Adminläget, med två flikar:
// - Importera bilder: välj originalmapp, se vad som har ändrats och kör
//   importen. Allt tungt arbete sker i en Web Worker (src/import/worker.ts).
// - AI-taggar: ändra taggarna och deras gränser (src/admin/TagEditor.tsx).
export function AdminView({ bank, onClose, onSaved }: Props) {
  const [originals, setOriginals] = useState<Originals>({ kind: 'none' })
  const [state, setState] = useState<State>({ kind: 'idle' })
  const [changed, setChanged] = useState(false)
  // Kopiera nya original till bildbankens original/. Avstängt som standard.
  const [copy, setCopy] = useState(false)
  const [tab, setTab] = useState<'import' | 'tags' | 'same'>('import')
  // Sant medan AI-taggarna sparas.
  const [tagsBusy, setTagsBusy] = useState(false)
  // Osparade ändringar under AI-taggar. De försvinner om Admin stängs eller en import körs.
  const [unsavedTags, setUnsavedTags] = useState(0)

  // Webbläsaren frågar innan sidan stängs eller laddas om med osparade ändringar.
  useEffect(() => {
    if (!unsavedTags) return
    const warn = (event: BeforeUnloadEvent) => event.preventDefault()
    window.addEventListener('beforeunload', warn)
    return () => window.removeEventListener('beforeunload', warn)
  }, [unsavedTags])

  // Frågar innan något görs som tar bort osparade ändringar under AI-taggar.
  const keepUnsaved = (what: string) =>
    unsavedTags > 0 &&
    !window.confirm(
      `Du har ${unsavedTags === 1 ? '1 osparad ändring' : `${unsavedTags} osparade ändringar`} under AI-taggar. ${what} tar bort dem. Fortsätt ändå?`
    )
  // Fliken AI-taggar läses in första gången den öppnas.
  const tagsOpened = useRef(false)
  if (tab === 'tags' && !tagsOpened.current) tagsOpened.current = true
  // Antal klara importer. Fliken AI-taggar läses in på nytt efter varje.
  const [imports, setImports] = useState(0)
  const worker = useRef<Worker | null>(null)

  // Har användaren valt bildbankens egen original/ finns inget att kopiera.
  // Bildbankens egen mapp innehåller app-data och är ingen originalmapp.
  async function ready(handle: FileSystemDirectoryHandle): Promise<Originals> {
    if ((await handle.isSameEntry(bank)) || (await findDirectory(handle, 'app-data'))) {
      throw new Error(
        `”${handle.name}” är bildbankens mapp. Välj mappen som innehåller fotografernas mappar, ` +
          'eller välj Använd bildbankens egen mapp.',
      )
    }
    const bankOriginals = await findDirectory(bank, 'original')
    return { kind: 'ready', handle, inBank: !!bankOriginals && (await bankOriginals.isSameEntry(handle)) }
  }

  // Utan ett eget val för den här bildbanken läses bilderna från dess egen original/.
  useEffect(() => {
    loadOriginalsFolder(bank).then(async (handle) => {
      if (!handle) {
        const own = await findDirectory(bank, 'original')
        if (own) setOriginals({ kind: 'ready', handle: own, inBank: true })
        return
      }
      const permission = await handle.queryPermission({ mode: 'read' })
      setOriginals(permission === 'granted' ? await ready(handle) : { kind: 'reconnect', handle })
    }).catch((error) => setState({ kind: 'idle', error: errorText(error) }))
    // ready läser bara bank, som inte ändras medan vyn är öppen.
  }, [])

  useEffect(() => {
    const instance = new Worker(new URL('../import/worker.ts', import.meta.url), { type: 'module' })
    instance.onmessage = (event: MessageEvent<FromWorker>) => {
      const message = event.data
      if (message.type === 'frame-request') {
        captureFrame(message.file).then((bitmap) =>
          instance.postMessage(
            { type: 'frame', requestId: message.requestId, bitmap } satisfies ToWorker,
            bitmap ? [bitmap] : [],
          ),
        )
      } else if (message.type === 'progress') {
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
        setImports((n) => n + 1)
        // Bilderna läses om, så att de går att öppna ovanpå Admin.
        onSaved().catch(() => {})
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
      const chosen = await ready(handle)
      await saveOriginalsFolder(bank, handle)
      setOriginals(chosen)
    } catch (error) {
      if (error instanceof DOMException && error.name === 'AbortError') return
      setState({ kind: 'idle', error: errorText(error) })
    }
  }

  async function reconnectOriginals(handle: FileSystemDirectoryHandle) {
    try {
      if ((await handle.requestPermission({ mode: 'read' })) === 'granted') setOriginals(await ready(handle))
    } catch (error) {
      setState({ kind: 'idle', error: errorText(error) })
    }
  }

  async function useBankOriginals() {
    const handle = await findDirectory(bank, 'original')
    if (!handle) {
      setState({ kind: 'idle', error: `Bildbankens mapp ”${bank.name}” saknar undermappen original.` })
      return
    }
    await saveOriginalsFolder(bank, handle)
    setOriginals({ kind: 'ready', handle, inBank: true })
  }

  function scan() {
    if (originals.kind !== 'ready') return
    setState({ kind: 'running', phase: 'scan', done: 0, total: 0, stopping: false })
    send({ type: 'scan', bank, originals: originals.handle })
  }

  function startImport() {
    setState({ kind: 'running', phase: 'import', done: 0, total: 0, stopping: false })
    if (keepUnsaved('Importen')) return
    send({ type: 'import', copyOriginals: copy && originals.kind === 'ready' && !originals.inBank })
  }

  function abort() {
    setState((current) => (current.kind === 'running' ? { ...current, stopping: true } : current))
    send({ type: 'abort' })
  }

  const busy = state.kind === 'running' || tagsBusy

  return (
    <main className="admin">
      <div className="admin-header">
        <h2>Admin</h2>
        <nav className="admin-tabs" aria-label="Admin">
          {(
            [
              ['import', 'Importera bilder'],
              ['tags', 'AI-taggar'],
              ['same', 'Samma bild'],
            ] as const
          ).map(([id, label]) => (
            <button
              key={id}
              type="button"
              className={tab === id ? 'selected' : undefined}
              aria-current={tab === id ? 'page' : undefined}
              disabled={busy && tab !== id}
              onClick={() => setTab(id)}
            >
              {label}
              {id === 'tags' && unsavedTags > 0 && (
                <span className="unsaved-dot" title="Osparade ändringar"> ●</span>
              )}
            </button>
          ))}
        </nav>
        <button type="button" disabled={busy} onClick={() => !keepUnsaved('Att lämna Admin') && onClose(changed)}>
          Tillbaka till bildbanken
        </button>
      </div>

      {/* Fliken ligger kvar när man byter, så att osparade ändringar finns kvar.
          Efter en import läses taggarna in på nytt. */}
      <div hidden={tab !== 'tags'}>
        {tagsOpened.current && (
          <TagEditor
            key={imports}
            bank={bank}
            onSaved={() => {
              setChanged(true)
              onSaved().catch(() => {})
              // En sökning före sparandet visar gamla AI-taggar. Sök igen.
              setState((current) => (current.kind === 'preview' ? { kind: 'idle' } : current))
            }}
            onBusy={setTagsBusy}
            onUnsaved={setUnsavedTags}
          />
        )}
      </div>

      {/* Jämförs varje gång fliken öppnas, så att listan följer mappen. */}
      {tab === 'same' && (
        <SameImages key={imports} bank={bank} originals={originals.kind === 'ready' ? originals.handle : null} />
      )}

      <div hidden={tab !== 'import'}>

      <section className="admin-folders">
        <div>
          <h3>Bildbanksmapp</h3>
          <p>
            <strong>{bank.name}</strong>. Index, miniatyrer och förhandsbilder sparas i app-data.
          </p>
        </div>
        <div className="originals">
          <h3>Bilderna läses från</h3>
          {originals.kind === 'ready' && originals.inBank && (
            <p>
              Bildbankens egen mapp <strong>{bank.name} › {originals.handle.name}</strong>. Varje undermapp är en
              fotograf.
            </p>
          )}
          {originals.kind === 'ready' && !originals.inBank && (
            <p className="outside">
              En mapp <strong>utanför bildbanken</strong> som heter <strong>{originals.handle.name}</strong>. Varje
              undermapp är en fotograf. Webbläsaren visar bara mappens namn, inte var den ligger.
            </p>
          )}
          {originals.kind === 'reconnect' && (
            <p className="outside">
              En mapp <strong>utanför bildbanken</strong> som heter <strong>{originals.handle.name}</strong>. Webbläsaren
              behöver ditt tillstånd för att läsa den igen.
            </p>
          )}
          {originals.kind === 'none' && <p>Välj mappen med fotografernas mappar.</p>}
          <div className="actions">
            {originals.kind === 'reconnect' && (
              <button type="button" disabled={busy} onClick={() => reconnectOriginals(originals.handle)}>
                Återanslut {originals.handle.name}
              </button>
            )}
            {!(originals.kind === 'ready' && originals.inBank) && (
              <button type="button" className="primary" disabled={busy} onClick={useBankOriginals}>
                Använd bildbankens egen mapp
              </button>
            )}
            <button type="button" disabled={busy} onClick={chooseOriginals}>
              Välj en mapp utanför bildbanken
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

      {state.kind === 'preview' && (
        <Preview summary={state.summary} onImport={startImport} onRescan={scan}>
          {originals.kind === 'ready' && !originals.inBank && (
            <label className="copy-originals">
              <input type="checkbox" checked={copy} onChange={(event) => setCopy(event.target.checked)} />
              Kopiera nya original till bildbankens original/
            </label>
          )}
        </Preview>
      )}

      {state.kind === 'aborted' && (
        <section className="import-result">
          <p role="status">
            {state.phase === 'import'
              ? `Importen avbröts efter ${count(state.done)} av ${count(state.total)} bilder. Det som är klart är sparat och fortsätter nästa gång.`
              : state.phase === 'ai'
                ? `Importen avbröts när AI-vektorer för ${count(state.done)} av ${count(state.total)} bilder var klara. Det som är klart är sparat och fortsätter nästa gång.`
                : state.phase === 'tags'
                  ? 'Importen avbröts när AI-taggarna sattes. Bilderna och AI-vektorerna är sparade och fortsätter nästa gång.'
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
        <section className="import-result">
          <p role="status">
            Importen är klar. {count(state.result.processed)} bilder importerades eller uppdaterades. Bildbanken har{' '}
            {count(state.result.total)} bilder.
          </p>
          <PathList
            title={DUPLICATES_TITLE}
            items={state.result.duplicates}
            render={(item: ImportResult['duplicates'][number]) =>
              `${item.path} (behåller ${item.sameAs})` +
              (item.movedTo
                ? `. Flyttad till ${item.movedTo}.`
                : item.problem
                  ? `. Ligger kvar, kunde inte flyttas: ${item.problem}`
                  : '. Ligger kvar i originalmappen.')
            }
          />
          {state.result.ai.model && (
            <p className="ai-result">
              {count(state.result.ai.computed)} nya AI-vektorer
              {state.result.ai.device === 'webgpu' && ', uträknade med grafikkortet'}
              {state.result.ai.device === 'wasm' && ', uträknade utan grafikkort (långsammare)'}.{' '}
              {count(state.result.ai.total)} bilder kan hittas med AI-sök.
            </p>
          )}
          {state.result.ai.problem && (
            <p className="warning" role="alert">
              {state.result.ai.problem}
            </p>
          )}
          {state.result.ai.model && !state.result.tags.problem && (
            <p className="tags-result">
              {state.result.tags.created && `app-data/config.json skapades med ${count(state.result.tags.tags)} förvalda taggar. `}
              {state.result.tags.retagged && `AI-taggarna sattes med ${count(state.result.tags.tags)} taggar. `}
              {count(state.result.tags.tagged)} bilder har AI-taggar.
            </p>
          )}
          {state.result.tags.skipped > 0 && (
            <p className="warning" role="alert">
              {count(state.result.tags.skipped)} taggar i app-data/config.json saknar tag, prompt eller threshold, eller
              finns redan. De användes inte.
            </p>
          )}
          {state.result.tags.problem && (
            <p className="warning" role="alert">
              {state.result.tags.problem}
            </p>
          )}
          {state.result.copied && (
            <p className="copy-result">
              {count(state.result.copied.copied)} original kopierades till bildbankens original/.
            </p>
          )}
          <PathList
            title="Fanns redan i bildbankens original/ med annat innehåll, skrevs inte över"
            items={state.result.copied?.notOverwritten ?? []}
          />
        </section>
      )}
      </div>
    </main>
  )
}

interface PreviewProps {
  summary: ScanSummary
  onImport: () => void
  onRescan: () => void
  // Val som visas före knapparna, t.ex. kopieringen av original.
  children?: ReactNode
}

function Preview({ summary, onImport, onRescan, children }: PreviewProps) {
  const work = summary.new.length + summary.changed.length + summary.moved.length
  const nothing =
    work === 0 && summary.removed.length === 0 && !(summary.ai.model && summary.ai.missing) && !summary.ai.retag
  // Bilder som tas bort förlorar sina taggar och rättigheter i indexet. Har fel
  // originalmapp valts ser det ut som att alla bilder har tagits bort, så
  // borttagningen måste bekräftas.
  const [confirmed, setConfirmed] = useState(false)
  const removing = summary.removed.length
  const total = removing + summary.unchanged + summary.changed.length + summary.moved.length
  return (
    <section className="import-preview">
      <h3>Det här händer vid importen</h3>
      {summary.recovery.length > 0 && (
        <div className="note recovery" role="status">
          <p>Förra importen avslutades inte ordentligt. Det här har åtgärdats:</p>
          <ul>
            {summary.recovery.map((note) => (
              <li key={note}>{note}</li>
            ))}
          </ul>
        </div>
      )}
      {summary.resumed > 0 && (
        <p className="note">
          {count(summary.resumed)} bilder blev klara i en avbruten import och behöver inte göras om.
        </p>
      )}
      {summary.ai.model ? (
        <>
          {summary.ai.missing > 0 && (
            <p className="note ai-note">
              {count(summary.ai.missing)} bilder får AI-vektorer för AI-sök. Med grafikkort tar det några tiondels
              sekunder per bild, utan grafikkort några sekunder.
            </p>
          )}
          {summary.ai.retag && (
            <p className="note ai-note">
              Alla bilder får nya AI-taggar från app-data/config.json, eftersom taggarna är nya eller har ändrats.
            </p>
          )}
        </>
      ) : (
        <p className="warning ai-note">
          AI-modellen saknas i app-data/models/{MODEL.name}. Bilderna importeras, men kan inte hittas med AI-sök förrän
          modellen finns och importen har körts igen.
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
      {removing > 0 && (
        <div className="warning remove-warning" role="alert">
          <p>
            {count(removing)} av {count(total)} bilder i bildbanken finns inte i originalmappen och tas bort ur
            bildbanken, med sina taggar och rättigheter.
            {removing === total && ' Det är alla bilder. Kontrollera att du har valt rätt originalmapp.'}
          </p>
          <label>
            <input type="checkbox" checked={confirmed} onChange={(event) => setConfirmed(event.target.checked)} />
            Ta bort {count(removing)} bilder ur bildbanken
          </label>
        </div>
      )}
      <PathList
        title="Dubbletter med exakt samma innehåll, importeras inte"
        items={summary.exactDuplicates}
        render={(item: { path: string; sameAs: string }) => `${item.path} (samma som ${item.sameAs})`}
      />
      <PathList
        title={DUPLICATES_TITLE}
        items={summary.nameDuplicates}
        render={(item: { path: string; sameAs: string }) => `${item.path} (behåller ${item.sameAs})`}
      />
      <PathList title="Inte bilder eller video, hoppas över" items={summary.skipped} />
      {children}
      <div className="actions">
        <button type="button" className="primary" disabled={removing > 0 && !confirmed} onClick={onImport}>
          {summary.resumed > 0 ? 'Fortsätt importen' : nothing ? 'Uppdatera index' : 'Starta import'}
        </button>
        <button type="button" onClick={onRescan}>
          Sök igen
        </button>
      </div>
    </section>
  )
}
