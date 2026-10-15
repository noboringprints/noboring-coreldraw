/**
 * Imposition maths: how many copies fit on a sheet ("ups"), where each one goes,
 * where the crop marks go, and where the sheet label can safely be printed.
 *
 * Pure functions, no browser APIs — used by the app, the export, and the tests.
 * Units: millimetres. Origin: bottom-left corner of the sheet (PDF convention).
 */
import type { PrintSettings, SheetSize } from '../config/defaults'
import { PT_PER_MM } from '../config/defaults'
import {
  type Matrix,
  type Rect,
  type Segment,
  EPS,
  expand,
  rectInside,
  rectsOverlap,
  round3,
  segmentBounds,
} from './geometry'

export type Rotation = 0 | 90 | 180 | 270

/** Removes floating-point noise (rounds to 1/1,000,000 mm). */
const r6 = (n: number) => Math.round(n * 1e6) / 1e6

/** One finished piece to print (one copy of a design, or one panel of a split poster). */
export interface LayoutItem<A = unknown> {
  /** Unique per copy. */
  id: string
  designId: string
  name: string
  /** For split posters: which panel this is. */
  panel?: { index: number; total: number }
  /** Final cut size, in the design's own orientation. */
  trimW: number
  trimH: number
  /** Opaque data the PDF export needs (source file, bleed mode…). Ignored by layout. */
  art?: A
}

export interface Placement<A = unknown> {
  /** Stable id: `${sheetId}/${slot}` */
  id: string
  slot: number
  item: LayoutItem<A>
  /** Trim (cut) rectangle on the sheet, as placed (after rotation). */
  trim: Rect
  /** Counter-clockwise rotation of the design on the sheet. */
  rotation: Rotation
}

export interface LabelPlacement {
  /** Box the label text must stay within (mm). For rotation 90 the text runs bottom-to-top. */
  box: Rect
  rotation: 0 | 90
}

export interface Sheet<A = unknown> {
  id: string
  /** 0-based index across the whole job. */
  index: number
  groupKey: string
  trimW: number
  trimH: number
  placements: Placement<A>[]
  marks: Segment[]
  label: LabelPlacement | null
  warnings: string[]
  /** Unused grid cells on this sheet (trim rectangles, as they would be placed): space that can still be filled. */
  freeSlots: Rect[]
}

export interface Grid {
  cols: number
  rows: number
  /** true = cells are rotated relative to the size as given (w and h swapped). */
  rotated: boolean
  count: number
  /** Trim size of each cell, as placed. */
  cellW: number
  cellH: number
}

export interface PlacementOverride {
  dx?: number
  dy?: number
  /** Extra quarter-turns (counter-clockwise). */
  quarterTurns?: number
}

export interface LayoutOptions {
  /** Force at most N copies per sheet, per size group. Key = groupKey(). */
  maxPerSheet?: Record<string, number | undefined>
  /** Manual adjustments made in the preview. Key = placement id. */
  overrides?: Record<string, PlacementOverride | undefined>
}

/** Usable area for artwork (including bleed): the sheet minus the margin on every side. */
export function printableArea(sheet: SheetSize, s: PrintSettings): Rect {
  return { x: s.marginMm, y: s.marginMm, w: sheet.widthMm - 2 * s.marginMm, h: sheet.heightMm - 2 * s.marginMm }
}

/** How many cells of `cell` (+gutter between them) fit into `avail`. */
function fitCount(avail: number, cell: number, gutter: number): number {
  if (cell <= 0) return 0
  return Math.max(0, Math.floor((avail + gutter + EPS) / (cell + gutter)))
}

/**
 * Finds the grid that fits the most copies, trying the design both upright and rotated 90°.
 * On a tie the design's own orientation wins (no rotation).
 * `maxPerSheet` limits the count (e.g. 1 = one copy per sheet).
 */
