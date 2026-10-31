import { useEffect, useMemo, useState } from 'react'
import { AdminView } from './admin/AdminView.tsx'
import { OpenImage } from './admin/openImage.ts'
import { decodeVectors, type Vectors } from './ai/embeddings.ts'
import { spreadHandTags } from './ai/handTags.ts'
import { MODEL } from './ai/modelInfo.ts'
import { DEFAULT_CONFIG, parseConfig, type BankConfig } from './ai/tagConfig.ts'
import { loadIndex } from './catalog/loadIndex.ts'
import type { ImageRecord } from './catalog/types.ts'
import { placeParts, placeWithTags, type Place } from './catalog/places.ts'
import { appendEdits, applyEdits, editedTags, loadEdits, mergeEdits, type Edit } from './catalog/edits.ts'
import { buildVocabulary, shownTags, wordKey, type ShownTag, type Vocabulary } from './catalog/vocabulary.ts'
import { ensureDirectory, readFile } from './fs/folder.ts'
import { DetailView } from './detail/DetailView.tsx'
import { Gallery } from './gallery/Gallery.tsx'
import { SearchBar, type FilterOptions } from './gallery/SearchBar.tsx'
import { ModelMissingError, textEmbeddings } from './ai/model.ts'
import { aiMatches, matchesFilters, NO_FILTERS, textMatches, year, type Filters } from './catalog/search.ts'

// Väntetiden i millisekunder efter sista tangenttrycket innan AI-söket körs.
const AI_DELAY = 400

const count = (n: number) => `${n.toLocaleString('sv-SE')} ${n === 1 ? 'bild' : 'bilder'}`

const sorted = (values: Iterable<string>) => [...new Set(values)].sort((a, b) => a.localeCompare(b, 'sv'))

// Värdena som filtren kan ha, bara de som någon bild har.
function filterOptions(images: ImageRecord[]): FilterOptions {
  const places = images.flatMap((image) => (image.place ? [image.place] : []))
  return {
    photographers: sorted(images.map((image) => image.photographer)),
    // Kameror som inte har ställts in kan ange t.ex. år 0002.
    years: sorted(images.map(year).filter((value) => value >= '1900')).reverse(),
    places: [
      { label: 'Stadsområden', values: sorted(places.map((place) => place.district)) },
      { label: 'Delområden', values: sorted(places.flatMap((place) => (place.subdistrict ? [place.subdistrict] : []))) },
      { label: 'Torg och parker', values: sorted(places.flatMap((place) => (place.name ? [place.name] : []))) },
    ].filter((group) => group.values.length),
  }
}

