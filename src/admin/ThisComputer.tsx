import { useEffect, useState } from 'react'
import { downloadFolder } from '../download/download.ts'
import { localFilePath } from '../download/localPath.ts'
import { loadDownloadFolder, loadLocalPath, saveLocalPath } from '../fs/folderStore.ts'

// Admin, fliken Den här datorn: inställningar som bara gäller den här datorn.
export function ThisComputer() {
  const [path, setPath] = useState('')
  const [saved, setSaved] = useState('')
  const [folder, setFolder] = useState<string | null>(null)
  const [message, setMessage] = useState<string | null>(null)
  useEffect(() => {
    loadLocalPath().then((value) => {
      setPath(value)
      setSaved(value)
    })
    loadDownloadFolder().then((handle) => setFolder(handle?.name ?? null))
  }, [])

  return (
    <section className="local-path">
      <h3>Kopiera sökväg</h3>
      <p>
        Skriv var bildbankens mapp ligger på den här datorn. Då visar detaljvyn knappen Kopiera sökväg, som kopierar
        originalets sökväg, t.ex. för att länka bilden i InDesign. Webbläsaren kan inte ta reda på sökvägen själv.
      </p>
      <form
        onSubmit={async (event) => {
          event.preventDefault()
          await saveLocalPath(path.trim())
          setSaved(path.trim())
          setMessage('Sparat.')
        }}
      >
        <label>
          Bildbankens mapp på den här datorn
          <input
            type="text"
            placeholder="T.ex. C:\Users\namn\Malmö stad\Bildbank eller /Users/namn/Library/CloudStorage/…/Bildbank"
            value={path}
            onChange={(event) => {
              setPath(event.target.value)
              setMessage(null)
            }}
          />
        </label>
        {path.trim() && <p className="note">Exempel: {localFilePath(path, 'original/Fotograf A/bild.jpg')}</p>}
        <div className="actions">
          <button type="submit" className="primary" disabled={path.trim() === saved}>
            Spara
          </button>
          {message && <span role="status">{message}</span>}
        </div>
      </form>

      <h3>Hämtade bilder</h3>
      <p>
        {folder ? (
          <>
            Bilderna laddas ner till mappen <strong>{folder}</strong>.
          </>
        ) : (
          'Ingen mapp är vald än. Du får välja den första gången du laddar ner en bild.'
        )}
      </p>
      <div className="actions">
        <button
          type="button"
          onClick={async () => {
            const handle = await downloadFolder(true)
            if (handle) setFolder(handle.name)
          }}
        >
          {folder ? 'Byt mapp' : 'Välj mapp'}
        </button>
      </div>
    </section>
  )
}
