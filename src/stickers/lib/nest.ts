/**
 * Puts stickers on sheets. Shape-aware: each sticker's real cut outline (plus half the gap all round) is
 * rasterised at 4 px/mm, and copies are arranged in a lattice – rows that may be shifted against each other –
 * so round and odd-shaped stickers nest into each other's gaps instead of sitting in bounding-box grids.
 * Designs are stacked one after another down the sheet and flow onto as many sheets as needed.
 *
 * Coordinates: "area" = the usable part of the sheet (inside marks + clearance), mm, origin top-left, y DOWN.
 * Each sticker's "item frame" is its cut box after rotation, origin top-left, y down.
 */
import { type StickerSettings, contentInsetMm } from '../config'
import type { Matrix, Rect } from '../../lib/geometry'
import { type BezierPath, type Pt, flatten } from './paths'

/** Packing resolution. 0.25 mm steps. */
const KP = 4

export type Rotation = 0 | 90

export interface NestDesign {
  id: string
  name: string
  cut: BezierPath[]
  /** Cut bounds in the sticker's local frame (mm, y up). */
  bounds: Rect
  copies: number
  rotation: 'auto' | Rotation
}

export interface StickerPlacement {
  id: string
  designId: string
  rot: Rotation
  /** Item-frame origin in area coordinates (mm, y down). */
  x: number
  y: number
}

export interface StickerSheetLayout {
  index: number
  placements: StickerPlacement[]
}

export interface NestResult {
  sheets: StickerSheetLayout[]
  /** How many of each design fit on an empty sheet, and the rotation used. */
  capacity: Record<string, { perSheet: number; rot: Rotation }>
  area: Rect
  warnings: string[]
}

/* ------------------------------------------------------------------ packing masks */

/** One sticker outline as runs of filled pixels per row (item frame, grown by half the gap). */
export interface PackMask {
  w: number
  h: number
  /** Per row: [start, end) pairs. */
  runs: Int32Array[]
  /** Halo around the cut box, mm (= half the gap). */
  halo: number
  /** Mask pixel (0, 0) is at item (−pad, −pad), mm. */
  pad: number
  /** Item frame size, mm. */
  itemW: number
  itemH: number
}

/** Local (mm, y up) → item frame (mm, y down) for a rotation. */
export function toItem(b: Rect, rot: Rotation): (x: number, y: number) => Pt {
  return rot === 0 ? (x, y) => [x - b.x, b.y + b.h - y] : (x, y) => [b.y + b.h - y, b.x + b.w - x]
}

export function itemSize(b: Rect, rot: Rotation): { w: number; h: number } {
  return rot === 0 ? { w: b.w, h: b.h } : { w: b.h, h: b.w }
}

const maskCache = new WeakMap<BezierPath[], Map<string, PackMask>>()

