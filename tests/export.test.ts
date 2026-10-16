import { describe, expect, it } from 'vitest'
import { PDFDocument, PDFName, PDFRawStream, decodePDFRawStream, PDFDict } from 'pdf-lib'
import { DEFAULT_SETTINGS, PT_PER_MM, SHEETS, cloneSettings, type PrintSettings } from '../src/config/defaults'
import { apply } from '../src/lib/geometry'
import { detectBleed, planArtwork, suggestTrim, type BleedMode, type SourceGeometry } from '../src/lib/artwork'
import { edgeBands, makeStrips, type RGBAImage } from '../src/lib/bleedRaster'
import { buildItems, type Design } from '../src/lib/job'
import { layoutJob, placementMatrix, type Placement } from '../src/lib/layout'
import { buildPrintPdf } from '../src/lib/exportPdf'
import { readSource, type SourcePageInfo } from '../src/lib/sources'
import { edgeTextWarning, textNearEdge } from '../src/lib/textCheck'
import { BORDER_COLORS, makeTestPoster } from '../src/lib/testDesign'
import { nodeRasterizer, nodeTextItems } from '../scripts/rasterNode'

const s = cloneSettings(DEFAULT_SETTINGS)
const pdf = (w: number, h: number): SourceGeometry => ({ kind: 'pdf', widthMm: w, heightMm: h, physicalSize: true })
const img = (pxW: number, pxH: number, dpi: number | null): SourceGeometry => ({
  kind: 'image',
  widthMm: (pxW * 25.4) / (dpi ?? 300),
  heightMm: (pxH * 25.4) / (dpi ?? 300),
  pxW,
  pxH,
  physicalSize: dpi !== null,
})

describe('bleed detection: only the real size counts', () => {
  it('file = trim + 3 mm on every side → has bleed', () => {
    expect(detectBleed(pdf(216, 303), 210, 297, 3)).toMatchObject({ mode: 'included', hasBleed: true })
  })
  it('within 0.5 mm still counts; 0.7 mm off does not', () => {
    expect(detectBleed(pdf(216.4, 303.4), 210, 297, 3).hasBleed).toBe(true)
    expect(detectBleed(pdf(216.7, 303), 210, 297, 3).hasBleed).toBe(false)
  })
  it('file = trim size → no bleed, mirror', () => {
    expect(detectBleed(pdf(210, 297), 210, 297, 3)).toMatchObject({ mode: 'mirror', hasBleed: false })
  })
  it('REGRESSION: big PDF with the same proportions as A4 + bleed is NOT treated as having bleed', () => {
    expect(detectBleed(pdf(432, 606), 210, 297, 3).mode).toBe('mirror')
  })
  it('REGRESSION: image without DPI is never treated as having bleed, whatever its proportions', () => {
    expect(detectBleed(img(2551, 3579, null), 210, 297, 3).mode).toBe('mirror')
  })
  it('image with DPI whose real size is trim + bleed → has bleed', () => {
    expect(detectBleed(img(2551, 3579, 300), 210, 297, 3).mode).toBe('included') // 216.0 × 303.0 mm
  })
  it('PDF trim box with full 3 mm bleed → has bleed; with 1 mm → mirror', () => {
    expect(detectBleed({ ...pdf(216, 303), trimBox: { x: 3, y: 3, w: 210, h: 297 } }, 210, 297, 3).mode).toBe('included')
    expect(detectBleed({ ...pdf(212, 299), trimBox: { x: 1, y: 1, w: 210, h: 297 } }, 210, 297, 3).mode).toBe('mirror')
  })
})

