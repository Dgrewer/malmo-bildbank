import { useEffect, useMemo, useRef, useState } from 'react'
import { decodeVectors, type Vectors } from '../ai/embeddings.ts'
import { hasModel, textEmbeddings } from '../ai/model.ts'
import { MODEL } from '../ai/modelInfo.ts'
import { DEFAULT_CONFIG, parseConfig, type AiTag, type BankConfig } from '../ai/tagConfig.ts'
import {
  applyTags,
  promptVectors,
  removeOldTagVectors,
  saveTagVectors,
  storedPromptVectors,
  type PromptVectors,
} from '../ai/tagging.ts'
import { readIndexFile } from '../catalog/loadIndex.ts'
import type { ImageRecord, IndexFile } from '../catalog/types.ts'
import { ensureDirectory, readFile, writeFile } from '../fs/folder.ts'
import { useObjectUrl } from '../fs/useObjectUrl.ts'
import { writeIndexFile } from '../import/indexFiles.ts'

// Adminvyn AI-taggar: välj en tagg, se bilderna sorterade efter hur väl de
// stämmer med taggens beskrivning och flytta gränsen. Taggar kan läggas till,
// ändras och tas bort. När ändringarna sparas skrivs app-data/config.json och
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

type Loaded = {
  index: IndexFile
  // Bilder med AI-vektor, i indexets ordning.
  images: ImageRecord[]
  imageVectors: Vectors
  thumbs: FileSystemDirectoryHandle
  saved: Draft[]
}

type LoadState = { kind: 'loading' } | { kind: 'error'; message: string } | { kind: 'ready'; data: Loaded }

// Reglagets omfång. Likheten mellan en bild och en beskrivning ligger nästan
// alltid mellan 0 och 0,15.
const MIN = 0
const MAX = 0.15
const STEP = 0.0025
// Bilder som visas ovanför och under strecket.
const SHOWN_ABOVE = 48
const SHOWN_BELOW = 24

const count = (n: number) => n.toLocaleString('sv-SE')
const format = (n: number) => n.toLocaleString('sv-SE', { minimumFractionDigits: 3, maximumFractionDigits: 4 })

let nextKey = 1
const toDrafts = (config: BankConfig): Draft[] => config.aiTags.map((tag) => ({ ...tag, key: nextKey++ }))
const toConfig = (drafts: Draft[]): BankConfig => ({
  version: 1,
  aiTags: drafts.map(({ tag, prompt, threshold }) => ({ tag: tag.trim(), prompt: prompt.trim(), threshold })),
})
const same = (a: AiTag, b: AiTag) => a.tag === b.tag && a.prompt === b.prompt && a.threshold === b.threshold

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
  const vectors = await promptVectors(
    bank,
    config.aiTags.map((tag) => tag.prompt),
    new Map([...stored, ...known]),
    onProgress,
  )
  await writeFile(appData, 'config.json', `${JSON.stringify(config, null, 2)}\n`)
  applyTags(index.images, imageVectors, config, vectors)
  const updated: IndexFile = { ...index, aiTagging: await saveTagVectors(appData, config, vectors) }
  await writeIndexFile(appData, JSON.stringify(updated, null, 2))
  await removeOldTagVectors(appData, updated.aiTagging!.file)
  return updated
}

