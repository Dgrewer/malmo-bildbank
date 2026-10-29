import { useEffect, useState } from 'react'
import { loadIndex } from './catalog/loadIndex.ts'
import type { ImageRecord } from './catalog/types.ts'
import { findDirectory } from './fs/folder.ts'
import { DetailView } from './detail/DetailView.tsx'
import { Gallery } from './gallery/Gallery.tsx'

interface Catalog {
  images: ImageRecord[]
  thumbs: FileSystemDirectoryHandle
  previews: FileSystemDirectoryHandle
}

type State = { kind: 'loading' } | { kind: 'error'; message: string } | { kind: 'ready'; catalog: Catalog }

async function openDirectory(parent: FileSystemDirectoryHandle, name: string, path: string) {
  const directory = await findDirectory(parent, name)
  if (!directory) throw new Error(`Hittar inte mappen ${path}.`)
  return directory
}

async function loadCatalog(root: FileSystemDirectoryHandle): Promise<Catalog> {
  let images = await loadIndex(root)
  // Testkroken kan upprepa testposterna, t.ex. till 3 000 (?testdata&repeat=3000).
  const repeat = import.meta.env.DEV ? window.__bildbankTestRepeat : undefined
  if (repeat && images.length) images = Array.from({ length: repeat }, (_, n) => images[n % images.length])
  const appData = await openDirectory(root, 'app-data', 'app-data')
  return {
    images,
    thumbs: await openDirectory(appData, 'thumbs', 'app-data/thumbs'),
    previews: await openDirectory(appData, 'previews', 'app-data/previews'),
  }
}

interface Props {
  root: FileSystemDirectoryHandle
  onChangeFolder: () => void
}

export function Library({ root, onChangeFolder }: Props) {
  const [state, setState] = useState<State>({ kind: 'loading' })
  const [selected, setSelected] = useState<number | null>(null)

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
  }, [root])

  return (
    <div className="app">
      <header className="topbar">
        <h1>Malmö Bildbank</h1>
        <span className="folder-name">
          {root.name}
          {state.kind === 'ready' && ` · ${state.catalog.images.length.toLocaleString('sv-SE')} bilder`}
        </span>
        <button type="button" onClick={onChangeFolder}>
          Byt mapp
        </button>
      </header>
      {state.kind === 'loading' && <p className="status">Läser bildbanken…</p>}
      {state.kind === 'error' && (
        <p className="error status" role="alert">
          {state.message}
        </p>
      )}
      {state.kind === 'ready' && (
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
