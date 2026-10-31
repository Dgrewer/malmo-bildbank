import { useEffect, useState } from 'react'
import { readIndexFile } from '../catalog/loadIndex.ts'
import { sameContent, type FileHash } from '../catalog/sameImage.ts'
import type { ImageRecord } from '../catalog/types.ts'
import { ensureDirectory, readFile } from '../fs/folder.ts'
import { useObjectUrl } from '../fs/useObjectUrl.ts'
import { quickHash } from '../import/hash.ts'
import { moveDuplicate } from './moveDuplicate.ts'
import { useOpenImage } from './openImage.ts'

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
  // Filer som har flyttats bort, efter sökväg: dit de flyttades, eller felet.
  const [moves, setMoves] = useState<Map<string, { to: string } | { error: string }>>(new Map())

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

  async function move(file: FileHash, kept: FileHash) {
    let result: { to: string } | { error: string }
    try {
      if (!originals) throw new Error('Välj först mappen som bilderna läses från, under Importera bilder.')
      if ((await originals.requestPermission({ mode: 'readwrite' })) !== 'granted') {
        throw new Error('Appen fick inte ändra i originalmappen. Försök igen och välj Tillåt.')
      }
      result = { to: await moveDuplicate(bank, originals, file, kept) }
    } catch (error) {
      result = { error: error instanceof Error ? error.message : String(error) }
    }
    setMoves((all) => new Map(all).set(file.path, result))
  }

  return (
    <section className="same-images">
      <p className="tag-explain">
        Här visas filer som är exakt samma bild men har olika namn, t.ex. JPG:en i ett RAW-par som också finns som en
        egen bild. Klicka på en miniatyr för att se bilden. <strong>Flytta bort</strong> flyttar filen till
        app-data/dubbletter/, så att det går att ångra. Behåll helst bilden med lägst id, eftersom taggarna hör till
        id:t. En bild som har beskurits eller ändrats räknas inte som samma bild.
      </p>
      {state.unread > 0 && (
        <p className="warning" role="alert">
          {count(state.unread)} RAW-par gick inte att läsa och är inte med. Kontrollera mappen under Importera bilder,
          Bilderna läses från.
        </p>
      )}
      <p role="status">
        {state.groups.length
          ? `${count(state.groups.length)} ${state.groups.length === 1 ? 'grupp' : 'grupper'} med samma bild under olika namn.`
          : 'Inga filer med samma innehåll och olika namn.'}
      </p>
      {[...moves.values()].some((result) => 'to' in result) && (
        <p className="note" role="status">
          Flyttade bilder försvinner ur bildbanken nästa gång du importerar.
        </p>
      )}
      {state.groups.map((group) => (
        <ul key={group[0].hash} className="same-group">
          {group.map((file) => (
            <SameFile
              key={file.path}
              file={file}
              image={state.byId.get(file.id)!}
              thumbs={state.thumbs}
              moved={moves.get(file.path)}
              onMove={() => move(file, group.find((other) => other.id !== file.id)!)}
            />
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

// Ett klick på Flytta bort markerar filen, ett klick till flyttar den.
function SameFile({
  file,
  image,
  thumbs,
  moved,
  onMove,
}: {
  file: FileHash
  image: ImageRecord
  thumbs: FileSystemDirectoryHandle
  moved: { to: string } | { error: string } | undefined
  onMove: () => Promise<void>
}) {
  const thumb = useObjectUrl(thumbs, `${image.id}.webp`)
  const opens = useOpenImage(image.id)
  const [armed, setArmed] = useState(false)
  const [busy, setBusy] = useState(false)
  const [, , ...rest] = file.path.split('/')
  const photographer = file.path.split('/')[1]
  return (
    <li data-id={image.id} data-path={file.path}>
      <span className="same-thumb" {...opens}>{thumb.status === 'ready' && <img src={thumb.url} alt="" loading="lazy" />}</span>
      <span>
        <strong>{image.id}</strong> {rest.join('/')}
        <small>
          {photographer}
          {file.path !== image.path && `, JPG till ${image.path.split('/').pop()}`}
          {image.alternates.length > 0 && file.path === image.path && ', RAW-fil'}
        </small>
        {moved && 'to' in moved && <small className="same-moved">Flyttad till {moved.to}</small>}
        {moved && 'error' in moved && (
          <small className="error" role="alert">
            {moved.error}
          </small>
        )}
      </span>
      {!(moved && 'to' in moved) && (
        <button
          type="button"
          className={armed ? 'same-move armed' : 'same-move'}
          disabled={busy}
          onClick={async () => {
            if (!armed) return setArmed(true)
            setBusy(true)
            await onMove()
            setBusy(false)
            setArmed(false)
          }}
          onBlur={() => !busy && setArmed(false)}
        >
          {busy ? 'Flyttar…' : armed ? 'Klicka igen för att flytta' : 'Flytta bort'}
        </button>
      )}
    </li>
  )
}
