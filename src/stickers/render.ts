/**
 * On-screen drawing of stickers with Canvas 2D – the same layers as the PDF (border fill, edge bleed, art, cut line).
 * The context must already map the sticker's local mm (y up) to the canvas.
 */
import type { CSSProperties } from 'react'
import type { Rect } from '../lib/geometry'
import type { BorderStyle, StickerSettings } from './config'
import type { BezierPath } from './lib/paths'
import { markDots, markRects } from './lib/marks'

export interface StickerVisual {
  cut: BezierPath[]
  bleed: BezierPath[]
  border: BorderStyle
  borderColor: string
  art: ImageBitmap | null
  artRect: Rect
  bleedImg?: ImageBitmap | null
  bleedRect?: Rect
}

const cache = new WeakMap<BezierPath[], Path2D>()
export function path2d(paths: BezierPath[]): Path2D {
  let p = cache.get(paths)
  if (!p) {
    p = new Path2D()
    for (const q of paths) {
      p.moveTo(q.start[0], q.start[1])
      for (const s of q.segs) p.bezierCurveTo(s[0], s[1], s[2], s[3], s[4], s[5])
      p.closePath()
    }
    cache.set(paths, p)
  }
  return p
}

function drawImageYUp(ctx: CanvasRenderingContext2D, img: CanvasImageSource, r: Rect) {
  ctx.save()
  ctx.translate(r.x, r.y + r.h)
  ctx.scale(1, -1)
  ctx.drawImage(img, 0, 0, r.w, r.h)
  ctx.restore()
}

/** Everything that gets printed for one sticker, clipped to its bleed outline (or to the cut line for the finished look). */
export function drawPrint(ctx: CanvasRenderingContext2D, v: StickerVisual, clipTo: 'bleed' | 'cut' = 'bleed') {
  ctx.save()
  ctx.clip(path2d(clipTo === 'cut' ? v.cut : v.bleed))
  if (clipTo === 'cut') {
    // the sticker material itself is white
    ctx.fillStyle = '#fff'
    ctx.fill(path2d(v.cut))
  }
  if (v.border === 'color') {
    ctx.fillStyle = v.borderColor
    ctx.fill(path2d(v.bleed))
  }
  if (v.bleedImg && v.bleedRect) drawImageYUp(ctx, v.bleedImg, v.bleedRect)
  ctx.imageSmoothingQuality = 'high'
  if (v.art) drawImageYUp(ctx, v.art, v.artRect)
  ctx.restore()
}

/** The cut line, `px` device pixels wide whatever the zoom (`pxPerUnit` = device px per mm). */
export function drawCut(ctx: CanvasRenderingContext2D, v: StickerVisual, color: string, px: number, pxPerUnit: number, dash?: number[]) {
  ctx.save()
  ctx.strokeStyle = color
  ctx.lineWidth = px / pxPerUnit
  ctx.lineJoin = 'round'
  if (dash) ctx.setLineDash(dash.map((d) => d / pxPerUnit))
  ctx.stroke(path2d(v.cut))
  ctx.restore()
}

/** Registration marks (context in sheet mm, y up). */
export function drawMarks(ctx: CanvasRenderingContext2D, s: StickerSettings) {
  ctx.fillStyle = '#111'
  for (const r of markRects(s)) ctx.fillRect(r.x, r.y, r.w, r.h)
  for (const d of markDots(s)) {
    ctx.beginPath()
    ctx.arc(d.cx, d.cy, d.r, 0, 2 * Math.PI)
    ctx.fill()
  }
}

/** Checkerboard pattern that shows transparency. */
export const CHECKER: CSSProperties = {
  backgroundColor: '#fff',
  backgroundImage: 'repeating-conic-gradient(#e7e9f0 0% 25%, transparent 0% 50%)',
  backgroundSize: '16px 16px',
}
