import { describe, expect, it } from 'vitest'
import { DEFAULT_CUT, type CutParams } from '../src/stickers/config'
import { type CutFrame, type CutRaster, computeCut, cutFrame } from '../src/stickers/lib/cutline'
import { distanceTo, fillHoles } from '../src/stickers/lib/edt'
import { flatten, pathsBounds, traceContours } from '../src/stickers/lib/paths'

/** Draws an art (given by a coverage function in art-local mm, y up) into a cut frame, like the worker does. */
function rasterize(frame: CutFrame, cover: (x: number, y: number) => number, color = [200, 30, 30]): CutRaster {
  const { w, h, pxPerMm: k } = frame
  const rgba = new Uint8ClampedArray(w * h * 4)
  const originX = frame.frame.x
  const originTopY = frame.frame.y + frame.frame.h
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) {
      // 4×4 supersampling for anti-aliased edges
      let a = 0
      for (let sy = 0; sy < 4; sy++)
        for (let sx = 0; sx < 4; sx++) {
          const mx = originX + (x + (sx + 0.5) / 4) / k - frame.art.x
          const my = originTopY - (y + (sy + 0.5) / 4) / k - frame.art.y
          if (mx >= 0 && my >= 0 && mx <= frame.art.w && my <= frame.art.h) a += cover(mx, my)
        }
      const i = (y * w + x) * 4
      rgba[i] = color[0]
      rgba[i + 1] = color[1]
      rgba[i + 2] = color[2]
      rgba[i + 3] = Math.round((a / 16) * 255)
    }
  return { rgba, w, h, pxPerMm: k, originX, originTopY }
}

const disc = (cx: number, cy: number, r: number) => (x: number, y: number) => ((x - cx) ** 2 + (y - cy) ** 2 <= r * r ? 1 : 0)
const radiiAround = (pts: [number, number][], cx: number, cy: number) => pts.map(([x, y]) => Math.hypot(x - cx, y - cy))
const params = (p: Partial<CutParams>): CutParams => ({ ...DEFAULT_CUT, ...p })

describe('distance transform', () => {
  it('is exact Euclidean', () => {
    const w = 21
    const mask = new Uint8Array(w * w)
    mask[10 * w + 10] = 1
    const d = distanceTo(mask, w, w)
    expect(d[10 * w + 10]).toBe(0)
    expect(d[10 * w + 13]).toBeCloseTo(3)
    expect(d[14 * w + 13]).toBeCloseTo(5) // 3-4-5
  })
  it('fills holes but not the outside', () => {
    const w = 7
    const m = new Uint8Array(w * w)
    for (let i = 1; i < 6; i++) m[1 * w + i] = m[5 * w + i] = m[i * w + 1] = m[i * w + 5] = 1
    const f = fillHoles(m, w, w)
    expect(f[3 * w + 3]).toBe(1)
    expect(f[0]).toBe(0)
  })
})

describe('marching squares', () => {
  it('traces a circle as one closed outline at the right radius', () => {
    const w = 60
    const f = new Float32Array(w * w)
    for (let y = 0; y < w; y++) for (let x = 0; x < w; x++) f[y * w + x] = 20 - Math.hypot(x + 0.5 - 30, y + 0.5 - 30)
    const loops = traceContours(f, w, w, 0)
    expect(loops).toHaveLength(1)
    for (const r of radiiAround(loops[0], 30, 30)) expect(r).toBeCloseTo(20, 1)
  })
})