export function packMask(cut: BezierPath[], b: Rect, rot: Rotation, halo: number): PackMask {
  let byKey = maskCache.get(cut)
  if (!byKey) maskCache.set(cut, (byKey = new Map()))
  const key = `${rot}|${halo}|${b.x},${b.y},${b.w},${b.h}`
  const hit = byKey.get(key)
  if (hit) return hit

  const { w: iw, h: ih } = itemSize(b, rot)
  const f = toItem(b, rot)
  const pad = halo + 0.5
  const W = Math.ceil((iw + 2 * pad) * KP) + 1
  const H = Math.ceil((ih + 2 * pad) * KP) + 1
  // polygons in mask pixels
  const polys = cut.map((p) => flatten(p, 8).map(([x, y]) => f(x, y)).map(([x, y]) => [(x + pad) * KP, (y + pad) * KP] as Pt))
  const fill = new Uint8Array(W * H)
  // scanline even-odd fill, pixel centres
  for (let row = 0; row < H; row++) {
    const yc = row + 0.5
    const xs: number[] = []
    for (const poly of polys)
      for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
        const [x1, y1] = poly[j]
        const [x2, y2] = poly[i]
        if (y1 <= yc !== y2 <= yc) xs.push(x1 + ((yc - y1) / (y2 - y1)) * (x2 - x1))
      }
    xs.sort((a, c) => a - c)
    for (let k = 0; k + 1 < xs.length; k += 2) {
      // pixels whose centre lies inside
      const a = Math.max(0, Math.ceil(xs[k] - 0.5))
      const c = Math.min(W, Math.floor(xs[k + 1] - 0.5) + 1)
      for (let x = a; x < c; x++) fill[row * W + x] = 1
    }
  }
  // grow by the halo (+ half a pixel, to stay on the safe side of the pixel-centre fill)
  const R = halo * KP + 0.5
  const grown = dilate(fill, W, H, R)
  const runs: Int32Array[] = []
  for (let y = 0; y < H; y++) {
    const r: number[] = []
    let x = 0
    while (x < W) {
      while (x < W && !grown[y * W + x]) x++
      if (x >= W) break
      const s = x
      while (x < W && grown[y * W + x]) x++
      r.push(s, x)
    }
    runs.push(Int32Array.from(r))
  }
  const m: PackMask = { w: W, h: H, runs, halo, pad, itemW: iw, itemH: ih }
  byKey.set(key, m)
  return m
}

/** Binary dilation by a disc of radius r pixels (via distance to the nearest set pixel, done per row – cheap for small r). */
function dilate(m: Uint8Array, w: number, h: number, r: number): Uint8Array {
  const out = new Uint8Array(w * h)
  const ri = Math.ceil(r)
  const span: number[] = []
  for (let dy = -ri; dy <= ri; dy++) span.push(Math.floor(Math.sqrt(Math.max(0, r * r - dy * dy))))
  // horizontal run-length helper: for each row, prefix sums to test "any set pixel in [a,b]"
  const pre = new Int32Array((w + 1) * h)
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) pre[y * (w + 1) + x + 1] = pre[y * (w + 1) + x] + m[y * w + x]
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) {
      for (let dy = -ri; dy <= ri; dy++) {
        const yy = y + dy
        if (yy < 0 || yy >= h) continue
        const s = span[dy + ri]
        const a = Math.max(0, x - s)
        const b = Math.min(w - 1, x + s)
        if (pre[yy * (w + 1) + b + 1] - pre[yy * (w + 1) + a] > 0) {
          out[y * w + x] = 1
          break
        }
      }
    }
  return out
}

/** Do mask A at (0,0) and mask B at (dx, dy) share any pixel? */
export function masksOverlap(A: PackMask, B: PackMask, dx: number, dy: number): boolean {
  const y0 = Math.max(0, dy)
  const y1 = Math.min(A.h, dy + B.h)
  for (let y = y0; y < y1; y++) {
    const ra = A.runs[y]
    const rb = B.runs[y - dy]
    if (!ra.length || !rb.length) continue
    for (let i = 0; i < ra.length; i += 2)
      for (let j = 0; j < rb.length; j += 2) if (ra[i] < rb[j + 1] + dx && rb[j] + dx < ra[i + 1]) return true
  }
  return false
}

/* ------------------------------------------------------------------ lattice */

interface Lattice {
  dx: number
  dy: number
  /** Horizontal shift of each row against the one above (px). */
  ox: number
}

const latticeCache = new WeakMap<PackMask, Lattice[]>()

