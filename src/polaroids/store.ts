/**
 * The current polaroid job is kept in this browser (IndexedDB): the photos and every polaroid's settings.
 * A database of its own, so it never clashes with the other tools' storage versions. Nothing leaves the computer.
 */
import type { PolaroidItem } from './model'

export interface SavedPhoto {
  id: string
  name: string
  type: string
  bytes: Uint8Array
  pxW: number
  pxH: number
}

export interface SavedJob {
  photos: SavedPhoto[]
  items: PolaroidItem[]
  savedAt: number
}

const DB = 'print-ready-polaroids'
const STORE = 'job'
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
