/**
 * How a design file is fitted into its trim box, and how bleed is handled.
 *
 * "Local space" = the design's own trim box: [0, trimW] × [0, trimH] in mm, upright.
 * The bleed area is the band from -bleed to trim + bleed around it.
 *
 * Rules:
 *  - A design is NEVER scaled to create bleed. Unless the file really contains bleed,
 *    the artwork is placed at exactly the trim size, so 100 % of it stays inside the cut line.
 *  - Missing bleed is built OUTSIDE the trim, by mirroring (or stretching) the design's outer edge.
 *  - A file only counts as "already has bleed" when its real size is trim + bleed on every side (±0.5 mm).
 *
 * Pure maths, no browser APIs.
 */
import { BLEED_MATCH_TOLERANCE_MM, SIZE_MATCH_TOLERANCE_MM, TRIM_SIZES } from '../config/defaults'
import { type Matrix, type Rect, multiply, round3 } from './geometry'

export type BleedMode = 'included' | 'mirror' | 'stretch' | 'none'
/** What to do when the design's proportions don't match the trim size. */
export type FitMode = 'fit' | 'fill'

export const BLEED_MODE_LABELS: Record<BleedMode, string> = {
  included: 'File already has bleed',
  mirror: 'Mirror edges',
  stretch: 'Stretch edge pixels',
  none: 'None – cut at design edge',
}

/** Size information about one page of a source file, as it appears on screen (after any page rotation). */
export interface SourceGeometry {
  kind: 'pdf' | 'image'
  /** Full extents in mm. For images without DPI information this is a nominal size (pixels at 300 dpi). */
  widthMm: number
  heightMm: number
  /** false for images that store no DPI: their real size is unknown, only their proportions. */
  physicalSize?: boolean
  /** Trim box from the PDF itself (only when the file defines one that's smaller than the page). */
  trimBox?: Rect
  /** Image pixel size (images only). */
  pxW?: number
  pxH?: number
}

/** One drawing of the source: clip to `clip` (local space), then draw the source through `matrix`. */
export interface ArtPiece {
  clip: Rect
  /** Maps source mm (displayed orientation) → local trim space mm. */
  matrix: Matrix
}

export interface ArtPlan {
  /** The design itself. Clipped to the trim box (or to the bleed box when the file has its own bleed). */
  main: ArtPiece
  /** Where the artwork actually lies in local space (= the trim box unless "fit" left white bands). */
  art: Rect
  /** Mirror/stretch drawn with the source itself (used for images, and for PDFs in 'vector' bleed mode). */
  bleedPieces: ArtPiece[]
  /** Size of one source unit in local mm, horizontally and vertically. */
  scaleX: number
  scaleY: number
  warnings: string[]
}

/** For vector PDFs in 'vector' bleed mode, "stretch" smears the outer 0.1 mm across the bleed. */
export const VECTOR_STRETCH_SLIVER_MM = 0.1
/** Proportions within this (1 %) are mapped exactly onto the trim box (tiny, invisible distortion; nothing cut, no gaps). */
export const ASPECT_TOLERANCE = 0.01

const near = (a: number, b: number, tol = SIZE_MATCH_TOLERANCE_MM) => Math.abs(a - b) <= tol

/** Does w×h match W×H in either orientation? */
export function sizeMatches(w: number, h: number, W: number, H: number, tol = SIZE_MATCH_TOLERANCE_MM): boolean {
  return (near(w, W, tol) && near(h, H, tol)) || (near(w, H, tol) && near(h, W, tol))
}

export interface BleedDetection {
  /** Suggested mode: 'included' only when the file really has bleed; otherwise 'mirror'. */
  mode: BleedMode
  /** True when the file's real size is trim + bleed on every side. */
  hasBleed: boolean
  /** Bleed found in the file, in mm (0 if none). */
  foundBleedMm: number
  /** Human explanation. */
  note: string
}