describe('artwork plan: the design is never scaled into the bleed', () => {
  const cases: [string, SourceGeometry][] = [
    ['PDF at trim size', pdf(210, 297)],
    ['image, no DPI, A4+bleed proportions', img(2551, 3579, null)],
    ['big PDF with A4+bleed proportions', pdf(432, 606)],
    ['image A4 at 300 DPI', img(2480, 3508, 300)],
  ]
  for (const [name, g] of cases)
    for (const mode of ['mirror', 'stretch', 'none'] as BleedMode[])
      it(`${name}, ${mode}: whole design lands exactly on the trim box`, () => {
        const plan = planArtwork(g, 210, 297, 3, mode)
        const m = plan.main.matrix
        const [x0, y0] = apply(m, 0, 0)
        const [x1, y1] = apply(m, g.widthMm, g.heightMm)
        expect(x0).toBeCloseTo(0, 9)
        expect(y0).toBeCloseTo(0, 9)
        expect(x1).toBeCloseTo(210, 9)
        expect(y1).toBeCloseTo(297, 9)
        expect(plan.main.clip).toEqual({ x: 0, y: 0, w: 210, h: 297 })
        expect(plan.bleedPieces).toHaveLength(mode === 'none' ? 0 : 8)
        // every bleed piece is OUTSIDE the trim box
        for (const p of plan.bleedPieces) {
          const c = p.clip
          const inside = c.x < 210 && c.x + c.w > 0 && c.y < 297 && c.y + c.h > 0
          expect(inside).toBe(false)
        }
      })

  it('file with real bleed: its trim area lands exactly on the trim box, bleed outside', () => {
    const plan = planArtwork(pdf(216, 303), 210, 297, 3, 'included')
    expect(apply(plan.main.matrix, 3, 3)).toEqual([0, 0])
    const [x, y] = apply(plan.main.matrix, 213, 300)
    expect(x).toBeCloseTo(210, 9)
    expect(y).toBeCloseTo(297, 9)
    expect(plan.main.clip).toEqual({ x: -3, y: -3, w: 216, h: 303 })
  })
  it('mirror: the left strip shows the outer 3 mm flipped across the cut line', () => {
    const plan = planArtwork(pdf(210, 297), 210, 297, 3, 'mirror')
    const left = plan.bleedPieces[0]
    expect(left.clip).toEqual({ x: -3, y: 0, w: 3, h: 297 })
    expect(apply(left.matrix, 1, 50)).toEqual([-1, 50]) // 1 mm inside → 1 mm outside
    expect(plan.warnings.join(' ')).toMatch(/added automatically/)
  })
  it('stretch (image): exactly one edge pixel is stretched across the bleed', () => {
    const g = img(2480, 3508, 300)
    const plan = planArtwork(g, 210, 297, 3, 'stretch')
    const right = plan.bleedPieces[1]
    const onePx = (g.widthMm / g.pxW!) * plan.scaleX
    const [x] = apply(right.matrix, g.widthMm - onePx, 10)
    expect(x).toBeCloseTo(213, 3)
  })
  it('different proportions: "fit" keeps the whole design (white bands), "fill" crops – both warn', () => {
    const fit = planArtwork(pdf(200, 200), 210, 297, 3, 'mirror', 'fit')
    expect(fit.art.w).toBeCloseTo(210, 9)
    expect(fit.art.h).toBeCloseTo(210, 9)
    expect(fit.main.clip.y).toBeCloseTo(43.5, 9)
    expect(fit.warnings.join(' ')).toMatch(/white bands/)
    const fill = planArtwork(pdf(200, 200), 210, 297, 3, 'mirror', 'fill')
    expect(fill.warnings.join(' ')).toMatch(/cut off/)
  })
  it('within 1 % proportions: mapped exactly, no gaps, no cropping', () => {
    const plan = planArtwork(pdf(211, 297), 210, 297, 3, 'mirror')
    expect(plan.warnings.join(' ')).not.toMatch(/proportions/)
    const [x1] = apply(plan.main.matrix, 211, 0)
    expect(x1).toBeCloseTo(210, 9)
  })
})

