/** pdf.js in the browser: previews, thumbnails, the 300 DPI bleed strips and text positions. The design itself is never rasterised. */
import * as pdfjs from 'pdfjs-dist'
import workerUrl from 'pdfjs-dist/build/pdf.worker.min.mjs?url'
import type { Rasterizer, RGBAImage } from './bleedRaster'
import type { TextItemLite } from './textCheck'

pdfjs.GlobalWorkerOptions.workerSrc = workerUrl

/** Renders one page to a canvas, `pxPerMm` pixels per millimetre. */
export async function renderPdfPage(bytes: Uint8Array, pageIndex: number, pxPerMm: number, signal?: { cancelled: boolean }): Promise<HTMLCanvasElement | null> {
  // pdf.js takes ownership of the buffer, so give it a copy
  const task = pdfjs.getDocument({ data: bytes.slice() })
  const doc = await task.promise
  try {
    if (signal?.cancelled) return null
    const page = await doc.getPage(pageIndex + 1)
    const viewport = page.getViewport({ scale: (pxPerMm * 25.4) / 72 })
    const canvas = document.createElement('canvas')
    canvas.width = Math.max(1, Math.round(viewport.width))
    canvas.height = Math.max(1, Math.round(viewport.height))
    const ctx = canvas.getContext('2d')!
    ctx.fillStyle = '#fff'
    ctx.fillRect(0, 0, canvas.width, canvas.height)
    await page.render({ canvasContext: ctx, viewport, canvas } as never).promise
    return signal?.cancelled ? null : canvas
  } finally {
    void task.destroy()
  }
}

/** Small thumbnail (data URL) for the upload list. */
export async function thumbnail(kind: 'pdf' | 'png' | 'jpg', bytes: Uint8Array, pageIndex = 0, maxPx = 360): Promise<string> {
  if (kind !== 'pdf') return URL.createObjectURL(new Blob([bytes as BlobPart], { type: kind === 'png' ? 'image/png' : 'image/jpeg' }))
  const probe = await renderPdfPage(bytes, pageIndex, 1.4)
  if (!probe) return ''
  const k = maxPx / Math.max(probe.width, probe.height)
  const c = document.createElement('canvas')
  c.width = Math.round(probe.width * k)
  c.height = Math.round(probe.height * k)
  c.getContext('2d')!.drawImage(probe, 0, 0, c.width, c.height)
  return c.toDataURL('image/png')
}

/** Renders PDFs to pixels in the browser with pdf.js (used for the 300 DPI bleed strips). */
export const browserRasterizer: Rasterizer = {
  async render(pdf, pxPerMm) {
    const task = pdfjs.getDocument({ data: pdf.slice() })
    const doc = await task.promise
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
      void task.destroy()
    }
  },
}

/** All text on a PDF page, with positions (PDF user space), for the "text near the edge" check. */
export async function pdfTextItems(bytes: Uint8Array, pageIndex: number): Promise<TextItemLite[]> {
  const task = pdfjs.getDocument({ data: bytes.slice() })
  const doc = await task.promise
  try {
    const page = await doc.getPage(pageIndex + 1)
    const tc = await page.getTextContent()
    return (tc.items as TextItemLite[]).filter((it) => typeof it.str === 'string' && it.str.trim() !== '')
  } finally {
    void task.destroy()
  }
}
