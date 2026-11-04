// Recording chunks reach disk as they are captured, so closing or killing the
// app mid-recording loses at most the last second. A recording's chunks are
// removed once its clip is saved in the encrypted database.
const DATABASE = 'balance-voice-recordings'
const STORE = 'chunks'

export type UnfinishedRecording = { id: string; startedAt: number; mimeType: string; chunks: Blob[] }
type StoredChunk = { recordingId: string; sequence: number; startedAt: number; mimeType: string; data: Blob }

let database: Promise<IDBDatabase> | null = null

function openDatabase(): Promise<IDBDatabase> {
  database ??= new Promise<IDBDatabase>((resolve, reject) => {
    const request = indexedDB.open(DATABASE, 1)
    request.onupgradeneeded = () => {
      request.result.createObjectStore(STORE, { keyPath: ['recordingId', 'sequence'] })
    }
    request.onsuccess = () => resolve(request.result)
    request.onerror = () => reject(request.error)
  })
  return database
}

async function withStore<T>(mode: IDBTransactionMode, run: (store: IDBObjectStore) => IDBRequest<T>): Promise<T> {
  const transaction = (await openDatabase()).transaction(STORE, mode)
  const request = run(transaction.objectStore(STORE))
  return new Promise<T>((resolve, reject) => {
    transaction.oncomplete = () => resolve(request.result)
    transaction.onerror = transaction.onabort = () => reject(transaction.error)
  })
}

export async function appendVoiceChunk(chunk: StoredChunk) {
  await withStore('readwrite', (store) => store.put(chunk))
}

export async function removeVoiceChunks(recordingId: string) {
  // An array sorts after every number, so this spans all of the sequences.
  await withStore('readwrite', (store) => store.delete(IDBKeyRange.bound([recordingId], [recordingId, []])))
}

export async function unfinishedVoiceRecordings(): Promise<UnfinishedRecording[]> {
  const chunks = await withStore<StoredChunk[]>('readonly', (store) => store.getAll())
  const recordings = new Map<string, UnfinishedRecording>()
  // Keys sort by recording, then sequence.
  for (const { recordingId, startedAt, mimeType, data } of chunks) {
    const recording = recordings.get(recordingId) ?? { id: recordingId, startedAt, mimeType, chunks: [] }
    recording.chunks.push(data)
    recordings.set(recordingId, recording)
  }
  return [...recordings.values()]
}