describe('bleed strips from the 300 DPI render (pixel maths)', () => {
  // bands where every pixel encodes its own column (R) and row (G)
  const band = (w: number, h: number, tag: number): RGBAImage => {
    const data = new Uint8Array(w * h * 4)
    for (let y = 0; y < h; y++)
      for (let x = 0; x < w; x++) {
        const i = (y * w + x) * 4
        data[i] = x
        data[i + 1] = y
        data[i + 2] = tag
        data[i + 3] = 255
      }
    return { width: w, height: h, data }
  }
  const trimW = 10
  const trimH = 8
  const ppm = 2 // px per mm
  const rects = edgeBands(trimW, trimH, 3)
  const bands = { left: band(6, 16, 1), right: band(6, 16, 2), bottom: band(20, 6, 3), top: band(20, 6, 4) }
  const px = (st: { width: number; rgb: Uint8Array }, x: number, y: number) => [...st.rgb.slice((y * st.width + x) * 3, (y * st.width + x) * 3 + 3)]

  it('mirror: pixels are flipped across the cut line', () => {
    const strips = makeStrips(bands, rects, trimW, trimH, 3, 'mirror')
    const by = Object.fromEntries(strips.map((st) => [st.name, st]))
    expect(by.left.width).toBe(3 * ppm)
    expect(by.left.rect).toEqual({ x: -3, y: 0, w: 3, h: 8 })
    // left strip: seam column (x=5) = band column 0 (the trim edge); outer column = band column 5
    expect(px(by.left, 5, 7)).toEqual([0, 7, 1])
    expect(px(by.left, 0, 7)).toEqual([5, 7, 1])
    // right strip: seam column 0 = band's last column
    expect(px(by.right, 0, 3)).toEqual([5, 3, 2])
    expect(px(by.right, 5, 3)).toEqual([0, 3, 2])
    // bottom strip: top row (seam) = band's bottom row
    expect(px(by.bottom, 4, 0)).toEqual([4, 5, 3])
    expect(px(by.bottom, 4, 5)).toEqual([4, 0, 3])
    // top strip: bottom row (seam) = band's top row
    expect(px(by.top, 4, 5)).toEqual([4, 0, 4])
    // corner: mirrored both ways
    expect(px(by['bottom-left'], 5, 0)).toEqual([0, 15, 1])
    expect(px(by['top-right'], 0, 5)).toEqual([5, 0, 2])
  })
  it('stretch: every strip pixel repeats the outermost pixel', () => {
    const strips = makeStrips(bands, rects, trimW, trimH, 3, 'stretch')
    const left = strips.find((st) => st.name === 'left')!
    for (let x = 0; x < left.width; x++) expect(px(left, x, 4)).toEqual([0, 4, 1])
    const top = strips.find((st) => st.name === 'top')!
    for (let y = 0; y < top.height; y++) expect(px(top, 7, y)).toEqual([7, 0, 4])
  })
})

/** Reads all content-stream text of a page. */
function pageContent(doc: PDFDocument, i: number): string {
  const page = doc.getPage(i)
  const contents = page.node.Contents()
  const streams = contents && 'asArray' in contents ? (contents as never as { asArray(): unknown[] }).asArray() : [contents]
  return streams
    .map((ref) => doc.context.lookup(ref as never) as PDFRawStream)
    .map((st) => new TextDecoder().decode(decodePDFRawStream(st).decode()))
    .join('\n')
}

async function buildFor(trimW: number, trimH: number, copies: number, opts: { sheet?: (typeof SHEETS)[number]; bleedInFile?: number; mode?: BleedMode; settings?: Partial<PrintSettings> } = {}) {
  // classic 3 mm bleed setup unless a test passes its own settings
  const classic = cloneSettings(DEFAULT_SETTINGS)
  Object.assign(classic, { bleedMm: 3, gutterMm: 0, marks: { ...classic.marks, offsetMm: 3, lengthMm: 5 } })
  const st: PrintSettings = { ...classic, ...opts.settings }
  st.sheet = opts.sheet ?? SHEETS[0]
  const bleedInFile = opts.bleedInFile ?? 3
  const bytes = await makeTestPoster({ trimW, trimH, bleed: bleedInFile, title: 'T', border: bleedInFile === 0 })
  const src = await readSource('t.pdf', bytes, 'src1')
  const design: Design = {
    id: 'd1', sourceId: 'src1', name: 'Test', trimName: 'X', trimW, trimH, copies,
    bleedMode: opts.mode ?? (bleedInFile ? 'included' : 'mirror'), fit: 'fit', bleedAuto: false, split: false, pageIndex: 0,
  }
  const sheets = layoutJob(buildItems([design], { src1: src }), st)
  const out = await buildPrintPdf(sheets, { src1: src }, st, { date: new Date(2026, 9, 15), rasterizer: nodeRasterizer })
  return { st, sheets, out, doc: await PDFDocument.load(out) }
}

