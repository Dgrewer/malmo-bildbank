import { useEffect, useMemo, useRef, useState } from 'react'
import { decodeVectors, type Vectors } from '../ai/embeddings.ts'
import { hasModel, textEmbeddings } from '../ai/model.ts'
import { MODEL } from '../ai/modelInfo.ts'
import {
  DEFAULT_CONFIG,
  EXAMPLE_RANGE,
  hasExamples,
  margin,
  parseConfig,
  similarity,
  TEXT_RANGE,
  type AiTag,
  type BankConfig,
} from '../ai/tagConfig.ts'
import {
  exampleVector,
  promptsOf,
  promptVectors,
  removeOldTagVectors,
  saveTagVectors,
  storedPromptVectors,
  tagVectors,
  applyTags,
  type PromptVectors,
} from '../ai/tagging.ts'
import { readIndexFile } from '../catalog/loadIndex.ts'
import type { ImageRecord, IndexFile } from '../catalog/types.ts'
import { ensureDirectory, readFile, writeFile } from '../fs/folder.ts'
import { useObjectUrl } from '../fs/useObjectUrl.ts'
import { writeIndexFile } from '../import/indexFiles.ts'

// Adminvyn AI-taggar: välj en tagg, se bilderna sorterade efter hur väl de
// stämmer och flytta gränsen. Taggar kan läggas till, ändras och tas bort, och
// en tagg kan hitta bilder som liknar några exempelbilder. Allt är en
// förhandsvisning tills man sparar. Då skrivs app-data/config.json och
// bilderna får nya AI-taggar direkt, utan import.

interface Props {
  bank: FileSystemDirectoryHandle
  // Anropas när indexet har sparats med nya AI-taggar.
  onSaved: () => void
  // Sant medan ändringarna sparas. Adminvyn låser då flikarna.
  onBusy: (busy: boolean) => void
}

// Ett utkast till en tagg. key skiljer taggarna åt medan namnet ändras.
interface Draft extends AiTag {
  key: number
}

interface Drafts {
  atLeastOneTag: boolean
  tags: Draft[]
}

type Loaded = {
  index: IndexFile
  // Bilder med AI-vektor, i indexets ordning.
  images: ImageRecord[]
  byId: Map<string, ImageRecord>
  imageVectors: Vectors
  thumbs: FileSystemDirectoryHandle
  saved: Drafts
}

type LoadState = { kind: 'loading' } | { kind: 'error'; message: string } | { kind: 'ready'; data: Loaded }

// Bilder som visas ovanför och under strecket.
const SHOWN_ABOVE = 48
const SHOWN_BELOW = 24
const UNTAGGED = -1

const count = (n: number) => n.toLocaleString('sv-SE')
const format = (n: number) => n.toLocaleString('sv-SE', { minimumFractionDigits: 3, maximumFractionDigits: 4 })
const rangeOf = (tag: AiTag) => (hasExamples(tag) ? EXAMPLE_RANGE : TEXT_RANGE)

let nextKey = 1
const toDrafts = (config: BankConfig): Drafts => ({
  atLeastOneTag: config.atLeastOneTag,
  tags: config.aiTags.map((tag) => ({ ...tag, key: nextKey++ })),
})
const toConfig = (drafts: Drafts): BankConfig => ({
  version: 1,
  atLeastOneTag: drafts.atLeastOneTag,
  aiTags: drafts.tags.map(({ tag, prompt, threshold, examples }) => ({
    tag: tag.trim(),
    prompt: prompt.trim(),
    threshold,
    ...(examples?.length && { examples }),
  })),
})
const same = (a: AiTag, b: AiTag) =>
  a.tag === b.tag &&
  a.prompt === b.prompt &&
  a.threshold === b.threshold &&
  (a.examples ?? []).join() === (b.examples ?? []).join()

