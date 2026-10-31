import { useEffect, useRef, useState, type WheelEvent } from 'react'
import { fileFormat, fileName, formatDuration, formatResolution, isVideo } from '../catalog/fileFormat.ts'
import { CONSENT_TEXT, formatTaken } from '../catalog/rights.ts'
import type { ImageRecord } from '../catalog/types.ts'
import type { Edit } from '../catalog/edits.ts'
import { placeParts } from '../catalog/places.ts'
import type { ShownTag, Vocabulary } from '../catalog/vocabulary.ts'
import { EditForm } from './EditForm.tsx'
import { SimilarPanel } from './SimilarPanel.tsx'
import { useObjectUrl } from '../fs/useObjectUrl.ts'

interface Props {
  image: ImageRecord
  // Bildens taggar: nyckelorden från filen och AI-taggarna, på svenska via ordlistan.
  tags: ShownTag[]
  // Bildens plats i galleriet, från 0, och antalet bilder.
  position: number
  count: number
  previews: FileSystemDirectoryHandle
  onNavigate: (position: number) => void
  // Visar alla bilder med taggen i galleriet. Saknas i Admin, där taggarna bara visas.
  onTag?: (tag: string) => void
  // Visar alla bilder från stadsområdet eller delområdet i galleriet.
  onPlace?: (place: string) => void
  vocabulary: Vocabulary
  // Sparar ändringar i användarens egen fil i app-data/edits/.
  onSave: (user: string, edits: Edit[]) => Promise<void>
  // Bildbanken, för panelen som sätter en tagg på liknande bilder.
  bank: FileSystemDirectoryHandle
  // Anropas när en ny AI-tagg har sparats, så att bilderna läses om. Saknas i
  // Admin, där AI-taggarna ändras i fliken AI-taggar.
  onTagsSaved?: () => Promise<void>
  onClose: () => void
}

function TagList({ tags, onTag }: { tags: ShownTag[]; onTag?: (tag: string) => void }) {
  return (
    <ul className="tag-list">
      {tags.map(({ tag, ai }) => (
        <li key={tag}>
          {!onTag ? (
            <span className={ai ? 'ai' : undefined}>{tag}</span>
          ) : (
          <button
            type="button"
            className={ai ? 'ai' : undefined}
            title={`Visa alla bilder med taggen ${tag}${ai ? '. Satt av AI.' : ''}`}
            onClick={() => onTag(tag)}
          >
            {tag}
          </button>
          )}
        </li>
      ))}
    </ul>
  )
}