interface Catalog {
  // Bilderna som de står i indexet, före användarnas ändringar.
  indexed: ImageRecord[]
  vocabulary: Vocabulary
  // Platsen för taggar som anger var motivet finns, efter ordlistans nyckel.
  tagPlaces: Map<string, Place>
  // Alla användares ändringar i app-data/edits/.
  edits: Edit[]
  config: BankConfig
  // Bildernas AI-vektorer, så att taggar som sätts för hand sprids till liknande bilder.
  vectors: Vectors
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
  const vectorFile = await readFile(root, 'app-data/embeddings.bin')
  return {
    indexed: images,
    vocabulary: buildVocabulary(config),
    tagPlaces: new Map(config.aiTags.filter((tag) => tag.place).map((tag) => [wordKey(tag.tag), tag.place!])),
    edits: await loadEdits(root),
    config,
    vectors: (vectorFile && decodeVectors(await vectorFile.arrayBuffer(), MODEL.dimensions)) || new Map(),
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
  // Bilden som är öppen ovanpå Admin, och bilderna man kan bläddra mellan där.
  const [adminImage, setAdminImage] = useState<{ ids: string[]; position: number } | null>(null)
  // Räknas upp när importen har ändrat indexet, så att katalogen läses om.
  const [version, setVersion] = useState(0)
  const [text, setText] = useState('')
  const [filters, setFilters] = useState<Filters>(NO_FILTERS)
  // AI-sökets träffar för söktexten text. problem förklarar varför AI-söket inte fungerade.
  const [ai, setAi] = useState<{ text: string; ids: string[]; problem: string | null } | null>(null)

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
    // Taggar som någon har satt för hand får också liknande bilder, som AI-taggar.
    const spread = spreadHandTags(catalog.vectors, merged.tags, catalog.config)
    const tags = new Map<string, ShownTag[]>()
    const images = catalog.indexed.map((indexed) => {
      const image = applyEdits(indexed, merged)
      const aiTags = [...image.aiTags, ...(spread.get(image.id) ?? [])]
      const shown = editedTags(shownTags({ tags: image.tags, aiTags }, catalog.vocabulary), merged.tags.get(image.id))
      tags.set(image.id, shown)
      // En plats som någon har ändrat går före taggarnas.
      if (merged.fields.get(image.id)?.place !== undefined) return image
      const fromTags = shown.flatMap((tag) => catalog.tagPlaces.get(wordKey(tag.tag)) ?? [])
      const place = placeWithTags(image.place, fromTags)
      return place === image.place ? image : { ...image, place }
    })
    return { images, tags }
  }, [catalog])
  const byId = useMemo(() => new Map((edited?.images ?? []).map((image) => [image.id, image])), [edited])
  const options = useMemo(() => filterOptions(edited?.images ?? []), [edited])

  // AI-söket körs en stund efter att man har slutat skriva, eftersom
  // textmodellen tar en stund första gången.
  const query = text.trim()
  useEffect(() => {
    if (!catalog || !query || !catalog.vectors.size) return
    let cancelled = false
    const timer = setTimeout(async () => {
      try {
        const [vector] = await textEmbeddings(root, [query])
        const ids = aiMatches(vector, catalog.vectors, new Set(catalog.indexed.map((image) => image.id)))
        if (!cancelled) setAi({ text: query, ids, problem: null })
      } catch (error) {
        const problem = error instanceof ModelMissingError ? 'AI-modellen saknas i bildbanken.' : 'Något gick fel.'
        if (!cancelled) setAi({ text: query, ids: [], problem })
      }
    }, AI_DELAY)
    return () => {
      cancelled = true
      clearTimeout(timer)
    }
  }, [catalog, root, query])

  const result = useMemo(() => {
    if (!edited) return { images: [], exact: 0, ai: 0 }
    const key = filter && wordKey(filter.value)
    const items = edited.images
      .filter(
        (image) =>
          !filter ||
          (filter.kind === 'place'
            ? image.place && placeParts(image.place).includes(filter.value)
            : edited.tags.get(image.id)!.some((other) => wordKey(other.tag) === key)),
      )
      .filter((image) => matchesFilters(image, filters))
      .map((image) => ({ image, tags: edited.tags.get(image.id)! }))
    if (!query) return { images: items.map((item) => item.image), exact: 0, ai: 0 }
    const exact = textMatches(items, query, catalog!.vocabulary)
    const found = new Set(exact.map((image) => image.id))
    const allowed = new Map(items.map((item) => [item.image.id, item.image]))
    const fromAi = ai?.text === query ? ai.ids.flatMap((id) => (allowed.has(id) && !found.has(id) ? [allowed.get(id)!] : [])) : []
    return { images: [...exact, ...fromAi], exact: exact.length, ai: fromAi.length }
  }, [edited, catalog, filter, filters, query, ai])
  const shown = result.images
  const aiPending = !!query && !!catalog?.vectors.size && ai?.text !== query

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
        <OpenImage.Provider value={(id, ids) => setAdminImage({ ids, position: ids.indexOf(id) })}>
          <AdminView
            bank={root}
            onSaved={reloadTags}
            onClose={(changed) => {
              setAdmin(false)
              setAdminImage(null)
              if (changed) setVersion((n) => n + 1)
            }}
          />
        </OpenImage.Provider>
      )}
      {!admin && state.kind === 'loading' && <p className="status">Läser bildbanken…</p>}
      {!admin && state.kind === 'error' && (
        <p className="error status" role="alert">
          {state.message}
        </p>
      )}
      {!admin && catalog && (
        <SearchBar text={text} filters={filters} options={options} onText={setText} onFilters={setFilters} />
      )}
      {!admin && catalog && (query || filter || filters !== NO_FILTERS) && (
        <div className="filter-bar" role="status">
          <span>
            {filter && (
              <>
                {filter.kind === 'tag' ? 'Bilder med taggen' : 'Bilder från'} <strong className="filter-tag">{filter.value}</strong> ·{' '}
              </>
            )}
            {count(shown.length)}
            {query && ` · ${result.exact.toLocaleString('sv-SE')} med sökorden`}
            {query && !!result.ai && `, ${result.ai.toLocaleString('sv-SE')} till från AI-sök`}
            {aiPending && ' · AI-söket letar…'}
            {query && !aiPending && ai?.problem && ` · AI-söket fungerar inte: ${ai.problem}`}
          </span>
          {filter && (
            <button type="button" onClick={() => setFilter(null)}>
              Visa alla bilder
            </button>
          )}
        </div>
      )}
      {!admin && catalog && (
        <Gallery
          key={`${filter?.kind}:${filter?.value}:${query}:${JSON.stringify(filters)}`}
          images={shown}
          thumbs={catalog.thumbs}
          onOpen={setSelected}
        />
      )}
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
      {admin && catalog && adminImage && byId.get(adminImage.ids[adminImage.position]) && (
        <DetailView
          key="admin"
          image={byId.get(adminImage.ids[adminImage.position])!}
          tags={edited!.tags.get(adminImage.ids[adminImage.position])!}
          vocabulary={catalog.vocabulary}
          onSave={saveEdits}
          bank={root}
          position={adminImage.position}
          count={adminImage.ids.length}
          previews={catalog.previews}
          onNavigate={(position) => setAdminImage({ ...adminImage, position })}
          onClose={() => setAdminImage(null)}
        />
      )}
    </div>
  )
}
