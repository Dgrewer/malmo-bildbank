import { useEffect, useState } from 'react'
import { checkRoot } from './fs/folder.ts'
import { loadFolder, saveFolder } from './fs/folderStore.ts'
import { Library } from './Library.tsx'

// File System Access API (showDirectoryPicker) finns bara i Chromium-baserade
// webbläsare, därför stöds endast Chrome och Edge.
const isSupported = 'showDirectoryPicker' in window

type State =
  | { kind: 'starting' }
  | { kind: 'choose'; error?: string }
  | { kind: 'reconnect'; handle: FileSystemDirectoryHandle; error?: string }
  | { kind: 'connected'; root: FileSystemDirectoryHandle }

async function openFolder(handle: FileSystemDirectoryHandle): Promise<State> {
  const problem = await checkRoot(handle)
  if (problem) return { kind: 'choose', error: problem }
  await saveFolder(handle)
  return { kind: 'connected', root: handle }
}

async function startState(): Promise<State> {
  // Testkroken läggs bara in av utvecklingsservern, se src/dev/testdataHook.ts.
  const testFolder = import.meta.env.DEV ? window.__bildbankTestFolder : undefined
  if (testFolder) return openFolder(await testFolder)
  const handle = await loadFolder()
  return handle ? { kind: 'reconnect', handle } : { kind: 'choose' }
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function App() {
  const [state, setState] = useState<State>({ kind: 'starting' })

  useEffect(() => {
    if (!isSupported) return
    startState().then(setState, (error) =>
      setState({ kind: 'choose', error: `Appen kunde inte starta: ${errorText(error)}` }),
    )
  }, [])

  async function chooseFolder() {
    try {
      const handle = await window.showDirectoryPicker({ id: 'bildbank', mode: 'readwrite' })
      setState(await openFolder(handle))
    } catch (error) {
      if (error instanceof DOMException && error.name === 'AbortError') return
      setState({ kind: 'choose', error: `Mappen kunde inte öppnas: ${errorText(error)}` })
    }
  }

  async function reconnect(handle: FileSystemDirectoryHandle) {
    try {
      const permission = await handle.requestPermission({ mode: 'readwrite' })
      if (permission !== 'granted') {
        setState({
          kind: 'reconnect',
          handle,
          error: 'Malmö Bildbank fick inte behörighet till mappen. Försök igen och välj Tillåt.',
        })
        return
      }
      setState(await openFolder(handle))
    } catch (error) {
      setState({ kind: 'choose', error: `Mappen kunde inte öppnas: ${errorText(error)}` })
    }
  }

  if (!isSupported) {
    return (
      <main className="start">
        <h1>Malmö Bildbank</h1>
        <p className="error" role="alert">
          Den här webbläsaren stöds inte. Öppna Malmö Bildbank i Google Chrome eller Microsoft Edge.
        </p>
      </main>
    )
  }

  if (state.kind === 'connected') {
    return <Library root={state.root} onChangeFolder={chooseFolder} />
  }

  return (
    <main className="start">
      <h1>Malmö Bildbank</h1>
      {state.kind === 'starting' ? (
        <p>Startar…</p>
      ) : (
        <>
          <p>Välj bildbankens mapp, den synkade SharePoint-mappen som innehåller original och app-data.</p>
          {state.error && (
            <p className="error" role="alert">
              {state.error}
            </p>
          )}
          <div className="actions">
            {state.kind === 'reconnect' && (
              <button type="button" className="primary" onClick={() => reconnect(state.handle)}>
                Återanslut {state.handle.name}
              </button>
            )}
            <button
              type="button"
              className={state.kind === 'reconnect' ? undefined : 'primary'}
              onClick={chooseFolder}
            >
              {state.kind === 'reconnect' ? 'Välj en annan mapp' : 'Välj mapp'}
            </button>
          </div>
        </>
      )}
    </main>
  )
}

export default App
