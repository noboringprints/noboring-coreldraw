/** pdf.js in the browser: previews, thumbnails, the 300 DPI bleed strips and text positions. The design itself is never rasterised. */
import * as pdfjs from 'pdfjs-dist'
import type { PDFDocumentProxy, PDFPageProxy } from 'pdfjs-dist'
import workerUrl from 'pdfjs-dist/build/pdf.worker.min.mjs?url'
import type { Rasterizer, RGBAImage } from './bleedRaster'
import { jpgSize, pngSize } from './sources'
import type { TextItemLite } from './textCheck'

pdfjs.GlobalWorkerOptions.workerSrc = workerUrl

/** A region of a rendered page, in pixels from its top-left corner. */
export interface PxRect {
  x: number
  y: number
  w: number
  h: number
}

/**
 * Renders a page (or just `region` of it) to a canvas, `pxPerMm` pixels per millimetre.
 * Rendering a region gives exactly the same pixels as that part of the full-page render.
 */
export function renderPage(page: PDFPageProxy, pxPerMm: number, region?: PxRect): { promise: Promise<HTMLCanvasElement>; cancel: () => void } {
  const scale = (pxPerMm * 25.4) / 72
  const full = page.getViewport({ scale })
  const r = region ?? { x: 0, y: 0, w: Math.round(full.width), h: Math.round(full.height) }
  const viewport = region ? page.getViewport({ scale, offsetX: -r.x, offsetY: -r.y }) : full
  const canvas = document.createElement('canvas')
  canvas.width = Math.max(1, r.w)
  canvas.height = Math.max(1, r.h)
  const ctx = canvas.getContext('2d')!
  ctx.fillStyle = '#fff'
  ctx.fillRect(0, 0, canvas.width, canvas.height)
  const task = page.render({ canvasContext: ctx, viewport, canvas } as never)
  return { promise: task.promise.then(() => canvas), cancel: () => task.cancel() }
}

/** Opens a PDF with pdf.js. pdf.js takes ownership of `bytes`; pass a copy if you still need them. */
export async function openPdf(bytes: Uint8Array): Promise<{ doc: PDFDocumentProxy; destroy: () => void }> {
  const task = pdfjs.getDocument({ data: bytes })
  try {
    return { doc: await task.promise, destroy: () => void task.destroy() }
  } catch (e) {
    void task.destroy()
    throw e
  }
}

/**
 * Uploaded PDFs are parsed by pdf.js once and shared by the thumbnail and the text check,
 * then closed a few seconds after the last use.
 */
const shared = new Map<Uint8Array, { doc: Promise<{ doc: PDFDocumentProxy; destroy: () => void }>; users: number; timer?: ReturnType<typeof setTimeout> }>()
async function withSourceDoc<T>(bytes: Uint8Array, fn: (doc: PDFDocumentProxy) => Promise<T>): Promise<T> {
  let entry = shared.get(bytes)
  if (!entry) {
    // pdf.js takes ownership of the buffer, so give it a copy
    entry = { doc: openPdf(bytes.slice()), users: 0 }
    shared.set(bytes, entry)
  }
  const e = entry
  clearTimeout(e.timer)
  e.users++
  try {
    return await fn((await e.doc).doc)
  } finally {
    if (--e.users === 0)
      e.timer = setTimeout(() => {
        if (e.users > 0) return
        if (shared.get(bytes) === e) shared.delete(bytes)
        e.doc.then((d) => d.destroy(), () => {})
      }, 5000)
  }
}

const toUrl = (canvas: HTMLCanvasElement) =>
  new Promise<string>((resolve) => canvas.toBlob((b) => resolve(b ? URL.createObjectURL(b) : canvas.toDataURL('image/png')), 'image/png'))

/** Image thumbnails are shown at most ~300 px wide; a copy this size keeps them sharp (2× for HiDPI screens). */
const IMAGE_THUMB_PX = 720

