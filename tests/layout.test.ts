import { describe, expect, it } from 'vitest'
import { DEFAULT_SETTINGS, PT_PER_MM, SHEETS, cloneSettings, type PrintSettings } from '../src/config/defaults'
import { expand, mmToPt, rectInside, rectsOverlap, segmentBounds, segmentHitsRect, type Segment } from '../src/lib/geometry'
import { bestGrid, layoutJob, placementMatrix, sheetLabelText, type LayoutItem } from '../src/lib/layout'
import { apply } from '../src/lib/geometry'

const S13x19 = SHEETS[0]
const SA3 = SHEETS[1]

/** 3 mm bleed, marks 3 mm from the corner, bleeds touching (the classic setup, used by most tests below). */
function settingsFor(sheet = S13x19): PrintSettings {
  const s = cloneSettings(DEFAULT_SETTINGS)
  s.sheet = sheet
  s.bleedMm = 3
  s.marks.offsetMm = 3
  s.marks.lengthMm = 5
  s.gutterMm = 0
  return s
}

const items = (n: number, w: number, h: number, name = 'Test'): LayoutItem[] =>
  Array.from({ length: n }, (_, i) => ({ id: `i${i}`, designId: 'd1', name, trimW: w, trimH: h }))

const close = (a: number, b: number, digits = 6) => expect(a).toBeCloseTo(b, digits)

/** Every invariant that must hold on any sheet. */
function checkInvariants(s: PrintSettings, sheet: ReturnType<typeof layoutJob>[number]) {
  const sheetRect = { x: 0, y: 0, w: s.sheet.widthMm, h: s.sheet.heightMm }
  const margin = { x: s.marginMm, y: s.marginMm, w: s.sheet.widthMm - 2 * s.marginMm, h: s.sheet.heightMm - 2 * s.marginMm }
  const arts = sheet.placements.map((p) => expand(p.trim, s.bleedMm))
  // artwork + bleed inside the margin, no overlaps
  arts.forEach((a, i) => {
    expect(rectInside(a, margin)).toBe(true)
    arts.slice(i + 1).forEach((b) => expect(rectsOverlap(a, b)).toBe(false))
  })
  for (const m of sheet.marks) {
    // marks never cross any artwork (incl. bleed)
    for (const a of arts) expect(segmentHitsRect(m, a)).toBe(false)
    // marks stay on the sheet, at least minEdge from the edge
    const b = segmentBounds(m)
    expect(rectInside(b, { x: s.minEdgeMm, y: s.minEdgeMm, w: s.sheet.widthMm - 2 * s.minEdgeMm, h: s.sheet.heightMm - 2 * s.minEdgeMm })).toBe(true)
    // marks are horizontal or vertical, length between minLength and length
    const len = Math.hypot(m.x2 - m.x1, m.y2 - m.y1)
    expect(len).toBeLessThanOrEqual(s.marks.lengthMm + 1e-9)
    expect(len).toBeGreaterThanOrEqual(s.marks.minLengthMm - 1e-9)
    expect(b.w < 1e-9 || b.h < 1e-9).toBe(true)
  }
  // label sits in the waste area: not touching artwork or marks, on the sheet
  if (sheet.label) {
    const L = sheet.label.box
    expect(rectInside(L, sheetRect)).toBe(true)
    for (const a of arts) expect(rectsOverlap(L, a, 0)).toBe(false)
    for (const m of sheet.marks) expect(rectsOverlap(L, segmentBounds(m), 0)).toBe(false)
  }
  // every cut line has at least one crop mark lying on it
  for (const p of sheet.placements) {
    const { x, y, w, h } = p.trim
    for (const cx of [x, x + w]) expect(sheet.marks.some((m) => Math.abs(m.x1 - cx) < 1e-6 && Math.abs(m.x2 - cx) < 1e-6)).toBe(true)
    for (const cy of [y, y + h]) expect(sheet.marks.some((m) => Math.abs(m.y1 - cy) < 1e-6 && Math.abs(m.y2 - cy) < 1e-6)).toBe(true)
  }
  expect(sheet.warnings).toEqual([])
}

