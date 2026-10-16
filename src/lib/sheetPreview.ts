/**
 * Caches for the on-screen sheet preview.
 * Each sheet's print PDF is built and opened with pdf.js once; zooming only re-renders it,
 * and flipping back to a sheet seen before (or the next one, prefetched) is instant.
 */
import type { PDFPageProxy } from 'pdfjs-dist'
import { openPdf, renderPage } from './pdfRender'

type Opened = { page: PDFPageProxy; destroy: () => void }

const MAX_DOCS = 4
const MAX_BASES = 6
const docs = new Map<string, Promise<Opened>>()
const bases = new Map<string, Promise<HTMLCanvasElement>>()

/** Most recently used last; the oldest entries are dropped beyond `max`. */
function lru<V>(m: Map<string, V>, key: string, make: () => V, max: number, evict?: (key: string, v: V) => void): V {
  const hit = m.get(key)
  if (hit !== undefined) {
    m.delete(key)
    m.set(key, hit)
    return hit
  }
  const v = make()
  m.set(key, v)
  while (m.size > max) {
    const [k, old] = m.entries().next().value!
    m.delete(k)
    evict?.(k, old)
  }
  return v
}

const forget = <V>(m: Map<string, V>, key: string, v: V) => {
  if (m.get(key) === v) m.delete(key)
}

export const isSheetReady = (key: string) => docs.has(key)

/** The first page of the sheet's print PDF, opened in pdf.js. `build` only runs when it isn't cached. */
export function sheetPage(key: string, build: () => Promise<Uint8Array>): Promise<PDFPageProxy> {
  const p = lru(
    docs,
    key,
    () => {
      const opened = (async () => {
        const { doc, destroy } = await openPdf(await build())
        try {
          return { page: await doc.getPage(1), destroy }
        } catch (e) {
          destroy()
          throw e
        }
      })()
      opened.catch(() => forget(docs, key, opened))
      return opened
    },
    MAX_DOCS,
    (k, old) => {
      for (const b of [...bases.keys()]) if (b.startsWith(k + '@')) bases.delete(b)
      old.then((o) => o.destroy(), () => {})
    },
  )
  return p.then((o) => o.page)
}

/** The whole sheet rendered at `pxPerMm` (kept small; zoomed-in detail is rendered separately). */
export function sheetBase(key: string, pxPerMm: number, page: PDFPageProxy): Promise<HTMLCanvasElement> {
  const k = `${key}@${pxPerMm}`
  return lru(
    bases,
    k,
    () => {
      const p = renderPage(page, pxPerMm).promise
      p.catch(() => forget(bases, k, p))
      return p
    },
    MAX_BASES,
  )
}