export function TagEditor({ bank, onSaved, onBusy }: Props) {
  const [state, setState] = useState<LoadState>({ kind: 'loading' })
  const [drafts, setDrafts] = useState<Draft[]>([])
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
  const savedByKey = new Map(data.saved.map((draft) => [draft.key, draft]))
  const dirty =
    drafts.length !== data.saved.length || drafts.some((draft) => !savedByKey.has(draft.key) || !same(draft, savedByKey.get(draft.key)!))
  const problems = validate(drafts)
  const current = drafts.find((draft) => draft.key === selected) ?? null
  // Antal bilder per tagg, som de är sparade nu.
  const savedCounts = new Map<string, number>()
  for (const image of data.index.images) {
    for (const tag of image.aiTags) savedCounts.set(tag, (savedCounts.get(tag) ?? 0) + 1)
  }

  function update(key: number, change: Partial<AiTag>) {
    setMessage(null)
    setDrafts((list) => list.map((draft) => (draft.key === key ? { ...draft, ...change } : draft)))
  }

  function add() {
    const draft: Draft = { key: nextKey++, tag: '', prompt: 'a photo of ', threshold: 0.06 }
    setMessage(null)
    setDrafts((list) => [draft, ...list])
    setSelected(draft.key)
    setFilter('')
  }

  function remove(key: number) {
    setMessage(null)
    setDrafts((list) => list.filter((draft) => draft.key !== key))
    setSelected(null)
  }

  async function saveAll() {
    setSaving({ done: 0, total: 0 })
    setMessage(null)
    onBusy(true)
    try {
      const config = toConfig(drafts)
      const index = await save(bank, config, vectors.current, (done, total) => setSaving({ done, total }))
      const saved = drafts.map((draft) => ({ ...draft, tag: draft.tag.trim(), prompt: draft.prompt.trim() }))
      setDrafts(saved)
      setState({ kind: 'ready', data: { ...data, index, saved } })
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
  const shown = drafts
    .filter((draft) => !needle || draft.tag.toLowerCase().includes(needle) || draft.prompt.toLowerCase().includes(needle))
    .sort((a, b) => (a.tag === '' ? -1 : b.tag === '' ? 1 : a.tag.localeCompare(b.tag, 'sv')))

  return (
    <section className="tag-editor">
      <div className="note tag-help">
        <p>
          AI-taggarna sätts automatiskt. AI:n jämför varje bild med en kort beskrivning på engelska och ger ett värde
          för hur väl de stämmer. Bilder med ett värde över <strong>gränsen</strong> får taggen.
        </p>
        <p>
          Välj en tagg och titta på bilderna. Flytta gränsen tills bilderna ovanför strecket är rätt. Ändringarna
          gäller för alla bilder när du sparar.
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
          <input
            type="search"
            placeholder="Sök bland taggarna"
            aria-label="Sök bland taggarna"
            value={filter}
            onChange={(event) => setFilter(event.target.value)}
          />
          <p className="tag-count">{count(drafts.length)} taggar</p>
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
                    <span>{draft.tag || '(ny tagg)'}</span>
                    {status ? (
                      <em>{status}</em>
                    ) : (
                      <small>{count(savedCounts.get(draft.tag) ?? 0)}</small>
                    )}
                  </button>
                </li>
              )
            })}
          </ul>
          {data.saved.some((draft) => !drafts.some((d) => d.key === draft.key)) && (
            <p className="removed-tags">
              Tas bort när du sparar:{' '}
              {data.saved
                .filter((draft) => !drafts.some((d) => d.key === draft.key))
                .map((draft) => draft.tag)
                .join(', ')}
            </p>
          )}
        </aside>

        {current ? (
          <TagDetail
            key={current.key}
            bank={bank}
            draft={current}
            data={data}
            vectors={vectors.current}
            disabled={!!saving}
            onChange={(change) => update(current.key, change)}
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
    if (!draft.prompt.trim()) problems.push(`Taggen ”${tag || '(ny tagg)'}” saknar beskrivning för AI:n.`)
  }
  return [...new Set(problems)]
}

interface DetailProps {
  bank: FileSystemDirectoryHandle
  draft: Draft
  data: Loaded
  vectors: PromptVectors
  disabled: boolean
  onChange: (change: Partial<AiTag>) => void
  onRemove: () => void
}

type Scores = { kind: 'idle' } | { kind: 'working' } | { kind: 'error'; message: string } | { kind: 'ready'; prompt: string; list: { image: ImageRecord; score: number }[] }