export function bestGrid(sheet: SheetSize, trimW: number, trimH: number, s: PrintSettings, maxPerSheet?: number): Grid {
  const area = printableArea(sheet, s)
  const b = s.bleedMm
  const g = s.gutterMm
  let best: Grid = { cols: 0, rows: 0, rotated: false, count: 0, cellW: trimW, cellH: trimH }
  for (const rotated of [false, true]) {
    const cw = rotated ? trimH : trimW
    const ch = rotated ? trimW : trimH
    let cols = fitCount(area.w, cw + 2 * b, g)
    let rows = fitCount(area.h, ch + 2 * b, g)
    if (maxPerSheet && maxPerSheet > 0 && cols * rows > maxPerSheet) {
      // choose the largest c×r ≤ max; prefer a squarer block
      let bc = 0
      let br = 0
      for (let c = 1; c <= cols; c++)
        for (let r = 1; r <= rows; r++)
          if (c * r <= maxPerSheet && (c * r > bc * br || (c * r === bc * br && Math.abs(c - r) < Math.abs(bc - br)))) {
            bc = c
            br = r
          }
      cols = bc
      rows = br
    }
    const count = cols * rows
    if (count > best.count) best = { cols, rows, rotated, count, cellW: cw, cellH: ch }
  }
  return best
}

/**
 * Trim rectangles for every cell of a grid, centred on the sheet.
 * Order: left-to-right, top-to-bottom (reading order).
 */
export function gridTrims(sheet: SheetSize, grid: Grid, s: PrintSettings): Rect[] {
  const b = s.bleedMm
  const g = s.gutterMm
  const pitchX = grid.cellW + 2 * b + g // distance from one trim's left edge to the next
  const pitchY = grid.cellH + 2 * b + g
  const blockW = grid.cols * (grid.cellW + 2 * b) + (grid.cols - 1) * g
  const blockH = grid.rows * (grid.cellH + 2 * b) + (grid.rows - 1) * g
  const left = (sheet.widthMm - blockW) / 2 + b
  const top = (sheet.heightMm + blockH) / 2 - b // top edge of the first row's trim
  const out: Rect[] = []
  for (let r = 0; r < grid.rows; r++)
    for (let c = 0; c < grid.cols; c++)
      out.push({ x: r6(left + c * pitchX), y: r6(top - r * pitchY - grid.cellH), w: grid.cellW, h: grid.cellH })
  return out
}

/** Groups designs by trim size. 210×297 and 297×210 are the same group. */
export function groupKey(w: number, h: number): string {
  const a = round3(Math.min(w, h))
  const b = round3(Math.max(w, h))
  return `${a}x${b}`
}

/**
 * Matrix that maps the design's own trim space ([0,trimW]×[0,trimH], upright)
 * onto its trim rectangle on the sheet, applying the rotation. Units: mm.
 */
export function placementMatrix(p: Placement): Matrix {
  const { x, y, w: W, h: H } = p.trim
  const { trimW: w, trimH: h } = p.item
  switch (p.rotation) {
    case 0:
      return [1, 0, 0, 1, x, y]
    case 90:
      return [0, 1, -1, 0, x + W, y]
    case 180:
      return [-1, 0, 0, -1, x + w, y + h]
    case 270:
      return [0, -1, 1, 0, x, y + H]
  }
}

function applyOverride<A>(p: Placement<A>, o: PlacementOverride | undefined): Placement<A> {
  if (!o) return p
  let { trim, rotation } = p
  const turns = (((o.quarterTurns ?? 0) % 4) + 4) % 4
  if (turns) {
    rotation = (((rotation + turns * 90) % 360) as Rotation)
    if (turns % 2 === 1) {
      const cx = trim.x + trim.w / 2
      const cy = trim.y + trim.h / 2
      trim = { x: cx - trim.h / 2, y: cy - trim.w / 2, w: trim.h, h: trim.w }
    }
  }
  trim = { ...trim, x: r6(trim.x + (o.dx ?? 0)), y: r6(trim.y + (o.dy ?? 0)) }
  return { ...p, trim, rotation }
}

/**
 * Crop marks for every trim corner.
 *
 * Each corner gets two short lines that continue the cut lines outward:
 * one horizontal, one vertical, starting `offset` mm from the corner and `length` mm long.
 * A line is left out when it points at another design and the gap is too small for both
 * designs' marks (they would run into the artwork or into each other), and it is shortened
 * where it would come closer than `minEdgeMm` to the sheet edge. Because copies are laid
 * out in a grid, every cut line still gets marks at the outside of the block, which is how
 * ganged sheets are cut.
 */
