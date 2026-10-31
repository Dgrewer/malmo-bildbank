import { useEffect, useMemo, useState } from 'react'
import { FIELDS, type Edit, type FieldValues } from '../catalog/edits.ts'
import { placeParts, type Place } from '../catalog/places.ts'
import { CONSENT_TEXT } from '../catalog/rights.ts'
import type { Consent, ImageRecord } from '../catalog/types.ts'
import { suggestTags, wordKey, type ShownTag, type Vocabulary } from '../catalog/vocabulary.ts'
import { loadUserName, saveUserName } from '../fs/folderStore.ts'
import { loadAreas, loadNamedPlaces, type NamedPlace } from '../places/load.ts'

interface Props {
  image: ImageRecord
  tags: ShownTag[]
  vocabulary: Vocabulary
  onSave: (user: string, edits: Edit[]) => Promise<void>
  onDone: () => void
  // Öppnar panelen som sätter en tagg på liknande bilder.
  onSimilar?: (tag: string) => void
}

// Delområdena för platsväljaren, efter stadsområde. Laddas först när någon redigerar.
type Districts = { district: string; subdistricts: string[] }[]

async function loadDistricts(): Promise<Districts> {
  const areas = await loadAreas()
  return areas.districts
    .map((district) => ({
      district: district.name,
      subdistricts: areas.subdistricts
        .filter((subdistrict) => subdistrict.district === district.name)
        .map((subdistrict) => subdistrict.name)
        .sort((a, b) => a.localeCompare(b, 'sv')),
    }))
    .sort((a, b) => a.district.localeCompare(b.district, 'sv'))
}

const placeValue = (place: Place | null) => (place ? JSON.stringify([place.district, place.subdistrict, place.name ?? null]) : '')

const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b)