async function load(bank: FileSystemDirectoryHandle): Promise<Loaded> {
  if (!(await hasModel(bank))) {
    throw new Error(`AI-modellen saknas i app-data/models/${MODEL.name}. Kör npm run download-model och importera.`)
  }
  const index = await readIndexFile(bank)
  const file = await readFile(bank, 'app-data/embeddings.bin')
  const imageVectors = file && decodeVectors(await file.arrayBuffer(), MODEL.dimensions)
  if (!index || !imageVectors?.size) {
    throw new Error('Bilderna har inga AI-vektorer än. Importera bilderna först, under Importera bilder.')
  }
  const configFile = await readFile(bank, 'app-data/config.json')
  const config = configFile ? parseConfig(await configFile.text()).config : DEFAULT_CONFIG
  return {
    index,
    images: index.images.filter((image) => imageVectors.has(image.id) && !image.previewProblem),
    byId: new Map(index.images.map((image) => [image.id, image])),
    imageVectors,
    thumbs: await ensureDirectory(bank, 'app-data/thumbs'),
    saved: toDrafts(config),
  }
}

// Sparar taggarna i config.json och sätter nya AI-taggar på alla bilder.
// Ordningen är densamma som vid importen: textvektorerna först, sedan indexet,
// sist borttagning av gamla textvektorer.
async function save(
  bank: FileSystemDirectoryHandle,
  config: BankConfig,
  known: PromptVectors,
  onProgress: (done: number, total: number) => void,
): Promise<IndexFile> {
  const appData = await ensureDirectory(bank, 'app-data')
  const index = await readIndexFile(bank)
  const file = await readFile(bank, 'app-data/embeddings.bin')
  const imageVectors = file && decodeVectors(await file.arrayBuffer(), MODEL.dimensions)
  if (!index || !imageVectors) throw new Error('Indexet eller AI-vektorerna går inte att läsa.')
  const stored = await storedPromptVectors(appData, index.aiTagging)
  const vectors = await promptVectors(bank, promptsOf(config), new Map([...stored, ...known]), onProgress)
  await writeFile(appData, 'config.json', `${JSON.stringify(config, null, 2)}\n`)
  applyTags(index.images, imageVectors, config, vectors)
  const updated: IndexFile = { ...index, aiTagging: await saveTagVectors(appData, config, vectors) }
  await writeIndexFile(appData, JSON.stringify(updated, null, 2))
  await removeOldTagVectors(appData, updated.aiTagging!.file)
  return updated
}