// Modal dialog: Esc stänger, och fokus stannar i dialogen så länge den är öppen.
// Vänster- och högerpil bläddrar. Dialogen ligger kvar öppen medan man bläddrar,
// och förhandsbildens object-URL frigörs när bilden byts eller dialogen stängs.
export function DetailView({ image, tags, position, count, previews, onNavigate, onTag, onPlace, vocabulary, onSave, bank, onTagsSaved, onClose }: Props) {
  // Bilden som redigeras, eller null. Byts bilden avslutas redigeringen.
  const [editing, setEditing] = useState<string | null>(null)
  const isEditing = editing === image.id
  // Taggen som panelen sätter på liknande bilder, eller null.
  const [similar, setSimilar] = useState<string | null>(null)
  const dialog = useRef<HTMLDialogElement>(null)
  const preview = useObjectUrl(previews, `${image.id}.webp`)
  const hasPrevious = position > 0
  const hasNext = position < count - 1

  useEffect(() => {
    if (!dialog.current!.open) dialog.current!.showModal()
  }, [])

  // Mushjulet över fotot bläddrar en bild per tag. En pekplatta skickar många
  // små händelser, så efter ett byte väntar vi en kort stund.
  const lastWheel = useRef(0)
  function onWheel(event: WheelEvent) {
    if (isEditing || Math.abs(event.deltaY) < 1 || event.timeStamp - lastWheel.current < 250) return
    lastWheel.current = event.timeStamp
    if (event.deltaY > 0 && hasNext) onNavigate(position + 1)
    else if (event.deltaY < 0 && hasPrevious) onNavigate(position - 1)
  }

  // Piltangenterna lyssnas på för hela sidan, så att de fungerar även när fokus
  // har hamnat utanför dialogen, t.ex. på body.
  function onKeyDown(event: globalThis.KeyboardEvent) {
    if (event.altKey || event.ctrlKey || event.metaKey || isEditing) return
    if (event.key === 'ArrowLeft' && hasPrevious) onNavigate(position - 1)
    else if (event.key === 'ArrowRight' && hasNext) onNavigate(position + 1)
    else return
    event.preventDefault()
  }
  const keyHandler = useRef(onKeyDown)
  keyHandler.current = onKeyDown
  useEffect(() => {
    const listener = (event: globalThis.KeyboardEvent) => keyHandler.current(event)
    document.addEventListener('keydown', listener)
    return () => document.removeEventListener('keydown', listener)
  }, [])

  return (
    <dialog
      ref={dialog}
      className={image.blocked ? 'detail is-blocked' : 'detail'}
      aria-labelledby="detail-title"
      onClose={onClose}
      onCancel={(event) => {
        // Esc stänger panelen, och annars redigeringen, i stället för att stänga bilden.
        if (similar) {
          event.preventDefault()
          setSimilar(null)
        } else if (isEditing) {
          event.preventDefault()
          setEditing(null)
        }
      }}
      onClick={(event) => event.target === dialog.current && dialog.current.close()}
    >
      <div
        className={isEditing ? 'detail-preview' : 'detail-preview closes'}
        title={isEditing ? undefined : 'Klicka för att stänga. Bläddra med mushjulet.'}
        // Ett klick på fotot stänger bilden, utom när man redigerar.
        onClick={() => !isEditing && dialog.current!.close()}
        onWheel={onWheel}
      >
        {image.previewProblem ? (
          <div className="preview-problem">
            <span className="problem-icon" aria-hidden="true">
              !
            </span>
            <p>{isVideo(image.path) ? 'Stillbild saknas' : 'Förhandsbild saknas'}</p>
          </div>
        ) : (
          <>
            {preview.status === 'ready' && <img src={preview.url} alt={image.description || `Bild ${image.id}`} />}
            {preview.status === 'missing' && <p>Förhandsbild saknas</p>}
          </>
        )}
      </div>
      <div className={isEditing ? 'detail-info editing' : 'detail-info'}>
        <div className="detail-header">
          <h2 id="detail-title">{image.id}</h2>
          <div className="detail-actions">
            <button type="button" onClick={() => dialog.current!.close()}>
              Stäng
            </button>
            <button
              type="button"
              className={isEditing ? 'edit-toggle editing' : 'edit-toggle'}
              aria-pressed={isEditing}
              title={isEditing ? 'Spara eller avbryt för att sluta redigera' : undefined}
              onClick={() => setEditing(image.id)}
            >
              Redigera
            </button>
          </div>
        </div>
        <div className="detail-nav">
          <button
            type="button"
            aria-label="Föregående bild"
            title="Föregående bild (vänsterpil)"
            disabled={!hasPrevious || isEditing}
            onClick={() => onNavigate(position - 1)}
          >
            ‹
          </button>
          <span className="detail-position">
            {(position + 1).toLocaleString('sv-SE')} av {count.toLocaleString('sv-SE')}
          </span>
          <button
            type="button"
            aria-label="Nästa bild"
            title="Nästa bild (högerpil)"
            disabled={!hasNext || isEditing}
            onClick={() => onNavigate(position + 1)}
          >
            ›
          </button>
        </div>

        {image.previewProblem && (
          <p className="problem" role="alert">
            <span className="problem-icon" aria-hidden="true">
              !
            </span>
            <span>{image.previewProblem}</span>
          </p>
        )}
        {image.blocked && (
          <p className="blocked-banner" role="alert">
            <strong>Spärrad.</strong> Bilden får inte användas.
          </p>
        )}
        {isVideo(image.path) && (
          <p className="note">
            Videon kan inte spelas upp i bildbanken.{!image.previewProblem && ' Bilden är en stillbild ur filmen.'}
          </p>
        )}
        {image.consent === 'missing' && (
          <p className="warning" role="alert">
            Samtycke saknas från personerna på bilden. Kontrollera innan bilden används.
          </p>
        )}

        {isEditing ? (
          <EditForm
            image={image}
            tags={tags}
            vocabulary={vocabulary}
            onSave={onSave}
            onDone={() => setEditing(null)}
            onSimilar={onTagsSaved && setSimilar}
          />
        ) : (
          <dl className="detail-fields">
            <dt>Original</dt>
            <dd>
              <span className="file-format">{fileFormat(image.path)}</span> {fileName(image.path)}
            </dd>
            <dt>Upplösning</dt>
            <dd>{formatResolution(image)}</dd>
            {image.durationSeconds !== null && (
              <>
                <dt>Längd</dt>
                <dd>{formatDuration(image.durationSeconds)}</dd>
              </>
            )}
            {image.alternates.length > 0 && (
              <>
                <dt>Även som</dt>
                {image.alternates.map((alternate) => (
                  <dd key={alternate}>
                    <span className="file-format">{fileFormat(alternate)}</span> {fileName(alternate)}
                  </dd>
                ))}
              </>
            )}
            <dt>Fotograf</dt>
            <dd>{image.photographer}</dd>
            <dt>Byline</dt>
            <dd>{image.byline}</dd>
            <dt>Villkor</dt>
            <dd>{image.terms || 'Inga villkor angivna'}</dd>
            <dt>Fotodatum</dt>
            <dd>{image.takenAt ? formatTaken(image.takenAt) : 'Okänt, filen saknar datum'}</dd>
            <dt>Samtycke</dt>
            <dd>{CONSENT_TEXT[image.consent]}</dd>
            <dt>Plats</dt>
            <dd className="detail-place">
              {image.place ? (
                <ul className="tag-list">
                  {placeParts(image.place).map((name) => (
                    <li key={name}>
                      {onPlace ? (
                        <button type="button" title={`Visa alla bilder från ${name}`} onClick={() => onPlace(name)}>
                          {name}
                        </button>
                      ) : (
                        <span>{name}</span>
                      )}
                    </li>
                  ))}
                </ul>
              ) : image.gps ? (
                'Utanför Malmö'
              ) : (
                'Okänd, bilden saknar GPS-position'
              )}
            </dd>
            <dt>Taggar</dt>
            <dd className="detail-tags">
              {tags.length ? (
                <>
                  <TagList tags={tags} onTag={onTag} />
                  <span className="tags-note">
                    {onTag && 'Klicka på en tagg för att se alla bilder med den.'}
                    {tags.some((tag) => tag.ai) && ' Streckade taggar har satts automatiskt och kan vara fel.'}
                  </span>
                </>
              ) : (
                'Inga taggar'
              )}
            </dd>
          </dl>
        )}
      </div>
      {similar && isEditing && onTagsSaved && (
        <SimilarPanel bank={bank} image={image} tag={similar} onSaved={onTagsSaved} onClose={() => setSimilar(null)} />
      )}
    </dialog>
  )
}
