import { useEffect, useMemo, useState } from 'react'
import { decide, EXAMPLE_RANGE, hasExamples, override, similarity } from '../ai/tagConfig.ts'
import { exampleVector, vectorsOf } from '../ai/tagging.ts'
import { wordKey } from '../catalog/vocabulary.ts'
import type { ImageRecord } from '../catalog/types.ts'
import {
  count,
  format,
  ImageRow,
  load,
  save,
  TagThumb,
  toConfig,
  WrongThumb,
  type Draft,
  type Loaded,
  type Scored,
} from '../admin/TagEditor.tsx'

interface Props {
  bank: FileSystemDirectoryHandle
  // Bilden som är taggens första exempel.
  image: ImageRecord
  tag: string
  // Anropas när AI-taggen har sparats och bilderna har fått nya AI-taggar.
  onSaved: () => Promise<void>
  // Stänger panelen. Redigeringen under ligger kvar som den var.
  onClose: () => void
}

type State =
  | { kind: 'loading' }
  | { kind: 'error'; message: string }
  // Taggen finns redan och styrs av en beskrivning. Den ändras i Admin.
  | { kind: 'prompt' }
  | { kind: 'ready'; data: Loaded; savedName: string | null }

const SHOWN_ABOVE = 48
const SHOWN_BELOW = 12

