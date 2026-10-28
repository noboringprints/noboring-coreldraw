import { useCallback, useEffect, useRef, useState } from 'react'
import { browserRasterizer, openPdf, renderPage, thumbnail } from '../lib/pdfRender'
import { type SourceFile, newId, readSource } from '../lib/sources'
import type { StickerSettings } from '../stickers/config'
import { buildItemPreviewPdf, buildSourcePdf } from './exportPrintCut'
import { type ContentInfo, type PrintCutItem, type Product, findContent, newItemFor } from './model'
import { loadJob, saveJob } from './store'

const thumbKey = (sourceId: string, page: number) => `${sourceId}:${page}`
const baseName = (name: string) => name.replace(/\.(pdf|png|jpe?g)$/i, '')

/** Where the design sits in one page of a file (null = it fills the page). Rendered at up to 8 px/mm. */
async function detectContent(src: SourceFile, pageIndex: number): Promise<ContentInfo | null> {
  const g = src.pages[pageIndex].geometry
  try {
    const [img] = await browserRasterizer.render(await buildSourcePdf(src, pageIndex), Math.min(8, 1600 / Math.max(g.widthMm, g.heightMm)))
    return findContent(img, g.widthMm, g.heightMm)
  } catch {
    return null
  }
}

/** Uploaded files, the items made from them, thumbnails, and saving the job in this browser. */
export function usePrintCutJob(settings: StickerSettings, products: Product[], toast: (msg: string) => void) {
  const [sources, setSources] = useState<Record<string, SourceFile>>({})
  const [items, setItems] = useState<PrintCutItem[]>([])
  const [thumbs, setThumbs] = useState<Record<string, string>>({})
  const [loading, setLoading] = useState(0)
  const [errors, setErrors] = useState<string[]>([])
  const [restored, setRestored] = useState(false)
  /** Design edge per file page (`sourceId:page`), for the "cut at design edge / file edge" switch. */
  const [contents, setContents] = useState<Record<string, ContentInfo | null>>({})
  // new uploads use the latest settings and products without re-creating addFiles
  const latest = useRef({ settings, products })
  useEffect(() => {
    latest.current = { settings, products }
  }, [settings, products])

  const makeThumbs = useCallback(async (src: SourceFile) => {
    for (const p of src.pages) {
      const url = await thumbnail(src.kind, src.bytes, p.index).catch(() => '')
      if (url) setThumbs((t) => ({ ...t, [thumbKey(src.id, p.index)]: url }))
    }
  }, [])

  // ---- the last job comes back on open
  const restoring = useRef(false)
  useEffect(() => {
    if (restoring.current) return
    restoring.current = true
    void (async () => {
      const job = await loadJob()
      if (job?.items.length) {
        const srcs: Record<string, SourceFile> = {}
        for (const f of job.files) {
          try {
            srcs[f.id] = await readSource(f.name, f.bytes, f.id)
          } catch {
            /* a file that can't be read any more is dropped with its items */
          }
        }
        setSources(srcs)
        setItems(job.items.filter((it) => srcs[it.sourceId]))
        Object.values(srcs).forEach((s) => void makeThumbs(s))
        for (const src of Object.values(srcs))
          for (const p of src.pages) {
            const c = await detectContent(src, p.index)
            setContents((m) => ({ ...m, [thumbKey(src.id, p.index)]: c }))
          }
        toast(`Your last job is back (${new Date(job.savedAt).toLocaleString()})`)
      }
      setRestored(true)
    })()
  }, [makeThumbs, toast])

  // ---- …and is saved on every change
  useEffect(() => {
    if (!restored) return
    const t = setTimeout(() => {
      const used = new Set(items.map((it) => it.sourceId))
      const files = Object.values(sources)
        .filter((s) => used.has(s.id))
        .map(({ id, name, kind, bytes }) => ({ id, name, kind, bytes }))
      void saveJob({ files, items, savedAt: Date.now() })
    }, 600)
    return () => clearTimeout(t)
  }, [items, sources, restored])

  const addFiles = useCallback(
    async (files: File[]) => {
      const errs: string[] = []
      setLoading((n) => n + files.length)
      for (const f of files) {
        try {
          const src = await readSource(f.name, new Uint8Array(await f.arrayBuffer()))
          const { settings: s, products: prods } = latest.current
          const many = src.pages.length > 1
          const found: Record<string, ContentInfo | null> = {}
          for (const p of src.pages) found[thumbKey(src.id, p.index)] = await detectContent(src, p.index)
          setContents((c) => ({ ...c, ...found }))
          const made = src.pages.map((p) =>
            newItemFor(
              newId('it'),
              many ? `${baseName(src.name)} · p${p.index + 1}` : baseName(src.name),
              src.id,
              p.index,
              p.geometry,
              prods,
              s.bleedMm,
              found[thumbKey(src.id, p.index)],
            ),
          )
          setSources((m) => ({ ...m, [src.id]: src }))
          setItems((list) => [
            ...list,
            ...made.map((m) => {
              const it: PrintCutItem & { product?: string } = { ...m }
              delete it.product
              return it
            }),
          ])
          const known = [...new Set(made.map((m) => m.product).filter(Boolean))]
          if (known.length) toast(`Recognised: ${known.join(', ')}`)
          void makeThumbs(src)
        } catch (e) {
          errs.push((e as Error).message)
        } finally {
          setLoading((n) => n - 1)
        }
      }
      setErrors(errs)
    },
    [makeThumbs, toast],
  )

  const update = useCallback((id: string, patch: Partial<PrintCutItem>) => setItems((l) => l.map((it) => (it.id === id ? { ...it, ...patch } : it))), [])
  const remove = useCallback((id: string) => setItems((l) => l.filter((it) => it.id !== id)), [])
  const duplicate = useCallback(
    (id: string) =>
      setItems((l) => {
        const i = l.findIndex((it) => it.id === id)
        if (i < 0) return l
        const copy = { ...l[i], id: newId('it'), name: `${l[i].name} (copy)` }
        return [...l.slice(0, i + 1), copy, ...l.slice(i + 1)]
      }),
    [],
  )
  const clear = useCallback(() => {
    setItems([])
    setSources({})
    setErrors([])
  }, [])

  const thumbOf = (it: PrintCutItem) => thumbs[thumbKey(it.sourceId, it.pageIndex)]
  const contentOf = (it: PrintCutItem) => contents[thumbKey(it.sourceId, it.pageIndex)] ?? null

  return { sources, items, setItems, thumbOf, contentOf, loading, errors, restored, addFiles, update, remove, duplicate, clear }
}