function TagDetail({ bank, draft, data, vectors, disabled, onChange, onRemove }: DetailProps) {
  const [scores, setScores] = useState<Scores>({ kind: 'idle' })
  const prompt = draft.prompt.trim()

  // Bildernas likhet med beskrivningen räknas ut en kort stund efter att man
  // har slutat skriva.
  useEffect(() => {
    if (!prompt) {
      setScores({ kind: 'idle' })
      return
    }
    let cancelled = false
    const known = vectors.get(prompt)
    const timer = setTimeout(
      async () => {
        setScores((current) => (current.kind === 'ready' ? current : { kind: 'working' }))
        try {
          const vector = known ?? (await textEmbeddings(bank, [prompt]))[0]
          vectors.set(prompt, vector)
          if (cancelled) return
          const list = data.images.map((image) => {
            const imageVector = data.imageVectors.get(image.id)!
            let score = 0
            for (let i = 0; i < vector.length; i++) score += vector[i] * imageVector[i]
            return { image, score }
          })
          list.sort((a, b) => b.score - a.score)
          setScores({ kind: 'ready', prompt, list })
        } catch (error) {
          if (!cancelled) setScores({ kind: 'error', message: error instanceof Error ? error.message : String(error) })
        }
      },
      known ? 0 : 600,
    )
    return () => {
      cancelled = true
      clearTimeout(timer)
    }
  }, [bank, prompt, data, vectors])

  const list = scores.kind === 'ready' ? scores.list : []
  const above = useMemo(() => list.filter((item) => item.score >= draft.threshold), [list, draft.threshold])
  const below = list.slice(above.length, above.length + SHOWN_BELOW)
  // Är det många bilder ovanför strecket visas de bästa och de närmast strecket.
  const top = above.length > SHOWN_ABOVE ? above.slice(0, 12) : above
  const nearLine = above.length > SHOWN_ABOVE ? above.slice(above.length - (SHOWN_ABOVE - 12)) : []

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
            AI:n förstår engelska bäst. Börja gärna med ”a photo of”, t.ex. ”a photo of a bicycle”. Två taggar med
            samma beskrivning och gräns hamnar på samma bilder, som solnedgång och soluppgång.
          </small>
        </label>
      </div>

      <div className="tag-threshold">
        <label htmlFor={`threshold-${draft.key}`}>Gräns: {format(draft.threshold)}</label>
        <div className="slider">
          <span>Fler bilder</span>
          <input
            id={`threshold-${draft.key}`}
            type="range"
            min={MIN}
            max={MAX}
            step={STEP}
            value={Math.min(MAX, Math.max(MIN, draft.threshold))}
            disabled={disabled}
            onChange={(event) => onChange({ threshold: Number(event.target.value) })}
          />
          <span>Färre men säkrare</span>
        </div>
        {scores.kind === 'ready' && (
          <p className="tag-hits" role="status">
            {count(above.length)} av {count(list.length)} bilder får taggen.
          </p>
        )}
        {scores.kind === 'working' && <p className="tag-hits">AI:n jämför bilderna med beskrivningen…</p>}
        {scores.kind === 'error' && (
          <p className="error" role="alert">
            {scores.message}
          </p>
        )}
      </div>

      <button type="button" className="remove-tag" disabled={disabled} onClick={onRemove}>
        Ta bort taggen
      </button>

      {scores.kind === 'ready' && (
        <div className="tag-images">
          <h4>Får taggen</h4>
          {above.length === 0 && <p className="tag-none">Ingen bild. Flytta reglaget åt vänster för fler bilder.</p>}
          <ImageRow items={top} thumbs={data.thumbs} />
          {nearLine.length > 0 && (
            <>
              <p className="tag-gap">… och {count(above.length - top.length - nearLine.length)} bilder till. Närmast strecket:</p>
              <ImageRow items={nearLine} thumbs={data.thumbs} />
            </>
          )}
          <div className="tag-line" aria-hidden="true">
            <span>gränsen</span>
          </div>
          <h4>Får inte taggen, närmast under strecket</h4>
          <ImageRow items={below} thumbs={data.thumbs} />
        </div>
      )}
    </div>
  )
}

function ImageRow({ items, thumbs }: { items: { image: ImageRecord; score: number }[]; thumbs: FileSystemDirectoryHandle }) {
  return (
    <ul className="tag-thumbs">
      {items.map((item) => (
        <TagThumb key={item.image.id} image={item.image} score={item.score} thumbs={thumbs} />
      ))}
    </ul>
  )
}

function TagThumb({ image, score, thumbs }: { image: ImageRecord; score: number; thumbs: FileSystemDirectoryHandle }) {
  const thumb = useObjectUrl(thumbs, `${image.id}.webp`)
  return (
    <li title={`${image.id}, värde ${format(score)}`}>
      {thumb.status === 'ready' ? <img src={thumb.url} alt={image.description || image.id} loading="lazy" /> : <span />}
      <small>{format(score)}</small>
    </li>
  )
}
