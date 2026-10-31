// Sparar valda mappar i IndexedDB så att de kan återanslutas vid nästa start.
// Handtagen gäller bara i den här webbläsaren på den här datorn.

const DB_NAME = 'malmo-bildbank'
const STORE = 'settings'
const FOLDER_KEY = 'folder'
// Originalmappen som importen läser från, t.ex. på G:.
const ORIGINALS_KEY = 'originals'

function openDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, 1)
    request.onupgradeneeded = () => request.result.createObjectStore(STORE)
    request.onsuccess = () => resolve(request.result)
    request.onerror = () => reject(request.error)
  })
}

async function run<T>(mode: IDBTransactionMode, action: (store: IDBObjectStore) => IDBRequest<T>): Promise<T> {
  const db = await openDb()
  try {
    return await new Promise<T>((resolve, reject) => {
      const request = action(db.transaction(STORE, mode).objectStore(STORE))
      request.onsuccess = () => resolve(request.result)
      request.onerror = () => reject(request.error)
    })
  } finally {
    db.close()
  }
}

async function load(key: string): Promise<FileSystemDirectoryHandle | null> {
  const handle = await run('readonly', (store) => store.get(key))
  return handle instanceof FileSystemDirectoryHandle ? handle : null
}

async function save(key: string, value: unknown): Promise<void> {
  await run('readwrite', (store) => store.put(value, key))
}

// Namnet som användarens ändringar sparas under, app-data/edits/<namn>.jsonl.
const USER_KEY = 'user'

export async function loadUserName(): Promise<string> {
  const name = await run('readonly', (store) => store.get(USER_KEY))
  return typeof name === 'string' ? name : ''
}

export const saveUserName = (name: string) => save(USER_KEY, name)

export const loadFolder = () => load(FOLDER_KEY)
export const saveFolder = (handle: FileSystemDirectoryHandle) => save(FOLDER_KEY, handle)

// Mappen Hämtade bilder, dit bilderna laddas ner.
const DOWNLOADS_KEY = 'downloads'
export const loadDownloadFolder = () => load(DOWNLOADS_KEY)
export const saveDownloadFolder = (handle: FileSystemDirectoryHandle) => save(DOWNLOADS_KEY, handle)

// Korgen: id:n för bilderna som användaren har samlat. Delas inte med någon.
const BASKET_KEY = 'basket'
export async function loadBasket(): Promise<string[]> {
  const ids = await run('readonly', (store) => store.get(BASKET_KEY))
  return Array.isArray(ids) ? ids.filter((id) => typeof id === 'string') : []
}
export const saveBasket = (ids: string[]) => save(BASKET_KEY, ids)

// Bildbankens sökväg på den här datorn, t.ex. C:\Users\namn\Malmö stad\Bildbank.
// Används av Kopiera sökväg. Webbläsaren kan inte ta reda på den själv.
const LOCAL_PATH_KEY = 'localPath'
export async function loadLocalPath(): Promise<string> {
  const path = await run('readonly', (store) => store.get(LOCAL_PATH_KEY))
  return typeof path === 'string' ? path : ''
}
export const saveLocalPath = (path: string) => save(LOCAL_PATH_KEY, path)

interface SavedOriginals {
  bank: FileSystemDirectoryHandle
  originals: FileSystemDirectoryHandle
}

// Originalmappen sparas ihop med bildbanken den valdes för. En originalmapp
// som valdes för en annan bildbank följer inte med.
export async function loadOriginalsFolder(bank: FileSystemDirectoryHandle): Promise<FileSystemDirectoryHandle | null> {
  const saved = (await run('readonly', (store) => store.get(ORIGINALS_KEY))) as SavedOriginals | undefined
  if (!(saved?.bank instanceof FileSystemDirectoryHandle) || !(saved.originals instanceof FileSystemDirectoryHandle)) {
    return null
  }
  return (await saved.bank.isSameEntry(bank)) ? saved.originals : null
}

export const saveOriginalsFolder = (bank: FileSystemDirectoryHandle, originals: FileSystemDirectoryHandle) =>
  save(ORIGINALS_KEY, { bank, originals } satisfies SavedOriginals)
