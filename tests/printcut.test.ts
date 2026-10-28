import { describe, expect, it } from 'vitest'
import { PDFDocument, PDFName, rgb } from 'pdf-lib'
import { PT_PER_MM } from '../src/config/defaults'
import { apply } from '../src/lib/geometry'
import { readSource, type SourceFile } from '../src/lib/sources'
import { buildPrintCutPdf, buildItemPreviewPdf } from '../src/printcut/exportPrintCut'
import {
  DEFAULT_PRINTCUT_SETTINGS,
  DEFAULT_PRODUCTS,
  type PrintCutItem,
  contourKey,
  contourParams,
  contourPadMm,
  contourRaster,
  findContent,
  itemShape,
  matchProduct,
  newItemFor,
  planItem,
  setContour,
} from '../src/printcut/model'
import { computeCut, cutFrame } from '../src/stickers/lib/cutline'
import { createCanvas } from '@napi-rs/canvas'
import { layoutProblems, nest } from '../src/stickers/lib/nest'
import { flatten } from '../src/stickers/lib/paths'

const s = DEFAULT_PRINTCUT_SETTINGS

async function designPdf(wMm: number, hMm: number, round = false): Promise<Uint8Array> {
  const doc = await PDFDocument.create()
  const page = doc.addPage([wMm * PT_PER_MM, hMm * PT_PER_MM])
  const W = wMm * PT_PER_MM
  const H = hMm * PT_PER_MM
  if (round) page.drawEllipse({ x: W / 2, y: H / 2, xScale: W / 2, yScale: H / 2, color: rgb(0.95, 0.75, 0.75) })
  else page.drawRectangle({ x: 0, y: 0, width: W, height: H, color: rgb(0.95, 0.75, 0.75) })
  return doc.save()
}

async function setup() {
  const coaster = await readSource('coaster.pdf', await designPdf(82, 82, true), 'src-c')
  const wrap = await readSource('mug wrap.pdf', await designPdf(250, 84.06), 'src-w')
  const sources: Record<string, SourceFile> = { [coaster.id]: coaster, [wrap.id]: wrap }
  const c = newItemFor('c', 'coaster', coaster.id, 0, coaster.pages[0].geometry, DEFAULT_PRODUCTS, s.bleedMm)
  const w = newItemFor('w', 'mug wrap', wrap.id, 0, wrap.pages[0].geometry, DEFAULT_PRODUCTS, s.bleedMm)
  return { sources, c, w }
}

describe('new items', () => {
  it('recognise saved products by file size and keep the file’s exact size', async () => {
    const { c, w } = await setup()
    expect(c.product).toBe('Round 82 mm')
    expect(c.shape).toBe('circle')
    expect(c.bleedMode).toBe('grow') // round: bleed all the way round, not mirrored square edges
    expect(w.product).toBe('Mug wrap 250 × 84')
    expect(w.shape).toBe('rect')
    expect([w.widthMm, w.heightMm]).toEqual([250, 84.06]) // never rescaled for a 0.06 mm difference
    expect(w.bleedMode).toBe('mirror')
  })

  it('recognise a file that already has the bleed', () => {
    const g = { kind: 'pdf' as const, physicalSize: true, widthMm: 86, heightMm: 86 }
    const it = newItemFor('x', 'x', 's', 0, g, DEFAULT_PRODUCTS, 2)
    expect([it.widthMm, it.heightMm, it.bleedMode, it.shape]).toEqual([82, 82, 'included', 'circle'])
  })

  it('match images without a DPI by their proportions', () => {
    const g = { kind: 'image' as const, physicalSize: false, widthMm: 84 * 3, heightMm: 250 * 3, pxW: 1000, pxH: 2976 }
    expect(matchProduct(g, DEFAULT_PRODUCTS, 2)).toMatchObject({ w: 84, h: 250, product: { name: 'Mug wrap 250 × 84' } })
  })
})

describe('shapes', () => {
  it('circle cut on the trim edge, bleed outline 2 mm outside it', () => {
    const { cut, bleed } = itemShape({ widthMm: 82, heightMm: 82, shape: 'circle', cornerMm: 0 }, 2)
    const r = (p: typeof cut) => flatten(p[0], 16).map(([x, y]) => Math.hypot(x - 41, y - 41))
    for (const d of r(cut)) expect(d).toBeCloseTo(41, 1)
    for (const d of r(bleed)) expect(d).toBeCloseTo(43, 1)
  })

  it('“extend edge” bleed maps the trim box exactly onto the bleed box', () => {
    const g = { kind: 'pdf' as const, physicalSize: true, widthMm: 82, heightMm: 82 }
    const it = { ...newItemFor('x', 'x', 's', 0, g, DEFAULT_PRODUCTS, 2) }
    const p = planItem(it, g, 2)
    expect(p.clipMainToCut).toBe(true)
    const m = p.under[0].matrix
    expect(apply(m, 0, 0).map((n) => +n.toFixed(6))).toEqual([-2, -2])
    expect(apply(m, 82, 82).map((n) => +n.toFixed(6))).toEqual([84, 84])
    // the design itself is never scaled
    expect(apply(p.main.matrix, 82, 82).map((n) => +n.toFixed(6))).toEqual([82, 82])
  })
})

