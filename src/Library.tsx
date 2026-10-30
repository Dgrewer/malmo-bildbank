import { useEffect, useMemo, useState } from 'react'
import { AdminView } from './admin/AdminView.tsx'
import { DEFAULT_CONFIG, parseConfig } from './ai/tagConfig.ts'
import { loadIndex } from './catalog/loadIndex.ts'
import type { ImageRecord } from './catalog/types.ts'
import { buildVocabulary, shownTags, wordKey, type ShownTag } from './catalog/vocabulary.ts'
import { ensureDirectory, readFile } from './fs/folder.ts'
import { DetailView } from './detail/DetailView.tsx'
import { Gallery } from './gallery/Gallery.tsx'

interface Catalog {
  images: ImageRecord[]
  // Bildens taggar som de visas, efter id: nyckelord och AI-taggar via ordlistan.
  tags: Map<string, ShownTag[]>
  thumbs: FileSystemDirectoryHandle
  previews: FileSystemDirectoryHandle
}

// Det som galleriet visar bilder med: en tagg, eller ett stadsområde eller delområde.
interface Filter {
  kind: 'tag' | 'place'
  value: string
}

type State = { kind: 'loading' } | { kind: 'error'; message: string } | { kind: 'ready'; catalog: Catalog }

async function loadCatalog(root: FileSystemDirectoryHandle): Promise<Catalog> {
  let images = await loadIndex(root)
  // Testkroken kan upprepa testposterna, t.ex. till 3 000 (?testdata&repeat=3000).
  const repeat = import.meta.env.DEV ? window.__bildbankTestRepeat : undefined
  if (repeat && images.length) images = Array.from({ length: repeat }, (_, n) => images[n % images.length])
  // Ordlistan finns i config.json. Går den inte att läsa visas taggarna som de är i indexet.
  const configFile = await readFile(root, 'app-data/config.json')
  let config = DEFAULT_CONFIG
  if (configFile) {
    try {
      config = parseConfig(await configFile.text()).config
    } catch {
      config = { ...DEFAULT_CONFIG, aiTags: [] }
    }
  }
  const vocabulary = buildVocabulary(config)
  return {
    images,
    tags: new Map(images.map((image) => [image.id, shownTags(image, vocabulary)])),
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
  // Taggen eller platsen som galleriet visar bilder med, eller null för alla bilder.
  const [filter, setFilter] = useState<Filter | null>(null)
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

  const catalog = state.kind === 'ready' ? state.catalog : null
  const shown = useMemo(() => {
    if (!catalog || !filter) return catalog?.images ?? []
    if (filter.kind === 'place') {
      return catalog.images.filter((image) => image.place?.district === filter.value || image.place?.subdistrict === filter.value)
    }
    const key = wordKey(filter.value)
    return catalog.images.filter((image) => catalog.tags.get(image.id)!.some((other) => wordKey(other.tag) === key))
  }, [catalog, filter])

  function show(next: Filter) {
    setFilter(next)
    setSelected(null)
  }

  return (
    <div className="app">
      <header className="topbar">
        <h1>Malmö Bildbank</h1>
        <span className="folder-name">
          {root.name}
          {catalog && ` · ${catalog.images.length.toLocaleString('sv-SE')} bilder`}
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
      {!admin && catalog && filter && (
        <div className="filter-bar" role="status">
          <span>
            {filter.kind === 'tag' ? 'Bilder med taggen' : 'Bilder från'} <strong className="filter-tag">{filter.value}</strong> ·{' '}
            {shown.length.toLocaleString('sv-SE')}{' '}
            {shown.length === 1 ? 'bild' : 'bilder'}
          </span>
          <button type="button" onClick={() => setFilter(null)}>
            Visa alla bilder
          </button>
        </div>
      )}
      {!admin && catalog && <Gallery key={filter ? `:` : ''} images={shown} thumbs={catalog.thumbs} onOpen={setSelected} />}
      {catalog && selected !== null && shown[selected] && (
        <DetailView
          image={shown[selected]}
          tags={catalog.tags.get(shown[selected].id)!}
          position={selected}
          count={shown.length}
          previews={catalog.previews}
          onNavigate={setSelected}
          onTag={(value) => show({ kind: 'tag', value })}
          onPlace={(value) => show({ kind: 'place', value })}
          onClose={() => setSelected(null)}
        />
      )}
    </div>
  )
}