describe('cut line around the artwork (contour)', () => {
  // a 40 mm round logo
  const art = disc(20, 20, 20)

  it('white border: cut is the art outline pushed out by exactly the border', () => {
    const p = params({ shape: 'contour', border: 'white', borderMm: 3, smoothMm: 2 })
    const fr = cutFrame(40, 40, p, 1.5)
    const g = computeCut(rasterize(fr, art), fr, p, 1.5)
    expect(g.pieces).toBe(1)
    expect(g.warnings).toEqual([])
    // centre of the art in the local frame is (3 + 20, 3 + 20)
    const radii = radiiAround(flatten(g.cut[0], 8), 23, 23)
    for (const r of radii) expect(Math.abs(r - 23)).toBeLessThan(0.12)
    // bounds = art + border on every side
    expect(g.bounds.w).toBeCloseTo(46, 0)
    expect(g.bounds.h).toBeCloseTo(46, 0)
    // bleed outline is 1.5 mm further out
    for (const r of radiiAround(flatten(g.bleed[0], 8), 23, 23)) expect(Math.abs(r - 24.5)).toBeLessThan(0.15)
    // white border → nothing printed past the art
    expect(g.bleedImage).toBeUndefined()
  })

  it('a smooth path: not thousands of tiny steps', () => {
    const p = params({ border: 'white', borderMm: 3 })
    const fr = cutFrame(40, 40, p, 1.5)
    const g = computeCut(rasterize(fr, art), fr, p, 1.5)
    expect(g.cut[0].segs.length).toBeLessThan(200)
    expect(g.cut[0].segs.length).toBeGreaterThan(8)
  })

  it('no border: cut runs right on the art edge and the edge colours are carried past it', () => {
    const p = params({ border: 'none', smoothMm: 0 })
    const fr = cutFrame(40, 40, p, 1.5)
    const g = computeCut(rasterize(fr, art, [10, 200, 50]), fr, p, 1.5)
    for (const r of radiiAround(flatten(g.cut[0], 8), 20, 20)) expect(Math.abs(r - 20)).toBeLessThan(0.1)
    expect(g.bleedImage).toBeDefined()
    const bi = g.bleedImage!
    // a pixel just outside the art, at the right edge, is filled with the art's colour
    const k = bi.w / bi.rect.w
    const px = Math.floor((40.8 - bi.rect.x) * k)
    const py = Math.floor((bi.rect.y + bi.rect.h - 20) * k)
    const o = (py * bi.w + px) * 4
    expect([bi.rgba[o], bi.rgba[o + 1], bi.rgba[o + 2], bi.rgba[o + 3]]).toEqual([10, 200, 50, 255])
  })

  it('two blobs far apart → two pieces and a warning; more smoothing joins them', () => {
    const two = (x: number, y: number) => Math.max(disc(6, 10, 6)(x, y), disc(34, 10, 6)(x, y))
    const p1 = params({ border: 'white', borderMm: 1, smoothMm: 1 })
    const f1 = cutFrame(40, 20, p1, 1)
    const g1 = computeCut(rasterize(f1, two), f1, p1, 1)
    expect(g1.pieces).toBe(2)
    expect(g1.warnings[0]).toMatch(/2 separate pieces/)
    const p2 = params({ border: 'white', borderMm: 1, smoothMm: 14 })
    const f2 = cutFrame(40, 20, p2, 1)
    expect(computeCut(rasterize(f2, two), f2, p2, 1).pieces).toBe(1)
  })

  it('holes inside the art (like the middle of an “O”) are not cut', () => {
    const ring = (x: number, y: number) => {
      const r = Math.hypot(x - 15, y - 15)
      return r <= 15 && r >= 8 ? 1 : 0
    }
    const p = params({ border: 'white', borderMm: 2, smoothMm: 0 })
    const fr = cutFrame(30, 30, p, 1)
    const g = computeCut(rasterize(fr, ring), fr, p, 1)
    expect(g.pieces).toBe(1)
  })

  it('a speck of dust next to the art is ignored', () => {
    const withDust = (x: number, y: number) => Math.max(disc(10, 10, 10)(x, y), disc(19.5, 0.5, 0.15)(x, y))
    const p = params({ border: 'white', borderMm: 0.5, smoothMm: 0 })
    const fr = cutFrame(20, 20, p, 1)
    const g = computeCut(rasterize(fr, withDust), fr, p, 1)
    expect(g.pieces).toBe(1)
  })
})