/** Works out whether the file already contains bleed for the chosen trim size. */
export function detectBleed(g: SourceGeometry, trimW: number, trimH: number, bleed: number): BleedDetection {
  const tol = BLEED_MATCH_TOLERANCE_MM
  const no = (note: string, found = 0): BleedDetection => ({ mode: 'mirror', hasBleed: false, foundBleedMm: round3(Math.max(0, found)), note })
  const f = (n: number) => String(round3(n))

  if (bleed <= 0)
    return { mode: 'none', hasBleed: false, foundBleedMm: 0, note: 'No bleed: the design is printed exactly as it is in the file and cut at its edge.' }

  if (g.trimBox) {
    const t = g.trimBox
    const sides = [t.x, t.y, g.widthMm - t.x - t.w, g.heightMm - t.y - t.h]
    const found = Math.min(...sides)
    if (!(near(t.w, trimW, tol) && near(t.h, trimH, tol)))
      return no(`The PDF's trim box is ${f(t.w)} × ${f(t.h)} mm, not ${f(trimW)} × ${f(trimH)} mm. The design will be fitted to the trim size and bleed mirrored.`)
    if (found >= bleed - tol) return { mode: 'included', hasBleed: true, foundBleedMm: round3(found), note: `PDF has a trim box with ${f(found)} mm bleed.` }
    return no(`PDF trim box has only ${f(Math.max(0, found))} mm bleed – bleed will be mirrored instead.`, found)
  }

  if (g.physicalSize === false)
    return no('This image has no DPI information, so its real size is unknown. It will be placed at exactly the trim size and bleed will be mirrored.')

  if (near(g.widthMm, trimW + 2 * bleed, tol) && near(g.heightMm, trimH + 2 * bleed, tol))
    return { mode: 'included', hasBleed: true, foundBleedMm: bleed, note: `File is trim + ${bleed} mm bleed on every side.` }
  if (near(g.widthMm, trimW, tol) && near(g.heightMm, trimH, tol)) return no('File is exactly the trim size – it has no bleed.')
  return no(`File is ${f(g.widthMm)} × ${f(g.heightMm)} mm, not the trim size. It will be scaled to the trim size (not into the bleed) and bleed mirrored.`)
}

/** Exact mapping of rectangle S onto rectangle T (separate x and y scale). */
export function stretchMatrix(S: Rect, T: Rect): Matrix {
  const sx = T.w / S.w
  const sy = T.h / S.h
  return [sx, 0, 0, sy, T.x - S.x * sx, T.y - S.y * sy]
}

/** Uniform scale + centre: S fits inside T ('fit') or covers T ('fill'). */
export function uniformMatrix(S: Rect, T: Rect, fit: FitMode): Matrix {
  const sc = fit === 'fit' ? Math.min(T.w / S.w, T.h / S.h) : Math.max(T.w / S.w, T.h / S.h)
  return [sc, 0, 0, sc, T.x + T.w / 2 - (S.x + S.w / 2) * sc, T.y + T.h / 2 - (S.y + S.h / 2) * sc]
}

const mapRect = (m: Matrix, r: Rect): Rect => ({ x: m[0] * r.x + m[4], y: m[3] * r.y + m[5], w: m[0] * r.w, h: m[3] * r.h })

/**
 * Plans how to draw a source into its trim box.
 * - included: the file's own bleed is used; the file's trim area lands exactly on the trim box.
 * - mirror / stretch / none: the file lands exactly on the trim box (never larger).
 *   For mirror/stretch, `bleedPieces` fill the 8 bleed strips (4 sides + 4 corners) with mirrored /
 *   stretched copies of the outer edge. (PDFs normally use 300 DPI image strips instead – see bleedRaster.ts.)
 */
