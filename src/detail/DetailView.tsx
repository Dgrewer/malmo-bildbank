import { useEffect, useRef } from 'react'
import { fileFormat, fileName, formatDuration, isVideo } from '../catalog/fileFormat.ts'
import { CONSENT_TEXT, formatDate, rightsExpired } from '../catalog/rights.ts'
import type { ImageRecord } from '../catalog/types.ts'
import { useObjectUrl } from '../fs/useObjectUrl.ts'

interface Props {
  image: ImageRecord
  previews: FileSystemDirectoryHandle
  onClose: () => void
}

// Modal dialog: Esc stänger, och fokus stannar i dialogen så länge den är öppen.
// Förhandsbildens object-URL frigörs när dialogen stängs.
export function DetailView({ image, previews, onClose }: Props) {
  const dialog = useRef<HTMLDialogElement>(null)
  const preview = useObjectUrl(previews, `${image.id}.webp`)
  const expired = rightsExpired(image)

  useEffect(() => {
    if (!dialog.current!.open) dialog.current!.showModal()
  }, [])

  return (
    <dialog
      ref={dialog}
      className={image.blocked ? 'detail is-blocked' : 'detail'}
      aria-labelledby="detail-title"
      onClose={onClose}
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
        </dl>
      </div>
    </dialog>
  )
}
