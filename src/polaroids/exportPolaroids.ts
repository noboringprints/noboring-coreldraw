/**
 * Polaroid sheets → PDF. Each polaroid is rendered once at 300 DPI (render.ts) and placed like a rectangular
 * sticker: the sticker export writes the sheet (Print layer, CutContour spot-colour layer, registration marks).
 * For guillotine work, crop marks are added at every corner, kept out of the neighbouring polaroids.
 * Runs in the browser and in Node – the caller supplies the renderer.
 */
import { PDFDocument, lineTo, moveTo, popGraphicsState, pushGraphicsState, setLineWidth, setStrokingCmykColor, stroke } from 'pdf-lib'
import { PT_PER_MM } from '../config/defaults'
import { type Rect, expand } from '../lib/geometry'
import { itemShape } from '../printcut/model'
import type { StickerSettings } from '../stickers/config'
import { type ExportDesign, type ExportMode, buildStickerPdf } from '../stickers/lib/exportStickers'
import { type NestDesign, type StickerSheetLayout, placementRect } from '../stickers/lib/nest'
import { CROP_MARK, type PolaroidItem, type PolaroidSettings, cornerFor, formatOf } from './model'

/** Cut line (trim) and bleed outline of a polaroid, local mm y up – cached, so nesting can cache on it. */
export function polaroidShape(it: Pick<PolaroidItem, 'formatId' | 'custom'>, p: PolaroidSettings) {
  const f = formatOf(it)
  const r = cornerFor(p)
  return itemShape({ widthMm: f.widthMm, heightMm: f.heightMm, shape: r > 0 ? 'rounded' : 'rect', cornerMm: r }, p.bleedMm)
}

export function polaroidNestDesigns(items: PolaroidItem[], p: PolaroidSettings): NestDesign[] {
  return items.map((it) => ({ id: it.id, name: it.name, ...polaroidShape(it, p), copies: Math.max(0, it.copies), rotation: it.rotation }))
}

/* ------------------------------------------------------------------ crop marks */

export interface Line {
  x1: number
  y1: number
  x2: number
  y2: number
}

/**
 * Crop marks for one sheet (mm, y up): at each polaroid corner, two short lines carrying the trim edges outward.
 * Every mark starts clear of the bleed and is shortened so it never prints on another polaroid or off the sheet.
 */
export function cropMarks(sheet: StickerSheetLayout, shapes: Record<string, { bounds: Rect }>, s: StickerSettings): Line[] {
  const rects = sheet.placements.map((p) => (shapes[p.designId] ? placementRect(p, shapes[p.designId].bounds, s) : null)).filter((r): r is Rect => !!r)
  const keepOut = rects.map((r) => expand(r, s.bleedMm + 0.3))
  const lo = 1
  const hiX = s.sheet.widthMm - 1
  const hiY = s.sheet.heightMm - 1
  const off = s.bleedMm + CROP_MARK.offsetMm
  const out: Line[] = []
  const seen = new Set<string>()
  const add = (l: Line) => {
    const key = [l.x1, l.y1, l.x2, l.y2].map((v) => v.toFixed(2)).join(',')
    if (!seen.has(key)) {
      seen.add(key)
      out.push(l)
    }
  }
  /** Longest free run from (x, y) in direction (dx, dy), up to `max`. */
  const free = (x: number, y: number, dx: number, dy: number, max: number) => {
    let len = max
    if (dx > 0) len = Math.min(len, hiX - x)
    if (dx < 0) len = Math.min(len, x - lo)
    if (dy > 0) len = Math.min(len, hiY - y)
    if (dy < 0) len = Math.min(len, y - lo)
    for (const k of keepOut) {
      if (dx !== 0) {
        if (y < k.y || y > k.y + k.h) continue
        if (x >= k.x && x <= k.x + k.w) return 0
        if (dx > 0 && k.x >= x) len = Math.min(len, k.x - x)
        if (dx < 0 && k.x + k.w <= x) len = Math.min(len, x - (k.x + k.w))
      } else {
        if (x < k.x || x > k.x + k.w) continue
        if (y >= k.y && y <= k.y + k.h) return 0
        if (dy > 0 && k.y >= y) len = Math.min(len, k.y - y)
        if (dy < 0 && k.y + k.h <= y) len = Math.min(len, y - (k.y + k.h))
      }
    }
    return Math.max(0, len)
  }
  for (const r of rects) {
    for (const [cx, sx] of [
      [r.x, -1],
      [r.x + r.w, 1],
    ] as const)
      for (const [cy, sy] of [
        [r.y, -1],
        [r.y + r.h, 1],
      ] as const) {
        // along the horizontal edge (y = cy), outward in x
        const hx = cx + sx * off
        const hl = free(hx, cy, sx, 0, CROP_MARK.lengthMm)
        if (hl >= CROP_MARK.minMm) add({ x1: hx, y1: cy, x2: hx + sx * hl, y2: cy })
        // along the vertical edge (x = cx), outward in y
        const vy = cy + sy * off
        const vl = free(cx, vy, 0, sy, CROP_MARK.lengthMm)
        if (vl >= CROP_MARK.minMm) add({ x1: cx, y1: vy, x2: cx, y2: vy + sy * vl })
      }
  }
  return out
}

