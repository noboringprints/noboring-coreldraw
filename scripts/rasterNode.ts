/**
 * Renders PDFs to pixels in Node (tests and the sample script), with pdf.js + @napi-rs/canvas.
 * The browser app uses src/lib/pdfRender.ts instead.
 */
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { createCanvas } from '@napi-rs/canvas'
import * as pdfjs from 'pdfjs-dist/legacy/build/pdf.mjs'
import type { Rasterizer, RGBAImage } from '../src/lib/bleedRaster'
import type { TextItemLite } from '../src/lib/textCheck'

const require = createRequire(import.meta.url)
const pdfjsRoot = dirname(require.resolve('pdfjs-dist/package.json'))
const standardFontDataUrl = pathToFileURL(join(pdfjsRoot, 'standard_fonts')).href + '/'

const open = (pdf: Uint8Array) => pdfjs.getDocument({ data: pdf.slice(), standardFontDataUrl, verbosity: 0 } as never)

export const nodeRasterizer: Rasterizer = {
  async render(pdf, pxPerMm) {
    const task = open(pdf)
    const doc = await task.promise
    try {
      const out: RGBAImage[] = []
      for (let i = 1; i <= doc.numPages; i++) {
        const page = await doc.getPage(i)
        const viewport = page.getViewport({ scale: (pxPerMm * 25.4) / 72 })
        const canvas = createCanvas(Math.max(1, Math.round(viewport.width)), Math.max(1, Math.round(viewport.height)))
        const ctx = canvas.getContext('2d')
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

export async function nodeTextItems(bytes: Uint8Array, pageIndex: number): Promise<TextItemLite[]> {
  const task = open(bytes)
  const doc = await task.promise
  try {
    const page = await doc.getPage(pageIndex + 1)
    const tc = await page.getTextContent()
    return (tc.items as TextItemLite[]).filter((it) => typeof it.str === 'string' && it.str.trim() !== '')
  } finally {
    void task.destroy()
  }
}
