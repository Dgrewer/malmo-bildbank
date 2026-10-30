import { useEffect, useState } from 'react'
import { AdminView } from './admin/AdminView.tsx'
import { loadIndex } from './catalog/loadIndex.ts'
import type { ImageRecord } from './catalog/types.ts'
import { ensureDirectory } from './fs/folder.ts'
import { DetailView } from './detail/DetailView.tsx'
import { Gallery } from './gallery/Gallery.tsx'

interface Catalog {
  images: ImageRecord[]
  thumbs: FileSystemDirectoryHandle
  previews: FileSystemDirectoryHandle
}

type State = { kind: 'loading' } | { kind: 'error'; message: string } | { kind: 'ready'; catalog: Catalog }

async function loadCatalog(root: FileSystemDirectoryHandle): Promise<Catalog> {
  let images = await loadIndex(root)
  // Testkroken kan upprepa testposterna, t.ex. till 3 000 (?testdata&repeat=3000).
  const repeat = import.meta.env.DEV ? window.__bildbankTestRepeat : undefined
  if (repeat && images.length) images = Array.from({ length: repeat }, (_, n) => images[n % images.length])
  return {
    images,
    thumbs: await ensureDirectory(root, 'app-data/thumbs'),
    previews: await ensureDirectory(root, 'app-data/previews'),
  }
}

interface Props {
  root: FileSystemDirectoryHandle
  onChangeFolder: () => void
}

export function Library({ root, onChangeFolder }: Props) {
  const [state, setState] = useState<State>({ kind: 'loading' })
  const [selected, setSelected] = useState<number | null>(null)
  const [admin, setAdmin] = useState(false)
  // Räknas upp när importen har ändrat indexet, så att katalogen läses om.
  const [version, setVersion] = useState(0)

  useEffect(() => {
    let cancelled = false
    setState({ kind: 'loading' })
    setSelected(null)
    loadCatalog(root).then(
      (catalog) => !cancelled && setState({ kind: 'ready', catalog }),
      (error) => !cancelled && setState({ kind: 'error', message: error instanceof Error ? error.message : String(error) }),
    )
    return () => {
      cancelled = true
    }
  }, [root, version])

  return (
    <div className="app">
      <header className="topbar">
        <h1>Malmö Bildbank</h1>
        <span className="folder-name">
          {root.name}
          {state.kind === 'ready' && ` · ${state.catalog.images.length.toLocaleString('sv-SE')} bilder`}
        </span>
        {!admin && (
          <button type="button" onClick={() => setAdmin(true)}>
            Admin
          </button>
        )}
        <button type="button" disabled={admin} onClick={onChangeFolder}>
          Byt mapp
        </button>
      </header>
      {admin && (
        <AdminView
          bank={root}
          onClose={(changed) => {
            setAdmin(false)
            if (changed) setVersion((n) => n + 1)
          }}
        />
      )}
      {!admin && state.kind === 'loading' && <p className="status">Läser bildbanken…</p>}
      {!admin && state.kind === 'error' && (
        <p className="error status" role="alert">
          {state.message}
        </p>
      )}
      {!admin && state.kind === 'ready' && (
        <Gallery images={state.catalog.images} thumbs={state.catalog.thumbs} onOpen={setSelected} />
      )}
      {state.kind === 'ready' && selected !== null && (
        <DetailView
          image={state.catalog.images[selected]}
          position={selected}
          count={state.catalog.images.length}
          previews={state.catalog.previews}
          onNavigate={setSelected}
          onClose={() => setSelected(null)}
        />
      )}
    </div>
  )
}