/** The two marks at the outside of a free corner: start `offset` from the corner, `length` long. */
function expectCornerMarks(marks: Segment[], cx: number, cy: number, dirX: -1 | 1, dirY: -1 | 1, s: PrintSettings) {
  const { offsetMm: o, lengthMm: l } = s.marks
  const hasH = marks.some(
    (m) => Math.abs(m.y1 - cy) < 1e-9 && Math.abs(m.y2 - cy) < 1e-9 && Math.abs(m.x1 - (cx + dirX * o)) < 1e-9 && Math.abs(m.x2 - (cx + dirX * (o + l))) < 1e-9,
  )
  const hasV = marks.some(
    (m) => Math.abs(m.x1 - cx) < 1e-9 && Math.abs(m.x2 - cx) < 1e-9 && Math.abs(m.y1 - (cy + dirY * o)) < 1e-9 && Math.abs(m.y2 - (cy + dirY * (o + l))) < 1e-9,
  )
  expect(hasH, `horizontal mark at corner ${cx},${cy}`).toBe(true)
  expect(hasV, `vertical mark at corner ${cx},${cy}`).toBe(true)
}

describe('units', () => {
  it('converts mm to PDF points exactly (72 / 25.4)', () => {
    close(PT_PER_MM, 2.834645669, 8)
    close(mmToPt(25.4), 72, 10)
    close(mmToPt(S13x19.widthMm), 936, 9) // 13 in × 72
    close(mmToPt(S13x19.heightMm), 1368, 9) // 19 in × 72
    close(mmToPt(297), 841.889764, 5)
    close(mmToPt(420), 1190.551181, 5)
  })
  it('13 × 19 inch sheet is 330.2 × 482.6 mm', () => {
    close(S13x19.widthMm, 330.2)
    close(S13x19.heightMm, 482.6)
  })
})

describe('ups on 13 × 19 inch', () => {
  const s = settingsFor()
  it('A3 = 1, A4 = 2, A5 = 4', () => {
    expect(bestGrid(s.sheet, 297, 420, s).count).toBe(1)
    expect(bestGrid(s.sheet, 210, 297, s).count).toBe(2)
    expect(bestGrid(s.sheet, 148, 210, s).count).toBe(4)
  })
  it('landscape input gives the same counts', () => {
    expect(bestGrid(s.sheet, 420, 297, s).count).toBe(1)
    expect(bestGrid(s.sheet, 297, 210, s).count).toBe(2)
    expect(bestGrid(s.sheet, 210, 148, s).count).toBe(4)
  })
  it('max per sheet override forces fewer copies', () => {
    expect(bestGrid(s.sheet, 148, 210, s, 1).count).toBe(1)
    expect(bestGrid(s.sheet, 148, 210, s, 2).count).toBe(2)
  })
})

describe('A3 single on 13 × 19', () => {
  const s = settingsFor()
  const [sheet] = layoutJob(items(1, 297, 420), s)
  it('trim box is centred: x 16.6, y 31.3, 297 × 420', () => {
    const t = sheet.placements[0].trim
    close(t.x, 16.6)
    close(t.y, 31.3)
    close(t.w, 297)
    close(t.h, 420)
    close(t.x * 2 + t.w, s.sheet.widthMm) // equal left/right space
    close(t.y * 2 + t.h, s.sheet.heightMm) // equal top/bottom space
    expect(sheet.placements[0].rotation).toBe(0)
  })
  it('bleed is 3 mm on every side', () => {
    const b = expand(sheet.placements[0].trim, s.bleedMm)
    close(b.x, 13.6)
    close(b.y, 28.3)
    close(b.w, 303)
    close(b.h, 426)
  })
  it('8 crop marks: 5 mm long, starting 3 mm from each trim corner', () => {
    expect(sheet.marks).toHaveLength(8)
    const { x, y, w, h } = sheet.placements[0].trim
    expectCornerMarks(sheet.marks, x, y, -1, -1, s)
    expectCornerMarks(sheet.marks, x + w, y, 1, -1, s)
    expectCornerMarks(sheet.marks, x, y + h, -1, 1, s)
    expectCornerMarks(sheet.marks, x + w, y + h, 1, 1, s)
    // e.g. bottom-left horizontal mark runs from x = 13.6 to 8.6 at y = 31.3
    expect(sheet.marks).toContainEqual({ x1: 13.6, y1: 31.3, x2: 8.6, y2: 31.3 })
  })
  it('passes all sheet checks', () => checkInvariants(s, sheet))
})

