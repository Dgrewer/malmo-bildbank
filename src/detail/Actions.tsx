import { useEffect, useState } from 'react'
import { fileFormat } from '../catalog/fileFormat.ts'
import type { ImageRecord } from '../catalog/types.ts'
import { downloadFolder, downloadImages, resultText } from '../download/download.ts'
import { localFilePath } from '../download/localPath.ts'
import { copyShareLink } from '../download/share.ts'
import { loadLocalPath } from '../fs/folderStore.ts'

interface Props {
  bank: FileSystemDirectoryHandle
  image: ImageRecord
  inBasket: boolean
  onBasket?: (id: string) => void
}

// Knapparna i detaljvyn: Ladda ner, Lägg i korgen, Dela och Kopiera sökväg.
// En spärrad bild går inte att ladda ner eller dela.
export function Actions({ bank, image, inBasket, onBasket }: Props) {
  const [message, setMessage] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [localPath, setLocalPath] = useState('')
  useEffect(() => {
    loadLocalPath().then(setLocalPath, () => setLocalPath(''))
  }, [])
  useEffect(() => setMessage(null), [image.id])

  async function download(only?: string, choose = false) {
    setBusy(true)
    setMessage(null)
    try {
      const folder = await downloadFolder(choose)
      if (!folder) return
      setMessage(resultText(await downloadImages(bank, folder, [image], only), folder.name))
    } catch (problem) {
      setMessage(`Det gick inte att ladda ner: ${problem instanceof Error ? problem.message : problem}`)
    } finally {
      setBusy(false)
    }
  }

  async function copyPath() {
    const path = localFilePath(localPath, image.path)
    try {
      await navigator.clipboard.writeText(path)
      setMessage(`Sökvägen är kopierad: ${path}`)
    } catch {
      setMessage(`Kopiera sökvägen: ${path}`)
    }
  }

  const files = [image.path, ...image.alternates]
  return (
    <div className="detail-download">
      <div className="download-row">
        {image.blocked ? (
          <span className="note">Spärrade bilder går inte att ladda ner.</span>
        ) : files.length === 1 ? (
          <button type="button" className="primary" disabled={busy} onClick={() => download()}>
            Ladda ner ({fileFormat(image.path)})
          </button>
        ) : (
          files.map((path) => (
            <button key={path} type="button" className="primary" disabled={busy} onClick={() => download(path)}>
              Ladda ner {fileFormat(path)}
            </button>
          ))
        )}
        {onBasket && (
          <button type="button" disabled={inBasket} onClick={() => onBasket(image.id)}>
            {inBasket ? 'Finns i korgen' : 'Lägg i korgen'}
          </button>
        )}
        {!image.blocked && (
          <button type="button" onClick={async () => setMessage(await copyShareLink([image.id]))}>
            Dela
          </button>
        )}
        {localPath && (
          <button type="button" title="Originalets sökväg på den här datorn, t.ex. för InDesign" onClick={copyPath}>
            Kopiera sökväg
          </button>
        )}
      </div>
      {message && (
        <p className="download-message" role="status">
          {message}{' '}
          {message.includes('hämtades') || message.includes('finns redan') ? (
            <button type="button" className="link" disabled={busy} onClick={() => download(undefined, true)}>
              Hämta till en annan mapp
            </button>
          ) : null}
        </p>
      )}
    </div>
  )
}