// Redigerar bildens uppgifter och taggar. Inget sparas förrän man trycker Spara,
// och då bara det som har ändrats, i användarens egen fil i app-data/edits/.
export function EditForm({ image, tags, vocabulary, onSave, onDone, onSimilar }: Props) {
  const [values, setValues] = useState<FieldValues>(() => ({
    photographer: image.photographer,
    byline: image.byline,
    terms: image.terms,
    rightsUntil: image.rightsUntil,
    consent: image.consent,
    blocked: image.blocked,
    place: image.place,
  }))
  // Taggarna som har lagts till eller tagits bort, efter ordlistans nyckel.
  const [changed, setChanged] = useState<Map<string, { tag: string; on: boolean }>>(new Map())
  const [user, setUser] = useState<string | null>(null)
  const [savedUser, setSavedUser] = useState('')
  const [districts, setDistricts] = useState<Districts>([])
  const [namedPlaces, setNamedPlaces] = useState<NamedPlace[]>([])
  const [placeText, setPlaceText] = useState(image.place?.name ?? '')
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    loadUserName().then(
      (name) => {
        setSavedUser(name)
        setUser(name)
      },
      () => setUser(''),
    )
    loadDistricts().then(setDistricts, () => setDistricts([]))
    loadNamedPlaces().then(setNamedPlaces, () => setNamedPlaces([]))
  }, [])

  const set = <F extends keyof FieldValues>(field: F, value: FieldValues[F]) =>
    setValues((all) => ({ ...all, [field]: value }))

  function setTag(tag: string, on: boolean) {
    setChanged((all) => {
      const next = new Map(all)
      const key = wordKey(tag)
      const original = tags.some((shown) => wordKey(shown.tag) === key)
      // Tillbaka till som det var: ingen ändring.
      if (original === on) next.delete(key)
      else next.set(key, { tag, on })
      return next
    })
  }

  const shown = useMemo(() => {
    const removed = tags.filter((shown) => changed.get(wordKey(shown.tag))?.on === false).map((shown) => shown.tag)
    const kept = tags.filter((shown) => !removed.includes(shown.tag))
    // En tillagd tagg som bilden redan har fått som AI-tagg visas en gång.
    const added = [...changed.values()]
      .filter((change) => change.on && !tags.some((shown) => wordKey(shown.tag) === wordKey(change.tag)))
      .map((change) => ({ tag: change.tag, ai: false }))
    return { kept: [...kept, ...added], removed, added: added.map((change) => change.tag) }
  }, [tags, changed])

  async function save() {
    const name = (user ?? '').trim()
    if (!name) {
      setError('Skriv ditt namn. Ändringarna sparas i en fil med ditt namn.')
      return
    }
    const at = new Date().toISOString()
    const base = { at, by: name, id: image.id }
    const edits: Edit[] = [
      ...FIELDS.filter((field) => !same(values[field], image[field])).map(
        (field) => ({ ...base, field, value: values[field] }) as Edit,
      ),
      ...[...changed.values()].map((change) => ({ ...base, tag: change.tag, on: change.on })),
    ]
    setSaving(true)
    setError(null)
    try {
      if (name !== savedUser) await saveUserName(name)
      await onSave(name, edits)
      onDone()
    } catch (problem) {
      setError(`Ändringarna sparades inte: ${problem instanceof Error ? problem.message : problem}`)
      setSaving(false)
    }
  }

  return (
    <form
      className="edit-form"
      onSubmit={(event) => {
        event.preventDefault()
        save()
      }}
    >
      {user !== null && !savedUser && (
        <label>
          Ditt namn
          <input type="text" value={user} required autoComplete="name" onChange={(event) => setUser(event.target.value)} />
          <small>Dina ändringar sparas i app-data/edits/ under ditt namn. Namnet sparas på den här datorn.</small>
        </label>
      )}
      <label>
        Fotograf
        <input type="text" value={values.photographer} onChange={(event) => set('photographer', event.target.value)} />
      </label>
      <label>
        Byline
        <input type="text" value={values.byline} onChange={(event) => set('byline', event.target.value)} />
      </label>
      <label>
        Villkor
        <textarea rows={2} value={values.terms} onChange={(event) => set('terms', event.target.value)} />
      </label>
      <label>
        Rättigheter till och med
        <input
          type="date"
          value={values.rightsUntil ?? ''}
          onChange={(event) => set('rightsUntil', event.target.value || null)}
        />
      </label>
      <label>
        Samtycke
        <select value={values.consent} onChange={(event) => set('consent', event.target.value as Consent)}>
          {(Object.keys(CONSENT_TEXT) as Consent[]).map((consent) => (
            <option key={consent} value={consent}>
              {CONSENT_TEXT[consent]}
            </option>
          ))}
        </select>
      </label>
      <label className="edit-check">
        <input type="checkbox" checked={values.blocked} onChange={(event) => set('blocked', event.target.checked)} />
        Spärrad, bilden får inte användas
      </label>
      <label>
        Plats
        <select
          value={placeValue(values.place)}
          onChange={(event) => {
            const value = event.target.value
            if (!value) {
              setPlaceText('')
              return set('place', null)
            }
            const [district, subdistrict, name] = JSON.parse(value) as [string, string | null, string | null]
            setPlaceText(name ?? '')
            set('place', { district, subdistrict, name })
          }}
        >
          <option value="">Ingen plats</option>
          {values.place &&
            (values.place.name || !districts.some((group) => group.subdistricts.includes(values.place!.subdistrict ?? ''))) && (
              <option value={placeValue(values.place)}>{placeParts(values.place).join(', ')}</option>
            )}
          {districts.map((group) => (
            <optgroup key={group.district} label={group.district}>
              {group.subdistricts.map((subdistrict) => (
                <option key={subdistrict} value={placeValue({ district: group.district, subdistrict })}>
                  {subdistrict}
                </option>
              ))}
            </optgroup>
          ))}
        </select>
      </label>
      <label>
        Torg eller park
        <input
          type="text"
          list="edit-named-places"
          placeholder="T.ex. Stortorget"
          value={placeText}
          onChange={(event) => {
            const text = event.target.value
            setPlaceText(text)
            // Ett namn ur listan ger också delområdet och stadsområdet.
            const wanted = text.trim().toLocaleLowerCase('sv')
            const found = namedPlaces.find((named) => named.label.toLocaleLowerCase('sv') === wanted)
            if (found) set('place', found.place)
            else if (!wanted && values.place?.name) set('place', { ...values.place, name: null })
          }}
        />
        <datalist id="edit-named-places">
          {namedPlaces.map((named) => (
            <option key={named.label} value={named.label} />
          ))}
        </datalist>
      </label>
      <div className="edit-tags">
        <span className="edit-label">Taggar</span>
        <TagChips
          kept={shown.kept}
          removed={shown.removed}
          vocabulary={vocabulary}
          disabled={saving}
          onSet={setTag}
        />
        {onSimilar && shown.added.length > 0 && (
          <div className="similar-buttons">
            {shown.added.map((tag) => (
              <button key={tag} type="button" className="similar-button" disabled={saving} onClick={() => onSimilar(tag)}>
                Sätt ”{tag}” på liknande bilder
              </button>
            ))}
          </div>
        )}
      </div>
      {error && (
        <p className="error" role="alert">
          {error}
        </p>
      )}
      <div className="edit-actions">
        <button type="submit" className="primary" disabled={saving}>
          {saving ? 'Sparar…' : 'Spara'}
        </button>
        <button type="button" disabled={saving} onClick={onDone}>
          Avbryt
        </button>
      </div>
    </form>
  )
}