describe('A4 2-up on 13 × 19', () => {
  const s = settingsFor()
  const sheets = layoutJob(items(2, 210, 297), s)
  const [sheet] = sheets
  it('both copies on one sheet, rotated 90° (landscape), stacked', () => {
    expect(sheets).toHaveLength(1)
    expect(sheet.placements).toHaveLength(2)
    const [a, b] = sheet.placements
    expect(a.rotation).toBe(90)
    expect(b.rotation).toBe(90)
    close(a.trim.x, 16.6)
    close(a.trim.y, 244.3)
    close(a.trim.w, 297)
    close(a.trim.h, 210)
    close(b.trim.x, 16.6)
    close(b.trim.y, 28.3)
  })
  it('bleeds touch but do not overlap (6 mm between trims)', () => {
    const [a, b] = sheet.placements
    close(a.trim.y - (b.trim.y + b.trim.h), 2 * s.bleedMm)
  })
  it('outer corners have full marks; marks between copies are dropped', () => {
    const [a, b] = sheet.placements
    expectCornerMarks(sheet.marks, a.trim.x, a.trim.y + a.trim.h, -1, 1, s)
    expectCornerMarks(sheet.marks, a.trim.x + a.trim.w, a.trim.y + a.trim.h, 1, 1, s)
    expectCornerMarks(sheet.marks, b.trim.x, b.trim.y, -1, -1, s)
    expectCornerMarks(sheet.marks, b.trim.x + b.trim.w, b.trim.y, 1, -1, s)
    expect(sheet.marks).toHaveLength(12) // 8 outer + 4 side marks for the two middle cut lines
  })
  it('rotation maps the design correctly onto the sheet', () => {
    const p = sheet.placements[0]
    const m = placementMatrix(p)
    // design's bottom-left (0,0) → sheet bottom-right of the trim; top-left (0,297) → bottom-left
    const [x0, y0] = apply(m, 0, 0)
    close(x0, p.trim.x + p.trim.w)
    close(y0, p.trim.y)
    const [x1, y1] = apply(m, 0, 297)
    close(x1, p.trim.x)
    close(y1, p.trim.y)
  })
  it('passes all sheet checks', () => checkInvariants(s, sheet))
})

describe('A5 4-up on 13 × 19', () => {
  const s = settingsFor()
  const [sheet] = layoutJob(items(4, 148, 210), s)
  it('2 × 2 grid, upright, reading order', () => {
    expect(sheet.placements).toHaveLength(4)
    const t = sheet.placements.map((p) => p.trim)
    sheet.placements.forEach((p) => expect(p.rotation).toBe(0))
    close(t[0].x, 14.1)
    close(t[0].y, 244.3)
    close(t[1].x, 168.1)
    close(t[1].y, 244.3)
    close(t[2].x, 14.1)
    close(t[2].y, 28.3)
    close(t[3].x, 168.1)
    close(t[3].y, 28.3)
  })
  it('16 crop marks, all at the outside of the block', () => {
    expect(sheet.marks).toHaveLength(16)
    const xs = [14.1, 162.1, 168.1, 316.1]
    const ys = [28.3, 238.3, 244.3, 454.3]
    for (const x of xs) {
      expect(sheet.marks).toContainEqual({ x1: x, y1: 457.3, x2: x, y2: 462.3 }) // top
      expect(sheet.marks).toContainEqual({ x1: x, y1: 25.3, x2: x, y2: 20.3 }) // bottom
    }
    for (const y of ys) {
      expect(sheet.marks.find((m) => m.y1 === y && m.x2 < m.x1)).toMatchObject({ x1: 11.1, x2: 6.1 }) // left
      expect(sheet.marks.find((m) => m.y1 === y && m.x2 > m.x1)).toMatchObject({ x1: 319.1, x2: 324.1 }) // right
    }
  })
  it('passes all sheet checks', () => checkInvariants(s, sheet))
  it('5 copies → 2 sheets (4 + 1)', () => {
    const sh = layoutJob(items(5, 148, 210), s)
    expect(sh.map((x) => x.placements.length)).toEqual([4, 1])
  })
})