export function cropMarks(placements: Placement[], sheet: SheetSize, s: PrintSettings): Segment[] {
  const { offsetMm: off, lengthMm: len, minLengthMm } = s.marks
  const clearance = 0.5 // keep marks this far away from neighbouring artwork
  const obstacles = placements.map((p) => expand(p.trim, s.bleedMm))
  const safe: Rect = {
    x: s.minEdgeMm,
    y: s.minEdgeMm,
    w: sheet.widthMm - 2 * s.minEdgeMm,
    h: sheet.heightMm - 2 * s.minEdgeMm,
  }
  const out: Segment[] = []
  const seen = new Set<string>()

  const push = (seg: Segment) => {
    const k = [seg.x1, seg.y1, seg.x2, seg.y2].map((n) => round3(n)).join(',')
    if (!seen.has(k)) {
      seen.add(k)
      out.push(seg)
    }
  }

  for (const p of placements) {
    const { x, y, w, h } = p.trim
    for (const cx of [x, x + w])
      for (const cy of [y, y + h]) {
        const dirX = cx === x ? -1 : 1 // pointing away from the trim
        const dirY = cy === y ? -1 : 1
        for (const axis of ['h', 'v'] as const) {
          const dx = axis === 'h' ? dirX : 0
          const dy = axis === 'v' ? dirY : 0
          let end = off + len
          let blocked = false
          // distance along the line (from the corner) to each obstacle
          for (const r of obstacles) {
            let t1: number, t2: number
            if (axis === 'h') {
              if (cy < r.y - 0.01 || cy > r.y + r.h + 0.01) continue // (lines along a neighbour's edge count: same cut line)
              const a = (r.x - cx) * dx
              const b = (r.x + r.w - cx) * dx
              t1 = Math.min(a, b)
              t2 = Math.max(a, b)
            } else {
              if (cx < r.x - 0.01 || cx > r.x + r.w + 0.01) continue
              const a = (r.y - cy) * dy
              const b = (r.y + r.h - cy) * dy
              t1 = Math.min(a, b)
              t2 = Math.max(a, b)
            }
            if (t2 <= off + 0.01) continue // obstacle is behind the start
            // A neighbour lies along this line. Its own facing mark runs back towards us, so keep
            // this mark only if both marks fit in the gap without touching; otherwise leave it out
            // (the marks on the outside of the block already mark this cut line).
            if (t1 < 2 * (off + len) - s.bleedMm + clearance) {
              blocked = true
              break
            }
          }
          if (blocked) continue
          // keep away from the sheet edge
          const edgeDist =
            axis === 'h'
              ? dx < 0
                ? cx - safe.x
                : safe.x + safe.w - cx
              : dy < 0
                ? cy - safe.y
                : safe.y + safe.h - cy
          end = Math.min(end, edgeDist)
          if (end - off < minLengthMm - EPS) continue
          push({ x1: r6(cx + dx * off), y1: r6(cy + dy * off), x2: r6(cx + dx * end), y2: r6(cy + dy * end) })
        }
      }
  }
  return out
}

/** Approximate height of the label text in mm (font size in points → mm). */
export function labelHeightMm(s: PrintSettings): number {
  return s.label.fontSizePt / PT_PER_MM
}

/**
 * Finds a strip in the waste area for the sheet label: below everything, else above,
 * else down the left/right side. Never touches artwork, bleed or crop marks.
 */