export function TagEditor({ bank, onSaved, onBusy }: Props) {
  const [state, setState] = useState<LoadState>({ kind: 'loading' })
  const [drafts, setDrafts] = useState<Drafts>({ atLeastOneTag: true, tags: [] })
  const [selected, setSelected] = useState<number | null>(null)
  const [filter, setFilter] = useState('')
  const [saving, setSaving] = useState<{ done: number; total: number } | null>(null)
  const [message, setMessage] = useState<{ kind: 'done' | 'error'; text: string } | null>(null)
  // Textvektorer efter prompt, så att samma beskrivning bara räknas ut en gång.
  const vectors = useRef<PromptVectors>(new Map())

  useEffect(() => {
    let cancelled = false
    load(bank).then(
      async (data) => {
        if (cancelled) return
        const appData = await ensureDirectory(bank, 'app-data')
        vectors.current = await storedPromptVectors(appData, data.index.aiTagging)
        setDrafts(data.saved)
        setState({ kind: 'ready', data })
      },
      (error) => !cancelled && setState({ kind: 'error', message: error instanceof Error ? error.message : String(error) }),
    )
    return () => {
      cancelled = true
    }
  }, [bank])

  if (state.kind === 'loading') return <p className="status">Läser AI-taggarna…</p>
  if (state.kind === 'error') {
    return (
      <p className="warning" role="alert">
        {state.message}
      </p>
    )
  }
  const { data } = state
  const savedByKey = new Map(data.saved.tags.map((draft) => [draft.key, draft]))
  const dirty =
    drafts.atLeastOneTag !== data.saved.atLeastOneTag ||
    drafts.tags.length !== data.saved.tags.length ||
    drafts.tags.some((draft) => !savedByKey.has(draft.key) || !same(draft, savedByKey.get(draft.key)!))
  const problems = validate(drafts.tags)
  const current = drafts.tags.find((draft) => draft.key === selected) ?? null
  // Antal bilder per tagg, som de är sparade nu.
  const savedCounts = new Map<string, number>()
  for (const image of data.index.images) {
    for (const tag of image.aiTags) savedCounts.set(tag, (savedCounts.get(tag) ?? 0) + 1)
  }

  function change(next: (drafts: Drafts) => Drafts) {
    setMessage(null)
    setDrafts(next)
  }

  function update(key: number, patch: Partial<AiTag>) {
    change((all) => ({ ...all, tags: all.tags.map((draft) => (draft.key === key ? { ...draft, ...patch } : draft)) }))
  }

  function add() {
    const draft: Draft = { key: nextKey++, tag: '', prompt: 'a photo of ', threshold: TEXT_RANGE.start }
    change((all) => ({ ...all, tags: [draft, ...all.tags] }))
    setSelected(draft.key)
    setFilter('')
  }

  function remove(key: number) {
    change((all) => ({ ...all, tags: all.tags.filter((draft) => draft.key !== key) }))
    setSelected(null)
  }

  // De förvalda taggarna med sina gränser ersätter samma taggar i utkastet,
  // och förvalda taggar som saknas läggs till. Egna taggar och taggar med
  // exempelbilder behålls som de är.
  function applyDefaults() {
    change((all) => {
      const defaults = new Map(DEFAULT_CONFIG.aiTags.map((tag) => [tag.tag, tag]))
      const tags = all.tags.map((draft) => {
        const fallback = defaults.get(draft.tag.trim())
        return fallback && !hasExamples(draft) ? { ...draft, prompt: fallback.prompt, threshold: fallback.threshold } : draft
      })
      const names = new Set(tags.map((draft) => draft.tag.trim()))
      for (const tag of DEFAULT_CONFIG.aiTags) {
        if (!names.has(tag.tag)) tags.push({ ...tag, key: nextKey++ })
      }
      return { ...all, tags }
    })
  }

  function selectByName(name: string) {
    const draft = drafts.tags.find((tag) => tag.tag === name)
    if (draft) {
      setSelected(draft.key)
      setFilter('')
    }
  }

  async function saveAll() {
    setSaving({ done: 0, total: 0 })
    setMessage(null)
    onBusy(true)
    try {
      const config = toConfig(drafts)
      const index = await save(bank, config, vectors.current, (done, total) => setSaving({ done, total }))
      const saved = {
        ...drafts,
        tags: drafts.tags.map((draft) => ({ ...draft, tag: draft.tag.trim(), prompt: draft.prompt.trim() })),
      }
      setDrafts(saved)
      setState({ kind: 'ready', data: { ...data, index, byId: new Map(index.images.map((i) => [i.id, i])), saved } })
      const tagged = index.images.filter((image) => image.aiTags.length).length
      setMessage({ kind: 'done', text: `Sparat. ${count(tagged)} bilder har AI-taggar.` })
      onSaved()
    } catch (error) {
      setMessage({ kind: 'error', text: `Taggarna sparades inte: ${error instanceof Error ? error.message : error}` })
    } finally {
      setSaving(null)
      onBusy(false)
    }
  }

  const needle = filter.trim().toLowerCase()
  const shown = drafts.tags
    .filter((draft) => !needle || draft.tag.toLowerCase().includes(needle) || draft.prompt.toLowerCase().includes(needle))
    .sort((a, b) => (a.tag === '' ? -1 : b.tag === '' ? 1 : a.tag.localeCompare(b.tag, 'sv')))
  const removed = data.saved.tags.filter((draft) => !drafts.tags.some((d) => d.key === draft.key))

  return (
    <section className="tag-editor">
      <div className="note tag-help">
        <p>
          AI-taggarna sätts automatiskt. AI:n jämför varje bild med taggens beskrivning, eller med exempelbilder, och
          ger ett värde för hur väl de stämmer. Bilder med ett värde över <strong>gränsen</strong> får taggen.
        </p>
        <p>
          Välj en tagg och flytta reglaget. Bilderna och antalet ändras direkt, men det är bara en förhandsvisning.
          Bildbanken ändras först när du trycker <strong>Spara ändringar</strong>.
        </p>
      </div>

      <div className="tag-actions">
        <button type="button" className="primary" disabled={!dirty || problems.length > 0 || !!saving} onClick={saveAll}>
          Spara ändringar
        </button>
        <button
          type="button"
          disabled={!dirty || !!saving}
          onClick={() => {
            setDrafts(data.saved)
            setMessage(null)
          }}
        >
          Ångra ändringar
        </button>
        <button
          type="button"
          disabled={!!saving}
          title="Förvalda taggar får de förvalda gränserna och beskrivningarna, och förvalda taggar som saknas läggs till. Egna taggar och taggar med exempelbilder ändras inte."
          onClick={applyDefaults}
        >
          Använd förvalda taggar och gränser
        </button>
        {saving && (
          <span role="status">
            Sparar
            {saving.total > 0 && ` – räknar ut nya beskrivningar, ${count(saving.done)} av ${count(saving.total)}`}…
          </span>
        )}
        {!saving && dirty && !problems.length && <span className="unsaved">Du har ändringar som inte är sparade.</span>}
        {message && (
          <span role={message.kind === 'error' ? 'alert' : 'status'} className={message.kind === 'error' ? 'error' : undefined}>
            {message.text}
          </span>
        )}
      </div>
      <label className="tag-option">
        <input
          type="checkbox"
          checked={drafts.atLeastOneTag}
          disabled={!!saving}
          onChange={(event) => change((all) => ({ ...all, atLeastOneTag: event.target.checked }))}
        />
        <span>
          <strong>Minst en tagg per bild.</strong> En bild som inte når gränsen för någon tagg får ändå den tagg den
          ligger närmast. Då har alla bilder minst en AI-tagg, men den kan oftare vara fel.
        </span>
      </label>
      {problems.length > 0 && (
        <ul className="warning tag-problems" role="alert">
          {problems.map((problem) => (
            <li key={problem}>{problem}</li>
          ))}
        </ul>
      )}

      <div className="tag-layout">
        <aside className="tag-sidebar">
          <button type="button" onClick={add} disabled={!!saving}>
            + Ny tagg
          </button>
          <button
            type="button"
            className={selected === UNTAGGED ? 'selected' : undefined}
            aria-current={selected === UNTAGGED}
            onClick={() => setSelected(UNTAGGED)}
          >
            Bilder utan AI-taggar
          </button>
          <input
            type="search"
            placeholder="Sök bland taggarna"
            aria-label="Sök bland taggarna"
            value={filter}
            onChange={(event) => setFilter(event.target.value)}
          />
          <p className="tag-count">{count(drafts.tags.length)} taggar</p>
          <ul className="tag-names">
            {shown.map((draft) => {
              const before = savedByKey.get(draft.key)
              const status = !before ? 'ny' : same(draft, before) ? null : 'ändrad'
              return (
                <li key={draft.key}>
                  <button
                    type="button"
                    className={draft.key === selected ? 'selected' : undefined}
                    aria-current={draft.key === selected}
                    onClick={() => setSelected(draft.key)}
                  >
                    <span>
                      {draft.tag || '(ny tagg)'}
                      {hasExamples(draft) && <span className="tag-kind"> · exempel</span>}
                    </span>
                    {status ? <em>{status}</em> : <small>{count(savedCounts.get(draft.tag) ?? 0)}</small>}
                  </button>
                </li>
              )
            })}
          </ul>
          {removed.length > 0 && (
            <p className="removed-tags">Tas bort när du sparar: {removed.map((draft) => draft.tag).join(', ')}</p>
          )}
        </aside>

        {selected === UNTAGGED ? (
          <Untagged
            bank={bank}
            drafts={drafts}
            data={data}
            vectors={vectors.current}
            onSelect={selectByName}
          />
        ) : current ? (
          <TagDetail
            key={current.key}
            bank={bank}
            draft={current}
            savedName={savedByKey.get(current.key)?.tag ?? null}
            data={data}
            vectors={vectors.current}
            disabled={!!saving}
            onChange={(patch) => update(current.key, patch)}
            onRemove={() => remove(current.key)}
          />
        ) : (
          <p className="tag-placeholder">Välj en tagg i listan, eller lägg till en ny.</p>
        )}
      </div>
    </section>
  )
}

