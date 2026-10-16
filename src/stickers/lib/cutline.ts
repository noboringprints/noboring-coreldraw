/**
 * Builds a sticker's cut line – what CorelDRAW's Contour tool + a "CutContour" outline does by hand:
 *
 *   1. the artwork's outline is taken from its transparency (alpha ≥ 50 %),
 *   2. pushed outward by the border width (exact Euclidean offset, so corners come out round),
 *   3. notches narrower than ~2 × smoothing are filled and holes closed, so the blade makes one smooth pass,
 *   4. traced and fitted with Bézier curves.
 *
 * It also makes the bleed: the region just past the cut that gets printed so a slightly shifted cut
 * never shows a white edge. Pure maths on pixel arrays – runs in a worker, in Node tests, anywhere.
 */
import type { CutParams } from '../config'
import type { Rect } from '../../lib/geometry'
import { components, distanceInside, distanceTo, distanceTransform, fillHoles } from './edt'
import { type BezierPath, type Pt, bezierThrough, ellipsePath, pathsBounds, roundedRectPath, simplifyClosed, smoothPolygon, traceContours } from './paths'

/** The artwork rendered at analysis resolution, inside a padded frame. */
export interface CutRaster {
  rgba: Uint8ClampedArray
  w: number
  h: number
  pxPerMm: number
  /** Local mm position of the raster's top-left corner (local frame: y up). */
  originX: number
  originTopY: number
}

/** Where everything sits in the sticker's own frame (mm, origin = bottom-left of the nominal cut box). */
export interface CutFrame {
  /** The art (its visible part) is placed here. */
  art: Rect
  /** Nominal cut box: art + border on every side. */
  box: Rect
  /** Raster frame: box + padding for smoothing / bleed. */
  frame: Rect
  pxPerMm: number
  w: number
  h: number
}

export interface CutGeometry {
  cut: BezierPath[]
  /** Cut line pushed out by the bleed: printing is clipped to this. */
  bleed: BezierPath[]
  bounds: Rect
  /** Edge colours carried past the art (only when there is no border). Straight RGBA, covers `rect`. */
  bleedImage?: { rgba: Uint8ClampedArray; w: number; h: number; rect: Rect }
  pieces: number
  warnings: string[]
}

/** Analysis resolution: ~300 DPI, fewer pixels for very big stickers. */
export function analysisPxPerMm(wMm: number, hMm: number, budget = 4_000_000): number {
  return Math.max(2, Math.min(12, Math.sqrt(budget / Math.max(1, wMm * hMm))))
}

export const borderOf = (p: CutParams) => (p.border === 'none' ? 0 : Math.max(0, p.borderMm))

/** Frame for an art of artW × artH mm. */
export function cutFrame(artW: number, artH: number, p: CutParams, bleedMm: number): CutFrame {
  const r = borderOf(p)
  const pad = Math.max(p.shape === 'contour' ? p.smoothMm : 0, bleedMm) + 1
  const box = { x: 0, y: 0, w: artW + 2 * r, h: artH + 2 * r }
  const frame = { x: -pad, y: -pad, w: box.w + 2 * pad, h: box.h + 2 * pad }
  const k = analysisPxPerMm(frame.w, frame.h)
  return {
    art: { x: r, y: r, w: artW, h: artH },
    box,
    frame,
    pxPerMm: k,
    w: Math.max(4, Math.ceil(frame.w * k)),
    h: Math.max(4, Math.ceil(frame.h * k)),
  }
}

/** Shape cut lines are exact vectors (no pixels involved). */
function shapePath(p: CutParams, box: Rect, grow: number): BezierPath {
  const b = { x: box.x - grow, y: box.y - grow, w: box.w + 2 * grow, h: box.h + 2 * grow }
  if (p.shape === 'circle') return ellipsePath(b.x + b.w / 2, b.y + b.h / 2, b.w / 2, b.h / 2)
  const radius = p.shape === 'rounded' ? p.cornerMm + grow : 0
  return roundedRectPath(b.x, b.y, b.w, b.h, radius)
}