export function planArtwork(g: SourceGeometry, trimW: number, trimH: number, bleed: number, mode: BleedMode, fit: FitMode = 'fit'): ArtPlan {
  const warnings: string[] = []
  const full: Rect = { x: 0, y: 0, w: g.widthMm, h: g.heightMm }
  const trim: Rect = { x: 0, y: 0, w: trimW, h: trimH }
  const bleedRect: Rect = { x: -bleed, y: -bleed, w: trimW + 2 * bleed, h: trimH + 2 * bleed }

  if (mode === 'included') {
    // the file's trim area → trim box; its extra margin becomes the bleed
    const m = g.trimBox ? stretchMatrix(g.trimBox, trim) : stretchMatrix(full, bleedRect)
    const covered = mapRect(m, full)
    const short = Math.max(
      covered.x - bleedRect.x,
      covered.y - bleedRect.y,
      bleedRect.x + bleedRect.w - (covered.x + covered.w),
      bleedRect.y + bleedRect.h - (covered.y + covered.h),
    )
    if (short > 0.2) warnings.push(`File has less than ${bleed} mm bleed (about ${round3(bleed - short)} mm). Edges may show white after cutting.`)
    return { main: { clip: bleedRect, matrix: m }, art: trim, bleedPieces: [], scaleX: m[0], scaleY: m[3], warnings }
  }

  const S = g.trimBox ?? full
  const diff = Math.abs(S.w / S.h - trimW / trimH) / (trimW / trimH)
  let m: Matrix
  if (diff <= ASPECT_TOLERANCE) {
    m = stretchMatrix(S, trim) // exact: whole design = whole trim box
  } else {
    m = uniformMatrix(S, trim, fit)
    const placed = mapRect(m, S)
    if (fit === 'fit') {
      const gapW = round3(Math.max(0, trimW - placed.w))
      const gapH = round3(Math.max(0, trimH - placed.h))
      warnings.push(
        `Design proportions don't match the trim size. The whole design is kept, so there will be white bands (${gapW > 0 ? gapW + ' mm across the width' : gapH + ' mm across the height'}). Choose “Fill & crop” or check the size.`,
      )
    } else {
      const lostW = round3(Math.max(0, placed.w - trimW))
      const lostH = round3(Math.max(0, placed.h - trimH))
      warnings.push(`Design proportions don't match the trim size: ${lostW > 0 ? lostW + ' mm of width' : lostH + ' mm of height'} will be cut off (“Fill & crop”).`)
    }
  }
  const placed = mapRect(m, S)
  const art: Rect = fit === 'fit' || diff <= ASPECT_TOLERANCE ? intersect(placed, trim) : trim
  const main: ArtPiece = { clip: art, matrix: m }

  if (mode === 'none' || bleed <= 0) {
    if (mode === 'none' && bleed > 0) warnings.push('No bleed: the sheet is cut exactly at the design edge, so a thin white line may show if the cut is slightly off.')
    return { main, art, bleedPieces: [], scaleX: m[0], scaleY: m[3], warnings }
  }

  // k = how much the edge is stretched into the bleed (1 = plain mirror)
  let k = 1
  if (mode === 'stretch') {
    // images: exactly one source pixel; vector PDFs: a 0.1 mm sliver
    const sliver = g.kind === 'image' && g.pxW ? (g.widthMm / g.pxW) * m[0] : VECTOR_STRETCH_SLIVER_MM
    k = bleed / sliver
  }
  const W = trimW
  const H = trimH
  const mxL: Matrix = [-k, 0, 0, 1, 0, 0]
  const mxR: Matrix = [-k, 0, 0, 1, (1 + k) * W, 0]
  const myB: Matrix = [1, 0, 0, -k, 0, 0]
  const myT: Matrix = [1, 0, 0, -k, 0, (1 + k) * H]
  const I: Matrix = [1, 0, 0, 1, 0, 0]
  const b = bleed
  const strips: [Rect, Matrix, Matrix][] = [
    [{ x: -b, y: 0, w: b, h: H }, mxL, I], // left
    [{ x: W, y: 0, w: b, h: H }, mxR, I], // right
    [{ x: 0, y: -b, w: W, h: b }, I, myB], // bottom
    [{ x: 0, y: H, w: W, h: b }, I, myT], // top
    [{ x: -b, y: -b, w: b, h: b }, mxL, myB], // corners
    [{ x: W, y: -b, w: b, h: b }, mxR, myB],
    [{ x: -b, y: H, w: b, h: b }, mxL, myT],
    [{ x: W, y: H, w: b, h: b }, mxR, myT],
  ]
  const bleedPieces = strips.map(([clip, mx, my]) => ({ clip, matrix: multiply(multiply(mx, my), m) }))
  warnings.push(`Bleed was added automatically (${mode === 'mirror' ? 'mirrored' : 'stretched'} edges, outside the cut line). Check the edges before printing.`)
  return { main, art, bleedPieces, scaleX: m[0], scaleY: m[3], warnings }
}