function validate(drafts: Draft[]): string[] {
  const problems: string[] = []
  const seen = new Set<string>()
  for (const draft of drafts) {
    const tag = draft.tag.trim()
    if (!tag) problems.push('En tagg saknar namn.')
    else if (seen.has(tag.toLowerCase())) problems.push(`Taggen ”${tag}” finns två gånger.`)
    seen.add(tag.toLowerCase())
    if (!draft.prompt.trim() && !hasExamples(draft)) {
      problems.push(`Taggen ”${tag || '(ny tagg)'}” saknar både beskrivning och exempelbilder.`)
    }
  }
  return [...new Set(problems)]
}

interface Scored {
  image: ImageRecord
  score: number
}

// Vektorn för en beskrivning. Räknas ut med textmodellen en kort stund efter
// att man har slutat skriva, och sparas så att den bara räknas ut en gång.
function usePromptVector(bank: FileSystemDirectoryHandle, prompt: string, vectors: PromptVectors, wanted: boolean) {
  const [state, setState] = useState<{ prompt: string; vector: Float32Array } | { error: string } | null>(null)
  useEffect(() => {
    if (!wanted || !prompt) return
    let cancelled = false
    const known = vectors.get(prompt)
    const timer = setTimeout(
      async () => {
        try {
          const vector = known ?? (await textEmbeddings(bank, [prompt]))[0]
          vectors.set(prompt, vector)
          if (!cancelled) setState({ prompt, vector })
        } catch (error) {
          if (!cancelled) setState({ error: error instanceof Error ? error.message : String(error) })
        }
      },
      known ? 0 : 600,
    )
    return () => {
      cancelled = true
      clearTimeout(timer)
    }
  }, [bank, prompt, vectors, wanted])
  return state
}

