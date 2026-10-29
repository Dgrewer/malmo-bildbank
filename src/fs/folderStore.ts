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

async function save(key: string, handle: FileSystemDirectoryHandle): Promise<void> {
  await run('readwrite', (store) => store.put(handle, key))
}

export const loadFolder = () => load(FOLDER_KEY)
export const saveFolder = (handle: FileSystemDirectoryHandle) => save(FOLDER_KEY, handle)
export const loadOriginalsFolder = () => load(ORIGINALS_KEY)
export const saveOriginalsFolder = (handle: FileSystemDirectoryHandle) => save(ORIGINALS_KEY, handle)