describe('exported PDF', () => {
  for (const [name, w, h, n, sheet] of [
    ['A3 single on 13×19', 297, 420, 1, SHEETS[0]],
    ['A4 2-up on 13×19', 210, 297, 2, SHEETS[0]],
    ['A5 4-up on 13×19', 148, 210, 4, SHEETS[0]],
    ['A4 1-up on A3', 210, 297, 1, SHEETS[1]],
    ['A5 2-up on A3', 148, 210, 2, SHEETS[1]],
  ] as const) {
    it(`${name}: page size is exactly the sheet, marks are where the layout says`, async () => {
      const { doc, sheets, st } = await buildFor(w, h, n, { sheet })
      expect(doc.getPageCount()).toBe(1)
      const { width, height } = doc.getPage(0).getSize()
      expect(width).toBeCloseTo(sheet.widthMm * PT_PER_MM, 6)
      expect(height).toBeCloseTo(sheet.heightMm * PT_PER_MM, 6)
      const content = pageContent(doc, 0)
      // each crop mark appears as "x1 y1 m x2 y2 l" in points
      const lines = [...content.matchAll(/([\d.-]+)\s+([\d.-]+)\s+m\s+([\d.-]+)\s+([\d.-]+)\s+l/g)].map((r) => r.slice(1).map(Number))
      expect(lines).toHaveLength(sheets[0].marks.length)
      for (const m of sheets[0].marks) {
        const want = [m.x1, m.y1, m.x2, m.y2].map((v) => v * PT_PER_MM)
        expect(lines.some((l) => l.every((v, i) => Math.abs(v - want[i]) < 1e-4)), JSON.stringify(m)).toBe(true)
      }
      expect(content).toMatch(/\/CSReg CS\s+1 SCN/)
      expect(content).toMatch(new RegExp(`${st.marks.lineWidthPt} w`))
      expect((content.match(/re\s+W\s+n/g) ?? []).length).toBe(n) // one clip per copy (file has its own bleed)
    }, 30_000)
  }

  it('embeds PDF designs as vectors (Form XObject), no images when the file has bleed', async () => {
    const { doc } = await buildFor(148, 210, 4)
    const xobjs = doc.getPage(0).node.Resources()!.lookup(PDFName.of('XObject'), PDFDict)
    const subtypes = xobjs.keys().map((k) => (doc.context.lookup(xobjs.get(k)) as PDFRawStream).dict.get(PDFName.of('Subtype'))?.toString())
    expect(subtypes).toContain('/Form')
    expect(subtypes).not.toContain('/Image')
  })

  it('registration colour space is Separation /All', async () => {
    const { doc } = await buildFor(297, 420, 1)
    const cs = doc.getPage(0).node.Resources()!.lookup(PDFName.of('ColorSpace'), PDFDict)
    expect(doc.context.lookup(cs.get(PDFName.of('CSReg'))!)!.toString()).toContain('/Separation /All /DeviceCMYK')
  })
})

const PPM = 12 // render the finished sheet at ~305 DPI
/** colour of the finished sheet at a point given in the design's own trim space (mm) */
async function sampler(out: Uint8Array, H: number) {
  const [page] = await nodeRasterizer.render(out, PPM)
  return (p: Placement, lx: number, ly: number) => {
    const [x, y] = apply(placementMatrix(p), lx, ly)
    const i = (Math.floor((H - y) * PPM) * page.width + Math.floor(x * PPM)) * 4
    return [page.data[i], page.data[i + 1], page.data[i + 2]]
  }
}