export function findLabelPlacement(
  placements: Placement[],
  marks: Segment[],
  sheet: SheetSize,
  s: PrintSettings,
): LabelPlacement | null {
  if (!s.label.enabled) return null
  const gap = 1 // clearance from marks/artwork
  const th = labelHeightMm(s)
  const things: Rect[] = [...placements.map((p) => expand(p.trim, s.bleedMm)), ...marks.map(segmentBounds)]
  if (!things.length) return null
  const minY = Math.min(...things.map((r) => r.y))
  const maxY = Math.max(...things.map((r) => r.y + r.h))
  const minX = Math.min(...things.map((r) => r.x))
  const maxX = Math.max(...things.map((r) => r.x + r.w))
  const e = s.minEdgeMm
  const fullW = sheet.widthMm - 2 * e
  const fullH = sheet.heightMm - 2 * e

  // bottom strip
  if (minY - gap - e >= th) return { box: { x: e, y: e, w: fullW, h: Math.min(th * 1.5, minY - gap - e) }, rotation: 0 }
  // top strip
  if (sheet.heightMm - e - (maxY + gap) >= th) {
    const h = Math.min(th * 1.5, sheet.heightMm - e - (maxY + gap))
    return { box: { x: e, y: sheet.heightMm - e - h, w: fullW, h }, rotation: 0 }
  }
  // left / right strips, text rotated
  if (minX - gap - e >= th) return { box: { x: e, y: e, w: Math.min(th * 1.5, minX - gap - e), h: fullH }, rotation: 90 }
  if (sheet.widthMm - e - (maxX + gap) >= th) {
    const w = Math.min(th * 1.5, sheet.widthMm - e - (maxX + gap))
    return { box: { x: sheet.widthMm - e - w, y: e, w, h: fullH }, rotation: 90 }
  }
  return null
}

/** Design name, plus the panel number for split posters. */
export const itemName = (it: LayoutItem) => (it.panel ? `${it.name} (panel ${it.panel.index} of ${it.panel.total})` : it.name)

/** Checks a finished sheet and returns plain-English problems (overlaps, off the sheet…). */
export function checkSheet(placements: Placement[], sheet: SheetSize, s: PrintSettings): string[] {
  const warnings: string[] = []
  const sheetRect: Rect = { x: 0, y: 0, w: sheet.widthMm, h: sheet.heightMm }
  const area = printableArea(sheet, s)
  placements.forEach((p, i) => {
    const art = expand(p.trim, s.bleedMm)
    if (!rectInside(art, sheetRect)) warnings.push(`"${itemName(p.item)}" goes off the sheet.`)
    else if (!rectInside(art, area)) warnings.push(`"${itemName(p.item)}" is inside the ${s.marginMm} mm sheet margin.`)
    for (let j = i + 1; j < placements.length; j++) {
      const q = placements[j]
      if (rectsOverlap(art, expand(q.trim, s.bleedMm)))
        warnings.push(`"${itemName(p.item)}" and "${itemName(q.item)}" overlap (including bleed).`)
    }
  })
  return warnings
}

/** Builds marks, label and warnings for a sheet whose placements are already decided. */
export function finishSheet<A>(sheet: Omit<Sheet<A>, 'marks' | 'label' | 'warnings' | 'freeSlots'> & { freeSlots?: Rect[] }, s: PrintSettings): Sheet<A> {
  const marks = cropMarks(sheet.placements, s.sheet, s)
  const label = findLabelPlacement(sheet.placements, marks, s.sheet, s)
  const warnings = checkSheet(sheet.placements, s.sheet, s)
  if (s.label.enabled && !label) warnings.push('No room for the sheet label in the margin.')
  // every trim edge should have at least one crop mark on its line
  for (const p of sheet.placements) {
    const { x, y, w, h } = p.trim
    const has = (pred: (m: Segment) => boolean) => marks.some(pred)
    const okX = (cx: number) => has((m) => Math.abs(m.x1 - cx) < 0.01 && Math.abs(m.x2 - cx) < 0.01)
    const okY = (cy: number) => has((m) => Math.abs(m.y1 - cy) < 0.01 && Math.abs(m.y2 - cy) < 0.01)
    if (!okX(x) || !okX(x + w) || !okY(y) || !okY(y + h)) {
      warnings.push(`Some cut lines of "${itemName(p.item)}" have no crop mark (not enough space around it).`)
      break
    }
  }
  return { ...sheet, freeSlots: sheet.freeSlots ?? [], marks, label, warnings }
}

/**
 * Lays out all items on as few sheets as possible.
 * - Items are grouped by trim size; each size group starts on a new sheet.
 * - Within a group, items fill the grid slots in the order given.
 */
