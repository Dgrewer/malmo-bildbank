import { useEffect, useRef, type KeyboardEvent } from 'react'
import { fileFormat, fileName, formatDuration, isVideo } from '../catalog/fileFormat.ts'
import { CONSENT_TEXT, formatDate, rightsExpired } from '../catalog/rights.ts'
import type { ImageRecord } from '../catalog/types.ts'
import { useObjectUrl } from '../fs/useObjectUrl.ts'

interface Props {
  image: ImageRecord
  // Bildens plats i galleriet, från 0, och antalet bilder.
  position: number
  count: number
  previews: FileSystemDirectoryHandle
  onNavigate: (position: number) => void
  onClose: () => void
}

function TagList({ tags }: { tags: string[] }) {
  return (
    <ul className="tag-list">
      {tags.map((tag) => (
        <li key={tag}>{tag}</li>
      ))}
    </ul>
  )
}

// Modal dialog: Esc stänger, och fokus stannar i dialogen så länge den är öppen.
// Vänster- och högerpil bläddrar. Dialogen ligger kvar öppen medan man bläddrar,
// och förhandsbildens object-URL frigörs när bilden byts eller dialogen stängs.
export function DetailView({ image, position, count, previews, onNavigate, onClose }: Props) {
  const dialog = useRef<HTMLDialogElement>(null)
  const preview = useObjectUrl(previews, `${image.id}.webp`)
  const expired = rightsExpired(image)
  const hasPrevious = position > 0
  const hasNext = position < count - 1

  useEffect(() => {
    if (!dialog.current!.open) dialog.current!.showModal()
  }, [])

  function onKeyDown(event: KeyboardEvent) {
    if (event.altKey || event.ctrlKey || event.metaKey) return
    if (event.key === 'ArrowLeft' && hasPrevious) onNavigate(position - 1)
    else if (event.key === 'ArrowRight' && hasNext) onNavigate(position + 1)
    else return
    event.preventDefault()
  }

  return (
    <dialog
      ref={dialog}
      className={image.blocked ? 'detail is-blocked' : 'detail'}
      aria-labelledby="detail-title"
      onClose={onClose}
      onKeyDown={onKeyDown}
      onClick={(event) => event.target === dialog.current && dialog.current.close()}
    >
      <div className="detail-preview">
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
      <div className="detail-info">
        <div className="detail-header">
          <h2 id="detail-title">{image.id}</h2>
          <button type="button" onClick={() => dialog.current!.close()}>
            Stäng
          </button>
        </div>
        <div className="detail-nav">
          <button
            type="button"
            aria-label="Föregående bild"
            title="Föregående bild (vänsterpil)"
            disabled={!hasPrevious}
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
            disabled={!hasNext}
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
        {expired && (
          <p className="warning" role="alert">
            Rättigheterna gick ut {formatDate(image.rightsUntil!)}. Bilden får inte användas.
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

        <dl className="detail-fields">
          <dt>Original</dt>
          <dd>
            <span className="file-format">{fileFormat(image.path)}</span> {fileName(image.path)}
          </dd>
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
          <dt>Rättigheter till och med</dt>
          <dd className={expired ? 'expired' : undefined}>
            {image.rightsUntil ? formatDate(image.rightsUntil) : 'Inget slutdatum'}
          </dd>
          <dt>Samtycke</dt>
          <dd>{CONSENT_TEXT[image.consent]}</dd>
          <dt>Nyckelord</dt>
          <dd>{image.tags.length ? <TagList tags={image.tags} /> : 'Inga nyckelord'}</dd>
          {image.aiTags.length > 0 && (
            <>
              <dt>AI-taggar</dt>
              <dd className="ai-tags">
                <TagList tags={image.aiTags} />
                <span className="ai-tags-note">Satta av AI. De kan vara fel.</span>
              </dd>
            </>
          )}
        </dl>
      </div>
    </dialog>
  )
}
