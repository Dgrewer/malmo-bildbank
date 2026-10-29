// Sparar den valda mappen i IndexedDB så att den kan återanslutas vid nästa
// start. Handtaget gäller bara i den här webbläsaren på den här datorn.

const DB_NAME = 'malmo-bildbank'
const STORE = 'settings'
const FOLDER_KEY = 'folder'

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

export async function loadFolder(): Promise<FileSystemDirectoryHandle | null> {
  const handle = await run('readonly', (store) => store.get(FOLDER_KEY))
  return handle instanceof FileSystemDirectoryHandle ? handle : null
}

export async function saveFolder(handle: FileSystemDirectoryHandle): Promise<void> {
  await run('readwrite', (store) => store.put(handle, FOLDER_KEY))
}
