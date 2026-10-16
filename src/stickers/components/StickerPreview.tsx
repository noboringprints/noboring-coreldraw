import { useEffect, useMemo, useRef, useState } from 'react'
import type { Rect } from '../../lib/geometry'
import type { Units } from '../config'
import { pathsBounds } from '../lib/paths'
import { fmtLen } from '../model'
import { type StickerVisual, drawCut, drawPrint, path2d } from '../render'

export type PreviewMode = 'print' | 'finished'

/**
 * One sticker, big. 'print' = as printed, with the cut line (and bleed outline) on white paper.
 * 'finished' = what the customer peels off: only what's inside the cut line, with a shadow.
 */
export default function StickerPreview(props: {
  visual: StickerVisual | null
  /** Shown while there's no cut line yet. */
  fallback: { art: ImageBitmap | null; box: Rect }
  mode: PreviewMode
  showBleed: boolean
  cutColor: string
  units: Units
  updating: boolean
}) {
  const host = useRef<HTMLDivElement>(null)
  const canvas = useRef<HTMLCanvasElement>(null)
  const [size, setSize] = useState({ w: 0, h: 0 })

  useEffect(() => {
    const el = host.current
    if (!el) return
    const ro = new ResizeObserver(() => setSize({ w: el.clientWidth, h: el.clientHeight }))
    ro.observe(el)
    return () => ro.disconnect()
  }, [])

  const { visual, fallback, mode, showBleed, cutColor } = props
  const fb = fallback.box
  // where the sticker sits on screen: the cut line's box (what the customer gets), centred with paper around it
  const view = useMemo(() => {
    const b = visual ? pathsBounds(visual.cut) : { x: fb.x, y: fb.y, w: fb.w, h: fb.h }
    if (b.w <= 0 || b.h <= 0 || !size.w || !size.h) return null
    const pad = Math.max(4, Math.max(b.w, b.h) * 0.08) // mm of paper around the sticker
    const z = Math.min((size.w - 96) / (b.w + 2 * pad), (size.h - 96) / (b.h + 2 * pad)) // css px per mm
    return { b, pad, z, ox: (size.w - b.w * z) / 2, oy: (size.h - b.h * z) / 2 }
  }, [visual, fb.x, fb.y, fb.w, fb.h, size])

  useEffect(() => {
    const c = canvas.current
    if (!c || !view) return
    const dpr = window.devicePixelRatio || 1
    c.width = Math.round(size.w * dpr)
    c.height = Math.round(size.h * dpr)
    const ctx = c.getContext('2d')!
    const { b, pad, z, ox, oy } = view
    // local mm (y up) → device px
    ctx.setTransform(dpr * z, 0, 0, -dpr * z, dpr * (ox - b.x * z), dpr * (oy + (b.y + b.h) * z))
    const pxPerMm = dpr * z

    if (mode === 'print') {
      ctx.save()
      ctx.shadowColor = 'rgba(0,0,0,.35)'
      ctx.shadowBlur = 24 * dpr
      ctx.shadowOffsetY = -6 * dpr
      ctx.fillStyle = '#fff'
      roundRect(ctx, b.x - pad, b.y - pad, b.w + 2 * pad, b.h + 2 * pad, 2)
      ctx.fill()
      ctx.restore()
      if (visual) {
        drawPrint(ctx, visual, 'bleed')
        if (showBleed) {
          ctx.save()
          ctx.strokeStyle = '#64748b'
          ctx.lineWidth = 1 / z
          ctx.setLineDash([4 / z, 3 / z])
          ctx.stroke(path2d(visual.bleed))
          ctx.restore()
        }
        drawCut(ctx, visual, cutColor, 1.6 * dpr, pxPerMm)
      } else if (fallback.art) {
        drawArt(ctx, fallback.art, fallback.box)
      }
    } else if (visual) {
      ctx.save()
      ctx.shadowColor = 'rgba(0,0,0,.45)'
      ctx.shadowBlur = 18 * dpr
      ctx.shadowOffsetY = -5 * dpr
      ctx.fillStyle = '#fff'
      ctx.fill(path2d(visual.cut))
      ctx.restore()
      drawPrint(ctx, visual, 'cut')
      drawCut(ctx, visual, 'rgba(0,0,0,.12)', 1 * dpr, pxPerMm)
    } else if (fallback.art) {
      drawArt(ctx, fallback.art, fallback.box)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [view, visual, fallback.art, mode, showBleed, cutColor])

  // dimension lines sit just outside the paper (print view) or the sticker (finished view)
  const gap = view ? (mode === 'print' ? view.pad * view.z : 0) + 12 : 0
  const labels = view && { w: fmtLen(view.b.w, props.units), h: fmtLen(view.b.h, props.units), x: view.ox, y: view.oy, bw: view.b.w * view.z, bh: view.b.h * view.z }

  return (
    <div ref={host} className="relative h-full w-full overflow-hidden">
      <canvas ref={canvas} className="absolute inset-0 h-full w-full" />
      {labels && (
        <>
          <div className="pointer-events-none absolute flex items-center gap-2" style={{ left: labels.x, top: labels.y + labels.bh + gap, width: labels.bw }}>
            <span className="h-px flex-1 bg-white/25" />
            <span className="rounded-md bg-white/10 px-1.5 py-0.5 text-[11px] font-semibold text-white/80 tabular-nums">{labels.w}</span>
            <span className="h-px flex-1 bg-white/25" />
          </div>
          <div className="pointer-events-none absolute flex flex-col items-center gap-2" style={{ left: labels.x + labels.bw + gap, top: labels.y, height: labels.bh }}>
            <span className="w-px flex-1 bg-white/25" />
            <span className="rounded-md bg-white/10 px-1.5 py-0.5 text-[11px] font-semibold text-white/80 tabular-nums">{labels.h}</span>
            <span className="w-px flex-1 bg-white/25" />
          </div>
        </>
      )}
      {props.updating && (
        <div className="absolute top-3 left-1/2 flex -translate-x-1/2 items-center gap-2 rounded-full bg-black/50 px-3 py-1.5 text-xs font-medium text-white/90 backdrop-blur">
          <span className="h-3 w-3 animate-spin rounded-full border-2 border-white/30 border-t-white" /> Updating cut line…
        </div>
      )}
    </div>
  )
}

function drawArt(ctx: CanvasRenderingContext2D, img: ImageBitmap, r: Rect) {
  ctx.save()
  ctx.translate(r.x, r.y + r.h)
  ctx.scale(1, -1)
  ctx.drawImage(img, 0, 0, r.w, r.h)
  ctx.restore()
}

function roundRect(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, r: number) {
  ctx.beginPath()
  ctx.roundRect(x, y, w, h, r)
}
