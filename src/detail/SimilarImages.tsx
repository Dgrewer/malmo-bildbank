import type { ImageRecord } from '../catalog/types.ts'
import { useObjectUrl } from '../fs/useObjectUrl.ts'

// Så många liknande bilder visas i detaljvyn. Resten visas i galleriet.
const SHOWN = 8

interface Props {
  images: ImageRecord[]
  thumbs: FileSystemDirectoryHandle
  // Visar de liknande bilderna i galleriet och öppnar bilden image.
  onOpen: (image: ImageRecord | null) => void
}

export function SimilarImages({ images, thumbs, onOpen }: Props) {
  if (!images.length) return <p className="note">Inga liknande bilder.</p>
  return (
    <>
      <ul className="similar-images">
        {images.slice(0, SHOWN).map((image) => (
          <li key={image.id}>
            <SimilarThumb image={image} thumbs={thumbs} onOpen={onOpen} />
          </li>
        ))}
      </ul>
      <button type="button" className="link" onClick={() => onOpen(null)}>
        Visa {images.length === 1 ? 'den' : `alla ${images.length.toLocaleString('sv-SE')}`} i galleriet
      </button>
    </>
  )
}

function SimilarThumb({ image, thumbs, onOpen }: { image: ImageRecord; thumbs: FileSystemDirectoryHandle; onOpen: Props['onOpen'] }) {
  const thumb = useObjectUrl(thumbs, `${image.id}.webp`)
  return (
    <button
      type="button"
      className={image.blocked ? 'similar-thumb is-blocked' : 'similar-thumb'}
      title={`${image.id}${image.blocked ? ', spärrad' : ''}`}
      aria-label={`Öppna ${image.id}`}
      onClick={() => onOpen(image)}
    >
      {thumb.status === 'ready' && <img src={thumb.url} alt="" draggable={false} />}
    </button>
  )
}