function intersect(a: Rect, b: Rect): Rect {
  const x = Math.max(a.x, b.x)
  const y = Math.max(a.y, b.y)
  return { x, y, w: Math.max(0, Math.min(a.x + a.w, b.x + b.w) - x), h: Math.max(0, Math.min(a.y + a.h, b.y + b.h) - y) }
}

/** Effective print resolution of an image at the planned size (the lower of the two directions). */
export function effectiveDpi(g: SourceGeometry, plan: ArtPlan): number | null {
  if (g.kind !== 'image' || !g.pxW || !g.pxH) return null
  const wIn = (g.widthMm * plan.scaleX) / 25.4
  const hIn = (g.heightMm * plan.scaleY) / 25.4
  return Math.round(Math.min(g.pxW / wIn, g.pxH / hIn))
}

/** Describes a size in words, e.g. "A4 + 3 mm bleed" or "A5 landscape". */
export function describeSize(w: number, h: number, bleed: number): string {
  for (const t of TRIM_SIZES) {
    const land = w > h ? ' landscape' : ''
    if (sizeMatches(w, h, t.widthMm, t.heightMm)) return `${t.name}${land}`
    if (sizeMatches(w, h, t.widthMm + 2 * bleed, t.heightMm + 2 * bleed, BLEED_MATCH_TOLERANCE_MM)) return `${t.name}${land} + ${bleed} mm bleed`
  }
  return ''
}

/** A3 / A4 / A5 named in a file name, e.g. "… Split Poster Set  3 Piece A4.pdf". */
export function sizeFromName(fileName: string | undefined) {
  const m = fileName?.match(/(?:^|[^a-z0-9])a([345])(?![0-9])/i)
  return m ? TRIM_SIZES.find((t) => t.name === `A${m[1]}`) : undefined
}

/**
 * Are the proportions of w×h those of the A-series (1 : √2), within 0.5 %?
 * (Tight on purpose: an A4 file with 3 mm bleed, 216 × 303 mm, is 0.8 % off and must keep its size.)
 */
export const isASeriesShape = (w: number, h: number) => Math.abs(Math.max(w, h) / Math.min(w, h) / Math.SQRT2 - 1) <= 0.005

/**
 * Best-guess trim size for a newly uploaded file.
 * - A file that is (nearly) a standard size keeps its OWN exact size, so it is printed 1:1, never rescaled.
 * - A file with A-series proportions but a non-standard size (e.g. a Canva "A4" export that is really
 *   160.87 × 228.07 mm) is printed at the A-size its file name says (else A4): scaled evenly, nothing cut.
 */
export function suggestTrim(g: SourceGeometry, bleed: number, fileName?: string): { name: string; w: number; h: number } {
  const land = g.widthMm > g.heightMm
  const orient = (w: number, h: number): [number, number] => (land ? [Math.max(w, h), Math.min(w, h)] : [Math.min(w, h), Math.max(w, h)])
  const named = sizeFromName(fileName)
  if (g.trimBox) {
    const t = g.trimBox
    const std = TRIM_SIZES.find((s) => sizeMatches(t.w, t.h, s.widthMm, s.heightMm))
    return std ? { name: std.name, w: t.w, h: t.h } : { name: 'Custom', w: round3(t.w), h: round3(t.h) }
  }
  if (g.physicalSize !== false) {
    for (const s of TRIM_SIZES) {
      if (sizeMatches(g.widthMm, g.heightMm, s.widthMm, s.heightMm)) return { name: s.name, w: g.widthMm, h: g.heightMm }
      if (bleed > 0 && sizeMatches(g.widthMm, g.heightMm, s.widthMm + 2 * bleed, s.heightMm + 2 * bleed, BLEED_MATCH_TOLERANCE_MM)) {
        const [w, h] = orient(s.widthMm, s.heightMm)
        return { name: s.name, w, h }
      }
    }
    if (g.kind === 'pdf' && !isASeriesShape(g.widthMm, g.heightMm)) return { name: 'Custom', w: round3(g.widthMm), h: round3(g.heightMm) }
  }
  // A-series shape (or an image of unknown size): the A-size from the file name, else A4, in the file's orientation
  const t = named ?? TRIM_SIZES.find((x) => x.name === 'A4')!
  const [w, h] = orient(t.widthMm, t.heightMm)
  return { name: t.name, w, h }
}