describe('on an A3 sheet (297 × 420)', () => {
  const s = settingsFor(SA3)
  it('A3 trim does NOT fit (needs 303 × 426 + margins) and says so', () => {
    expect(bestGrid(s.sheet, 297, 420, s).count).toBe(0)
    const [sheet] = layoutJob(items(1, 297, 420), s)
    expect(sheet.warnings.join(' ')).toMatch(/does not fit/)
  })
  it('A4 = 1-up, centred', () => {
    const [sheet] = layoutJob(items(1, 210, 297), s)
    const t = sheet.placements[0].trim
    close(t.x, 43.5)
    close(t.y, 61.5)
    expect(sheet.marks).toHaveLength(8)
    checkInvariants(s, sheet)
  })
  it('A5 = 2-up (landscape, stacked)', () => {
    const sheets = layoutJob(items(2, 148, 210), s)
    expect(sheets).toHaveLength(1)
    const [a, b] = sheets[0].placements
    expect(a.rotation).toBe(90)
    close(a.trim.x, 43.5)
    close(a.trim.w, 210)
    close(a.trim.h, 148)
    close(a.trim.y, 213)
    close(b.trim.y, 59)
    checkInvariants(s, sheets[0])
  })
  it('A4 with a 3 mm margin fits 1-up and the result still passes checks', () => {
    const s2 = settingsFor(SA3)
    s2.marginMm = 3
    const [sheet] = layoutJob(items(1, 210, 297), s2)
    checkInvariants(s2, sheet)
  })
})

describe('DEFAULTS: classic 3 mm bleed', () => {
  const s = cloneSettings(DEFAULT_SETTINGS)
  it('defaults are 3 mm bleed, bleeds touching, 5 mm marks starting 3 mm from the corner (outside the bleed)', () => {
    expect(s.bleedMm).toBe(3)
    expect(s.gutterMm).toBe(0)
    expect(s.marks).toMatchObject({ lengthMm: 5, offsetMm: 3 })
    expect(s.marks.offsetMm).toBeGreaterThanOrEqual(s.bleedMm)
  })
  it('every corner of every copy gets its marks, clear of all artwork and bleed', () => {
    for (const [w, h, n] of [[297, 420, 1], [210, 297, 2], [148, 210, 4]]) {
      const [sheet] = layoutJob(items(n, w, h), s)
      expect(sheet.placements).toHaveLength(n)
      expect(sheet.marks.length).toBeGreaterThan(0)
      checkInvariants(s, sheet)
    }
  })
})

