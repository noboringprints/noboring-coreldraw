/** Registration marks for print-and-cut: where the cutter's optical sensor finds the sheet. */
import type { Rect } from '../../lib/geometry'
import type { StickerSettings } from '../config'

/** Filled rectangles (mm, y up) that make up the registration marks. */
export function markRects(s: StickerSettings): Rect[] {
  const { style, sizeMm: S, lengthMm: L, thicknessMm: t } = s.marks
  if (style === 'none' || style === 'dots') return []
  const m = s.marginMm
  const W = s.sheet.widthMm
  const H = s.sheet.heightMm
  const square = (x: number, y: number): Rect => ({ x, y, w: S, h: S })
  // an L whose outer corner is at (cx, cy), arms running into the sheet (sx, sy = ±1)
  const ell = (cx: number, cy: number, sx: 1 | -1, sy: 1 | -1): Rect[] => [
    { x: sx > 0 ? cx : cx - L, y: sy > 0 ? cy : cy - t, w: L, h: t },
    { x: sx > 0 ? cx : cx - t, y: sy > 0 ? cy : cy - L, w: t, h: L },
  ]
  if (style === 'squares') return [square(m, m), square(W - m - S, m), square(m, H - m - S), square(W - m - S, H - m - S)]
  const bl = ell(m, m, 1, 1)
  const br = ell(W - m, m, -1, 1)
  const tr = ell(W - m, H - m, -1, -1)
  if (style === 'silhouette') return [square(m, H - m - S), ...bl, ...br, ...tr]
  return [...bl, ...br, ...tr, ...ell(m, H - m, 1, -1)]
}

/**
 * Round dot marks (mm, y up): one filled black circle in each corner, its outer edge `marginMm`
 * from both sheet edges. Die-cut / flatbed cutters find the dots with their camera and start cutting from them.
 */
export function markDots(s: StickerSettings): { cx: number; cy: number; r: number }[] {
  if (s.marks.style !== 'dots') return []
  const r = s.marks.sizeMm / 2
  const lo = s.marginMm + r
  const right = s.sheet.widthMm - lo
  const top = s.sheet.heightMm - lo
  return [
    { cx: lo, cy: lo, r },
    { cx: right, cy: lo, r },
    { cx: lo, cy: top, r },
    { cx: right, cy: top, r },
  ]
}
