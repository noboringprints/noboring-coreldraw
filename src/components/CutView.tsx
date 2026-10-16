import { useEffect, useMemo, useState } from 'react'
import type { PDFPageProxy } from 'pdfjs-dist'
import { Scissors } from 'lucide-react'
import type { ArtRef } from '../lib/job'
import type { Placement, Sheet } from '../lib/layout'
import { renderPage } from '../lib/pdfRender'
import { CanvasView, fmtMm } from './ui'

const GAP = 28 // px between pieces
const LABEL_H = 44 // px under each piece for its name and size
const PAD = 40

/**
 * "After cutting": every piece of the sheet as it comes off the guillotine –
 * cut exactly on the trim line (bleed and crop marks gone), turned upright, all at the same scale.
 * The pixels are cropped from the real print PDF of the sheet.
 */
export default function CutView(props: {
  sheet: Sheet<ArtRef>
  sheetKey: string
  sheetH: number
  vp: { w: number; h: number }
  loadPage: (s: Sheet<ArtRef>) => Promise<PDFPageProxy>
}) {
  const { sheet, vp } = props
  const pieces = sheet.placements

  // one shared scale (px per mm) so pieces keep their real sizes relative to each other; try 1…n rows, keep the biggest
  const layout = useMemo(() => {
    const availW = vp.w - 2 * PAD
    const availH = vp.h - 2 * PAD - 90 // room for the caption and the controls at the top
    let best = { scale: 0, cols: Math.max(1, pieces.length) }
    for (let rows = 1; rows <= pieces.length; rows++) {
      const cols = Math.ceil(pieces.length / rows)
      let maxRowW = 0
      let sumH = 0
      for (let r = 0; r < rows; r++) {
        const row = pieces.slice(r * cols, (r + 1) * cols)
        if (!row.length) continue
        maxRowW = Math.max(maxRowW, row.reduce((n, p) => n + p.item.trimW, 0))
        sumH += Math.max(...row.map((p) => p.item.trimH))
      }
      const used = Math.ceil(pieces.length / cols)
      const scale = Math.min((availW - GAP * (cols - 1)) / maxRowW, (availH - (GAP + LABEL_H) * used) / sumH)
      if (scale > best.scale) best = { scale, cols }
    }
    const scale = Math.max(0.2, best.scale)
    // widest row at that scale: the pieces wrap into exactly the chosen rows
    let rowW = 0
    for (let i = 0; i < pieces.length; i += best.cols) {
      const row = pieces.slice(i, i + best.cols)
      rowW = Math.max(rowW, row.reduce((n, p) => n + Math.max(140, p.item.trimW * scale), 0) + GAP * (row.length - 1))
    }
    return { scale, rowW }
  }, [pieces, vp.w, vp.h])

  // render resolution: enough for the screen, in steps so resizing doesn't re-render all the time
  const dpr = window.devicePixelRatio || 1
  const res = Math.min(14, Math.max(2, 2 ** Math.ceil(Math.log2(layout.scale * dpr))))
  const want = `${props.sheetKey}@${res}`
  const [shots, setShots] = useState<{ key: string; canvases: HTMLCanvasElement[] } | null>(null)

  useEffect(() => {
    if (shots?.key === want) return
    let cancelled = false
    const jobs: { cancel: () => void }[] = []
    const t = setTimeout(async () => {
      try {
        const page = await props.loadPage(sheet)
        if (cancelled) return
        const canvases = await Promise.all(
          pieces.map((p) => {
            const job = renderPage(page, res, trimRegion(p, props.sheetH, res))
            jobs.push(job)
            return job.promise.then((c) => upright(c, p.rotation))
          }),
        )
        if (!cancelled) setShots({ key: want, canvases })
      } catch {
        /* superseded or unreadable – the placeholders stay */
      }
    }, 100)
    return () => {
      cancelled = true
      clearTimeout(t)
      jobs.forEach((j) => j.cancel())
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [want])

  const fresh = shots?.key.startsWith(props.sheetKey + '@')
  const s = layout.scale
  return (
    <div
      className="absolute inset-0 z-20 flex animate-fade-up flex-col items-center overflow-auto bg-canvas"
      style={{ padding: PAD, paddingTop: 76 }}
      onPointerDown={(e) => e.stopPropagation()}
      onPointerMove={(e) => e.stopPropagation()}
    >
      <p className="mb-5 flex items-center gap-2 text-sm text-slate-300">
        <Scissors size={15} className="text-brand-300" />
        After cutting – bleed and crop marks trimmed away. {pieces.length === 1 ? '1 piece' : `${pieces.length} pieces`} from this sheet.
      </p>
      <div className="m-auto flex flex-wrap justify-center" style={{ gap: GAP, width: Math.ceil(layout.rowW) + 1 }}>
        {pieces.map((p, i) => {
          const c = fresh ? shots!.canvases[i] : undefined
          return (
            <figure key={p.id} className="flex flex-col items-center">
              <div
                className="relative bg-white shadow-[0_18px_50px_rgb(0_0_0/0.55)] transition-transform duration-200 hover:-translate-y-1"
                style={{ width: p.item.trimW * s, height: p.item.trimH * s }}
              >
                {c ? (
                  <CanvasView canvas={c} label={`${p.item.name} after cutting`} className="h-full w-full" />
                ) : (
                  <div className="grid h-full w-full place-items-center">
                    <span className="h-6 w-6 animate-spin rounded-full border-2 border-slate-300 border-t-brand-500" />
                  </div>
                )}
              </div>
              <figcaption className="mt-3 max-w-full text-center" style={{ width: Math.max(140, p.item.trimW * s) }}>
                <div className="truncate text-sm font-semibold text-white">
                  {p.item.name}
                  {p.item.panel && <span className="font-normal text-slate-400"> · panel {p.item.panel.index} of {p.item.panel.total}</span>}
                </div>
                <div className="text-xs text-slate-400 tabular-nums">
                  {fmtMm(p.item.trimW)} × {fmtMm(p.item.trimH)} mm
                </div>
              </figcaption>
            </figure>
          )
        })}
      </div>
    </div>
  )
}

/** The trim rectangle of a placement, in pixels of the sheet rendered at `res` px/mm (top-left origin). */
function trimRegion(p: Placement, sheetH: number, res: number) {
  const x0 = Math.round(p.trim.x * res)
  const y0 = Math.round((sheetH - p.trim.y - p.trim.h) * res)
  const x1 = Math.round((p.trim.x + p.trim.w) * res)
  const y1 = Math.round((sheetH - p.trim.y) * res)
  return { x: x0, y: y0, w: Math.max(1, x1 - x0), h: Math.max(1, y1 - y0) }
}

/** Turns a piece back to the design's own orientation (it was placed `rotation`° counter-clockwise). Lossless quarter turns. */
function upright(c: HTMLCanvasElement, rotation: number): HTMLCanvasElement {
  if (!rotation) return c
  const side = rotation === 90 || rotation === 270
  const out = document.createElement('canvas')
  out.width = side ? c.height : c.width
  out.height = side ? c.width : c.height
  const ctx = out.getContext('2d')!
  ctx.translate(out.width / 2, out.height / 2)
  ctx.rotate((rotation * Math.PI) / 180) // clockwise on screen = undoes the counter-clockwise placement
  ctx.drawImage(c, -c.width / 2, -c.height / 2)
  return out
}
