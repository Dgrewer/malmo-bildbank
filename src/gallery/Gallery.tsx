import { useLayoutEffect, useRef, useState } from 'react'
import { formatDuration, isVideo } from '../catalog/fileFormat.ts'
import type { ImageRecord } from '../catalog/types.ts'
import { DownloadIcon, DRAG_TYPE, ShareIcon } from '../download/Basket.tsx'
import { useObjectUrl } from '../fs/useObjectUrl.ts'

const MIN_CELL = 180
const GAP = 8
// Antal rader utanför vyn som renderas i förväg, så att snabb scrollning inte visar tomma rutor.
const OVERSCAN_ROWS = 2

interface Props {
  images: ImageRecord[]
  thumbs: FileSystemDirectoryHandle
  onOpen: (index: number) => void
  onDownload: (image: ImageRecord) => void
  onShare: (image: ImageRecord) => void
}

// Virtuellt rutnät: bara raderna som syns (plus OVERSCAN_ROWS) finns i DOM:en,
// oavsett hur många bilder indexet innehåller.
export function Gallery({ images, thumbs, onOpen, onDownload, onShare }: Props) {
  const scroller = useRef<HTMLDivElement>(null)
  const [size, setSize] = useState({ width: 0, height: 0 })
  const [scrollTop, setScrollTop] = useState(0)

  useLayoutEffect(() => {
    const element = scroller.current!
    const observer = new ResizeObserver(() =>
      setSize({ width: element.clientWidth, height: element.clientHeight }),
    )
    observer.observe(element)
    return () => observer.disconnect()
  }, [])

  const innerWidth = Math.max(0, size.width - 2 * GAP)
  const columns = Math.max(1, Math.floor((innerWidth + GAP) / (MIN_CELL + GAP)))
  const cell = (innerWidth - GAP * (columns - 1)) / columns
  const rowHeight = cell + GAP
  const rows = Math.ceil(images.length / columns)

  const firstRow = Math.max(0, Math.floor(scrollTop / rowHeight) - OVERSCAN_ROWS)
  const lastRow = Math.min(rows - 1, Math.ceil((scrollTop + size.height) / rowHeight) + OVERSCAN_ROWS)
  const visible: number[] = []
  if (size.width > 0) {
    for (let index = firstRow * columns; index < Math.min(images.length, (lastRow + 1) * columns); index++) {
      visible.push(index)
    }
  }

  return (
    <div className="gallery" ref={scroller} onScroll={(event) => setScrollTop(event.currentTarget.scrollTop)}>
      <div className="gallery-inner" style={{ height: rows * rowHeight + GAP }}>
        {visible.map((index) => (
          <Thumbnail
            key={index}
            index={index}
            image={images[index]}
            thumbs={thumbs}
            left={GAP + (index % columns) * (cell + GAP)}
            top={GAP + Math.floor(index / columns) * rowHeight}
            size={cell}
            onOpen={onOpen}
            onDownload={onDownload}
            onShare={onShare}
          />
        ))}
      </div>
    </div>
  )
}

interface ThumbnailProps {
  index: number
  image: ImageRecord
  thumbs: FileSystemDirectoryHandle
  left: number
  top: number
  size: number
  onOpen: (index: number) => void
  onDownload: (image: ImageRecord) => void
  onShare: (image: ImageRecord) => void
}

function Thumbnail({ index, image, thumbs, left, top, size, onOpen, onDownload, onShare }: ThumbnailProps) {
  const thumb = useObjectUrl(thumbs, `${image.id}.webp`)
  return (
    <div className="gallery-slot" style={{ transform: `translate(${left}px, ${top}px)`, width: size, height: size }}>
    <button
      type="button"
      className={image.blocked ? 'gallery-cell is-blocked' : 'gallery-cell'}
      data-index={index}
      draggable
      onDragStart={(event) => {
        event.dataTransfer.setData(DRAG_TYPE, image.id)
        event.dataTransfer.effectAllowed = 'copy'
      }}
      onClick={() => onOpen(index)}
      aria-label={
        `${image.id}, ${isVideo(image.path) ? 'video' : 'foto'} ${image.photographer}` +
        `${image.blocked ? ', spärrad' : ''}${image.previewProblem ? ', förhandsbild saknas' : ''}`
      }
      title={image.previewProblem ?? undefined}
    >
      {image.previewProblem ? (
        <span className="thumb-problem">
          <span className="problem-icon" aria-hidden="true">
            !
          </span>
          {isVideo(image.path) ? 'Stillbild saknas' : 'Förhandsbild saknas'}
        </span>
      ) : (
        <>
          {thumb.status === 'ready' && <img src={thumb.url} alt="" draggable={false} />}
          {thumb.status === 'missing' && <span className="thumb-missing">Miniatyr saknas</span>}
        </>
      )}
      {image.blocked && <span className="badge-blocked">Spärrad</span>}
      {isVideo(image.path) && (
        <span className="badge-video">
          Video{image.durationSeconds !== null && ` · ${formatDuration(image.durationSeconds)}`}
        </span>
      )}
    </button>
      {/* Spärrade bilder får inte användas, så de går varken att dela eller ladda ner. */}
      {!image.blocked && (
        <>
          <button type="button" className="cell-action share" title="Kopiera en länk till bilden" aria-label={`Dela ${image.id}`} onClick={() => onShare(image)}>
            <ShareIcon />
          </button>
          <button type="button" className="cell-action download" title="Ladda ner originalet" aria-label={`Ladda ner ${image.id}`} onClick={() => onDownload(image)}>
            <DownloadIcon />
          </button>
        </>
      )}
    </div>
  )
}