describe('cut line shapes', () => {
  const square = () => 1
  it('rounded rectangle = art + border, exact vectors', () => {
    const p = params({ shape: 'rounded', border: 'white', borderMm: 2, cornerMm: 4 })
    const fr = cutFrame(50, 30, p, 1.5)
    const g = computeCut(rasterize(fr, square), fr, p, 1.5)
    expect(g.bounds.x).toBeCloseTo(0, 3)
    expect(g.bounds.w).toBeCloseTo(54, 3)
    expect(g.bounds.h).toBeCloseTo(34, 3)
    expect(pathsBounds(g.bleed).w).toBeCloseTo(57, 3)
  })
  it('circle on a square photo warns that corners are cut off', () => {
    const p = params({ shape: 'circle', border: 'none' })
    const fr = cutFrame(40, 40, p, 1.5)
    const g = computeCut(rasterize(fr, square), fr, p, 1.5)
    expect(g.warnings.join()).toMatch(/cut off/)
    expect(g.bleedImage).toBeDefined()
  })
})

import { DEFAULT_STICKER_SETTINGS, cloneStickerSettings } from '../src/stickers/config'
import { type NestDesign, contentArea, layoutProblems, nest, placementRect, roomOnLastSheet } from '../src/stickers/lib/nest'
import { ellipsePath, roundedRectPath } from '../src/stickers/lib/paths'

const circleDesign = (id: string, d: number, copies: number): NestDesign => ({
  id,
  name: id,
  cut: [ellipsePath(d / 2, d / 2, d / 2, d / 2)],
  bounds: { x: 0, y: 0, w: d, h: d },
  copies,
  rotation: 'auto',
})
const rectDesign = (id: string, w: number, h: number, copies: number): NestDesign => ({
  id,
  name: id,
  cut: [roundedRectPath(0, 0, w, h, 0)],
  bounds: { x: 0, y: 0, w, h },
  copies,
  rotation: 'auto',
})

