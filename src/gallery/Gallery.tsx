import { useLayoutEffect, useRef, useState } from 'react'
import type { ImageRecord } from '../catalog/types.ts'
import { useObjectUrl } from '../fs/useObjectUrl.ts'

const MIN_CELL = 180
const GAP = 8
// Antal rader utanför vyn som renderas i förväg, så att snabb scrollning inte visar tomma rutor.
const OVERSCAN_ROWS = 2

interface Props {
  images: ImageRecord[]
  thumbs: FileSystemDirectoryHandle
  onOpen: (index: number) => void
}

// Virtuellt rutnät: bara raderna som syns (plus OVERSCAN_ROWS) finns i DOM:en,
// oavsett hur många bilder indexet innehåller.
export function Gallery({ images, thumbs, onOpen }: Props) {
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
}

function Thumbnail({ index, image, thumbs, left, top, size, onOpen }: ThumbnailProps) {
  const thumb = useObjectUrl(thumbs, `${image.id}.webp`)
  return (
    <button
      type="button"
      className="gallery-cell"
      data-index={index}
      style={{ transform: `translate(${left}px, ${top}px)`, width: size, height: size }}
      onClick={() => onOpen(index)}
      aria-label={`${image.id}, foto ${image.photographer}`}
    >
      {thumb.status === 'ready' && <img src={thumb.url} alt="" draggable={false} />}
      {thumb.status === 'missing' && <span className="thumb-missing">Miniatyr saknas</span>}
    </button>
  )
}