describe('REGRESSION: design without bleed – nothing inside the cut line is lost', () => {
  const is = (c: number[], rgb: [number, number, number]) => c.every((v, i) => Math.abs(v - rgb[i] * 255) < 45)

  for (const mode of ['mirror', 'stretch'] as const)
    it(`A4 2-up, ${mode} (300 DPI strips): the 2 mm border is fully inside the cut, bleed outside`, async () => {
      const { out, sheets } = await buildFor(210, 297, 2, { bleedInFile: 0, mode })
      const at = await sampler(out, SHEETS[0].heightMm)
      for (const p of sheets[0].placements) {
        // just inside each cut line: the border colour (design not pushed out into the bleed)
        expect(is(at(p, 0.4, 150), BORDER_COLORS.left)).toBe(true)
        expect(is(at(p, 1.6, 150), BORDER_COLORS.left)).toBe(true)
        expect(is(at(p, 209.6, 150), BORDER_COLORS.right)).toBe(true)
        expect(is(at(p, 105, 0.4), BORDER_COLORS.bottom)).toBe(true)
        expect(is(at(p, 105, 296.6), BORDER_COLORS.top)).toBe(true)
        // the border is exactly 2 mm (not scaled): 2.6 mm inside is no longer border
        expect(is(at(p, 2.6, 150), BORDER_COLORS.left)).toBe(false)
        // in the bleed: mirrored/stretched border
        expect(is(at(p, -0.5, 150), BORDER_COLORS.left)).toBe(true)
        expect(is(at(p, 210.5, 150), BORDER_COLORS.right)).toBe(true)
        expect(is(at(p, 105, -0.5), BORDER_COLORS.bottom)).toBe(true)
        expect(is(at(p, 105, 297.5), BORDER_COLORS.top)).toBe(true)
        // 2.6 mm out: mirror shows the design again (not border); stretch keeps the edge colour
        expect(is(at(p, -2.6, 150), BORDER_COLORS.left)).toBe(mode === 'stretch')
      }
    }, 60_000)

  it('bleed strips are 300 DPI images outside the trim; the design stays vector', async () => {
    const { doc, sheets } = await buildFor(210, 297, 2, { bleedInFile: 0 })
    const xobjs = doc.getPage(0).node.Resources()!.lookup(PDFName.of('XObject'), PDFDict)
    const keys = xobjs.keys().map(String)
    expect(keys.filter((k) => k.includes('BleedStrip'))).toHaveLength(8 * sheets[0].placements.length)
    const forms = keys.filter((k) => (doc.context.lookup(xobjs.get(PDFName.of(k.slice(1)))) as PDFRawStream).dict.get(PDFName.of('Subtype'))?.toString() === '/Form')
    expect(forms.length).toBeGreaterThan(0)
    // a 3 mm strip at 300 DPI is 35 px thick
    const left = keys.map((k) => doc.context.lookup(xobjs.get(PDFName.of(k.slice(1)))) as PDFRawStream).find((st) => st.dict.get(PDFName.of('Width'))?.toString() === '35')
    expect(left).toBeTruthy()
  }, 30_000)

  it('vector bleed setting: no images, border still inside', async () => {
    const { out, sheets, doc } = await buildFor(148, 210, 1, { bleedInFile: 0, settings: { bleedStrips: 'vector' } })
    const xobjs = doc.getPage(0).node.Resources()!.lookup(PDFName.of('XObject'), PDFDict)
    expect(xobjs.keys().map(String).some((k) => k.includes('BleedStrip'))).toBe(false)
    const at = await sampler(out, SHEETS[0].heightMm)
    const p = sheets[0].placements[0]
    expect(is(at(p, 0.4, 100), BORDER_COLORS.left)).toBe(true)
    expect(is(at(p, -0.5, 100), BORDER_COLORS.left)).toBe(true)
  }, 30_000)

  it('bleed "None": cut exactly at the design edge, bleed area stays white', async () => {
    const { out, sheets } = await buildFor(148, 210, 1, { bleedInFile: 0, mode: 'none' })
    const at = await sampler(out, SHEETS[0].heightMm)
    const p = sheets[0].placements[0]
    expect(is(at(p, 0.4, 100), BORDER_COLORS.left)).toBe(true)
    expect(at(p, -1, 100)).toEqual([255, 255, 255])
  }, 30_000)
})