describe('13 × 19 sheet', () => {
  it('gangs coasters and mug wraps without touching cut lines', async () => {
    const { c, w } = await setup()
    const items: PrintCutItem[] = [
      { ...c, copies: 6 },
      { ...w, copies: 3 },
    ]
    const designs = items.map((it) => ({ id: it.id, name: it.name, ...itemShape(it, s.bleedMm), copies: it.copies, rotation: it.rotation }))
    const r = nest(designs, s)
    expect(r.warnings).toEqual([])
    const placed = r.sheets.flatMap((sh) => sh.placements)
    expect(placed.filter((p) => p.designId === 'c')).toHaveLength(6)
    expect(placed.filter((p) => p.designId === 'w')).toHaveLength(3)
    expect(r.sheets).toHaveLength(1) // 3 wraps + 6 coasters fit one 13 × 19 sheet
    const shapes = Object.fromEntries(designs.map((d) => [d.id, d]))
    for (const sh of r.sheets) {
      const p = layoutProblems(sh, shapes, s)
      expect([...p.overlapping, ...p.outside]).toEqual([])
    }
  })

  it('exports a 13 × 19 print & cut PDF with a CutContour spot colour', async () => {
    const { sources, c, w } = await setup()
    const items = [c, w]
    const designs = items.map((it) => ({ id: it.id, name: it.name, ...itemShape(it, s.bleedMm), copies: 2, rotation: it.rotation }))
    const { sheets } = nest(designs, s)
    const bytes = await buildPrintCutPdf(sheets, items, sources, s, { mode: 'print-cut', date: new Date('2026-10-27') })
    const doc = await PDFDocument.load(bytes)
    expect(doc.getPageCount()).toBe(sheets.length)
    const { width, height } = doc.getPage(0).getSize()
    expect(width).toBeCloseTo(13 * 72, 3)
    expect(height).toBeCloseTo(19 * 72, 3)
    const text = Buffer.from(bytes).toString('latin1')
    expect(text).toContain('/CutContour')
    expect(text).toContain('/Separation')
    // both designs embedded as vector pages (Form XObjects), not images
    expect(text.match(/\/Subtype \/Form/g)?.length).toBeGreaterThanOrEqual(2)
    expect(doc.catalog.has(PDFName.of('OCProperties'))).toBe(true)
  })

  it('preview of one item is its bleed box', async () => {
    const { sources, c } = await setup()
    const doc = await PDFDocument.load(await buildItemPreviewPdf(c, sources[c.sourceId], 2))
    const { width } = doc.getPage(0).getSize()
    expect(width / PT_PER_MM).toBeCloseTo(86, 3)
  })
})

/** A file of wMm × hMm at 8 px/mm, white, with something drawn by `cover` (mm from top-left). */
function picture(wMm: number, hMm: number, cover: (x: number, y: number) => boolean) {
  const k = 8
  const width = wMm * k
  const height = hMm * k
  const data = new Uint8ClampedArray(width * height * 4).fill(255)
  for (let y = 0; y < height; y++)
    for (let x = 0; x < width; x++)
      if (cover((x + 0.5) / k, (y + 0.5) / k)) data.set([200, 40, 30, 255], (y * width + x) * 4)
  return { width, height, data }
}

describe('cut at the design edge', () => {
  // a round 78 mm design in a 90 × 90 mm file, slightly off-centre
  const round = picture(90, 90, (x, y) => (x - 44) ** 2 + (y - 46) ** 2 <= 39 * 39)

  it('finds a round design inside empty space', () => {
    const c = findContent(round, 90, 90)!
    expect(c.ellipse).toBe(true)
    expect(c.rect.w).toBeCloseTo(78 - 0.2, 0)
    expect(c.rect.h).toBeCloseTo(78 - 0.2, 0)
    expect(c.rect.x).toBeCloseTo(5.1, 0) // 44 − 39, + inset
    expect(c.rect.y).toBeCloseTo(90 - 46 - 39 + 0.1, 0) // y up from the bottom
  })

  it('a rectangle with a margin is not round; a design that fills the file is left alone', () => {
    expect(findContent(picture(100, 60, (x, y) => x > 5 && x < 95 && y > 5 && y < 55), 100, 60)!.ellipse).toBe(false)
    expect(findContent(picture(50, 50, () => true), 50, 50)).toBeNull()
  })

  it('new pieces are cut on the design’s own outline, at the design’s own size', () => {
    const g = { kind: 'pdf' as const, physicalSize: true, widthMm: 90, heightMm: 90 }
    const content = findContent(round, 90, 90)
    const it = newItemFor('x', 'x', 's', 0, g, [], 2, content)
    expect(it.shape).toBe('contour')
    expect(it.crop).toEqual(content!.rect)
    expect(it.widthMm).toBeCloseTo(77.8, 0)
    // the design part of the file lands exactly on the cut circle's box
    const p = planItem(it, g, 2)
    const r = content!.rect
    const a = apply(p.main.matrix, r.x, r.y)
    const b = apply(p.main.matrix, r.x + r.w, r.y + r.h)
    expect(a[0]).toBeCloseTo(0, 6)
    expect(a[1]).toBeCloseTo(0, 6)
    expect(b[0]).toBeCloseTo(it.widthMm, 6)
    expect(b[1]).toBeCloseTo(it.heightMm, 6)
  })

  it('an 82 mm round design with space around it is recognised as the 82 mm product', () => {
    const pic = picture(90, 90, (x, y) => (x - 45) ** 2 + (y - 45) ** 2 <= 41.1 * 41.1)
    const it = newItemFor('x', 'x', 's', 0, { kind: 'pdf', physicalSize: true, widthMm: 90, heightMm: 90 }, DEFAULT_PRODUCTS, 2, findContent(pic, 90, 90))
    expect(it.product).toBe('Round 82 mm')
  })
})