/** Is the raster pixel's centre inside the shape grown by `grow` mm? */
function insideShape(p: CutParams, box: Rect, grow: number, x: number, y: number): boolean {
  const b = { x: box.x - grow, y: box.y - grow, w: box.w + 2 * grow, h: box.h + 2 * grow }
  if (p.shape === 'circle') {
    const rx = b.w / 2
    const ry = b.h / 2
    const u = (x - b.x - rx) / rx
    const v = (y - b.y - ry) / ry
    return u * u + v * v <= 1
  }
  if (x < b.x || x > b.x + b.w || y < b.y || y > b.y + b.h) return false
  const r = p.shape === 'rounded' ? Math.min(p.cornerMm + grow, b.w / 2, b.h / 2) : 0
  if (r <= 0) return true
  const cx = Math.min(Math.max(x, b.x + r), b.x + b.w - r)
  const cy = Math.min(Math.max(y, b.y + r), b.y + b.h - r)
  return (x - cx) ** 2 + (y - cy) ** 2 <= r * r
}

function loopsToPaths(loops: Pt[][], r: CutRaster, minAreaMm2: number): BezierPath[] {
  const k = r.pxPerMm
  const out: BezierPath[] = []
  for (const loop of loops) {
    const mm: Pt[] = loop.map(([px, py]) => [r.originX + px / k, r.originTopY - py / k])
    let area = 0
    for (let i = 0, j = mm.length - 1; i < mm.length; j = i++) area += (mm[j][0] - mm[i][0]) * (mm[j][1] + mm[i][1])
    if (Math.abs(area / 2) < minAreaMm2) continue
    const simple = simplifyClosed(smoothPolygon(mm, 2), Math.max(0.02, 0.35 / k))
    if (simple.length >= 3) out.push(bezierThrough(simple))
  }
  return out
}

/**
 * The whole cut-line computation for one sticker.
 * `raster` is the art drawn into `frame` (see cutFrame) at frame.pxPerMm.
 */