describe('DEFAULTS: 3 mm bleed on every side', () => {
  it('a file without bleed gets mirrored bleed; a file with 3 mm bleed uses its own', () => {
    expect(DEFAULT_SETTINGS.bleedMm).toBe(3)
    expect(detectBleed(pdf(210, 297), 210, 297, DEFAULT_SETTINGS.bleedMm).mode).toBe('mirror')
    expect(detectBleed(pdf(216, 303), 210, 297, DEFAULT_SETTINGS.bleedMm).mode).toBe('included')
  })
  it('mirrored bleed fills all four sides and all four corners', async () => {
    const { out, sheets } = await buildFor(148, 210, 1, { bleedInFile: 0, mode: 'mirror', settings: cloneSettings(DEFAULT_SETTINGS) })
    const at = await sampler(out, SHEETS[0].heightMm)
    const p = sheets[0].placements[0]
    const white = [255, 255, 255]
    for (const [x, y] of [[-1.5, 100], [149.5, 100], [70, -1.5], [70, 211.5], [-1.5, -1.5], [149.5, -1.5], [-1.5, 211.5], [149.5, 211.5]])
      expect(at(p, x, y)).not.toEqual(white)
  }, 30_000)
})

describe('no-bleed setup: the design is printed exactly as it is', () => {
  const noBleed = () => {
    const st = cloneSettings(DEFAULT_SETTINGS)
    Object.assign(st, { bleedMm: 0, gutterMm: 8, marks: { ...st.marks, lengthMm: 4, offsetMm: 1 } })
    return st
  }
  it('no bleed is detected/added, the file keeps its exact size', () => {
    expect(detectBleed(pdf(210, 297), 210, 297, 0).mode).toBe('none')
    expect(detectBleed(pdf(216, 303), 216, 303, 0).mode).toBe('none')
    expect(suggestTrim(pdf(210.4, 297.3), 0)).toEqual({ name: 'A4', w: 210.4, h: 297.3 })
    expect(suggestTrim(pdf(216, 303), 0)).toEqual({ name: 'Custom', w: 216, h: 303 })
    expect(suggestTrim(pdf(300, 100), 0, 'x A4.pdf')).toEqual({ name: 'Custom', w: 300, h: 100 }) // not A-shaped: exact size
    const plan = planArtwork(pdf(297, 210), 297, 210, 0, 'none')
    expect(plan.main.matrix).toEqual([1, 0, 0, 1, 0, 0])
    expect(plan.bleedPieces).toEqual([])
    expect(plan.warnings).toEqual([])
  })
  it('a Canva "A4" export that is really 160.87 × 228.07 mm is printed at real A4 (scaled evenly)', () => {
    const g = pdf(160.867, 228.071)
    expect(suggestTrim(g, 0, 'Hanuman Fire Triptych  Devotional Split Poster Set  3 Piece A4.pdf')).toEqual({ name: 'A4', w: 210, h: 297 })
    expect(suggestTrim(g, 0, 'Golden Muse  3 Piece A3.pdf')).toEqual({ name: 'A3', w: 297, h: 420 })
    expect(suggestTrim(g, 0, 'poster.pdf')).toEqual({ name: 'A4', w: 210, h: 297 })
    expect(suggestTrim(pdf(228.071, 160.867), 0, 'a5 landscape.pdf')).toEqual({ name: 'A5', w: 210, h: 148 })
    const plan = planArtwork(g, 210, 297, 0, 'none')
    expect(plan.warnings).toEqual([]) // whole design, no white bands, no crop
    expect(plan.main.clip).toEqual({ x: 0, y: 0, w: 210, h: 297 })
  })
  it('split panels: drawn 1:1, nothing outside the design edge, no images', async () => {
    const { out, sheets, doc } = await buildFor(210, 297, 2, { bleedInFile: 0, mode: 'none', settings: noBleed() })
    const xobjs = doc.getPage(0).node.Resources()!.lookup(PDFName.of('XObject'), PDFDict)
    const subtypes = xobjs.keys().map((k) => (doc.context.lookup(xobjs.get(k)) as PDFRawStream).dict.get(PDFName.of('Subtype'))?.toString())
    expect(subtypes).not.toContain('/Image')
    const [page] = await nodeRasterizer.render(out, 12)
    const H = SHEETS[0].heightMm
    const at = (p: Placement, lx: number, ly: number) => {
      const [x, y] = apply(placementMatrix(p), lx, ly)
      const i = (Math.floor((H - y) * 12) * page.width + Math.floor(x * 12)) * 4
      return [page.data[i], page.data[i + 1], page.data[i + 2]]
    }
    const is = (c: number[], rgb: [number, number, number]) => c.every((v, i) => Math.abs(v - rgb[i] * 255) < 45)
    for (const p of sheets[0].placements) {
      expect(is(at(p, 0.4, 150), BORDER_COLORS.left)).toBe(true)
      expect(is(at(p, 1.6, 150), BORDER_COLORS.left)).toBe(true)
      expect(is(at(p, 2.6, 150), BORDER_COLORS.left)).toBe(false) // exactly 2 mm: not scaled
      expect(is(at(p, 209.6, 150), BORDER_COLORS.right)).toBe(true)
      expect(at(p, -0.5, 150)).toEqual([255, 255, 255]) // no bleed outside the edge
      expect(at(p, 210.5, 150)).toEqual([255, 255, 255])
      expect(at(p, 105, -0.5)).toEqual([255, 255, 255])
      expect(at(p, 105, 297.5)).toEqual([255, 255, 255])
    }
  }, 30_000)
})