export type PrintCutJob = ReturnType<typeof usePrintCutJob>

/* ------------------------------------------------------------------ previews */

const previewKey = (it: PrintCutItem, bleedMm: number) => [it.sourceId, it.pageIndex, it.widthMm, it.heightMm, it.shape, it.cornerMm, it.bleedMode, it.fit, bleedMm, JSON.stringify(it.crop ?? null)].join('|')

/**
 * Each item's look on the sheet: the item rendered on its own from the same PDF code as the download
 * (so bleed, shape and clipping on screen are exactly what prints). One at a time, newest settings first.
 */
export function useItemPreviews(items: PrintCutItem[], sources: Record<string, SourceFile>, bleedMm: number): Record<string, ImageBitmap> {
  const [bitmaps, setBitmaps] = useState<Record<string, ImageBitmap>>({})
  const pending = useRef(new Set<string>())

  useEffect(() => {
    let cancelled = false
    const wanted = new Map(items.map((it) => [previewKey(it, bleedMm), it]))
    void (async () => {
      for (const [key, it] of wanted) {
        if (cancelled) return
        const src = sources[it.sourceId]
        if (!src || bitmaps[key] || pending.current.has(key)) continue
        pending.current.add(key)
        try {
          const pdf = await buildItemPreviewPdf(it, src, bleedMm, browserRasterizer)
          const { doc, destroy } = await openPdf(pdf)
          try {
            const page = await doc.getPage(1)
            const longest = Math.max(it.widthMm, it.heightMm) + 2 * bleedMm
            const canvas = await renderPage(page, Math.min(8, 2400 / longest)).promise
            const bmp = await createImageBitmap(canvas)
            setBitmaps((m) => ({ ...m, [key]: bmp }))
          } finally {
            destroy()
          }
        } catch {
          /* no preview – the cut line is still shown */
        } finally {
          pending.current.delete(key)
        }
      }
      // let go of pictures nothing uses any more
      setBitmaps((m) => {
        const stale = Object.keys(m).filter((k) => !wanted.has(k))
        if (!stale.length) return m
        const next = { ...m }
        for (const k of stale) {
          next[k].close()
          delete next[k]
        }
        return next
      })
    })()
    return () => {
      cancelled = true
    }
  }, [items, sources, bleedMm, bitmaps])

  const out: Record<string, ImageBitmap> = {}
  for (const it of items) {
    const b = bitmaps[previewKey(it, bleedMm)]
    if (b) out[it.id] = b
  }
  return out
}
