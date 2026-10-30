import { useEffect, useMemo, useState } from 'react'
import { AdminView } from './admin/AdminView.tsx'
import { DEFAULT_CONFIG, parseConfig } from './ai/tagConfig.ts'
import { loadIndex } from './catalog/loadIndex.ts'
import type { ImageRecord } from './catalog/types.ts'
import { placeParts, placeWithTags, type Place } from './catalog/places.ts'
import { appendEdits, applyEdits, editedTags, loadEdits, mergeEdits, type Edit } from './catalog/edits.ts'
import { buildVocabulary, shownTags, wordKey, type ShownTag, type Vocabulary } from './catalog/vocabulary.ts'
import { ensureDirectory, readFile } from './fs/folder.ts'
import { DetailView } from './detail/DetailView.tsx'
import { Gallery } from './gallery/Gallery.tsx'

interface Catalog {
  // Bilderna som de står i indexet, före användarnas ändringar.
  indexed: ImageRecord[]
  vocabulary: Vocabulary
  // Platsen för taggar som anger var motivet finns, efter ordlistans nyckel.
  tagPlaces: Map<string, Place>
  // Alla användares ändringar i app-data/edits/.
  edits: Edit[]
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
  return {
    indexed: images,
    vocabulary: buildVocabulary(config),
    tagPlaces: new Map(config.aiTags.filter((tag) => tag.place).map((tag) => [wordKey(tag.tag), tag.place!])),
    edits: await loadEdits(root),
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
  // Bilderna och deras taggar efter användarnas ändringar.
  const edited = useMemo(() => {
    if (!catalog) return null
    const merged = mergeEdits(catalog.edits)
    const tags = new Map<string, ShownTag[]>()
    const images = catalog.indexed.map((indexed) => {
      const image = applyEdits(indexed, merged)
      const shown = editedTags(shownTags(image, catalog.vocabulary), merged.tags.get(image.id))
      tags.set(image.id, shown)
      // En plats som någon har ändrat går före taggarnas.
      if (merged.fields.get(image.id)?.place !== undefined) return image
      const fromTags = shown.flatMap((tag) => catalog.tagPlaces.get(wordKey(tag.tag)) ?? [])
      const place = placeWithTags(image.place, fromTags)
      return place === image.place ? image : { ...image, place }
    })
    return { images, tags }
  }, [catalog])
  const shown = useMemo(() => {
    if (!edited || !filter) return edited?.images ?? []
    if (filter.kind === 'place') {
      return edited.images.filter((image) => image.place && placeParts(image.place).includes(filter.value))
    }
    const key = wordKey(filter.value)
    return edited.images.filter((image) => edited.tags.get(image.id)!.some((other) => wordKey(other.tag) === key))
  }, [edited, filter])

  // Sparar ändringar i användarens egen fil och visar dem direkt.
  async function saveEdits(user: string, edits: Edit[]) {
    await appendEdits(root, user, edits)
    setState((current) =>
      current.kind === 'ready' ? { kind: 'ready', catalog: { ...current.catalog, edits: [...current.catalog.edits, ...edits] } } : current,
    )
  }

  // Läser om bilderna efter en ny AI-tagg, utan att stänga bilden som är öppen.
  async function reloadTags() {
    const next = await loadCatalog(root)
    setState({ kind: 'ready', catalog: next })
  }

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
          {catalog && ` · ${catalog.indexed.length.toLocaleString('sv-SE')} bilder`}
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
          tags={edited!.tags.get(shown[selected].id)!}
          vocabulary={catalog.vocabulary}
          onSave={saveEdits}
          bank={root}
          onTagsSaved={reloadTags}
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