// Gör en tagg som någon har satt för hand till en AI-tagg med bilden som
// exempel, så att liknande bilder får den. Som AI-taggar i Admin, men utan att
// lämna bilden. Ingenting sparas förrän man trycker Spara AI-taggen.
export function SimilarPanel({ bank, image, tag, onSaved, onClose }: Props) {
  const [state, setState] = useState<State>({ kind: 'loading' })
  const [draft, setDraft] = useState<Draft | null>(null)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    let cancelled = false
    load(bank).then(
      (data) => {
        if (cancelled) return
        const existing = data.saved.tags.find((other) => wordKey(other.tag) === wordKey(tag))
        if (existing && !hasExamples(existing) && existing.prompt) return setState({ kind: 'prompt' })
        setDraft(
          existing
            ? {
                ...existing,
                examples: [...(existing.examples ?? []).filter((id) => id !== image.id), image.id],
                excluded: existing.excluded?.filter((id) => id !== image.id),
              }
            : { key: -1, tag, prompt: '', threshold: EXAMPLE_RANGE.start, examples: [image.id] },
        )
        setState({ kind: 'ready', data, savedName: existing?.tag ?? null })
      },
      (problem) => !cancelled && setState({ kind: 'error', message: problem instanceof Error ? problem.message : String(problem) }),
    )
    return () => {
      cancelled = true
    }
  }, [bank, image.id, tag])

  const data = state.kind === 'ready' ? state.data : null
  const examples = draft?.examples ?? []
  const exampleKey = examples.join()
  const excludedKey = (draft?.excluded ?? []).join()
  const list = useMemo<Scored[]>(() => {
    if (!data || !exampleKey) return []
    const vector = exampleVector(exampleKey.split(','), data.imageVectors)
    if (!vector) return []
    const fixes = { excluded: vectorsOf(excludedKey ? excludedKey.split(',') : [], data.imageVectors), included: new Map() }
    return data.images
      .map((other) => {
        const imageVector = data.imageVectors.get(other.id)!
        return { image: other, score: similarity(vector, imageVector), override: override(fixes, other.id, imageVector) }
      })
      .sort((a, b) => b.score - a.score)
  }, [data, exampleKey, excludedKey])

  function setRole(id: string, role: 'example' | 'wrong' | null) {
    setDraft((current) => {
      if (!current) return current
      const nextExamples = (current.examples ?? []).filter((other) => other !== id)
      const nextExcluded = (current.excluded ?? []).filter((other) => other !== id)
      if (role === 'example') nextExamples.push(id)
      if (role === 'wrong') nextExcluded.push(id)
      return {
        ...current,
        examples: nextExamples.length ? nextExamples : undefined,
        excluded: nextExcluded.length ? nextExcluded : undefined,
      }
    })
  }

  async function saveTag() {
    if (!data || !draft) return
    setSaving(true)
    setError(null)
    try {
      const tags: Draft[] = data.saved.tags.some((other) => other.key === draft.key)
        ? data.saved.tags.map((other) => (other.key === draft.key ? draft : other))
        : [...data.saved.tags, draft]
      await save(bank, toConfig({ ...data.saved, tags }), new Map(), () => {})
      await onSaved()
      onClose()
    } catch (problem) {
      setError(`AI-taggen sparades inte: ${problem instanceof Error ? problem.message : problem}`)
      setSaving(false)
    }
  }

  const header = (
    <div className="similar-header">
      <h3>”{tag}” på liknande bilder</h3>
      <button type="button" disabled={saving} onClick={onClose}>
        ← Tillbaka till redigeringen
      </button>
    </div>
  )

  if (state.kind !== 'ready' || !draft || !data) {
    return (
      <section className="similar-panel" aria-label={`${tag} på liknande bilder`}>
        {header}
        {state.kind === 'loading' && <p className="status">Letar efter liknande bilder…</p>}
        {state.kind === 'error' && (
          <p className="warning" role="alert">
            {state.message}
          </p>
        )}
        {state.kind === 'prompt' && (
          <p className="warning" role="alert">
            ”{tag}” är redan en AI-tagg som bygger på en beskrivning. Du ändrar den i Admin, under AI-taggar.
          </p>
        )}
      </section>
    )
  }

  const savedName = state.savedName
  const hasTag = (other: ImageRecord) => !!savedName && other.aiTags.includes(savedName)
  const byExamples = examples.length > 0
  const range = EXAMPLE_RANGE
  const above = list.filter((item) => decide(item.override, item.score, draft.threshold))
  const wrong = list.filter(
    (item) => item.override === 'excluded' || (item.override === 'like-excluded' && item.score >= draft.threshold),
  )
  const below = list.filter((item) => item.score < draft.threshold && !item.override).slice(0, SHOWN_BELOW)
  const thumbProps = {
    thumbs: data.thumbs,
    examples,
    hasTag,
    disabled: saving,
    onToggleExample: (id: string) => setRole(id, examples.includes(id) ? null : 'example'),
    onWrong: (id: string) => setRole(id, 'wrong'),
  }

  return (
    <section className="similar-panel" aria-label={`${tag} på liknande bilder`}>
      {header}
      <p className="tag-explain">
        Dra i reglaget tills rätt bilder får taggen. Tryck <strong>Inte rätt</strong> under en bild som är fel, och{' '}
        <strong>Exempel</strong> under en bra träff. Inget sparas förrän du trycker <strong>Spara AI-taggen</strong>.
      </p>

      <h4>Exempelbilder</h4>
      {byExamples ? (
        <ul className="tag-thumbs">
          {examples.flatMap((id) => {
            const example = data.byId.get(id)
            return example ? [<TagThumb key={id} image={example} score={null} {...thumbProps} />] : []
          })}
        </ul>
      ) : (
        <p className="warning">Välj minst en exempelbild. Annars vet AI:n inte vad den ska leta efter.</p>
      )}

      {byExamples && (
        <>
          <div className="tag-threshold">
            <label htmlFor="similar-threshold">Gräns: {format(draft.threshold)}</label>
            <div className="slider">
              <span>Fler bilder</span>
              <input
                id="similar-threshold"
                type="range"
                min={range.min}
                max={range.max}
                step={range.step}
                value={Math.min(range.max, Math.max(range.min, draft.threshold))}
                disabled={saving}
                onChange={(event) => setDraft({ ...draft, threshold: Number(event.target.value) })}
              />
              <span>Färre men säkrare</span>
            </div>
            <p className="tag-hits" role="status">
              {count(above.length)} av {count(list.length)} bilder får taggen.
            </p>
          </div>

          <div className="tag-images">
            <h4>Får taggen</h4>
            {above.length === 0 && <p className="tag-none">Ingen bild. Flytta reglaget åt vänster för fler bilder.</p>}
            <ImageRow items={above.slice(0, SHOWN_ABOVE)} {...thumbProps} />
            {above.length > SHOWN_ABOVE && (
              <p className="tag-gap">… och {count(above.length - SHOWN_ABOVE)} bilder till.</p>
            )}
            <div className="tag-line" aria-hidden="true">
              <span>gränsen</span>
            </div>
            <h4>Får inte taggen, närmast under strecket</h4>
            <ImageRow items={below} {...thumbProps} below />
          </div>
        </>
      )}

      {wrong.length > 0 && (
        <div className="tag-wrong">
          <h4>Inte rätt ({count(wrong.length)})</h4>
          <ul className="tag-thumbs">
            {wrong.map((item) => (
              <WrongThumb
                key={item.image.id}
                image={item.image}
                similar={item.override === 'like-excluded'}
                thumbs={data.thumbs}
                hasTag={hasTag(item.image)}
                disabled={saving}
                onUndo={() => setRole(item.image.id, null)}
              />
            ))}
          </ul>
        </div>
      )}

      {error && (
        <p className="error" role="alert">
          {error}
        </p>
      )}
      <div className="similar-actions">
        <button type="button" className="primary" disabled={saving || !byExamples} onClick={saveTag}>
          {saving ? 'Sparar…' : 'Spara AI-taggen'}
        </button>
        <button type="button" disabled={saving} onClick={onClose}>
          Tillbaka
        </button>
      </div>
    </section>
  )
}