describe('no-bleed setup: 8 mm gap (split posters, as the CorelDRAW reference)', () => {
  const s = cloneSettings(DEFAULT_SETTINGS)
  Object.assign(s, { bleedMm: 0, gutterMm: 8, marks: { ...s.marks, lengthMm: 4, offsetMm: 1 } })
  const sheets = layoutJob(items(2, 210, 297), s)
  const [a, b] = sheets[0].placements
  it('A4 panels: 2 per sheet, landscape, stacked with an 8 mm white gap', () => {
    expect(sheets).toHaveLength(1)
    expect(sheets[0].placements).toHaveLength(2)
    close(a.trim.w, 297)
    close(a.trim.h, 210)
    close(a.trim.y - (b.trim.y + b.trim.h), 8)
    checkInvariants(s, sheets[0])
  })
  it('marks only at the outside: none in the gap between the panels', () => {
    expectCornerMarks(sheets[0].marks, a.trim.x, a.trim.y + a.trim.h, -1, 1, s)
    expectCornerMarks(sheets[0].marks, a.trim.x + a.trim.w, a.trim.y + a.trim.h, 1, 1, s)
    expectCornerMarks(sheets[0].marks, b.trim.x, b.trim.y, -1, -1, s)
    expectCornerMarks(sheets[0].marks, b.trim.x + b.trim.w, b.trim.y, 1, -1, s)
    const gapTop = a.trim.y
    const gapBottom = b.trim.y + b.trim.h
    const inGap = sheets[0].marks.filter((m) => {
      const r = segmentBounds(m)
      return r.y < gapTop - 1e-6 && r.y + r.h > gapBottom + 1e-6
    })
    expect(inGap).toEqual([])
    // 8 outer + 4 side marks on the two inner cut lines
    expect(sheets[0].marks).toHaveLength(12)
  })
  it('A5 4-up: no marks between the panels either', () => {
    const [sh] = layoutJob(items(4, 148, 210), s)
    expect(sh.placements).toHaveLength(4)
    expect(sh.marks).toHaveLength(16)
    checkInvariants(s, sh)
  })
})

describe('mixing and splitting', () => {
  const s = settingsFor()
  it('different sizes go on separate sheets; same sizes share', () => {
    const list: LayoutItem[] = [
      ...items(1, 148, 210, 'Cat'),
      { id: 'x', designId: 'd2', name: 'Dog', trimW: 210, trimH: 148 },
      ...items(1, 210, 297, 'Big'),
    ]
    const sheets = layoutJob(list, s)
    expect(sheets).toHaveLength(2)
    expect(sheets[0].placements.map((p) => p.item.name)).toEqual(['Cat', 'Dog'])
    expect(sheets[0].placements[1].rotation).toBe(90) // landscape design in a portrait cell
    expect(sheets[1].placements.map((p) => p.item.name)).toEqual(['Big'])
  })
  it('label text names designs, panels, size, sheet number and date', () => {
    const list: LayoutItem[] = [1, 2, 3].map((i) => ({
      id: `p${i}`,
      designId: 'sp',
      name: 'Mountains',
      panel: { index: i, total: 3 },
      trimW: 148,
      trimH: 210,
    }))
    const [sheet] = layoutJob(list, s)
    const text = sheetLabelText(sheet, 6, new Date(2026, 9, 15), 'A5')
    expect(text).toContain('Mountains (Panels 1–3 of 3)')
    expect(text).toContain('A5 148 × 210 mm')
    expect(text).toContain('Sheet 1 of 6')
    expect(text).toContain('15 Oct 2026')
  })
  it('manual move/rotate overrides apply and are checked', () => {
    const [base] = layoutJob(items(1, 148, 210), s)
    const id = base.placements[0].id
    const [moved] = layoutJob(items(1, 148, 210), s, { overrides: { [id]: { dx: 10, dy: -5, quarterTurns: 1 } } })
    const p = moved.placements[0]
    expect(p.rotation).toBe(90)
    close(p.trim.w, 210)
    close(p.trim.h, 148)
    const [far] = layoutJob(items(1, 148, 210), s, { overrides: { [id]: { dx: 500 } } })
    expect(far.warnings.join(' ')).toMatch(/off the sheet/)
  })
  it('wider gutter gives full marks between copies too', () => {
    const s2 = settingsFor()
    s2.gutterMm = 20
    const sheets = layoutJob(items(2, 148, 210), s2)
    expect(sheets[0].marks).toHaveLength(16) // every corner gets both marks
    checkInvariants(s2, sheets[0])
  })
})
