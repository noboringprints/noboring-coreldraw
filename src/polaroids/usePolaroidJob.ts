/**
 * State of the polaroid job: the photos (original bytes + a small preview for the screen) and the polaroids
 * made from them. Autosaved in the browser; full-size photos are only decoded while the PDF is being made.
 */
import { useCallback, useEffect, useRef, useState } from 'react'
import { type NewItemDefaults, type PolaroidItem, DEFAULT_CROP, newItem } from './model'
import { canvasSize, drawPolaroid } from './render'
import { type SavedPhoto, loadJob, saveJob } from './store'

export interface Photo extends SavedPhoto {
  /** Longest side at most PREVIEW_PX – for the editor and the sheet preview. */
  preview: ImageBitmap | null
}

const PREVIEW_PX = 2000
const ACCEPTED = /\.(jpe?g|png|webp|gif|bmp|avif)$/i

let counter = 0
const uid = (p: string) => `${p}-${Date.now().toString(36)}-${(counter++).toString(36)}`
const baseName = (n: string) => n.replace(/\.[^.]+$/, '')

async function makePreview(bytes: Uint8Array, type: string): Promise<{ preview: ImageBitmap; pxW: number; pxH: number }> {
  const full = await createImageBitmap(new Blob([bytes as BlobPart], { type }), { imageOrientation: 'from-image' })
  const pxW = full.width
  const pxH = full.height
  const k = Math.min(1, PREVIEW_PX / Math.max(pxW, pxH))
  if (k >= 1) return { preview: full, pxW, pxH }
  const c = new OffscreenCanvas(Math.round(pxW * k), Math.round(pxH * k))
  const ctx = c.getContext('2d')!
  ctx.imageSmoothingQuality = 'high'
  ctx.drawImage(full, 0, 0, c.width, c.height)
  full.close()
  return { preview: c.transferToImageBitmap(), pxW, pxH }
}

export function usePolaroidJob(defaults: NewItemDefaults) {
  const [photos, setPhotos] = useState<Record<string, Photo>>({})
  const [items, setItems] = useState<PolaroidItem[]>([])
  const [loading, setLoading] = useState(0)
  const [errors, setErrors] = useState<string[]>([])
  const [restored, setRestored] = useState(false)
  const defaultsRef = useRef(defaults)
  defaultsRef.current = defaults

  // ---------- restore the last job
  useEffect(() => {
    let alive = true
    void (async () => {
      const job = await loadJob()
      if (!alive) return
      if (job?.items.length) {
        setItems(job.items)
        const out: Record<string, Photo> = {}
        for (const p of job.photos) {
          try {
            const { preview } = await makePreview(p.bytes, p.type)
            out[p.id] = { ...p, preview }
          } catch {
            out[p.id] = { ...p, preview: null }
          }
        }
        if (alive) setPhotos(out)
      }
      if (alive) setRestored(true)
    })()
    return () => {
      alive = false
    }
  }, [])

  // ---------- autosave (debounced)
  useEffect(() => {
    if (!restored) return
    const t = setTimeout(() => {
      const used = new Set(items.map((it) => it.photoId))
      void saveJob({
        photos: Object.values(photos)
          .filter((p) => used.has(p.id))
          .map(({ id, name, type, bytes, pxW, pxH }) => ({ id, name, type, bytes, pxW, pxH })),
        items,
        savedAt: Date.now(),
      })
    }, 600)
    return () => clearTimeout(t)
  }, [items, photos, restored])

  const addFiles = useCallback(async (files: File[]) => {
    const errs: string[] = []
    const list = files.filter((f) => {
      const ok = f.type.startsWith('image/') || ACCEPTED.test(f.name)
      if (!ok) errs.push(`${f.name}: not a photo – use JPG, PNG or WebP.`)
      return ok
    })
    setErrors(errs)
    if (!list.length) return
    setLoading((n) => n + list.length)
    for (const f of list) {
      try {
        const bytes = new Uint8Array(await f.arrayBuffer())
        const type = f.type || 'image/jpeg'
        const { preview, pxW, pxH } = await makePreview(bytes, type)
        const id = uid('ph')
        setPhotos((m) => ({ ...m, [id]: { id, name: f.name, type, bytes, pxW, pxH, preview } }))
        setItems((list) => [...list, newItem(uid('pl'), id, baseName(f.name), defaultsRef.current)])
      } catch {
        const heic = /\.hei[cf]$/i.test(f.name) || /hei[cf]/i.test(f.type)
        setErrors((e) => [...e, heic ? `${f.name}: iPhone HEIC photos can't be read here – share or export them as JPG first.` : `${f.name}: could not read this picture.`])
      } finally {
        setLoading((n) => n - 1)
      }
    }
  }, [])

  const update = useCallback((id: string, patch: Partial<PolaroidItem>) => {
    setItems((list) => list.map((it) => (it.id === id ? { ...it, ...patch } : it)))
  }, [])

  const updateAll = useCallback((patch: (it: PolaroidItem) => Partial<PolaroidItem>) => {
    setItems((list) => list.map((it) => ({ ...it, ...patch(it) })))
  }, [])

  const remove = useCallback((id: string) => {
    setItems((list) => list.filter((it) => it.id !== id))
  }, [])

  /** Another polaroid of the same photo (e.g. a different caption or crop). */
  const duplicate = useCallback((id: string): string => {
    const nid = uid('pl')
    setItems((list) => {
      const i = list.findIndex((it) => it.id === id)
      if (i < 0) return list
      const copy: PolaroidItem = { ...structuredClone(list[i]), id: nid, name: `${list[i].name} (2)`, copies: 1 }
      return [...list.slice(0, i + 1), copy, ...list.slice(i + 1)]
    })
    return nid
  }, [])

  const move = useCallback((id: string, dir: -1 | 1) => {
    setItems((list) => {
      const i = list.findIndex((it) => it.id === id)
      const j = i + dir
      if (i < 0 || j < 0 || j >= list.length) return list
      const out = [...list]
      ;[out[i], out[j]] = [out[j], out[i]]
      return out
    })
  }, [])

  const clear = useCallback(() => {
    setItems([])
    setPhotos({})
    setErrors([])
  }, [])

  return { photos, items, loading, errors, restored, addFiles, update, updateAll, remove, duplicate, move, clear, setErrors }
}