describe('sticker sheet layout', () => {
  // L corners: the usable area is 179 × 266 mm on A4 (the numbers below assume it)
  const s = cloneStickerSettings(DEFAULT_STICKER_SETTINGS)
  s.marks.style = 'l-corners'
  const lookup = (ds: NestDesign[]) => Object.fromEntries(ds.map((d) => [d.id, d]))

  it('rectangles: plain grid with the gap between cut lines, nothing outside the usable area', () => {
    const ds = [rectDesign('r', 50, 30, 1000)]
    const res = nest(ds, s)
    const area = contentArea(s)
    // A4 with default marks: usable 210 − 2·15.5 = 179 wide, 297 − 31 = 266 high
    expect(area.w).toBeCloseTo(179)
    const perRow = Math.floor((179 + 3) / (50 + 3))
    const perCol = Math.floor((266 + 3) / (30 + 3))
    // the rotated way round (30 wide, 50 high) fits 5 × 5 = 25 against 3 × 8 = 24
    const rotated = Math.floor((179 + 3) / 33) * Math.floor((266 + 3) / 53)
    expect(res.capacity.r.perSheet).toBe(Math.max(perRow * perCol, rotated))
    for (const sh of res.sheets) {
      const pr = layoutProblems(sh, lookup(ds), s)
      expect(pr.overlapping.size).toBe(0)
      expect(pr.outside.size).toBe(0)
    }
    // neighbouring cut lines are exactly the gap apart (to the 0.25 mm packing grid)
    const rects = res.sheets[0].placements.map((p) => placementRect(p, ds[0].bounds, s)).sort((a, b) => a.x - b.x || a.y - b.y)
    const xs = [...new Set(rects.map((r) => Math.round(r.x * 100) / 100))].sort((a, b) => a - b)
    expect(xs[1] - xs[0] - rects[0].w).toBeGreaterThanOrEqual(3 - 0.01)
    expect(xs[1] - xs[0] - rects[0].w).toBeLessThan(3.5)
  })

  it('circles nest into each other’s gaps: more fit than in a square grid', () => {
    const ds = [circleDesign('c', 40, 1000)]
    const res = nest(ds, s)
    const grid = Math.floor((179 + 3) / 43) * Math.floor((266 + 3) / 43)
    expect(res.capacity.c.perSheet).toBeGreaterThan(grid)
    const pr = layoutProblems(res.sheets[0], lookup(ds), s)
    expect(pr.overlapping.size).toBe(0)
    expect(pr.outside.size).toBe(0)
  })

  it('copies flow onto as many sheets as needed; designs share a sheet', () => {
    const ds = [rectDesign('a', 60, 60, 5), circleDesign('b', 30, 7)]
    const res = nest(ds, s)
    const count = (id: string) => res.sheets.flatMap((sh) => sh.placements).filter((p) => p.designId === id).length
    expect(count('a')).toBe(5)
    expect(count('b')).toBe(7)
    expect(res.sheets).toHaveLength(1)
    expect(layoutProblems(res.sheets[0], lookup(ds), s).overlapping.size).toBe(0)
    const many = nest([rectDesign('a', 60, 60, 30)], s)
    expect(many.sheets.length).toBe(Math.ceil(30 / many.capacity.a.perSheet))
  })

  it('different designs share rows instead of each taking a band of its own', () => {
    const ds = [rectDesign('a', 50, 50, 2), rectDesign('b', 50, 50, 2)]
    const res = nest(ds, s)
    expect(res.sheets).toHaveLength(1)
    const pl = res.sheets[0].placements
    // 4 squares of 50 mm on a 179 mm wide area: 3 in the first row, 1 in the second – never 4 rows
    const bottom = Math.max(...pl.map((p) => p.y + 50))
    expect(bottom).toBeLessThanOrEqual(2 * 50 + 3 + 0.5)
    expect(layoutProblems(res.sheets[0], lookup(ds), s).overlapping.size).toBe(0)
  })

  it('mixed sheets: small stickers fill the gaps left by big ones', () => {
    const ds = [rectDesign('big', 120, 80, 2), circleDesign('dot', 25, 12)]
    const res = nest(ds, s)
    expect(res.sheets).toHaveLength(1)
    expect(res.sheets[0].placements).toHaveLength(14)
    const pr = layoutProblems(res.sheets[0], lookup(ds), s)
    expect(pr.overlapping.size).toBe(0)
    expect(pr.outside.size).toBe(0)
  })

  it('a full sheet of one design, then the rest mixed', () => {
    const one = nest([circleDesign('c', 40, 1)], s).capacity.c.perSheet
    const ds = [circleDesign('c', 40, one + 2), rectDesign('r', 30, 30, 3)]
    const res = nest(ds, s)
    expect(res.sheets).toHaveLength(2)
    expect(res.sheets[0].placements.every((p) => p.designId === 'c')).toBe(true)
    expect(res.sheets[0].placements).toHaveLength(one)
    expect(res.sheets[1].placements).toHaveLength(5)
    for (const sh of res.sheets) expect(layoutProblems(sh, lookup(ds), s).overlapping.size).toBe(0)
  })

  it('is fast enough to run on every change, “fill sheet” included', () => {
    const ds = [rectDesign('a', 45, 38, 7), circleDesign('b', 33, 9), rectDesign('c', 70, 25, 4)]
    const t0 = performance.now()
    nest(ds, s)
    roomOnLastSheet(ds, 'b', s)
    expect(performance.now() - t0).toBeLessThan(1500)
  })

  it('“fill the sheet” finds exactly the free room', () => {
    const ds = [circleDesign('c', 40, 3)]
    const room = roomOnLastSheet(ds, 'c', s)
    expect(room).toBe(nest(ds, s).capacity.c.perSheet - 3)
  })

  it('a sticker bigger than the sheet is reported, not placed', () => {
    const res = nest([rectDesign('big', 400, 400, 1)], s)
    expect(res.sheets).toHaveLength(0)
    expect(res.warnings[0]).toMatch(/bigger than the printable area/)
  })

  it('moving a sticker onto another is detected', () => {
    const ds = [rectDesign('r', 40, 40, 2)]
    const res = nest(ds, s)
    const sh = res.sheets[0]
    sh.placements[1] = { ...sh.placements[1], x: sh.placements[0].x + 10, y: sh.placements[0].y }
    expect(layoutProblems(sh, lookup(ds), s).overlapping.size).toBe(2)
  })
})

