/**
 * The current Print & Cut job is kept in this browser (IndexedDB): the uploaded files and every item's settings.
 * Close the tab, come back tomorrow, change the copies and download again. Nothing leaves the computer.
 */
import type { SourceKind } from '../lib/sources'
import type { PrintCutItem } from './model'

export interface SavedJob {
  files: { id: string; name: string; kind: SourceKind; bytes: Uint8Array }[]
  items: PrintCutItem[]
  savedAt: number
}

const DB = 'print-ready'
const STORE = 'printcut'
const KEY = 'current-job'

function open(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB, 1)
    req.onupgradeneeded = () => req.result.createObjectStore(STORE)
    req.onsuccess = () => resolve(req.result)
    req.onerror = () => reject(req.error)
  })
}

async function run<T>(mode: IDBTransactionMode, fn: (s: IDBObjectStore) => IDBRequest): Promise<T> {
  const db = await open()
  try {
    return await new Promise<T>((resolve, reject) => {
      const req = fn(db.transaction(STORE, mode).objectStore(STORE))
      req.onsuccess = () => resolve(req.result as T)
      req.onerror = () => reject(req.error)
    })
  } finally {
    db.close()
  }
}

export async function loadJob(): Promise<SavedJob | null> {
  try {
    return (await run<SavedJob | undefined>('readonly', (s) => s.get(KEY))) ?? null
  } catch {
    return null // private window / storage blocked: start empty
  }
}

export async function saveJob(job: SavedJob): Promise<void> {
  try {
    if (!job.items.length) await run('readwrite', (s) => s.delete(KEY))
    else await run('readwrite', (s) => s.put(job, KEY))
  } catch {
    /* not remembered – the job still works, it just won't survive a reload */
  }
}