interface DetailProps {
  bank: FileSystemDirectoryHandle
  draft: Draft
  // Taggens namn som det är sparat, eller null för en ny tagg.
  savedName: string | null
  data: Loaded
  vectors: PromptVectors
  disabled: boolean
  onChange: (patch: Partial<AiTag>) => void
  onRemove: () => void
}

function TagDetail({ bank, draft, savedName, data, vectors, disabled, onChange, onRemove }: DetailProps) {
  const prompt = draft.prompt.trim()
  const examples = draft.examples ?? []
  const byExamples = examples.length > 0
  const promptVector = usePromptVector(bank, prompt, vectors, !byExamples)
  const range = rangeOf(draft)

  // Vektorn som bilderna jämförs med: exempelbildernas, annars beskrivningens.
  const exampleKey = examples.join()
  const examplesVector = useMemo(
    () => (exampleKey ? exampleVector(exampleKey.split(','), data.imageVectors) : null),
    [exampleKey, data],
  )
  const vector = byExamples
    ? examplesVector
    : promptVector && 'vector' in promptVector && promptVector.prompt === prompt
      ? promptVector.vector
      : null
  const list = useMemo<Scored[]>(() => {
    if (!vector) return []
    return data.images
      .map((image) => ({ image, score: similarity(vector, data.imageVectors.get(image.id)!) }))
      .sort((a, b) => b.score - a.score)
  }, [vector, data])

  const above = list.filter((item) => item.score >= draft.threshold)
  const below = list.slice(above.length, above.length + SHOWN_BELOW)
  // Är det många bilder ovanför strecket visas de bästa och de närmast strecket.
  const top = above.length > SHOWN_ABOVE ? above.slice(0, 12) : above
  const nearLine = above.length > SHOWN_ABOVE ? above.slice(above.length - (SHOWN_ABOVE - 12)) : []
  const savedCount = savedName ? data.index.images.filter((image) => image.aiTags.includes(savedName)).length : 0
  const hasTag = (image: ImageRecord) => !!savedName && image.aiTags.includes(savedName)

  function toggleExample(id: string) {
    const next = examples.includes(id) ? examples.filter((example) => example !== id) : [...examples, id]
    // Bild mot bild ger mycket högre värden än bild mot text, så gränsen byter skala.
    let threshold = draft.threshold
    if (next.length && !examples.length) threshold = EXAMPLE_RANGE.start
    if (!next.length && examples.length) threshold = TEXT_RANGE.start
    onChange({ examples: next.length ? next : undefined, threshold })
  }

  const thumbProps = { thumbs: data.thumbs, examples, hasTag, disabled, onToggleExample: toggleExample }

  return (
    <div className="tag-detail">
      <div className="tag-fields">
        <label>
          Tagg
          <input
            type="text"
            value={draft.tag}
            disabled={disabled}
            onChange={(event) => onChange({ tag: event.target.value })}
            autoFocus={!draft.tag}
          />
          <small>Ordet som visas i bildbanken och går att söka på.</small>
        </label>
        <label>
          Beskrivning för AI:n, på engelska
          <input
            type="text"
            value={draft.prompt}
            disabled={disabled}
            onChange={(event) => onChange({ prompt: event.target.value })}
          />
          <small>
            {byExamples
              ? 'Används inte så länge taggen har exempelbilder.'
              : 'AI:n förstår engelska bäst. Börja gärna med ”a photo of”, t.ex. ”a photo of a bicycle”. Två taggar med samma beskrivning och gräns hamnar på samma bilder, som solnedgång och soluppgång.'}
          </small>
        </label>
      </div>

      <div className="tag-examples">
        <h4>Exempelbilder</h4>
        <p className="tag-explain">
          Klicka på <strong>Exempel</strong> under en bild som visar motivet. Med exempelbilder letar AI:n efter bilder
          som liknar dem i stället för att läsa beskrivningen. Det fungerar bra för byggnader och platser som AI:n inte
          känner igen med namn, t.ex. Malmöhus, Triangeln eller Centralstationen. Nya bilder som importeras får taggen
          automatiskt.
        </p>
        {byExamples && (
          <ul className="tag-thumbs">
            {examples.map((id) => {
              const image = data.byId.get(id)
              return image ? (
                <TagThumb key={id} image={image} score={null} {...thumbProps} />
              ) : (
                <li key={id} className="missing-example">
                  {id} finns inte längre
                  <button type="button" disabled={disabled} onClick={() => toggleExample(id)}>
                    Ta bort
                  </button>
                </li>
              )
            })}
          </ul>
        )}
      </div>

      <div className="tag-threshold">
        <label htmlFor={`threshold-${draft.key}`}>Gräns: {format(draft.threshold)}</label>
        <div className="slider">
          <span>Fler bilder</span>
          <input
            id={`threshold-${draft.key}`}
            type="range"
            min={range.min}
            max={range.max}
            step={range.step}
            value={Math.min(range.max, Math.max(range.min, draft.threshold))}
            disabled={disabled}
            onChange={(event) => onChange({ threshold: Number(event.target.value) })}
          />
          <span>Färre men säkrare</span>
        </div>
        {vector && (
          <p className="tag-hits" role="status">
            {count(above.length)} av {count(list.length)} bilder får taggen.
          </p>
        )}
        {vector && savedName && <p className="tag-saved">Sparat nu: {count(savedCount)} bilder.</p>}
        {!vector && !byExamples && prompt && !(promptVector && 'error' in promptVector) && (
          <p className="tag-hits">AI:n jämför bilderna med beskrivningen…</p>
        )}
        {!byExamples && promptVector && 'error' in promptVector && (
          <p className="error" role="alert">
            {promptVector.error}
          </p>
        )}
      </div>

      <button type="button" className="remove-tag" disabled={disabled} onClick={onRemove}>
        Ta bort taggen
      </button>

      {vector && (
        <div className="tag-images">
          <h4>Får taggen</h4>
          <p className="tag-explain">
            <span className="mark-new">ny</span> får taggen när du sparar. <span className="mark-lost">försvinner</span>{' '}
            har taggen nu men tappar den när du sparar.
          </p>
          {above.length === 0 && <p className="tag-none">Ingen bild. Flytta reglaget åt vänster för fler bilder.</p>}
          <ImageRow items={top} {...thumbProps} />
          {nearLine.length > 0 && (
            <>
              <p className="tag-gap">
                … och {count(above.length - top.length - nearLine.length)} bilder till. Närmast strecket:
              </p>
              <ImageRow items={nearLine} {...thumbProps} />
            </>
          )}
          <div className="tag-line" aria-hidden="true">
            <span>gränsen</span>
          </div>
          <h4>Får inte taggen, närmast under strecket</h4>
          <ImageRow items={below} {...thumbProps} below />
        </div>
      )}
    </div>
  )
}