export type PolaroidJob = ReturnType<typeof usePolaroidJob>

/* ------------------------------------------------------------------ drawing helpers */

/** A canvas with one polaroid drawn on it (preview resolution). */
export function renderToCanvas(it: PolaroidItem, photo: Photo | undefined, pxPerMm: number, bleedMm: number, canvas = document.createElement('canvas')) {
  const { w, h } = canvasSize(it, pxPerMm, bleedMm)
  if (canvas.width !== w) canvas.width = w
  if (canvas.height !== h) canvas.height = h
  const ctx = canvas.getContext('2d')!
  ctx.setTransform(1, 0, 0, 1, 0, 0)
  ctx.clearRect(0, 0, w, h)
  drawPolaroid(ctx, it, { pxPerMm, bleedMm, photo: photo?.preview ? { img: photo.preview, pxW: photo.pxW, pxH: photo.pxH } : null })
  return canvas
}

/** The 300 DPI print of one polaroid, from the full-size photo. `cache` keeps decoded photos for the length of one export. */
export async function renderForPrint(it: PolaroidItem, photo: Photo | undefined, bleedMm: number, cache: Map<string, ImageBitmap>): Promise<{ bytes: Uint8Array; kind: 'jpg' }> {
  const k = 300 / 25.4
  const { w, h } = canvasSize(it, k, bleedMm)
  const c = new OffscreenCanvas(w, h)
  const ctx = c.getContext('2d')!
  let img: ImageBitmap | undefined
  if (photo) {
    img = cache.get(photo.id)
    if (!img) {
      img = await createImageBitmap(new Blob([photo.bytes as BlobPart], { type: photo.type }), { imageOrientation: 'from-image' })
      cache.set(photo.id, img)
    }
  }
  drawPolaroid(ctx, it, { pxPerMm: k, bleedMm, photo: img && photo ? { img, pxW: photo.pxW, pxH: photo.pxH } : null })
  const blob = await c.convertToBlob({ type: 'image/jpeg', quality: 0.95 })
  return { bytes: new Uint8Array(await blob.arrayBuffer()), kind: 'jpg' }
}

export const resetCrop = () => ({ ...DEFAULT_CROP })
