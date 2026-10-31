import { useState, type DragEvent } from 'react'
import type { ImageRecord } from '../catalog/types.ts'
import { useObjectUrl } from '../fs/useObjectUrl.ts'

// Typen i dataTransfer när en bild dras från galleriet.
export const DRAG_TYPE = 'application/x-bildbank-id'

// Miniatyren i korgen förstoras till ungefär rutnätets storlek när musen är över den.
const ENLARGED = 180

interface Props {
  images: ImageRecord[]
  thumbs: FileSystemDirectoryHandle
  // Text efter senaste nedladdningen eller delningen.
  message: string | null
  busy: boolean
  onAdd: (id: string) => void
  onRemove: (id: string) => void
  onOpen: (id: string) => void
  onDownload: () => void
  onShare: () => void
  onClear: () => void
}

// Korgen längst ner på sidan. Man drar bilder hit från galleriet. Korgen
// sparas bara på den här datorn.
export function Basket({ images, thumbs, message, busy, onAdd, onRemove, onOpen, onDownload, onShare, onClear }: Props) {
  const [over, setOver] = useState(false)
  const accepts = (event: DragEvent) => event.dataTransfer.types.includes(DRAG_TYPE)
  return (
    <section
      className={over ? 'basket drop-target' : 'basket'}
      aria-label="Korg"
      onDragOver={(event) => {
        if (!accepts(event)) return
        event.preventDefault()
        event.dataTransfer.dropEffect = 'copy'
        setOver(true)
      }}
      onDragLeave={() => setOver(false)}
      onDrop={(event) => {
        setOver(false)
        const id = event.dataTransfer.getData(DRAG_TYPE)
        if (id) {
          event.preventDefault()
          onAdd(id)
        }
      }}
    >
      <div className="basket-title">
        <strong>Korg</strong>
        <span>{images.length === 1 ? '1 bild' : `${images.length.toLocaleString('sv-SE')} bilder`}</span>
      </div>
      {images.length ? (
        <ul className="basket-items">
          {images.map((image) => (
            <BasketItem key={image.id} image={image} thumbs={thumbs} onRemove={onRemove} onOpen={onOpen} />
          ))}
        </ul>
      ) : (
        <p className="basket-empty">Dra bilder hit för att samla dem och ladda ner alla på en gång.</p>
      )}
      {message && (
        <p className="basket-message" role="status">
          {message}
        </p>
      )}
      <div className="basket-actions">
        <button type="button" className="icon-button" title="Ladda ner alla bilderna i korgen" aria-label="Ladda ner alla" disabled={busy || !images.length} onClick={onDownload}>
          <DownloadIcon />
        </button>
        <button type="button" className="icon-button" title="Kopiera en länk till bilderna i korgen" aria-label="Dela korgen" disabled={busy || !images.length} onClick={onShare}>
          <ShareIcon />
        </button>
        <button type="button" className="basket-clear" disabled={busy || !images.length} onClick={onClear}>
          Töm
        </button>
      </div>
    </section>
  )
}

function BasketItem({ image, thumbs, onRemove, onOpen }: { image: ImageRecord; thumbs: FileSystemDirectoryHandle; onRemove: (id: string) => void; onOpen: (id: string) => void }) {
  const thumb = useObjectUrl(thumbs, `${image.id}.webp`)
  // Var den förstorade miniatyren visas, eller null.
  const [enlarged, setEnlarged] = useState<{ left: number; top: number } | null>(null)
  return (
    <li
      className={image.blocked ? 'basket-item is-blocked' : 'basket-item'}
      onMouseEnter={(event) => {
        const rect = event.currentTarget.getBoundingClientRect()
        const left = Math.min(Math.max(8, rect.left + rect.width / 2 - ENLARGED / 2), window.innerWidth - ENLARGED - 8)
        setEnlarged({ left, top: rect.top - ENLARGED - 8 })
      }}
      onMouseLeave={() => setEnlarged(null)}
    >
      {enlarged && thumb.status === 'ready' && (
        <img className="basket-preview" src={thumb.url} alt="" style={{ ...enlarged, width: ENLARGED, height: ENLARGED }} />
      )}
      <button type="button" className="basket-thumb" aria-label={`Öppna ${image.id}`} title={image.blocked ? `${image.id}, spärrad` : image.id} onClick={() => onOpen(image.id)}>
        {thumb.status === 'ready' && <img src={thumb.url} alt="" draggable={false} />}
      </button>
      <button type="button" className="basket-remove" aria-label={`Ta bort ${image.id} ur korgen`} title="Ta bort ur korgen" onClick={() => onRemove(image.id)}>
        ×
      </button>
    </li>
  )
}

export function DownloadIcon() {
  return (
    <svg viewBox="0 0 24 24" width="20" height="20" aria-hidden="true" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M12 4v11M7 10l5 5 5-5M5 20h14" />
    </svg>
  )
}

export function ShareIcon() {
  return (
    <svg viewBox="0 0 24 24" width="20" height="20" aria-hidden="true" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <circle cx="18" cy="5" r="2.5" />
      <circle cx="6" cy="12" r="2.5" />
      <circle cx="18" cy="19" r="2.5" />
      <path d="M8.2 10.8l7.6-4.4M8.2 13.2l7.6 4.4" />
    </svg>
  )
}