describe('text near the edge', () => {
  const info: SourcePageInfo = { index: 0, pdfRotate: 0, pdfBox: { left: 0, bottom: 0, right: 210 * PT_PER_MM, top: 297 * PT_PER_MM }, geometry: pdf(210, 297) }
  const plan = planArtwork(info.geometry, 210, 297, 3, 'mirror')
  const at = (xMm: number, yMm: number, str = 'Hello') => ({ str, transform: [12, 0, 0, 12, xMm * PT_PER_MM, yMm * PT_PER_MM], width: 30, height: 12 })
  it('flags text inside the 5 mm safe zone, not text further in', () => {
    const found = textNearEdge([at(2, 100, 'SALE'), at(20, 100, 'Fine')], info, plan, 210, 297, 5)
    expect(found.map((f) => f.text)).toEqual(['SALE'])
    expect(found[0].distanceMm).toBeCloseTo(2, 1)
    expect(edgeTextWarning(found, 5)).toMatch(/closer than 5 mm.*SALE/)
  })
  it('flags text that runs past the cut line as "will be cut off"', () => {
    const found = textNearEdge([at(-1, 100, 'Cut')], info, plan, 210, 297, 5)
    expect(edgeTextWarning(found, 5)).toMatch(/cut off.*Cut/)
  })
  it('reads real text positions from a PDF (pdf.js)', async () => {
    const bytes = await makeTestPoster({ trimW: 148, trimH: 210, bleed: 0, title: 'Leaves', border: true })
    const src = await readSource('t.pdf', bytes)
    const p = src.pages[0]
    const pl = planArtwork(p.geometry, 148, 210, 3, 'mirror')
    const items = await nodeTextItems(bytes, 0)
    expect(items.map((i) => i.str)).toContain('Leaves')
    expect(textNearEdge(items, p, pl, 148, 210, 5)).toEqual([]) // title is 12 mm from the edge
    expect(textNearEdge(items, p, pl, 148, 210, 15).map((t) => t.text)).toContain('Leaves')
  })
})

describe('split poster', () => {
  it('3 panels each get their own position and marks', async () => {
    const bytes = await makeTestPoster({ trimW: 148, trimH: 210, bleed: 3, title: 'Split', pages: 3 })
    const src = await readSource('split.pdf', bytes, 'sp')
    const design: Design = {
      id: 'd', sourceId: 'sp', name: 'Split', trimName: 'A5', trimW: 148, trimH: 210, copies: 1,
      bleedMode: 'included', fit: 'fit', bleedAuto: true, split: true, pageIndex: 0,
    }
    const items = buildItems([design], { sp: src })
    expect(items.map((i) => i.panel)).toEqual([
      { index: 1, total: 3 },
      { index: 2, total: 3 },
      { index: 3, total: 3 },
    ])
    const sheets = layoutJob(items, s)
    expect(sheets[0].placements.map((p) => (p.item.art as { pageIndex: number }).pageIndex)).toEqual([0, 1, 2])
    expect(sheets[0].warnings).toEqual([])
  })
})