interface ThumbProps {
  thumbs: FileSystemDirectoryHandle
  examples: string[]
  // Har bilden taggen som den är sparad nu?
  hasTag: (image: ImageRecord) => boolean
  disabled: boolean
  onToggleExample: (id: string) => void
}

function ImageRow({ items, below = false, ...props }: ThumbProps & { items: Scored[]; below?: boolean }) {
  return (
    <ul className="tag-thumbs">
      {items.map((item) => (
        <TagThumb key={item.image.id} image={item.image} score={item.score} below={below} {...props} />
      ))}
    </ul>
  )
}

function TagThumb({
  image,
  score,
  below = false,
  thumbs,
  examples,
  hasTag,
  disabled,
  onToggleExample,
}: ThumbProps & { image: ImageRecord; score: number | null; below?: boolean }) {
  const thumb = useObjectUrl(thumbs, `${image.id}.webp`)
  const example = examples.includes(image.id)
  const mark = score === null ? null : below ? (hasTag(image) ? 'lost' : null) : hasTag(image) ? null : 'new'
  return (
    <li title={score === null ? image.id : `${image.id}, värde ${format(score)}`} data-id={image.id}>
      <div className="tag-thumb">
        {thumb.status === 'ready' ? <img src={thumb.url} alt={image.description || image.id} loading="lazy" /> : <span />}
        {mark === 'new' && <span className="mark-new">ny</span>}
        {mark === 'lost' && <span className="mark-lost">försvinner</span>}
      </div>
      <div className="tag-thumb-info">
        {score !== null && <small>{format(score)}</small>}
        <button
          type="button"
          className={example ? 'example selected' : 'example'}
          aria-pressed={example}
          disabled={disabled}
          onClick={() => onToggleExample(image.id)}
        >
          {example ? '✓ Exempel' : 'Exempel'}
        </button>
      </div>
    </li>
  )
}

