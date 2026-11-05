/**
 * State of the polaroid job: the photos (original bytes + a small preview for the screen) and the polaroids
 * made from them. Autosaved in the browser; full-size photos are only decoded while the PDF is being made.
 */
import { useCallback, useEffect, useRef, useState } from 'react'
import { type NewItemDefaults, type PolaroidItem, DEFAULT_CROP, formatOf, newItem, photoWindow, placePhoto } from './model'
import { canvasSize, drawPolaroid } from './render'
import { type SavedPhoto, loadJob, saveJob } from './store'

export interface Photo extends SavedPhoto {
  /** Longest side at most PREVIEW_PX – for the editor and the sheet preview. */
  preview: ImageBitmap | null
}

/** Phones and tablets have far less memory for decoded pictures (iOS Safari drops images past its limit). */
const SMALL_DEVICE = typeof matchMedia === 'function' && matchMedia('(pointer: coarse)').matches
const PREVIEW_PX = SMALL_DEVICE ? 1400 : 2000
const ACCEPTED = /\.(jpe?g|png|webp|gif|bmp|avif)$/i

let counter = 0
const uid = (p: string) => `${p}-${Date.now().toString(36)}-${(counter++).toString(36)}`
const baseName = (n: string) => n.replace(/\.[^.]+$/, '')

/* ------------------------------------------------------------------ canvases that work everywhere */

type AnyCanvas = OffscreenCanvas | HTMLCanvasElement

/** OffscreenCanvas where there is one (Safari only since iOS 16.4), a plain canvas otherwise. */
function makeCanvas(w: number, h: number): AnyCanvas {
  if (typeof OffscreenCanvas !== 'undefined') return new OffscreenCanvas(w, h)
  const c = document.createElement('canvas')
  c.width = w
  c.height = h
  return c
}

function context(c: AnyCanvas) {
  const ctx = c.getContext('2d') as CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D | null
  if (!ctx) throw new Error('this browser ran out of memory for pictures – close other tabs and try again')
  return ctx
}

async function canvasToBlob(c: AnyCanvas, type: string, quality: number): Promise<Blob> {
  if ('convertToBlob' in c) return c.convertToBlob({ type, quality })
  return new Promise((resolve, reject) => c.toBlob((b) => (b ? resolve(b) : reject(new Error('could not encode the picture'))), type, quality))
}

/** Releases a canvas's memory right away (iOS counts it until garbage collection otherwise). */
function freeCanvas(c: AnyCanvas) {
  c.width = 0
  c.height = 0
}

function decode(bytes: Uint8Array, type: string, opts: ImageBitmapOptions = {}): Promise<ImageBitmap> {
  return createImageBitmap(new Blob([bytes as BlobPart], { type }), { imageOrientation: 'from-image', ...opts })
}

/** The picture drawn `k` times smaller (k ≤ 1) – a fresh bitmap; `img` is closed. */
async function shrink(img: ImageBitmap, k: number): Promise<ImageBitmap> {
  if (k >= 0.999) return img
  const c = makeCanvas(Math.max(1, Math.round(img.width * k)), Math.max(1, Math.round(img.height * k)))
  const ctx = context(c)
  ctx.imageSmoothingEnabled = true
  ctx.imageSmoothingQuality = 'high'
  ctx.drawImage(img, 0, 0, c.width, c.height)
  img.close()
  const out = await createImageBitmap(c)
  freeCanvas(c)
  return out
}

/**
 * Decodes a photo at (about) `k` of its size. Asks the browser to scale while decoding (much less memory for a
 * 24–48 MP iPhone photo); browsers that ignore that get the picture scaled afterwards.
 */
async function decodeScaled(bytes: Uint8Array, type: string, pxW: number, pxH: number, k: number): Promise<ImageBitmap> {
  if (k >= 0.999) return decode(bytes, type)
  const w = Math.max(1, Math.round(pxW * k))
  const h = Math.max(1, Math.round(pxH * k))
  let img: ImageBitmap
  try {
    img = await decode(bytes, type, { resizeWidth: w, resizeHeight: h, resizeQuality: 'high' })
  } catch {
    img = await decode(bytes, type)
  }
  return img.width > w * 1.01 ? shrink(img, w / img.width) : img
}

async function makePreview(bytes: Uint8Array, type: string): Promise<{ preview: ImageBitmap; pxW: number; pxH: number }> {
  const full = await decode(bytes, type)
  const pxW = full.width
  const pxH = full.height
  if (!pxW || !pxH) throw new Error('empty picture')
  return { preview: await shrink(full, Math.min(1, PREVIEW_PX / Math.max(pxW, pxH))), pxW, pxH }
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
        // photos first, then the polaroids – a polaroid is never on screen (or printable) before its photo
        setLoading((n) => n + job.photos.length)
        const out: Record<string, Photo> = {}
        for (const p of job.photos) {
          try {
            const { preview } = await makePreview(p.bytes, p.type)
            out[p.id] = { ...p, preview }
          } catch {
            out[p.id] = { ...p, preview: null }
          } finally {
            if (alive) setLoading((n) => n - 1)
          }
          if (!alive) {
            for (const q of Object.values(out)) q.preview?.close()
            return
          }
        }
        setPhotos(out)
        setItems(job.items)
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

/**
 * The 300 DPI print of one polaroid. The photo is decoded only as big as the print needs (a phone photo is often
 * several times the needed size) and only one decoded photo is kept at a time (`cache`), so phones don't run out
 * of picture memory. Never falls back to the grey stand-in: a missing photo is an error.
 */
export async function renderForPrint(it: PolaroidItem, photo: Photo | undefined, bleedMm: number, cache: Map<string, ImageBitmap>): Promise<{ bytes: Uint8Array; kind: 'jpg' | 'png' }> {
  if (!photo) throw new Error(`the photo for “${it.name}” is not loaded – wait for the photos to finish loading, or add it again`)
  const k = 300 / 25.4
  // print pixels per photo pixel, with a little spare: below 1 the photo has more detail than 300 DPI can show
  const win = photoWindow(formatOf(it))
  const need = Math.ceil(Math.min(1, k * placePhoto(it.crop, photo.pxW, photo.pxH, win.w, win.h).scale * 1.15) * 64) / 64
  const key = `${photo.id}@${need}`
  let img = cache.get(key)
  if (!img) {
    for (const b of cache.values()) b.close()
    cache.clear()
    try {
      img = await decodeScaled(photo.bytes, photo.type, photo.pxW, photo.pxH, need)
    } catch {
      throw new Error(`could not read the photo for “${it.name}” – the device may be out of memory; close other tabs and try again`)
    }
    if (!img.width) throw new Error(`could not read the photo for “${it.name}”`)
    cache.set(key, img)
  }
  const { w, h } = canvasSize(it, k, bleedMm)
  const c = makeCanvas(w, h)
  try {
    drawPolaroid(context(c) as CanvasRenderingContext2D, it, { pxPerMm: k, bleedMm, photo: { img, pxW: photo.pxW, pxH: photo.pxH } })
    const bytes = new Uint8Array(await (await canvasToBlob(c, 'image/jpeg', 0.95)).arrayBuffer())
    // some browsers quietly hand back a PNG when they can't encode JPEG
    const kind = bytes[0] === 0xff && bytes[1] === 0xd8 ? 'jpg' : bytes[0] === 0x89 && bytes[1] === 0x50 ? 'png' : null
    if (!kind) throw new Error('the browser could not encode the print picture')
    return { bytes, kind }
  } finally {
    freeCanvas(c)
  }
}

export const resetCrop = () => ({ ...DEFAULT_CROP })