export function layoutJob<A>(items: LayoutItem<A>[], s: PrintSettings, opts: LayoutOptions = {}): Sheet<A>[] {
  const groups = new Map<string, LayoutItem<A>[]>()
  for (const it of items) {
    const k = groupKey(it.trimW, it.trimH)
    if (!groups.has(k)) groups.set(k, [])
    groups.get(k)!.push(it)
  }

  const sheets: Sheet<A>[] = []
  for (const [key, list] of groups) {
    const first = list[0]
    const grid = bestGrid(s.sheet, first.trimW, first.trimH, s, opts.maxPerSheet?.[key])
    if (grid.count === 0) {
      // doesn't fit at all — still make a sheet per item so the problem is visible
      for (const it of list) {
        const id = `${key}#${sheets.length}`
        const trim = { x: (s.sheet.widthMm - it.trimW) / 2, y: (s.sheet.heightMm - it.trimH) / 2, w: it.trimW, h: it.trimH }
        const sh = finishSheet<A>(
          { id, index: sheets.length, groupKey: key, trimW: it.trimW, trimH: it.trimH, placements: [{ id: `${id}/0`, slot: 0, item: it, trim, rotation: 0 }] },
          s,
        )
        sh.warnings.unshift(`${round3(it.trimW)} × ${round3(it.trimH)} mm (with bleed) does not fit on ${s.sheet.name} inside the margin.`)
        sheets.push(sh)
      }
      continue
    }
    const trims = gridTrims(s.sheet, grid, s)
    const cellLandscape = grid.cellW > grid.cellH + EPS
    for (let start = 0; start < list.length; start += grid.count) {
      const id = `${key}#${sheets.length}`
      const placements: Placement<A>[] = list.slice(start, start + grid.count).map((it, slot) => {
        const itemLandscape = it.trimW > it.trimH + EPS
        const isSquare = Math.abs(it.trimW - it.trimH) < EPS
        const rotation: Rotation = !isSquare && itemLandscape !== cellLandscape ? 90 : 0
        const base: Placement<A> = { id: `${id}/${slot}`, slot, item: it, trim: trims[slot], rotation }
        return applyOverride(base, opts.overrides?.[base.id])
      })
      const freeSlots = trims.slice(placements.length)
      sheets.push(finishSheet<A>({ id, index: sheets.length, groupKey: key, trimW: first.trimW, trimH: first.trimH, placements, freeSlots }, s))
    }
  }
  return sheets
}

const fmt = (n: number) => String(round3(n))

/** Text printed in the sheet's waste margin. */
export function sheetLabelText(sheet: Sheet, totalSheets: number, date: Date, trimName?: string): string {
  // names, with copy counts / panel ranges
  const parts: string[] = []
  const byDesign = new Map<string, { name: string; count: number; panels: number[]; total?: number }>()
  for (const p of sheet.placements) {
    const it = p.item
    const k = it.designId
    if (!byDesign.has(k)) byDesign.set(k, { name: it.name, count: 0, panels: [], total: it.panel?.total })
    const e = byDesign.get(k)!
    e.count++
    if (it.panel) e.panels.push(it.panel.index)
  }
  for (const e of byDesign.values()) {
    if (e.panels.length) {
      const ps = [...new Set(e.panels)].sort((a, b) => a - b)
      const range = ps.length > 1 && ps[ps.length - 1] - ps[0] === ps.length - 1 ? `${ps[0]}–${ps[ps.length - 1]}` : ps.join(', ')
      parts.push(`${e.name} (Panel${ps.length > 1 ? 's' : ''} ${range} of ${e.total})`)
    } else parts.push(e.count > 1 ? `${e.name} ×${e.count}` : e.name)
  }
  const first = sheet.placements[0]?.item
  const w = first ? first.trimW : sheet.trimW
  const h = first ? first.trimH : sheet.trimH
  const size = `${trimName ? trimName + ' ' : ''}${fmt(w)} × ${fmt(h)} mm`
  const d = date.toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: 'numeric' })
  return `${parts.join(', ')}  |  Trim ${size}  |  Sheet ${sheet.index + 1} of ${totalSheets}  |  ${d}`
}