/** Good lattices for one shape: for each row shift, the tightest row spacing. */
function lattices(M: PackMask): Lattice[] {
  const hit = latticeCache.get(M)
  if (hit) return hit
  // tightest step along a row
  let dx = 1
  for (; dx < M.w; dx++) {
    let ok = true
    for (let k = 1; k * dx < M.w && ok; k++) if (masksOverlap(M, M, k * dx, 0)) ok = false
    if (ok) break
  }
  const out: Lattice[] = []
  const step = Math.max(1, Math.round(dx / 200))
  for (let ox = 0; ox < dx; ox += step) {
    let dy = 1
    for (; dy < M.h; dy++) {
      let ok = true
      // every lattice vector (a·dx + b·ox, b·dy) that could reach the shape must not overlap
      for (let b = 1; b * dy < M.h && ok; b++) {
        const base = b * ox
        const aMin = Math.ceil((-M.w - base) / dx)
        const aMax = Math.floor((M.w - base) / dx)
        for (let a = aMin; a <= aMax && ok; a++) if (masksOverlap(M, M, a * dx + base, b * dy)) ok = false
      }
      if (ok) break
    }
    out.push({ dx, dy, ox })
  }
  latticeCache.set(M, out)
  return out
}

/** Positions (mask px) of up to `max` copies laid out with lattice L in an area of AW × AH px, starting at row y0. */
function latticePositions(L: Lattice, M: PackMask, AW: number, AH: number, y0: number, max: number): { pos: [number, number][]; bottom: number } {
  const pos: [number, number][] = []
  let bottom = y0
  for (let j = 0; pos.length < max; j++) {
    const y = y0 + j * L.dy
    if (y + M.h > AH) break
    const xo = (((j * L.ox) % L.dx) + L.dx) % L.dx
    let placed = false
    for (let x = xo; x + M.w <= AW && pos.length < max; x += L.dx) {
      pos.push([x, y])
      placed = true
    }
    if (!placed && L.dx >= AW) break
    bottom = y + M.h
  }
  return { pos, bottom }
}

function bestLattice(M: PackMask, AW: number, AH: number): { L: Lattice; count: number } {
  let best: { L: Lattice; count: number } | null = null
  for (const L of lattices(M)) {
    const count = latticePositions(L, M, AW, AH, 0, Infinity).pos.length
    if (!best || count > best.count) best = { L, count }
  }
  return best!
}

/* ------------------------------------------------------------------ skyline (mixed sheets) */

interface Profile {
  /** Per mask column: first and one-past-last filled row (top = NONE when the column is empty). */
  top: Int32Array
  bottom: Int32Array
  maxBottom: number
}
const NONE = 1 << 30
const profileCache = new WeakMap<PackMask, Profile>()

function profileOf(M: PackMask): Profile {
  let p = profileCache.get(M)
  if (p) return p
  const top = new Int32Array(M.w).fill(NONE)
  const bottom = new Int32Array(M.w).fill(-1)
  for (let y = 0; y < M.h; y++) {
    const r = M.runs[y]
    for (let i = 0; i < r.length; i += 2)
      for (let x = Math.max(0, r[i]); x < Math.min(M.w, r[i + 1]); x++) {
        if (y < top[x]) top[x] = y
        bottom[x] = y + 1
      }
  }
  p = { top, bottom, maxBottom: Math.max(0, ...bottom) }
  profileCache.set(M, p)
  return p
}

/**
 * Lowest spot (then leftmost) where the shape fits on top of what's placed. `sky[x]` = first free row in column x.
 * Shape-aware: a sticker's outline drops into the dips between the ones above it.
 */
function skylineSpot(sky: Int32Array, M: PackMask, P: Profile, AW: number, AH: number): { x: number; y: number } | null {
  let best: { x: number; y: number } | null = null
  for (let X = 0; X + M.w <= AW; X++) {
    let Y = 0
    for (let x = 0; x < M.w; x++) {
      if (P.top[x] === NONE) continue
      const v = sky[X + x] - P.top[x]
      if (v > Y) {
        Y = v
        if (best && Y >= best.y) break
      }
    }
    if (Y + P.maxBottom > AH) continue
    if (!best || Y < best.y) best = { x: X, y: Y }
  }
  return best
}

function raiseSkyline(sky: Int32Array, X: number, Y: number, P: Profile) {
  for (let x = 0; x < P.bottom.length; x++) if (P.bottom[x] >= 0) sky[X + x] = Math.max(sky[X + x], Y + P.bottom[x])
}

/* ------------------------------------------------------------------ sheets */