/** Small thumbnail (object URL) for the upload list. Display only – the print uses the original file. */
export async function thumbnail(kind: 'pdf' | 'png' | 'jpg', bytes: Uint8Array, pageIndex = 0, maxPx = 360): Promise<string> {
  if (kind !== 'pdf') {
    const blob = new Blob([bytes as BlobPart], { type: kind === 'png' ? 'image/png' : 'image/jpeg' })
    try {
      const { w, h } = kind === 'png' ? pngSize(bytes) : jpgSize(bytes)
      if (Math.max(w, h) <= IMAGE_THUMB_PX) return URL.createObjectURL(blob)
      // decode once (off the main thread), keep a small copy, so lists don't hold full-size photos
      const bmp = await createImageBitmap(blob)
      const k = IMAGE_THUMB_PX / Math.max(bmp.width, bmp.height)
      const c = document.createElement('canvas')
      c.width = Math.max(1, Math.round(bmp.width * k))
      c.height = Math.max(1, Math.round(bmp.height * k))
      const ctx = c.getContext('2d')!
      ctx.imageSmoothingQuality = 'high'
      ctx.drawImage(bmp, 0, 0, c.width, c.height)
      bmp.close()
      return await toUrl(c)
    } catch {
      return URL.createObjectURL(blob)
    }
  }
  return withSourceDoc(bytes, async (doc) => {
    const page = await doc.getPage(pageIndex + 1)
    const v = page.getViewport({ scale: 1 }) // points
    // render straight at thumbnail size instead of rendering bigger and shrinking
    const pxPerMm = (maxPx / Math.max(v.width, v.height)) * (72 / 25.4)
    return toUrl(await renderPage(page, pxPerMm).promise)
  })
}

/** Renders PDFs to pixels in the browser with pdf.js (used for the 300 DPI bleed strips). */
export const browserRasterizer: Rasterizer = {
  async render(pdf, pxPerMm) {
    const { doc, destroy } = await openPdf(pdf.slice())
    try {
      const out: RGBAImage[] = []
      for (let i = 1; i <= doc.numPages; i++) {
        const page = await doc.getPage(i)
        const viewport = page.getViewport({ scale: (pxPerMm * 25.4) / 72 })
        const canvas = document.createElement('canvas')
        canvas.width = Math.max(1, Math.round(viewport.width))
        canvas.height = Math.max(1, Math.round(viewport.height))
        const ctx = canvas.getContext('2d', { willReadFrequently: true })!
        ctx.fillStyle = '#fff'
        ctx.fillRect(0, 0, canvas.width, canvas.height)
        // stretch by < 1 px so the page fills the whole-pixel canvas exactly (no half-covered edge pixels)
        const fill = [canvas.width / viewport.width, 0, 0, canvas.height / viewport.height, 0, 0]
        await page.render({ canvasContext: ctx, viewport, canvas, transform: fill } as never).promise
        const img = ctx.getImageData(0, 0, canvas.width, canvas.height)
        out.push({ width: img.width, height: img.height, data: img.data })
      }
      return out
    } finally {
      destroy()
    }
  },
}

/** Text positions only depend on the file, so they are read once per page and reused when settings change. */
const textCache = new WeakMap<Uint8Array, Map<number, Promise<TextItemLite[]>>>()

/** All text on a PDF page, with positions (PDF user space), for the "text near the edge" check. */
export function pdfTextItems(bytes: Uint8Array, pageIndex: number): Promise<TextItemLite[]> {
  let pages = textCache.get(bytes)
  if (!pages) textCache.set(bytes, (pages = new Map()))
  const cached = pages.get(pageIndex)
  if (cached) return cached
  const p = withSourceDoc(bytes, async (doc) => {
    const page = await doc.getPage(pageIndex + 1)
    const tc = await page.getTextContent()
    return (tc.items as TextItemLite[]).filter((it) => typeof it.str === 'string' && it.str.trim() !== '')
  })
  const map = pages
  p.catch(() => map.delete(pageIndex))
  map.set(pageIndex, p)
  return p
}
