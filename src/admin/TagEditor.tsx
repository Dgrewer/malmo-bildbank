import { useEffect, useMemo, useRef, useState } from 'react'
import { decodeVectors, type Vectors } from '../ai/embeddings.ts'
import { hasModel, textEmbeddings } from '../ai/model.ts'
import { MODEL } from '../ai/modelInfo.ts'
import {
  decide,
  DEFAULT_CONFIG,
  EXAMPLE_RANGE,
  hasExamples,
  isBlocked,
  override,
  parseConfig,
  similarity,
  TEXT_RANGE,
  type AiTag,
  type BankConfig,
  type Override,
} from '../ai/tagConfig.ts'
import {
  applyTags,
  exampleVector,
  promptsOf,
  promptVectors,
  removeOldTagVectors,
  saveTagVectors,
  storedPromptVectors,
  tagVector,
  vectorsOf,
  type PromptVectors,
} from '../ai/tagging.ts'
import { readIndexFile } from '../catalog/loadIndex.ts'
import { buildVocabulary, suggestTags, unknownKeywords, wordKey, type Vocabulary } from '../catalog/vocabulary.ts'
import type { ImageRecord, IndexFile } from '../catalog/types.ts'
import type { Place } from '../catalog/places.ts'
import { loadNamedPlaces, type NamedPlace } from '../places/load.ts'
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
export interface Draft extends AiTag {
  key: number
}

export interface Drafts {
  atLeastOneTag: boolean
  tags: Draft[]
  hiddenKeywords: string[]
}