export function contentArea(s: StickerSettings): Rect {
  const inset = contentInsetMm(s)
  return { x: inset, y: inset, w: Math.max(0, s.sheet.widthMm - 2 * inset), h: Math.max(0, s.sheet.heightMm - 2 * inset) }
}

interface Job {
  d: NestDesign
  /** Rotations allowed, preferred first. */
  shapes: { rot: Rotation; M: PackMask }[]
  L: Lattice
  capacity: number
  left: number
  next: number
}

/**
 * Lays out all designs. Pure and fast (masks and lattices are cached), so it runs on every change.
 * - A sheet that one design fills on its own gets that design's lattice: neat rows, the most per sheet.
 * - Sheets that hold several designs are packed shape by shape (skyline), biggest first, so different
 *   stickers fill each other's gaps.
 */
export function nest(designs: NestDesign[], s: StickerSettings): NestResult {
  const area = contentArea(s)
  const halo = s.gapMm / 2
  // masks are padded by `pad`; growing the area by the same amount keeps every cut box inside the area
  const pad = halo + 0.5
  const AW = Math.floor((area.w + 2 * pad) * KP)
  const AH = Math.floor((area.h + 2 * pad) * KP)
  const sheets: StickerSheetLayout[] = []
  const capacity: NestResult['capacity'] = {}
  const warnings: string[] = []

  const jobs: Job[] = []
  for (const d of designs) {
    if (!d.cut.length || d.bounds.w <= 0) continue
    // the rotation that fits the most on an empty sheet comes first
    const rots: Rotation[] = d.rotation === 'auto' ? [0, 90] : [d.rotation]
    const options = rots
      .map((rot) => ({ rot, M: packMask(d.cut, d.bounds, rot, halo) }))
      .filter((o) => o.M.w <= AW && o.M.h <= AH)
      .map((o) => ({ ...o, ...bestLattice(o.M, AW, AH) }))
      .sort((a, b) => b.count - a.count)
    if (!options.length) {
      capacity[d.id] = { perSheet: 0, rot: 0 }
      warnings.push(`“${d.name}” is bigger than the printable area of the sheet.`)
      continue
    }
    capacity[d.id] = { perSheet: options[0].count, rot: options[0].rot }
    if (d.copies > 0) jobs.push({ d, shapes: options.map(({ rot, M }) => ({ rot, M })), L: options[0].L, capacity: options[0].count, left: d.copies, next: 0 })
  }

  // mask top-left is at item (−pad, −pad) and the area grows by pad: they cancel out, so px / KP = item position
  const place = (sheet: StickerSheetLayout, j: Job, rot: Rotation, x: number, y: number) => {
    sheet.placements.push({ id: `${j.d.id}#${j.next++}`, designId: j.d.id, rot, x: x / KP, y: y / KP })
    j.left--
  }

  while (jobs.some((j) => j.left > 0)) {
    const sheet: StickerSheetLayout = { index: sheets.length, placements: [] }
    const active = jobs.filter((j) => j.left > 0)
    const first = active[0]
    const spans: [number, number][] = [] // px column span of everything placed, for centring

    if (active.length === 1 || first.left >= first.capacity) {
      // one design on this sheet: its lattice
      const { M, rot } = first.shapes[0]
      for (const [x, y] of latticePositions(first.L, M, AW, AH, 0, Math.min(first.left, first.capacity)).pos) {
        place(sheet, first, rot, x, y)
        spans.push([x, x + M.w])
      }
    } else {
      // several designs: biggest first, each dropped into the lowest spot it fits
      const sky = new Int32Array(AW)
      const order = [...active].sort((a, b) => b.shapes[0].M.w * b.shapes[0].M.h - a.shapes[0].M.w * a.shapes[0].M.h)
      for (const j of order) {
        while (j.left > 0) {
          let best: { x: number; y: number; rot: Rotation; M: PackMask } | null = null
          for (const { rot, M } of j.shapes) {
            const spot = skylineSpot(sky, M, profileOf(M), AW, AH)
            if (spot && (!best || spot.y < best.y)) best = { ...spot, rot, M }
          }
          if (!best) break
          raiseSkyline(sky, best.x, best.y, profileOf(best.M))
          place(sheet, j, best.rot, best.x, best.y)
          spans.push([best.x, best.x + best.M.w])
        }
      }
    }
    if (!sheet.placements.length) break // nothing fits (can't happen: every job fits an empty sheet)

    // centre the sheet's contents across the usable width
    const minX = Math.min(...spans.map((p) => p[0]))
    const maxX = Math.max(...spans.map((p) => p[1]))
    const shift = (Math.floor((AW - (maxX - minX)) / 2) - minX) / KP
    for (const p of sheet.placements) p.x += shift
    sheets.push(sheet)
  }
  return { sheets, capacity, area, warnings }
}