describe('contour cut', () => {
  /** A half disc (like half a diya) with a white hole in it, 60 × 40 mm, drawn on white with the tracing pad around it. */
  const item: PrintCutItem = {
    id: 'h',
    name: 'half',
    sourceId: 'src-h',
    pageIndex: 0,
    widthMm: 60,
    heightMm: 40,
    shape: 'contour',
    cornerMm: 0,
    bleedMode: 'none',
    fit: 'fit',
    copies: 1,
    rotation: 'auto',
    border: { style: 'color', mm: 3, color: '#ffcc00' },
  }
  const k = 8
  const P = contourPadMm(item, s.bleedMm)
  const W = Math.round((60 + 2 * P) * k)
  const H = Math.round((40 + 2 * P) * k)
  const data = new Uint8ClampedArray(W * H * 4).fill(255)
  for (let y = 0; y < H; y++)
    for (let x = 0; x < W; x++) {
      // local mm, y up; half disc of radius 30 sitting on the bottom edge, white hole of radius 5 inside
      const mx = (x + 0.5) / k - P
      const my = 40 + P - (y + 0.5) / k
      const d = Math.hypot(mx - 30, my)
      if (my >= 0 && d <= 30 && Math.hypot(mx - 30, my - 15) > 5) data.set([200, 40, 30, 255], (y * W + x) * 4)
    }
  const raster = contourRaster({ width: W, height: H, data }, item, s.bleedMm)

  it('the background is taken away, enclosed white stays part of the design', () => {
    const at = (mx: number, my: number) => raster.rgba[(Math.floor((40 + P - my) * k) * W + Math.floor((mx + P) * k)) * 4 + 3]
    expect(at(30, 15)).toBe(255) // the white hole is printed, not cut out
    expect(at(30, 10)).toBe(255)
    expect(at(2, 35)).toBe(0) // the empty corner is gone
  })

  it('the cut follows the outline plus the border', () => {
    const p = contourParams(item)
    const geo = computeCut(raster, cutFrame(W / k, H / k, p, s.bleedMm), p, s.bleedMm)
    expect(geo.pieces).toBe(1)
    // half disc 60 × 30 mm + 3 mm border all round
    expect(geo.bounds.x).toBeCloseTo(-3, 0)
    expect(geo.bounds.y).toBeCloseTo(-3, 0)
    expect(geo.bounds.w).toBeCloseTo(66, 0)
    expect(geo.bounds.h).toBeCloseTo(36, 0)
    // the top-left corner of the box is NOT inside the cut (it is not a rectangle)
    const pts = flatten(geo.cut[0])
    expect(pts.every(([x, y]) => Math.hypot(x - 30, y) <= 33 + 0.3)).toBe(true)
  })

  it('exports the traced cut with a printed colour border', async () => {
    const p = contourParams(item)
    const geo = computeCut(raster, cutFrame(W / k, H / k, p, s.bleedMm), p, s.bleedMm)
    const c = createCanvas(W, H)
    const g = c.getContext('2d')
    const img = g.createImageData(W, H)
    img.data.set(raster.rgba)
    g.putImageData(img, 0, 0)
    const png = new Uint8Array(c.toBuffer('image/png'))
    setContour(contourKey(item, s.bleedMm), { cut: geo.cut, bleed: geo.bleed, bounds: geo.bounds, pieces: geo.pieces, warnings: geo.warnings, art: { png, rect: { x: -P, y: -P, w: W / k, h: H / k } } })
    expect(itemShape(item, s.bleedMm).bounds).toEqual(geo.bounds)
    const src = await readSource('half.pdf', await designPdf(60, 40), 'src-h')
    const { sheets } = nest([{ id: 'h', name: 'half', ...itemShape(item, s.bleedMm), copies: 4, rotation: 'auto' }], s)
    const bytes = await buildPrintCutPdf(sheets, [{ ...item, copies: 4 }], { [src.id]: src }, s, { mode: 'print-cut', date: new Date('2026-10-28') })
    const doc = await PDFDocument.load(bytes)
    expect(doc.getPageCount()).toBe(1)
    const text = Buffer.from(bytes).toString('latin1')
    expect(text).toContain('/CutContour')
    expect(text).toMatch(/\/Subtype \/Image/) // the design without its background
  })
})
