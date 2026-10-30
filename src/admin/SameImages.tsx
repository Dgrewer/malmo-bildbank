import { useEffect, useState } from 'react'
import { readIndexFile } from '../catalog/loadIndex.ts'
import { sameContent, type FileHash } from '../catalog/sameImage.ts'
import type { ImageRecord } from '../catalog/types.ts'
import { ensureDirectory, readFile } from '../fs/folder.ts'
import { useObjectUrl } from '../fs/useObjectUrl.ts'
import { quickHash } from '../import/hash.ts'

interface Props {
  bank: FileSystemDirectoryHandle
  // Mappen med fotografernas mappar, eller null om den inte går att läsa nu.
  originals: FileSystemDirectoryHandle | null
}

type State =
  | { kind: 'loading'; done: number; total: number }
  | { kind: 'error'; message: string }
  | {
      kind: 'ready'
      groups: FileHash[][]
      byId: Map<string, ImageRecord>
      thumbs: FileSystemDirectoryHandle
      // RAW-par vars filer inte gick att läsa.
      unread: number
    }

const count = (n: number) => n.toLocaleString('sv-SE')

// Fingeravtrycken per fil. Indexets hash gäller hela bilden, och för ett RAW-par
// är det båda filerna tillsammans. Därför räknas parens filer ut här, var för sig.
async function fileHashes(
  images: ImageRecord[],
  originals: FileSystemDirectoryHandle | null,
  onProgress: (done: number, total: number) => void,
): Promise<{ files: FileHash[]; unread: number }> {
  const files: FileHash[] = []
  const pairs = images.filter((image) => image.alternates.length)
  let unread = 0
  for (const image of images) {
    if (!image.alternates.length && image.hash) files.push({ id: image.id, path: image.path, hash: image.hash })
  }
  for (const [n, image] of pairs.entries()) {
    onProgress(n, pairs.length)
    try {
      for (const path of [image.path, ...image.alternates]) {
        const file = originals && (await readFile(originals, path.replace(/^original\//, '')))
        if (!file) throw new Error(path)
        files.push({ id: image.id, path, hash: await quickHash(file) })
      }
    } catch {
      unread++
    }
  }
  return { files, unread }
}

// Adminfliken Samma bild: filer med exakt samma innehåll men olika namn.
export function SameImages({ bank, originals }: Props) {
  const [state, setState] = useState<State>({ kind: 'loading', done: 0, total: 0 })
  const [round, setRound] = useState(0)

  useEffect(() => {
    let cancelled = false
    setState({ kind: 'loading', done: 0, total: 0 })
    ;(async () => {
      const index = await readIndexFile(bank)
      if (!index) throw new Error('Bildbanken har inget index än. Importera bilderna först.')
      const { files, unread } = await fileHashes(index.images, originals, (done, total) => {
        if (!cancelled) setState({ kind: 'loading', done, total })
      })
      return {
        kind: 'ready' as const,
        groups: sameContent(files),
        byId: new Map(index.images.map((image) => [image.id, image])),
        thumbs: await ensureDirectory(bank, 'app-data/thumbs'),
        unread,
      }
    })().then(
      (ready) => !cancelled && setState(ready),
      (error) => !cancelled && setState({ kind: 'error', message: error instanceof Error ? error.message : String(error) }),
    )
    return () => {
      cancelled = true
    }
  }, [bank, originals, round])

  if (state.kind === 'loading') {
    return (
      <p className="status" aria-live="polite">
        Jämför filerna{state.total ? ` – RAW-par ${count(state.done)} av ${count(state.total)}` : '…'}
      </p>
    )
  }
  if (state.kind === 'error') {
    return (
      <p className="warning" role="alert">
        {state.message}
      </p>
    )
  }

  return (
    <section className="same-images">
      <p className="tag-explain">
        Filerna i varje grupp har exakt samma innehåll men olika namn och finns som olika bilder i bildbanken. Vanliga
        kopior importeras redan bara en gång, och resten visas under Importera bilder, Sök efter ändringar. Här syns de
        som importen inte ser: en RAW-fil eller JPG:en bredvid den som är samma fil som en annan bild. Ingenting flyttas
        automatiskt. Behåll en fil och ta bort eller flytta de andra i mappen för hand. Taggar och rättigheter hör till
        id:t, så behåll helst den med lägst id. Bara exakta kopior hittas: en bild som har beskurits, förminskats eller
        redigerats räknas inte.
      </p>
      {state.unread > 0 && (
        <p className="warning" role="alert">
          {count(state.unread)} RAW-par gick inte att läsa och är inte med. Välj mappen som bilderna läses från under
          Importera bilder.
        </p>
      )}
      <p role="status">
        {state.groups.length
          ? `${count(state.groups.length)} ${state.groups.length === 1 ? 'grupp' : 'grupper'} med samma bild under olika namn.`
          : 'Inga filer med samma innehåll och olika namn.'}
      </p>
      {state.groups.map((group) => (
        <ul key={group[0].hash} className="same-group">
          {group.map((file) => (
            <SameFile key={file.path} file={file} image={state.byId.get(file.id)!} thumbs={state.thumbs} />
          ))}
        </ul>
      ))}
      <div className="actions">
        <button type="button" onClick={() => setRound((n) => n + 1)}>
          Jämför igen
        </button>
      </div>
    </section>
  )
}

function SameFile({ file, image, thumbs }: { file: FileHash; image: ImageRecord; thumbs: FileSystemDirectoryHandle }) {
  const thumb = useObjectUrl(thumbs, `${image.id}.webp`)
  const [, , ...rest] = file.path.split('/')
  const photographer = file.path.split('/')[1]
  return (
    <li data-id={image.id}>
      <span className="same-thumb">{thumb.status === 'ready' && <img src={thumb.url} alt="" loading="lazy" />}</span>
      <span>
        <strong>{image.id}</strong> {rest.join('/')}
        <small>
          {photographer}
          {file.path !== image.path && `, JPG till ${image.path.split('/').pop()}`}
          {image.alternates.length > 0 && file.path === image.path && ', RAW-fil'}
        </small>
      </span>
    </li>
  )
}