export type Loaded = {
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
const ALL_IMAGES = -2
const KEYWORDS = -3
// Bilder som visas åt gången i bildvyerna.
const PAGE = 60
// Beskrivningar som textmodellen tar åt gången i adminvyn. Modellen körs i
// sidan, och mellan varje omgång hinner sidan svara på klick.
const UI_CHUNK = 4
const breathe = () => new Promise((resolve) => setTimeout(resolve, 0))

export const count = (n: number) => n.toLocaleString('sv-SE')
export const format = (n: number) => n.toLocaleString('sv-SE', { minimumFractionDigits: 3, maximumFractionDigits: 4 })
const rangeOf = (tag: AiTag) => (hasExamples(tag) ? EXAMPLE_RANGE : TEXT_RANGE)

let nextKey = 1
const toDrafts = (config: BankConfig): Drafts => ({
  atLeastOneTag: config.atLeastOneTag,
  tags: config.aiTags.map((tag) => ({ ...tag, key: nextKey++ })),
  hiddenKeywords: config.hiddenKeywords ?? [],
})
export const toConfig = (drafts: Drafts): BankConfig => ({
  version: 1,
  atLeastOneTag: drafts.atLeastOneTag,
  aiTags: drafts.tags.map(({ tag, prompt, threshold, examples, excluded, included, synonyms, related, place }) => ({
    tag: tag.trim(),
    prompt: prompt.trim(),
    threshold,
    ...(examples?.length && { examples }),
    ...(excluded?.length && { excluded }),
    ...(included?.length && { included }),
    ...(synonyms?.length && { synonyms }),
    ...(related?.length && { related }),
    ...(place && { place }),
  })),
  ...(drafts.hiddenKeywords.length && { hiddenKeywords: drafts.hiddenKeywords }),
})
const LISTS = ['examples', 'excluded', 'included', 'synonyms', 'related'] as const
const same = (a: AiTag, b: AiTag) =>
  a.tag === b.tag &&
  a.prompt === b.prompt &&
  a.threshold === b.threshold &&
  LISTS.every((list) => (a[list] ?? []).join('\n') === (b[list] ?? []).join('\n')) &&
  a.place?.name === b.place?.name
// Andra taggar som ett nytt namn liknar eller redan är ett annat ord för.
function similarTags(name: string, vocabulary: Vocabulary): string[] {
  const wanted = name.trim()
  if (!wanted) return []
  const { exact, near } = suggestTags(wanted, vocabulary)
  return [...new Set([exact, ...near])].filter((tag): tag is string => !!tag && tag !== wanted)
}
// Listan utan id, eller undefined om den blir tom.
const without = (list: string[] | undefined, id: string) => {
  const rest = (list ?? []).filter((other) => other !== id)
  return rest.length ? rest : undefined
}

export async function load(bank: FileSystemDirectoryHandle): Promise<Loaded> {
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
export async function save(
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
    promptsOf(config),
    new Map([...stored, ...known]),
    async (done, total) => {
      onProgress(done, total)
      await breathe()
    },
    UI_CHUNK,
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
  const [drafts, setDrafts] = useState<Drafts>({ atLeastOneTag: true, tags: [], hiddenKeywords: [] })
  const [selected, setSelected] = useState<number | null>(null)
  const [filter, setFilter] = useState('')
  const [saving, setSaving] = useState<{ done: number; total: number } | null>(null)
  const [message, setMessage] = useState<{ kind: 'done' | 'error'; text: string } | null>(null)
  // Valen på bildernas närmaste taggar sedan man sparade. Bilderna ligger kvar
  // i vyn och valen syns tills man sparar eller ångrar.
  const [choices, setChoices] = useState<Choices>(new Map())
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

  // Ordlistan som den blir med utkastet: synonymer, taggar som hör ihop och dolda nyckelord.
  const vocabulary = useMemo(() => buildVocabulary(toConfig(drafts)), [drafts])

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
    drafts.hiddenKeywords.join('\n') !== data.saved.hiddenKeywords.join('\n') ||
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

  // De förvalda taggarna får sina förvalda beskrivningar och gränser, och
  // förvalda taggar som saknas läggs till. Egna taggar, taggar med
  // exempelbilder och bilder markerade som Inte rätt behålls som de är.
  function applyDefaults() {
    const defaults = new Map(DEFAULT_CONFIG.aiTags.map((tag) => [tag.tag, tag]))
    let reset = 0
    const tags = drafts.tags.map((draft) => {
      const fallback = defaults.get(draft.tag.trim())
      if (!fallback || hasExamples(draft)) return draft
      if (draft.prompt === fallback.prompt && draft.threshold === fallback.threshold) return draft
      reset++
      return { ...draft, prompt: fallback.prompt, threshold: fallback.threshold }
    })
    const names = new Set(tags.map((draft) => draft.tag.trim()))
    const added = DEFAULT_CONFIG.aiTags.filter((tag) => !names.has(tag.tag))
    for (const tag of added) tags.push({ ...tag, key: nextKey++ })
    change((all) => ({ ...all, tags }))
    setMessage({
      kind: 'done',
      text:
        reset || added.length
          ? `${count(reset)} taggar fick förvalda värden och ${count(added.length)} lades till. Tryck Spara ändringar för att använda dem.`
          : 'Alla förvalda taggar har redan sina förvalda värden.',
    })
  }

  // Ger bilden taggen (on) eller tar bort den, för hand. På en tagg med
  // exempelbilder blir bilden ett exempel, så att taggen lär sig av den. Finns
  // ingen tagg med namnet skapas en, med bilden som exempel.
  function setImageTag(id: string, name: string, on: boolean) {
    const wanted = name.trim()
    if (!wanted) return
    change((all) => {
      const existing = all.tags.find((draft) => draft.tag.trim().toLowerCase() === wanted.toLowerCase())
      if (!existing) {
        if (!on) return all
        const draft: Draft = { key: nextKey++, tag: wanted, prompt: '', threshold: EXAMPLE_RANGE.start, examples: [id] }
        return { ...all, tags: [...all.tags, draft] }
      }
      const examples = without(existing.examples, id)
      let patch: Partial<AiTag>
      if (on && hasExamples(existing)) {
        patch = {
          examples: [...(examples ?? []), id],
          excluded: without(existing.excluded, id),
          included: without(existing.included, id),
        }
      } else if (on) {
        patch = { included: [...(without(existing.included, id) ?? []), id], excluded: without(existing.excluded, id) }
      } else {
        patch = { examples, included: without(existing.included, id), excluded: [...(without(existing.excluded, id) ?? []), id] }
        // Var bilden det sista exemplet jämförs bilderna med beskrivningen igen.
        if (!examples && hasExamples(existing)) patch.threshold = TEXT_RANGE.start
      }
      return { ...all, tags: all.tags.map((draft) => (draft === existing ? { ...draft, ...patch } : draft)) }
    })
  }

  // Tar ut en tagg ur sin grupp: alla kopplingar till och från den tas bort.
  function leaveGroup(name: string) {
    change((all) => ({
      ...all,
      tags: all.tags.map((draft) =>
        draft.tag === name
          ? { ...draft, related: undefined }
          : draft.related
            ? { ...draft, related: without(draft.related.filter((other) => wordKey(other) !== wordKey(name)), '') }
            : draft,
      ),
    }))
  }

  // Kopplar ett nyckelord till en tagg: ordet blir en synonym till taggen.
  function mapKeyword(word: string, name: string) {
    change((all) => ({
      ...all,
      tags: all.tags.map((draft) =>
        draft.tag === name ? { ...draft, synonyms: [...(draft.synonyms ?? []), word.trim()] } : draft,
      ),
    }))
  }

  function selectByName(name: string) {
    const draft = drafts.tags.find((tag) => tag.tag === name)
    if (draft) {
      setSelected(draft.key)
      setFilter('')
    }
  }

  // Ångrar en rättning för hand: bilden får taggen om värdet räcker. Blev
  // bilden ett exempel för att den behölls under bilden tas det bort.
  function clearImageTag(id: string, name: string, example = false) {
    change((all) => ({
      ...all,
      tags: all.tags.map((draft) => {
        if (draft.tag !== name) return draft
        const patch: Partial<AiTag> = { excluded: without(draft.excluded, id), included: without(draft.included, id) }
        if (example && draft.examples?.includes(id)) {
          patch.examples = without(draft.examples, id)
          if (!patch.examples) patch.threshold = TEXT_RANGE.start
        }
        return { ...draft, ...patch }
      }),
    }))
  }

  function choose(id: string, tag: string, choice: Choice | null) {
    setChoices((all) => {
      const next = new Map(all)
      const forImage = new Map(next.get(id))
      if (choice) forImage.set(tag, choice)
      else forImage.delete(tag)
      if (forImage.size) next.set(id, forImage)
      else next.delete(id)
      return next
    })
  }

  async function saveAll() {
    setSaving({ done: 0, total: 0 })
    setMessage(null)
    onBusy(true)
    try {
      // Har en tagg bytt namn följer taggarna som hör ihop med den med.
      const renames = new Map<string, string>()
      for (const draft of drafts.tags) {
        const before = savedByKey.get(draft.key)
        if (before && before.tag !== draft.tag.trim()) renames.set(before.tag, draft.tag.trim())
      }
      const renamed = {
        ...drafts,
        tags: drafts.tags.map((draft) =>
          draft.related ? { ...draft, related: draft.related.map((name) => renames.get(name) ?? name) } : draft,
        ),
      }
      const config = toConfig(renamed)
      const index = await save(bank, config, vectors.current, (done, total) => setSaving({ done, total }))
      const saved = {
        ...renamed,
        tags: renamed.tags.map((draft) => ({ ...draft, tag: draft.tag.trim(), prompt: draft.prompt.trim() })),
      }
      setDrafts(saved)
      setChoices(new Map())
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
        <p>
          Har en bild fått en tagg som inte stämmer, tryck <strong>Inte rätt</strong> under bilden. Känner AI:n inte igen
          en byggnad eller plats, tryck <strong>Exempel</strong> under några bilder som visar den. Taggarna gäller för alla som använder bildbanken, och nya bilder
          taggas automatiskt när de importeras. Varje rättning gör alltså bildbanken bättre för alla.
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
            setChoices(new Map())
            setMessage(null)
          }}
        >
          Ångra ändringar
        </button>
        <button type="button" disabled={!!saving} aria-describedby="defaults-help" onClick={applyDefaults}>
          Återställ förvalda taggar
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
      <p className="tag-explain" id="defaults-help">
        <strong>Återställ förvalda taggar</strong> ger taggarna som följer med bildbanken (som ”flygbild” och ”bro”)
        tillbaka sina ursprungliga beskrivningar och gränser, och lägger tillbaka förvalda taggar som har tagits bort.
        Taggar ni har lagt till själva, taggar med exempelbilder och bilder markerade som <strong>Inte rätt</strong>{' '}
        ändras inte. Inget ändras i bildbanken förrän du trycker Spara ändringar, och Ångra ändringar tar bort det.
      </p>
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
          <button
            type="button"
            className={selected === ALL_IMAGES ? 'selected' : undefined}
            aria-current={selected === ALL_IMAGES}
            onClick={() => setSelected(ALL_IMAGES)}
          >
            Alla bilder och deras taggar
          </button>
          <button
            type="button"
            className={selected === KEYWORDS ? 'selected' : undefined}
            aria-current={selected === KEYWORDS}
            onClick={() => setSelected(KEYWORDS)}
          >
            Okända nyckelord
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
              const renamed = before && before.tag !== draft.tag.trim() ? before.tag : null
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
                      {renamed && <span className="tag-kind"> · hette {renamed}</span>}
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

        {selected === KEYWORDS ? (
          <KeywordsView
            images={data.index.images}
            vocabulary={vocabulary}
            hidden={drafts.hiddenKeywords}
            disabled={!!saving}
            onMap={mapKeyword}
            onHide={(word, hide) =>
              change((all) => ({
                ...all,
                hiddenKeywords: hide
                  ? [...all.hiddenKeywords, word]
                  : all.hiddenKeywords.filter((other) => wordKey(other) !== wordKey(word)),
              }))
            }
          />
        ) : selected === UNTAGGED || selected === ALL_IMAGES ? (
          <ImagesView
            bank={bank}
            onlyUntagged={selected === UNTAGGED}
            drafts={drafts}
            data={data}
            vectors={vectors.current}
            vocabulary={vocabulary}
            disabled={!!saving}
            choices={choices}
            onSet={setImageTag}
            onClear={clearImageTag}
            onChoose={choose}
          />
        ) : current ? (
          <TagDetail
            key={current.key}
            bank={bank}
            draft={current}
            nameTaken={drafts.tags.some(
              (draft) => draft.key !== current.key && draft.tag.trim().toLowerCase() === current.tag.trim().toLowerCase(),
            )}
            similar={
              savedByKey.get(current.key)?.tag === current.tag.trim() ? [] : similarTags(current.tag, vocabulary)
            }
            savedName={savedByKey.get(current.key)?.tag ?? null}
            data={data}
            vectors={vectors.current}
            vocabulary={vocabulary}
            disabled={!!saving}
            onChange={(patch) => update(current.key, patch)}
            onRemove={() => remove(current.key)}
            onSelect={selectByName}
            onLeaveGroup={leaveGroup}
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

export interface Scored {
  image: ImageRecord
  score: number
  override: Override
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
  // Sant om en annan tagg redan har samma namn.
  nameTaken: boolean
  // Andra taggar som ett nytt namn liknar.
  similar: string[]
  // Taggens namn som det är sparat, eller null för en ny tagg.
  savedName: string | null
  data: Loaded
  vectors: PromptVectors
  vocabulary: Vocabulary
  disabled: boolean
  onChange: (patch: Partial<AiTag>) => void
  onRemove: () => void
  onSelect: (tag: string) => void
  // Tar ut taggen ur gruppen av taggar som hör ihop.
  onLeaveGroup: (tag: string) => void
}

function TagDetail({
  bank,
  draft,
  nameTaken,
  similar,
  savedName,
  data,
  vectors,
  vocabulary,
  disabled,
  onChange,
  onRemove,
  onSelect,
  onLeaveGroup,
}: DetailProps) {
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
  const excludedKey = (draft.excluded ?? []).join()
  const includedKey = (draft.included ?? []).join()
  const list = useMemo<Scored[]>(() => {
    if (!vector) return []
    const fixes = {
      excluded: vectorsOf(excludedKey ? excludedKey.split(',') : [], data.imageVectors),
      included: vectorsOf(includedKey ? includedKey.split(',') : [], data.imageVectors),
    }
    return data.images
      .map((image) => {
        const imageVector = data.imageVectors.get(image.id)!
        return { image, score: similarity(vector, imageVector), override: override(fixes, image.id, imageVector) }
      })
      .sort((a, b) => b.score - a.score)
  }, [vector, excludedKey, includedKey, data])

  const above = list.filter((item) => decide(item.override, item.score, draft.threshold))
  // Bilder som är markerade som fel, och bilder över gränsen som liknar dem.
  const wrong = list.filter(
    (item) => item.override === 'excluded' || (item.override === 'like-excluded' && item.score >= draft.threshold),
  )
  const below = list.filter((item) => item.score < draft.threshold && !item.override).slice(0, SHOWN_BELOW)
  // Är det många bilder ovanför strecket visas de bästa och de närmast strecket.
  const top = above.length > SHOWN_ABOVE ? above.slice(0, 12) : above
  const nearLine = above.length > SHOWN_ABOVE ? above.slice(above.length - (SHOWN_ABOVE - 12)) : []
  const savedCount = savedName ? data.index.images.filter((image) => image.aiTags.includes(savedName)).length : 0
  const hasTag = (image: ImageRecord) => !!savedName && image.aiTags.includes(savedName)

  const excludedIds = draft.excluded ?? []

  // En bild är antingen exempel, markerad som fel eller ingetdera.
  function setRole(id: string, role: 'example' | 'wrong' | null) {
    const nextExamples = role === 'example' ? [...examples.filter((e) => e !== id), id] : examples.filter((e) => e !== id)
    const nextExcluded =
      role === 'wrong' ? [...excludedIds.filter((e) => e !== id), id] : excludedIds.filter((e) => e !== id)
    // Bild mot bild ger mycket högre värden än bild mot text, så gränsen byter skala.
    let threshold = draft.threshold
    if (nextExamples.length && !examples.length) threshold = EXAMPLE_RANGE.start
    if (!nextExamples.length && examples.length) threshold = TEXT_RANGE.start
    onChange({
      examples: nextExamples.length ? nextExamples : undefined,
      excluded: nextExcluded.length ? nextExcluded : undefined,
      included: without(draft.included, id),
      threshold,
    })
  }
  const toggleExample = (id: string) => setRole(id, examples.includes(id) ? null : 'example')

  const thumbProps = {
    thumbs: data.thumbs,
    examples,
    hasTag,
    disabled,
    onToggleExample: toggleExample,
    onWrong: (id: string) => setRole(id, 'wrong'),
  }

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
          {nameTaken ? (
            <small className="error" role="alert">
              Det finns redan en tagg som heter ”{draft.tag.trim()}”. Fältet byter namn på den här taggen. Leta efter
              taggar i sökfältet till vänster.
            </small>
          ) : (
            <small>
              Ordet som visas i bildbanken och går att söka på. Ändrar du det här byter taggen namn.
              {savedName && savedName !== draft.tag.trim() && ` Den hette ”${savedName}”.`}
            </small>
          )}
        </label>
        {!nameTaken && similar.length > 0 && (
          <p className="warning similar-tags" role="status">
            Det finns redan en liknande tagg:{' '}
            {similar.map((tag) => (
              <button key={tag} type="button" className="chip" onClick={() => onSelect(tag)}>
                {tag}
              </button>
            ))}{' '}
            Använd hellre den, eller lägg till ditt ord som ett annat ord för den, så att alla taggar samma sak.
          </p>
        )}
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

      <WordList
        title="Andra ord för samma sak"
        explain="Synonymer, engelska ord och vanliga felstavningar, t.ex. ”turningtorso” för Turning Torso. Bilder vars nyckelord är något av orden visas med den här taggen, och skriver någon ordet föreslås den här taggen."
        words={draft.synonyms ?? []}
        placeholder="Lägg till ord"
        disabled={disabled}
        check={(word) => {
          const owner = vocabulary.byWord.get(wordKey(word))
          return owner ? `”${word}” ${owner === draft.tag.trim() ? 'finns redan' : `hör redan till taggen ${owner}`}.` : null
        }}
        onAdd={(word) => onChange({ synonyms: [...(draft.synonyms ?? []), word] })}
        onRemove={(word) => onChange({ synonyms: without(draft.synonyms, word) })}
      />
      <WordList
        title="Hör ihop med"
        explain="Taggar som ska visas tillsammans, t.ex. restaurang och kafé eller butik och affär. Har en bild den ena taggen visas den med alla i gruppen. Det påverkar inte vilka AI-taggar AI:n sätter."
        words={(vocabulary.groups.get(draft.tag.trim()) ?? []).filter((name) => name !== draft.tag.trim())}
        placeholder="Lägg till tagg"
        list="tag-name-list"
        options={vocabulary.names}
        disabled={disabled}
        check={(word) => {
          const name = vocabulary.byWord.get(wordKey(word))
          if (!name) return `Det finns ingen tagg som heter ”${word}”.`
          return name === draft.tag.trim() ? 'Taggen hör alltid ihop med sig själv.' : null
        }}
        onAdd={(word) => onChange({ related: [...(draft.related ?? []), vocabulary.byWord.get(wordKey(word))!] })}
        onRemove={onLeaveGroup}
      />
      <TagPlace place={draft.place} disabled={disabled} onChange={(place) => onChange({ place })} />

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
            har taggen nu men tappar den när du sparar. Tryck <strong>Inte rätt</strong> under en bild som inte ska ha
            taggen.
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

      {wrong.length > 0 && (
        <div className="tag-wrong">
          <h4>Inte rätt ({count(wrong.length)})</h4>
          <p className="tag-explain">
            De här bilderna får aldrig taggen, och inte heller bilder som är nästan likadana, t.ex. andra bilder i samma
            serie. Det gäller även bilder som importeras senare. Tryck <strong>Ångra</strong> om en bild ska kunna få
            taggen igen.
          </p>
          <ul className="tag-thumbs">
            {wrong.map((item) => (
              <WrongThumb
                key={item.image.id}
                image={item.image}
                similar={item.override === 'like-excluded'}
                thumbs={data.thumbs}
                hasTag={hasTag(item.image)}
                disabled={disabled}
                onUndo={() => setRole(item.image.id, null)}
              />
            ))}
          </ul>
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
  onWrong: (id: string) => void
}

export function ImageRow({ items, below = false, ...props }: ThumbProps & { items: Scored[]; below?: boolean }) {
  return (
    <ul className="tag-thumbs">
      {items.map((item) => (
        <TagThumb key={item.image.id} image={item.image} score={item.score} below={below} {...props} />
      ))}
    </ul>
  )
}

export function TagThumb({
  image,
  score,
  below = false,
  thumbs,
  examples,
  hasTag,
  disabled,
  onToggleExample,
  onWrong,
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
        {!below && !example && (
          <button
            type="button"
            className="wrong"
            title="Bilden ska inte ha taggen"
            disabled={disabled}
            onClick={() => onWrong(image.id)}
          >
            Inte rätt
          </button>
        )}
      </div>
    </li>
  )
}

// En bild som inte får taggen för att den, eller en nästan likadan bild, är markerad som fel.
export function WrongThumb({
  image,
  similar,
  thumbs,
  hasTag,
  disabled,
  onUndo,
}: {
  image: ImageRecord
  similar: boolean
  thumbs: FileSystemDirectoryHandle
  hasTag: boolean
  disabled: boolean
  onUndo: () => void
}) {
  const thumb = useObjectUrl(thumbs, `${image.id}.webp`)
  return (
    <li title={image.id} data-id={image.id}>
      <div className="tag-thumb">
        {thumb.status === 'ready' ? <img src={thumb.url} alt={image.description || image.id} loading="lazy" /> : <span />}
        {hasTag && <span className="mark-lost">försvinner</span>}
      </div>
      <div className="tag-thumb-info">
        {similar ? (
          <small>Liknar en bild som inte är rätt</small>
        ) : (
          <button type="button" disabled={disabled} onClick={onUndo}>
            Ångra
          </button>
        )}
      </div>
    </li>
  )
}

interface ImagesProps {
  bank: FileSystemDirectoryHandle
  // Bara bilder som inte når gränsen för någon tagg.
  onlyUntagged: boolean
  drafts: Drafts
  data: Loaded
  vectors: PromptVectors
  vocabulary: Vocabulary
  disabled: boolean
  choices: Choices
  onSet: (id: string, tag: string, on: boolean) => void
  onClear: (id: string, tag: string, example?: boolean) => void
  onChoose: (id: string, tag: string, choice: Choice | null) => void
}

// Ett val på en bilds närmaste tagg: behåll den eller ta bort den.
type Choice = 'keep' | 'remove'
type Choices = Map<string, Map<string, Choice>>

interface ImageTags {
  image: ImageRecord
  // Taggarna som bilden får när man sparar. fallback är taggen den får genom Minst en tagg per bild.
  tags: { tag: string; fallback: boolean; manual: boolean }[]
  // Taggar som är borttagna för hand från just den här bilden.
  removed: string[]
  // Taggarna som bilden ligger närmast men inte får.
  near: string[]
  // Sant om bilden inte når gränsen för någon tagg.
  untagged: boolean
}

// Värdet för varje bild mot en taggvektor, i data.images ordning. Sparas per
// laddning så att samma tagg bara räknas en gång.
const scoreCache = new WeakMap<Loaded, Map<string, Float32Array>>()
function scoresFor(data: Loaded, key: string, vector: Float32Array): Float32Array {
  let cache = scoreCache.get(data)
  if (!cache) scoreCache.set(data, (cache = new Map()))
  let scores = cache.get(key)
  if (!scores) {
    scores = new Float32Array(data.images.length)
    data.images.forEach((image, n) => (scores![n] = similarity(vector, data.imageVectors.get(image.id)!)))
    if (cache.size > 1000) cache.clear()
    cache.set(key, scores)
  }
  return scores
}

// Taggarna som varje bild får med utkastet, på samma sätt som när man sparar.
function imageTags(config: BankConfig, data: Loaded, vectors: PromptVectors): ImageTags[] {
  const tags = config.aiTags.flatMap((aiTag) => {
    const vector = tagVector(aiTag, data.imageVectors, vectors)
    if (!vector) return []
    const key = vector.examples ? `e:${aiTag.examples!.join()}` : `p:${aiTag.prompt}`
    const range = vector.examples ? EXAMPLE_RANGE : TEXT_RANGE
    return [{ aiTag, vector, range: range.max - range.min, scores: scoresFor(data, key, vector.vector) }]
  })
  return data.images.map((image, n) => {
    const imageVector = data.imageVectors.get(image.id)!
    const result: ImageTags = { image, tags: [], removed: [], near: [], untagged: true }
    const candidates: { tag: string; margin: number }[] = []
    for (const { aiTag, vector, range, scores } of tags) {
      const value = override(vector, image.id, imageVector)
      if (value === 'excluded') result.removed.push(aiTag.tag)
      if (decide(value, scores[n], vector.threshold)) {
        result.tags.push({ tag: aiTag.tag, fallback: false, manual: value === 'included' })
      } else if (!isBlocked(value)) {
        candidates.push({ tag: aiTag.tag, margin: (scores[n] - vector.threshold) / range })
      }
    }
    result.untagged = !result.tags.length
    candidates.sort((a, b) => b.margin - a.margin)
    if (result.untagged && config.atLeastOneTag && candidates.length) {
      result.tags.push({ tag: candidates.shift()!.tag, fallback: true, manual: false })
    }
    result.near = candidates.slice(0, 3).map((candidate) => candidate.tag)
    return result
  })
}

// Bilderna med taggarna de får. Ett klick på en tagg markerar den, ett klick
// till tar bort den från bilden. Nya taggar skrivs in under bilden.
function ImagesView({
  bank,
  onlyUntagged,
  drafts,
  data,
  vectors,
  vocabulary,
  disabled,
  choices,
  onSet,
  onClear,
  onChoose,
}: ImagesProps) {
  const [ready, setReady] = useState<{ config: BankConfig } | { error: string } | null>(null)
  const [progress, setProgress] = useState<{ done: number; total: number } | null>(null)
  const [shown, setShown] = useState(PAGE)
  const config = useMemo(() => toConfig(drafts), [drafts])

  // Beskrivningar som inte har räknats ut än behövs för att veta vilka taggar bilderna får.
  useEffect(() => {
    let cancelled = false
    promptVectors(
      bank,
      promptsOf(config),
      vectors,
      async (done, total) => {
        // Ändras utkastet under tiden avbryts det. Det som hann räknas ut finns kvar i vectors.
        if (cancelled) throw new Error('avbruten')
        if (total) setProgress({ done, total })
        await breathe()
      },
      UI_CHUNK,
    ).then(
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

  const all = useMemo(
    () => (ready && 'config' in ready ? imageTags(ready.config, data, vectors) : []),
    [ready, data, vectors],
  )
  const untagged = all.filter((item) => item.untagged)
  // En bild där man har valt på den närmaste taggen ligger kvar tills man sparar.
  const list = onlyUntagged ? all.filter((item) => item.untagged || choices.has(item.image.id)) : all
  const names = useMemo(() => drafts.tags.map((draft) => draft.tag.trim()).filter(Boolean).sort((a, b) => a.localeCompare(b, 'sv')), [drafts])

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
        Räknar ut vilka taggar bilderna får
        {progress && progress.total > 0 && ` – ${count(progress.done)} av ${count(progress.total)} beskrivningar`}…
      </p>
    )
  }
  return (
    <div className={onlyUntagged ? 'tag-detail tag-images-view tag-untagged' : 'tag-detail tag-images-view'}>
      <h4>{onlyUntagged ? 'Bilder utan AI-taggar' : 'Alla bilder och deras taggar'}</h4>
      <p className="tag-hits" role="status">
        {onlyUntagged
          ? `${count(untagged.length)} av ${count(data.images.length)} bilder når inte gränsen för någon tagg.`
          : `${count(all.length)} bilder.`}
      </p>
      <p className="tag-explain">
        Under varje bild står taggarna den får. Klicka på en tagg som är fel: den blir röd med ett kryss. Klicka igen
        för att ta bort den från bilden. Skriv i fältet under bilden för att lägga till en tagg. Nästan likadana
        bilder, t.ex. andra bilder i samma serie, följer med. Inget ändras förrän du trycker Spara ändringar.
        {onlyUntagged &&
          (drafts.atLeastOneTag
            ? ' Bilderna här når inte gränsen för någon tagg, så de får den tagg de ligger närmast, märkt ”närmast”. Den kan bytas om taggarna ändras. Stämmer taggen: klicka på namnet, så blir det grönt och taggen behålls. Är den fel: klicka på krysset, så blir det rött och taggen tas bort. Bilden ligger kvar här och visar ditt val tills du sparar. Klicka på samma del igen för att ångra.'
            : ' Slå på Minst en tagg per bild om alla bilder ska få minst en tagg.')}
      </p>
      <datalist id="tag-name-list">
        {names.map((name) => (
          <option key={name} value={name} />
        ))}
      </datalist>
      <ul className="tag-thumbs image-tags">
        {list.slice(0, shown).map((item) => (
          <ImageTagsThumb
            key={item.image.id}
            item={item}
            thumbs={data.thumbs}
            disabled={disabled}
            showNear={onlyUntagged}
            choices={choices.get(item.image.id)}
            suggest={(word) => suggestTags(word, vocabulary)}
            onSet={(tag, on) => onSet(item.image.id, tag, on)}
            onClear={(tag, example) => onClear(item.image.id, tag, example)}
            onChoose={(tag, choice) => onChoose(item.image.id, tag, choice)}
          />
        ))}
      </ul>
      {list.length > shown && (
        <button type="button" onClick={() => setShown((value) => value + PAGE)}>
          Visa fler bilder ({count(list.length - shown)} kvar)
        </button>
      )}
    </div>
  )
}

function ImageTagsThumb({
  item,
  thumbs,
  disabled,
  showNear,
  choices,
  suggest,
  onSet,
  onClear,
  onChoose,
}: {
  item: ImageTags
  thumbs: FileSystemDirectoryHandle
  disabled: boolean
  showNear: boolean
  // Valen på bildens närmaste taggar sedan man sparade.
  choices: Map<string, Choice> | undefined
  suggest: (word: string) => { exact: string | null; near: string[] }
  onSet: (tag: string, on: boolean) => void
  onClear: (tag: string, example?: boolean) => void
  onChoose: (tag: string, choice: Choice | null) => void
}) {
  const thumb = useObjectUrl(thumbs, `${item.image.id}.webp`)
  // Taggen som är markerad för borttagning. Nästa klick tar bort den.
  const [armed, setArmed] = useState<string | null>(null)
  const [text, setText] = useState('')
  // Ett nytt ord som liknar befintliga taggar. Användaren väljer en av dem eller ordet.
  const [ask, setAsk] = useState<{ word: string; near: string[] } | null>(null)

  function choose(tag: string) {
    onSet(tag, true)
    setText('')
    setAsk(null)
  }

  // Finns ordet i ordlistan används den taggen, t.ex. Turning Torso för
  // "turningtorso". Liknar det en tagg frågar appen först.
  function add() {
    const word = text.trim()
    if (!word) return
    const { exact, near } = suggest(word)
    if (exact) choose(exact)
    else if (near.length) setAsk({ word, near })
    else choose(word)
  }

  return (
    <li title={item.image.id} data-id={item.image.id}>
      <div className="tag-thumb">
        {thumb.status === 'ready' ? (
          <img src={thumb.url} alt={item.image.description || item.image.id} loading="lazy" />
        ) : (
          <span />
        )}
      </div>
      <ul className="image-tag-chips">
        {/* Taggar man har valt på står först, så att de inte flyttar sig. */}
        {[...(choices ?? [])].map(([tag, choice]) => (
          <li key={`choice-${tag}`}>
            <SplitChip
              tag={tag}
              choice={choice}
              disabled={disabled}
              onKeep={() => {
                if (choice === 'keep') onClear(tag, true)
                else onSet(tag, true)
                onChoose(tag, choice === 'keep' ? null : 'keep')
              }}
              onRemove={() => {
                if (choice === 'remove') onClear(tag)
                else onSet(tag, false)
                onChoose(tag, choice === 'remove' ? null : 'remove')
              }}
            />
          </li>
        ))}
        {item.tags
          .filter(({ tag }) => !choices?.has(tag))
          .map(({ tag, fallback, manual }) => (
            <li key={tag}>
              {fallback ? (
                <SplitChip
                  tag={tag}
                  choice={null}
                  disabled={disabled}
                  onKeep={() => {
                    onSet(tag, true)
                    onChoose(tag, 'keep')
                  }}
                  onRemove={() => {
                    onSet(tag, false)
                    onChoose(tag, 'remove')
                  }}
                />
              ) : (
                <button
                  type="button"
                  className={armed === tag ? 'chip armed' : 'chip'}
                  data-tag={tag}
                  disabled={disabled}
                  title={armed === tag ? 'Klicka igen för att ta bort taggen från bilden' : 'Klicka om taggen är fel'}
                  onClick={() => {
                    if (armed === tag) {
                      setArmed(null)
                      onSet(tag, false)
                    } else setArmed(tag)
                  }}
                  onBlur={() => setArmed((value) => (value === tag ? null : value))}
                >
                  {armed === tag && <span aria-hidden="true">✕ </span>}
                  {tag}
                  {manual && <small> för hand</small>}
                </button>
              )}
            </li>
          ))}
        {item.removed
          .filter((tag) => !choices?.has(tag))
          .map((tag) => (
            <li key={`removed-${tag}`}>
              <button
                type="button"
                className="chip removed"
                data-tag={tag}
                disabled={disabled}
                title="Borttagen från bilden. Klicka för att ångra."
                onClick={() => onClear(tag)}
              >
                <s>{tag}</s> ↶
              </button>
            </li>
          ))}
      </ul>
      {showNear && item.near.length > 0 && (
        <p className="near-tags">
          Förslag:{' '}
          {item.near.map((tag) => (
            <button key={tag} type="button" className="chip suggestion" disabled={disabled} onClick={() => onSet(tag, true)}>
              + {tag}
            </button>
          ))}
        </p>
      )}
      <form
        className="add-tag"
        onSubmit={(event) => {
          event.preventDefault()
          add()
        }}
      >
        <input
          type="text"
          list="tag-name-list"
          placeholder="Lägg till tagg"
          aria-label={`Lägg till tagg på ${item.image.id}`}
          value={text}
          disabled={disabled}
          onChange={(event) => {
            setText(event.target.value)
            setAsk(null)
          }}
        />
        <button type="submit" disabled={disabled || !text.trim()} aria-label="Lägg till">
          +
        </button>
      </form>
      {ask && (
        <p className="did-you-mean" role="status">
          Menade du{' '}
          {ask.near.map((tag) => (
            <button key={tag} type="button" className="chip" disabled={disabled} onClick={() => choose(tag)}>
              {tag}
            </button>
          ))}
          ?{' '}
          <button type="button" className="chip suggestion" disabled={disabled} onClick={() => choose(ask.word)}>
            Nej, ny tagg ”{ask.word}”
          </button>
        </p>
      )}
    </li>
  )
}

// Den närmaste taggen, delad i två: namnet behåller den på bilden och krysset
// tar bort den. Valet syns tills man sparar, och ett klick till på samma del
// ångrar det.
function SplitChip({
  tag,
  choice,
  disabled,
  onKeep,
  onRemove,
}: {
  tag: string
  choice: Choice | null
  disabled: boolean
  onKeep: () => void
  onRemove: () => void
}) {
  return (
    <span className={choice ? `chip split chosen-${choice}` : 'chip split fallback'} data-tag={tag}>
      <button
        type="button"
        className="split-keep"
        disabled={disabled}
        aria-pressed={choice === 'keep'}
        aria-label={`Behåll ${tag} på bilden`}
        title={choice === 'keep' ? 'Behålls när du sparar. Klicka för att ångra.' : 'Taggen stämmer. Behåll den på bilden.'}
        onClick={onKeep}
      >
        {tag}
        {!choice && <small> närmast</small>}
      </button>
      <button
        type="button"
        className="split-remove"
        disabled={disabled}
        aria-pressed={choice === 'remove'}
        aria-label={`Ta bort ${tag} från bilden`}
        title={choice === 'remove' ? 'Tas bort när du sparar. Klicka för att ångra.' : 'Taggen är fel. Ta bort den från bilden.'}
        onClick={onRemove}
      >
        ✕
      </button>
    </span>
  )
}

// Platsen där taggens motiv finns, t.ex. Stortorget för Malmö rådhus.
function TagPlace({
  place,
  disabled,
  onChange,
}: {
  place: Place | undefined
  disabled: boolean
  onChange: (place: Place | undefined) => void
}) {
  const [places, setPlaces] = useState<NamedPlace[]>([])
  const [text, setText] = useState('')
  const [problem, setProblem] = useState<string | null>(null)
  useEffect(() => {
    loadNamedPlaces().then(setPlaces, () => setPlaces([]))
  }, [])

  function choose() {
    const wanted = text.trim().toLocaleLowerCase('sv')
    const found = places.find((named) => named.label.toLocaleLowerCase('sv') === wanted)
    if (!found) {
      setProblem(`Hittar inget torg eller park som heter ”${text.trim()}”. Välj ett namn ur listan.`)
      return
    }
    onChange(found.place)
    setText('')
    setProblem(null)
  }

  return (
    <div className="word-list tag-place">
      <h4>Plats</h4>
      <p className="tag-explain">
        Torget eller parken där motivet finns, t.ex. Stortorget för Malmö rådhus. Bilder med taggen som saknar GPS får
        platsen. Har bilden GPS i samma delområde men inget torg eller park, får den platsens namn.
      </p>
      {place ? (
        <p className="tag-place-current">
          <strong>{place.name}</strong> · {place.subdistrict ? `${place.subdistrict} · ` : ''}
          {place.district}{' '}
          <button type="button" disabled={disabled} onClick={() => onChange(undefined)}>
            Ta bort platsen
          </button>
        </p>
      ) : (
        <form
          className="add-tag"
          onSubmit={(event) => {
            event.preventDefault()
            choose()
          }}
        >
          <input
            type="text"
            list="named-place-list"
            placeholder="Välj torg eller park"
            aria-label="Plats för taggen"
            value={text}
            disabled={disabled}
            onChange={(event) => {
              setText(event.target.value)
              setProblem(null)
            }}
          />
          <datalist id="named-place-list">
            {places.map((named) => (
              <option key={named.label} value={named.label} />
            ))}
          </datalist>
          <button type="submit" disabled={disabled || !text.trim()}>
            Välj
          </button>
        </form>
      )}
      {problem && (
        <p className="warning" role="alert">
          {problem}
        </p>
      )}
    </div>
  )
}

// En lista med ord som går att lägga till och ta bort.
function WordList({
  title,
  explain,
  words,
  placeholder,
  list,
  options,
  disabled,
  check,
  onAdd,
  onRemove,
}: {
  title: string
  explain: string
  words: string[]
  placeholder: string
  list?: string
  options?: string[]
  disabled: boolean
  // Ett felmeddelande om ordet inte går att lägga till, annars null.
  check: (word: string) => string | null
  onAdd: (word: string) => void
  onRemove: (word: string) => void
}) {
  const [text, setText] = useState('')
  const problem = text.trim() ? check(text.trim()) : null
  return (
    <div className="word-list">
      <h4>{title}</h4>
      <p className="tag-explain">{explain}</p>
      <ul className="image-tag-chips">
        {words.map((word) => (
          <li key={word}>
            <button type="button" className="chip" disabled={disabled} title="Ta bort" onClick={() => onRemove(word)}>
              {word} ✕
            </button>
          </li>
        ))}
      </ul>
      <form
        className="add-tag"
        onSubmit={(event) => {
          event.preventDefault()
          if (!text.trim() || problem) return
          onAdd(text.trim())
          setText('')
        }}
      >
        <input
          type="text"
          list={list}
          placeholder={placeholder}
          aria-label={`${title}: ${placeholder}`}
          value={text}
          disabled={disabled}
          onChange={(event) => setText(event.target.value)}
        />
        <button type="submit" disabled={disabled || !text.trim() || !!problem}>
          Lägg till
        </button>
      </form>
      {problem && <small className="error">{problem}</small>}
      {list && options && (
        <datalist id={list}>
          {options.map((name) => (
            <option key={name} value={name} />
          ))}
        </datalist>
      )}
    </div>
  )
}

// Nyckelord från bildfilerna som inte finns i ordlistan. De kopplas till en
// tagg, som ett annat ord för den, eller döljs.
function KeywordsView({
  images,
  vocabulary,
  hidden,
  disabled,
  onMap,
  onHide,
}: {
  images: ImageRecord[]
  vocabulary: Vocabulary
  hidden: string[]
  disabled: boolean
  onMap: (word: string, tag: string) => void
  onHide: (word: string, hide: boolean) => void
}) {
  const unknown = useMemo(() => unknownKeywords(images, vocabulary), [images, vocabulary])
  return (
    <div className="tag-detail keywords-view">
      <h4>Okända nyckelord</h4>
      <p className="tag-explain">
        Nyckelord som fotografen eller bildbyrån har skrivit in i bildfilerna, och som inte finns i ordlistan. De visas
        som taggar som de är. Koppla ett ord till en tagg, t.ex. ”fountain” till fontän, så visas bilderna med den
        taggen. Dölj ord som inte säger något om bilden. Inget ändras förrän du trycker Spara ändringar.
      </p>
      <p className="tag-hits" role="status">
        {count(unknown.length)} okända nyckelord.
      </p>
      <datalist id="keyword-tag-list">
        {vocabulary.names.map((name) => (
          <option key={name} value={name} />
        ))}
      </datalist>
      <ul className="keyword-rows">
        {unknown.slice(0, 200).map(({ word, count: images }) => (
          <KeywordRow key={word} word={word} images={images} vocabulary={vocabulary} disabled={disabled} onMap={onMap} onHide={onHide} />
        ))}
      </ul>
      {hidden.length > 0 && (
        <>
          <h4>Dolda nyckelord</h4>
          <ul className="image-tag-chips">
            {hidden.map((word) => (
              <li key={word}>
                <button type="button" className="chip removed" disabled={disabled} title="Visa igen" onClick={() => onHide(word, false)}>
                  <s>{word}</s> ↶
                </button>
              </li>
            ))}
          </ul>
        </>
      )}
    </div>
  )
}

function KeywordRow({
  word,
  images,
  vocabulary,
  disabled,
  onMap,
  onHide,
}: {
  word: string
  images: number
  vocabulary: Vocabulary
  disabled: boolean
  onMap: (word: string, tag: string) => void
  onHide: (word: string, hide: boolean) => void
}) {
  const [text, setText] = useState('')
  const tag = vocabulary.byWord.get(wordKey(text))
  return (
    <li data-word={word}>
      <span>
        <strong>{word}</strong> <small>{count(images)} bilder</small>
      </span>
      <form
        className="add-tag"
        onSubmit={(event) => {
          event.preventDefault()
          if (tag) onMap(word, tag)
        }}
      >
        <input
          type="text"
          list="keyword-tag-list"
          placeholder="Tagg"
          aria-label={`Koppla ${word} till tagg`}
          value={text}
          disabled={disabled}
          onChange={(event) => setText(event.target.value)}
        />
        <button type="submit" disabled={disabled || !tag}>
          Koppla
        </button>
      </form>
      <button type="button" disabled={disabled} onClick={() => onHide(word, true)}>
        Dölj
      </button>
    </li>
  )
}