interface UntaggedProps {
  bank: FileSystemDirectoryHandle
  drafts: Drafts
  data: Loaded
  vectors: PromptVectors
  onSelect: (tag: string) => void
}

type Near = { tag: string; score: number; threshold: number }

// Bilder som inte når gränsen för någon tagg, med de taggar de ligger närmast.
function Untagged({ bank, drafts, data, vectors, onSelect }: UntaggedProps) {
  const [ready, setReady] = useState<{ config: BankConfig } | { error: string } | null>(null)
  const [progress, setProgress] = useState<{ done: number; total: number } | null>(null)
  const config = useMemo(() => toConfig(drafts), [drafts])

  // Beskrivningar som inte har räknats ut än behövs för att veta vilka bilder som blir utan.
  useEffect(() => {
    let cancelled = false
    promptVectors(bank, promptsOf(config), vectors, (done, total) => {
      if (!cancelled && total) setProgress({ done, total })
    }).then(
      (computed) => {
        for (const [prompt, vector] of computed) vectors.set(prompt, vector)
        if (!cancelled) setReady({ config })
      },
      (error) => !cancelled && setReady({ error: error instanceof Error ? error.message : String(error) }),
    )
    return () => {
      cancelled = true
    }
  }, [bank, config, vectors])

  const untagged = useMemo(() => {
    if (!ready || !('config' in ready)) return []
    const tags = tagVectors(ready.config, data.imageVectors, vectors)
    const result: { image: ImageRecord; near: Near[] }[] = []
    for (const image of data.images) {
      const imageVector = data.imageVectors.get(image.id)!
      if (tags.some((tag) => similarity(tag.vector, imageVector) >= tag.threshold)) continue
      const near = tags
        .map((tag) => ({ tag, margin: margin(tag, imageVector) }))
        .sort((a, b) => b.margin - a.margin)
        .slice(0, 3)
        .map(({ tag }) => ({ tag: tag.tag, score: similarity(tag.vector, imageVector), threshold: tag.threshold }))
      result.push({ image, near })
    }
    return result
  }, [ready, data, vectors])

  if (ready && 'error' in ready) {
    return (
      <p className="error" role="alert">
        {ready.error}
      </p>
    )
  }
  if (!ready) {
    return (
      <p className="status">
        Räknar ut vilka bilder som inte når någon tagg
        {progress && progress.total > 0 && ` – ${count(progress.done)} av ${count(progress.total)} beskrivningar`}…
      </p>
    )
  }
  return (
    <div className="tag-detail tag-untagged">
      <h4>Bilder utan AI-taggar</h4>
      <p className="tag-hits" role="status">
        {count(untagged.length)} av {count(data.images.length)} bilder når inte gränsen för någon tagg.
      </p>
      <p className="tag-explain">
        {drafts.atLeastOneTag
          ? 'Med Minst en tagg per bild får de ändå den tagg de ligger närmast, den första under varje bild.'
          : 'De får inga AI-taggar. Slå på Minst en tagg per bild om alla bilder ska få minst en.'}{' '}
        Klicka på en tagg under en bild för att sänka dess gräns, eller lägg till en ny tagg som passar.
      </p>
      <ul className="tag-thumbs untagged">
        {untagged.map(({ image, near }) => (
          <UntaggedThumb key={image.id} image={image} near={near} thumbs={data.thumbs} onSelect={onSelect} />
        ))}
      </ul>
    </div>
  )
}

function UntaggedThumb({
  image,
  near,
  thumbs,
  onSelect,
}: {
  image: ImageRecord
  near: Near[]
  thumbs: FileSystemDirectoryHandle
  onSelect: (tag: string) => void
}) {
  const thumb = useObjectUrl(thumbs, `${image.id}.webp`)
  return (
    <li title={image.id} data-id={image.id}>
      <div className="tag-thumb">
        {thumb.status === 'ready' ? <img src={thumb.url} alt={image.description || image.id} loading="lazy" /> : <span />}
      </div>
      <ul className="near-tags">
        {near.map((item) => (
          <li key={item.tag}>
            <button type="button" onClick={() => onSelect(item.tag)} title={`Gräns ${format(item.threshold)}`}>
              {item.tag} <small>{format(item.score)}</small>
            </button>
          </li>
        ))}
      </ul>
    </li>
  )
}
