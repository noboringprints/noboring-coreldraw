import { describe, expect, it } from 'vitest'
import { PDFDocument, PDFName, rgb } from 'pdf-lib'
import { PT_PER_MM } from '../src/config/defaults'
import { apply } from '../src/lib/geometry'
import { readSource, type SourceFile } from '../src/lib/sources'
import { buildPrintCutPdf, buildItemPreviewPdf } from '../src/printcut/exportPrintCut'
import { DEFAULT_PRINTCUT_SETTINGS, DEFAULT_PRODUCTS, type PrintCutItem, itemShape, matchProduct, newItemFor, planItem } from '../src/printcut/model'
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