/* ------------------------------------------------------------------ PDF */

/** Renders one polaroid with its bleed, top row first (JPEG or PNG bytes). */
export type PolaroidRenderer = (it: PolaroidItem, bleedMm: number) => Promise<{ bytes: Uint8Array; kind: 'jpg' | 'png' }>

export async function buildPolaroidPdf(
  sheets: StickerSheetLayout[],
  items: PolaroidItem[],
  p: PolaroidSettings,
  s: StickerSettings,
  render: PolaroidRenderer,
  opts: { mode?: ExportMode; title?: string; date?: Date; onProgress?: (done: number, total: number) => void } = {},
): Promise<Uint8Array> {
  const used = new Set(sheets.flatMap((sh) => sh.placements.map((pl) => pl.designId)))
  const todo = items.filter((it) => used.has(it.id))
  const designs: Record<string, ExportDesign> = {}
  const b = Math.max(0, p.bleedMm)
  for (const [i, it] of todo.entries()) {
    opts.onProgress?.(i, todo.length)
    const f = formatOf(it)
    const { cut, bleed, bounds } = polaroidShape(it, p)
    // a cut-only file has no artwork to render
    const art = opts.mode === 'cut' && p.finish === 'printcut' ? null : await render(it, b)
    designs[it.id] = {
      id: it.id,
      name: it.name,
      cut,
      bleed,
      bounds,
      border: 'none',
      borderColor: '#000000',
      ...(art ? { art: { bytes: art.bytes, kind: art.kind, rect: { x: -b, y: -b, w: f.widthMm + 2 * b, h: f.heightMm + 2 * b } } } : {}),
    }
  }
  opts.onProgress?.(todo.length, todo.length)
  const mode: ExportMode = p.finish === 'printcut' ? (opts.mode ?? 'print-cut') : 'print'
  const bytes = await buildStickerPdf(sheets, designs, s, { mode, date: opts.date, title: opts.title ?? 'Polaroid sheets', noun: 'polaroid' })
  if (p.finish !== 'crop') return bytes

  // crop marks, on top of everything
  const doc = await PDFDocument.load(bytes)
  const pages = doc.getPages()
  sheets.forEach((sh, i) => {
    const page = pages[i]
    if (!page) return
    const lines = cropMarks(sh, designs, s)
    if (!lines.length) return
    page.pushOperators(pushGraphicsState(), setStrokingCmykColor(0, 0, 0, 1), setLineWidth(CROP_MARK.lineWidthPt))
    for (const l of lines) page.pushOperators(moveTo(l.x1 * PT_PER_MM, l.y1 * PT_PER_MM), lineTo(l.x2 * PT_PER_MM, l.y2 * PT_PER_MM), stroke())
    page.pushOperators(popGraphicsState())
  })
  return doc.save({ useObjectStreams: false })
}