/** How many more copies of `designId` fit on the last sheet without starting a new one. */
export function roomOnLastSheet(designs: NestDesign[], designId: string, s: StickerSettings): number {
  const base = nest(designs, s).sheets.length
  const with_ = (extra: number) => nest(designs.map((d) => (d.id === designId ? { ...d, copies: d.copies + extra } : d)), s).sheets.length
  if (base === 0) return 0
  let lo = 0
  let hi = 1
  while (hi < 5000 && with_(hi) === base) {
    lo = hi
    hi *= 2
  }
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1
    if (with_(mid) === base) lo = mid
    else hi = mid
  }
  return lo
}

/** Local sticker mm (y up) → sheet mm (y up). */
export function placementMatrix(p: StickerPlacement, b: Rect, s: StickerSettings): Matrix {
  const area = contentArea(s)
  const H = s.sheet.heightMm
  const ax = area.x + p.x
  const ay = area.y + p.y // from the top
  if (p.rot === 0) return [1, 0, 0, 1, ax - b.x, H - ay - b.y - b.h]
  return [0, 1, -1, 0, ax + b.y + b.h, H - ay - b.x - b.w]
}

/** Cut box of a placement on the sheet (mm, y up). */
export function placementRect(p: StickerPlacement, b: Rect, s: StickerSettings): Rect {
  const area = contentArea(s)
  const { w, h } = itemSize(b, p.rot)
  return { x: area.x + p.x, y: s.sheet.heightMm - (area.y + p.y) - h, w, h }
}

/** Pairs of placements whose stickers (with the gap) overlap, and placements that leave the usable area. */
export function layoutProblems(
  sheet: StickerSheetLayout,
  designs: Record<string, { cut: BezierPath[]; bounds: Rect }>,
  s: StickerSettings,
): { overlapping: Set<string>; outside: Set<string> } {
  const halo = s.gapMm / 2
  const area = contentArea(s)
  const overlapping = new Set<string>()
  const outside = new Set<string>()
  const items = sheet.placements
    .map((p) => {
      const d = designs[p.designId]
      if (!d) return null
      const M = packMask(d.cut, d.bounds, p.rot, halo)
      return { p, M, x: Math.round(p.x * KP), y: Math.round(p.y * KP) }
    })
    .filter((v): v is NonNullable<typeof v> => !!v)
  for (const it of items) {
    if (it.p.x < -0.01 || it.p.y < -0.01 || it.p.x + it.M.itemW > area.w + 0.01 || it.p.y + it.M.itemH > area.h + 0.01) outside.add(it.p.id)
  }
  for (let i = 0; i < items.length; i++)
    for (let j = i + 1; j < items.length; j++) {
      const a = items[i]
      const b = items[j]
      if (a.x + a.M.w <= b.x || b.x + b.M.w <= a.x || a.y + a.M.h <= b.y || b.y + b.M.h <= a.y) continue
      if (masksOverlap(a.M, b.M, b.x - a.x, b.y - a.y)) {
        overlapping.add(a.p.id)
        overlapping.add(b.p.id)
      }
    }
  return { overlapping, outside }
}