import { PDFArray, PDFDocument as PdfDoc, PDFRawStream, decodePDFRawStream } from 'pdf-lib'
import { createCanvas } from '@napi-rs/canvas'
import { PT_PER_MM } from '../src/config/defaults'
import { buildCutSvg, buildStickerPdf, markDots, markRects, type ExportDesign } from '../src/stickers/lib/exportStickers'

function pngOf(w: number, h: number): Uint8Array {
  const c = createCanvas(w, h)
  const g = c.getContext('2d')
  g.fillStyle = '#e33'
  g.beginPath()
  g.arc(w / 2, h / 2, w / 2 - 2, 0, Math.PI * 2)
  g.fill()
  return new Uint8Array(c.toBuffer('image/png'))
}

describe('sticker export', () => {
  const s = cloneStickerSettings(DEFAULT_STICKER_SETTINGS)
  const design: ExportDesign = {
    id: 'c',
    name: 'Circle',
    cut: [ellipsePath(23, 23, 23, 23)],
    bleed: [ellipsePath(23, 23, 24.5, 24.5)],
    bounds: { x: 0, y: 0, w: 46, h: 46 },
    border: 'color',
    borderColor: '#ffcc00',
    art: { bytes: pngOf(200, 200), kind: 'png', rect: { x: 3, y: 3, w: 40, h: 40 } },
  }
  const layout = nest([{ id: 'c', name: 'Circle', cut: design.cut, bounds: design.bounds, copies: 5, rotation: 'auto' }], s)

  const contentOf = async (bytes: Uint8Array) => {
    const doc = await PdfDoc.load(bytes)
    const page = doc.getPage(0)
    const contents = page.node.Contents()
    const streams = contents instanceof PDFArray ? contents.asArray().map((r) => doc.context.lookup(r)) : [contents]
    const text = streams.map((st) => new TextDecoder().decode(decodePDFRawStream(st as PDFRawStream).decode())).join('\n')
    return { doc, page, text }
  }

  it('page = sheet size; cut lines are a CutContour spot colour with overprint, on their own layer', async () => {
    const pdf = await buildStickerPdf(layout.sheets, { c: design }, s, { mode: 'print-cut', date: new Date('2026-10-16') })
    const { doc, page, text } = await contentOf(pdf)
    expect(page.getWidth()).toBeCloseTo(210 * PT_PER_MM, 3)
    expect(page.getHeight()).toBeCloseTo(297 * PT_PER_MM, 3)
    const raw = new TextDecoder('latin1').decode(pdf)
    expect(raw).toMatch(/\/Separation \/CutContour \/DeviceCMYK/)
    expect(raw).toMatch(/\/OP true/)
    expect(raw).toMatch(/\/OCProperties/)
    expect(raw).toMatch(/\(Print\)/)
    expect(raw).toMatch(/\(CutContour\)/)
    // 5 stickers → 5 stroked cut paths, each 4 curves (ellipse)
    expect(text.match(/ S\n/g)?.length ?? text.match(/\bS\b/g)?.length).toBe(5)
    expect(text).toMatch(/\/CSCut CS/)
    expect(text).toMatch(/\/GSCut gs/)
    // printed border fill and art image are drawn
    expect(text).toMatch(/1 0\.8 0 rg/)
    expect(doc.getPageCount()).toBe(1)
  })

  it('print-only has no cut colour; cut-only has no artwork', async () => {
    const printOnly = new TextDecoder('latin1').decode(await buildStickerPdf(layout.sheets, { c: design }, s, { mode: 'print' }))
    expect(printOnly).not.toMatch(/CutContour \/DeviceCMYK/)
    const cutOnly = await buildStickerPdf(layout.sheets, { c: design }, s, { mode: 'cut' })
    const { text } = await contentOf(cutOnly)
    expect(text).not.toMatch(/ Do\b/)
    expect(text).toMatch(/\/CSCut CS/)
  })

  it('dot marks: 4 black dots, outer edge exactly the margin (10 mm) from both sheet edges', async () => {
    expect(s.marks.style).toBe('dots')
    expect(markRects(s)).toHaveLength(0)
    const dots = markDots(s)
    expect(dots).toHaveLength(4)
    for (const d of dots) {
      expect(d.r).toBeCloseTo(s.marks.sizeMm / 2, 9)
      expect(Math.min(d.cx - d.r, 210 - d.cx - d.r)).toBeCloseTo(10, 9)
      expect(Math.min(d.cy - d.r, 297 - d.cy - d.r)).toBeCloseTo(10, 9)
    }
    // stickers keep clear of the dots
    for (const p of layout.sheets[0].placements) {
      const r = placementRect(p, design.bounds, s)
      for (const d of dots) {
        const nx = Math.max(r.x, Math.min(d.cx, r.x + r.w))
        const ny = Math.max(r.y, Math.min(d.cy, r.y + r.h))
        expect(Math.hypot(nx - d.cx, ny - d.cy)).toBeGreaterThanOrEqual(d.r + s.marks.clearanceMm - 1e-6)
      }
    }
    // printed in 100 % K in the PDF, circles in the SVG
    const { text } = await contentOf(await buildStickerPdf(layout.sheets, { c: design }, s, { mode: 'print-cut' }))
    expect(text).toMatch(/0 0 0 1 k/)
    const svg = buildCutSvg(layout.sheets[0], { c: design }, s)
    expect(svg.match(/<circle /g)).toHaveLength(4)
    expect(svg).toContain(`<circle cx="12.5" cy="12.5" r="2.5"/>`)
  })

  it('registration marks sit in the corners, inside the margin rule', () => {
    const marks = markRects({ ...s, marks: { ...s.marks, style: 'l-corners' } })
    expect(marks).toHaveLength(8) // 4 L-shapes
    for (const m of marks) {
      expect(m.x).toBeGreaterThanOrEqual(s.marginMm - 1e-9)
      expect(m.y).toBeGreaterThanOrEqual(s.marginMm - 1e-9)
      expect(m.x + m.w).toBeLessThanOrEqual(210 - s.marginMm + 1e-9)
      expect(m.y + m.h).toBeLessThanOrEqual(297 - s.marginMm + 1e-9)
    }
    const area = contentArea(s)
    // no sticker comes near a mark
    for (const p of layout.sheets[0].placements) {
      const r = placementRect(p, design.bounds, s)
      expect(r.x).toBeGreaterThanOrEqual(area.x - 1e-6)
      expect(r.y).toBeGreaterThanOrEqual(area.y - 1e-6)
    }
  })

  it('SVG cut file lines up with the PDF (same positions, mm, top-left origin)', () => {
    const svg = buildCutSvg(layout.sheets[0], { c: design }, s)
    expect(svg).toMatch(/width="210mm" height="297mm" viewBox="0 0 210 297"/)
    expect(svg.match(/<path /g)).toHaveLength(5)
    const r = placementRect(layout.sheets[0].placements[0], design.bounds, s)
    // ellipse path starts at its rightmost point: (x + w, centre)
    const m = svg.match(/<path d="M([\d.]+) ([\d.]+)/)!
    expect(Number(m[1])).toBeCloseTo(r.x + r.w, 2)
    expect(Number(m[2])).toBeCloseTo(297 - (r.y + r.h / 2), 2)
  })
})