// Taggarna som i Admin, Bilder utan AI-taggar: ett klick markerar en tagg, ett
// klick till tar bort den. En borttagen tagg visas överstruken och kan ångras.
function TagChips({
  kept,
  removed,
  vocabulary,
  disabled,
  onSet,
}: {
  kept: ShownTag[]
  removed: string[]
  vocabulary: Vocabulary
  disabled: boolean
  onSet: (tag: string, on: boolean) => void
}) {
  const [armed, setArmed] = useState<string | null>(null)
  const [text, setText] = useState('')
  const [ask, setAsk] = useState<{ word: string; near: string[] } | null>(null)
  const names = useMemo(() => [...vocabulary.names].sort((a, b) => a.localeCompare(b, 'sv')), [vocabulary])

  function choose(tag: string) {
    onSet(tag, true)
    setText('')
    setAsk(null)
  }

  // Finns ordet i ordlistan används den taggen. Liknar det en tagg frågar appen först.
  function add() {
    const word = text.trim()
    if (!word) return
    const { exact, near } = suggestTags(word, vocabulary)
    if (exact) choose(exact)
    else if (near.length) setAsk({ word, near })
    else choose(word)
  }

  return (
    <>
      <ul className="image-tag-chips">
        {kept.map(({ tag, ai }) => (
          <li key={tag}>
            <button
              type="button"
              className={armed === tag ? 'chip armed' : ai ? 'chip ai' : 'chip'}
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
            </button>
          </li>
        ))}
        {removed.map((tag) => (
          <li key={`removed-${tag}`}>
            <button
              type="button"
              className="chip removed"
              data-tag={tag}
              disabled={disabled}
              title="Borttagen från bilden. Klicka för att ångra."
              onClick={() => onSet(tag, true)}
            >
              <s>{tag}</s> ↶
            </button>
          </li>
        ))}
      </ul>
      <datalist id="edit-tag-names">
        {names.map((name) => (
          <option key={name} value={name} />
        ))}
      </datalist>
      <div className="add-tag">
        <input
          type="text"
          list="edit-tag-names"
          placeholder="Lägg till tagg"
          aria-label="Lägg till tagg"
          value={text}
          disabled={disabled}
          onChange={(event) => {
            setText(event.target.value)
            setAsk(null)
          }}
          onKeyDown={(event) => {
            // Enter lägger till taggen i stället för att spara formuläret.
            if (event.key === 'Enter') {
              event.preventDefault()
              add()
            }
          }}
        />
        <button type="button" disabled={disabled || !text.trim()} aria-label="Lägg till" onClick={add}>
          +
        </button>
      </div>
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
    </>
  )
}