export function computeCut(raster: CutRaster, frame: CutFrame, p: CutParams, bleedMm: number): CutGeometry {
  const { w, h, rgba, pxPerMm: k } = raster
  const n = w * h
  const warnings: string[] = []
  const r = borderOf(p)

  // ---- the art's outline: alpha ≥ 50 %, minus specks of dust (e.g. left over from background removal)
  let mask = new Uint8Array(n)
  for (let i = 0; i < n; i++) mask[i] = rgba[i * 4 + 3] >= 128 ? 1 : 0
  const { labels, sizes } = components(mask, w, h)
  const speck = Math.max(3, 0.2 * k * k) // < 0.2 mm²
  if (sizes.some((s, i) => i > 0 && s < speck)) {
    mask = new Uint8Array(n)
    for (let i = 0; i < n; i++) mask[i] = labels[i] && sizes[labels[i]] >= speck ? 1 : 0
  }
  const empty = !mask.some((v) => v)
  if (empty && p.shape === 'contour') {
    return { cut: [], bleed: [], bounds: { x: 0, y: 0, w: 0, h: 0 }, pieces: 0, warnings: ['The image is fully transparent – there is nothing to cut around.'] }
  }

  // ---- cut region (as a field whose `level` crossing is the cut line)
  let cut: BezierPath[]
  let inCut: Uint8Array
  if (p.shape === 'contour') {
    const R = r * k
    const S = Math.max(0, p.smoothMm) * k
    let field: Float32Array
    let level: number
    if (R === 0 && S === 0) {
      // straight on the art edge: trace the alpha itself (sub-pixel exact), holes filled
      const filled = fillHoles(mask, w, h)
      field = new Float32Array(n)
      for (let i = 0; i < n; i++) {
        const a = rgba[i * 4 + 3]
        if (mask[i]) field[i] = a
        else if (filled[i]) field[i] = 255 // enclosed hole
        else field[i] = a >= 128 ? 0 : a // outside (a removed speck counts as empty)
      }
      level = 127.5
    } else {
      const dOut = distanceTo(mask, w, h)
      const grown = new Uint8Array(n)
      for (let i = 0; i < n; i++) grown[i] = dOut[i] <= R + S ? 1 : 0
      const closed = fillHoles(grown, w, h)
      if (S > 0) {
        // closing: grow by border + smoothing, then shrink back by smoothing
        field = distanceInside(closed, w, h)
        level = S + 0.5
      } else {
        field = new Float32Array(n)
        for (let i = 0; i < n; i++) field[i] = closed[i] && dOut[i] > R ? 1 : R - dOut[i]
        level = 0
      }
    }
    // keep the frame's outer ring outside, so every outline closes
    for (let x = 0; x < w; x++) field[x] = field[n - w + x] = -1
    for (let y = 0; y < h; y++) field[y * w] = field[y * w + w - 1] = -1
    cut = loopsToPaths(traceContours(field, w, h, level), raster, 0.5)
    inCut = new Uint8Array(n)
    for (let i = 0; i < n; i++) inCut[i] = field[i] >= level ? 1 : 0
  } else {
    cut = [shapePath(p, frame.box, 0)]
    inCut = new Uint8Array(n)
    for (let y = 0; y < h; y++)
      for (let x = 0; x < w; x++) inCut[y * w + x] = insideShape(p, frame.box, 0, raster.originX + (x + 0.5) / k, raster.originTopY - (y + 0.5) / k) ? 1 : 0
  }

  if (!cut.length) return { cut: [], bleed: [], bounds: { x: 0, y: 0, w: 0, h: 0 }, pieces: 0, warnings: ['Could not find an outline to cut around.'] }

  // ---- bleed region: the cut region pushed out by the bleed (a sliver more when cutting right on the art)
  const b = Math.max(bleedMm, p.border === 'none' ? 0.25 : 0)
  let bleed: BezierPath[]
  let inBleed: Uint8Array
  if (p.shape === 'contour') {
    const dCut = distanceTo(inCut, w, h)
    const B = b * k
    const field = new Float32Array(n)
    for (let i = 0; i < n; i++) field[i] = B + 0.5 - dCut[i]
    for (let x = 0; x < w; x++) field[x] = field[n - w + x] = -1
    for (let y = 0; y < h; y++) field[y * w] = field[y * w + w - 1] = -1
    bleed = loopsToPaths(traceContours(field, w, h, 0), raster, 0.5)
    inBleed = new Uint8Array(n)
    for (let i = 0; i < n; i++) inBleed[i] = field[i] >= 0 ? 1 : 0
  } else {
    bleed = [shapePath(p, frame.box, b)]
    inBleed = new Uint8Array(n)
    for (let y = 0; y < h; y++)
      for (let x = 0; x < w; x++) inBleed[y * w + x] = insideShape(p, frame.box, b, raster.originX + (x + 0.5) / k, raster.originTopY - (y + 0.5) / k) ? 1 : 0
  }

  // ---- no border: carry the art's edge colours out past the cut line (nearest solid pixel)
  let bleedImage: CutGeometry['bleedImage']
  if (p.border === 'none' && !empty) {
    const solid = new Uint8Array(n)
    let any = false
    for (let i = 0; i < n; i++)
      if (mask[i] && rgba[i * 4 + 3] >= 250) {
        solid[i] = 1
        any = true
      }
    const src = any ? solid : mask
    const { nearest } = distanceTransform(src, w, h, true)
    // crop to where something is drawn
    let x0 = w
    let y0 = h
    let x1 = -1
    let y1 = -1
    for (let y = 0; y < h; y++)
      for (let x = 0; x < w; x++) {
        const i = y * w + x
        if (inBleed[i] && !src[i]) {
          if (x < x0) x0 = x
          if (x > x1) x1 = x
          if (y < y0) y0 = y
          if (y > y1) y1 = y
        }
      }
    if (x1 >= x0) {
      const bw = x1 - x0 + 1
      const bh = y1 - y0 + 1
      const out = new Uint8ClampedArray(bw * bh * 4)
      for (let y = y0; y <= y1; y++)
        for (let x = x0; x <= x1; x++) {
          const i = y * w + x
          if (!inBleed[i] || src[i]) continue
          const j = nearest![i] * 4
          const o = ((y - y0) * bw + (x - x0)) * 4
          out[o] = rgba[j]
          out[o + 1] = rgba[j + 1]
          out[o + 2] = rgba[j + 2]
          out[o + 3] = 255
        }
      bleedImage = { rgba: out, w: bw, h: bh, rect: { x: raster.originX + x0 / k, y: raster.originTopY - (y1 + 1) / k, w: bw / k, h: bh / k } }
    }
  }

  // ---- checks
  if (p.shape === 'contour' && cut.length > 1)
    warnings.push(`This cut line makes ${cut.length} separate pieces. Raise “Smoothing” or the border to join them into one sticker.`)
  if (p.shape !== 'contour' && !empty) {
    // art outside the cut gets cut off
    let lost = 0
    let total = 0
    for (let i = 0; i < n; i++)
      if (mask[i]) {
        total++
        if (!inCut[i]) lost++
      }
    if (total && lost / total > 0.02) warnings.push(`About ${Math.round((lost / total) * 100)} % of the artwork is outside this shape and will be cut off.`)
  }

  return { cut, bleed, bounds: pathsBounds(cut), bleedImage, pieces: cut.length, warnings }
}
