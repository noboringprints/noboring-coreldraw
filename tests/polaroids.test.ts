import { describe, expect, it } from 'vitest'
import { type Canvas, createCanvas } from '@napi-rs/canvas'
import { PDFDocument, PDFName } from 'pdf-lib'
import { expand } from '../src/lib/geometry'
import { DEFAULT_PRINTCUT_SETTINGS } from '../src/printcut/model'
import { layoutProblems, nest, placementRect } from '../src/stickers/lib/nest'
import { buildPolaroidPdf, cropMarks, polaroidNestDesigns, polaroidShape } from '../src/polaroids/exportPolaroids'
import {
  DEFAULT_NEW,
  DEFAULT_POLAROID_SETTINGS,
  FORMATS,
  THEMES,
  type PolaroidItem,
  type PolaroidSettings,
  formatOf,
  minZoom,
  newItem,
  photoDpi,
  photoWindow,
  placePhoto,
  sheetSettings,
} from '../src/polaroids/model'
import { type Ctx2D, applyFilter, canvasSize, drawPolaroid } from '../src/polaroids/render'
import { enhancePixels } from '../src/polaroids/enhance'

const crop: PolaroidSettings = { ...DEFAULT_POLAROID_SETTINGS }
const printcut: PolaroidSettings = { ...DEFAULT_POLAROID_SETTINGS, finish: 'printcut', gapMm: 4, cornerMm: 3 }
const sheetOf = (p: PolaroidSettings) => sheetSettings(p, DEFAULT_PRINTCUT_SETTINGS)

const item = (id: string, patch: Partial<PolaroidItem> = {}): PolaroidItem => ({ ...newItem(id, 'ph', id, DEFAULT_NEW), ...patch })

/** A solid-colour "photo", w × h px. */
function photo(w: number, h: number, color = '#ff0000') {
  const c = createCanvas(w, h)
  const ctx = c.getContext('2d')
  ctx.fillStyle = color
  ctx.fillRect(0, 0, w, h)
  return c
}

function render(it: PolaroidItem, k: number, bleed: number, img = photo(400, 300)) {
  const { w, h } = canvasSize(it, k, bleed)
  const c = createCanvas(w, h)
  drawPolaroid(c.getContext('2d') as unknown as Ctx2D, it, { pxPerMm: k, bleedMm: bleed, photo: { img: img as unknown as CanvasImageSource, pxW: img.width, pxH: img.height } })
  return c
}

const px = (c: Canvas, x: number, y: number) => [...c.getContext('2d').getImageData(Math.round(x), Math.round(y), 1, 1).data]

describe('formats', () => {
  it('every standard format leaves a real photo window and a deeper bottom strip', () => {
    for (const f of FORMATS) {
      const w = photoWindow(f)
      expect(w.w, f.id).toBeGreaterThan(30)
      expect(w.h, f.id).toBeGreaterThan(30)
      expect(f.bottomMm, f.id).toBeGreaterThan(f.topMm)
      expect(w.x + w.w + f.sideMm, f.id).toBeCloseTo(f.widthMm, 6)
    }
  })
  it('classic matches the instant-film card: 88 × 107 mm with a 79 mm square photo', () => {
    const f = formatOf({ formatId: 'classic' })
    expect([f.widthMm, f.heightMm]).toEqual([88, 107])
    const w = photoWindow(f)
    expect([w.w, w.h]).toEqual([79, 79])
  })
})

describe('photo crop', () => {
  it('zoom 1 covers the window; panning is clamped to the photo edge', () => {
    // 4000 × 3000 landscape photo into a 79 mm square: height limits
    const p = placePhoto({ zoom: 1, cx: 0, cy: 0.5, turn: 0, flip: false }, 4000, 3000, 79, 79)
    expect(p.scale).toBeCloseTo(79 / 3000, 9)
    // the visible part is 3000 px wide, so the centre can't go left of 1500 px
    expect(p.crop.cx).toBeCloseTo(1500 / 4000, 9)
    expect(p.ox).toBeCloseTo(0, 6)
    expect(p.crop.cy).toBe(0.5)
  })
  it('a quarter turn swaps the photo sides', () => {
    const p = placePhoto({ zoom: 1, cx: 0.5, cy: 0.5, turn: 1, flip: false }, 4000, 3000, 79, 79)
    expect([p.rw, p.rh]).toEqual([3000, 4000])
  })
  it('zooming out stops at the whole photo visible', () => {
    const z = minZoom(4000, 3000, 0, 79, 79)
    expect(z).toBeCloseTo(0.75, 9)
    const p = placePhoto({ zoom: 0.1, cx: 0.9, cy: 0.9, turn: 0, flip: false }, 4000, 3000, 79, 79)
    expect(p.crop.zoom).toBeCloseTo(0.75, 9)
    expect(p.crop.cx).toBe(0.5) // the whole width shows – centred
  })
  it('print resolution follows the zoom', () => {
    const it0 = item('a')
    const dpi1 = photoDpi(it0, 4000, 3000)
    const dpi2 = photoDpi({ ...it0, crop: { ...it0.crop, zoom: 2 } }, 4000, 3000)
    expect(dpi1).toBe(Math.round(25.4 / (79 / 3000))) // ≈ 965
    expect(dpi2).toBe(Math.round(25.4 / (79 / 3000) / 2))
  })
})

describe('rendering', () => {
  const k = 6
  it('frame, photo and bleed land where they should', () => {
    const it0 = item('a')
    const c = render(it0, k, 2)
    const f = formatOf(it0)
    const win = photoWindow(f)
    expect([c.width, c.height]).toEqual([Math.round((88 + 4) * k), Math.round((107 + 4) * k)])
    // the frame colour runs into the bleed
    const frame = px(c, 1, 1)
    expect(frame.slice(0, 3)).toEqual([0xfb, 0xfb, 0xf8])
    // photo window centre is the photo
    const mid = px(c, (2 + win.x + win.w / 2) * k, (2 + win.y + win.h / 2) * k)
    expect(mid.slice(0, 3)).toEqual([255, 0, 0])
    // the bottom strip is frame
    expect(px(c, (2 + f.widthMm / 2) * k, (2 + f.heightMm - 4) * k).slice(0, 3)).toEqual([0xfb, 0xfb, 0xf8])
  })
  it('the filter changes only the photo', () => {
    const c = render(item('a', { filter: 'bw' }), k, 0)
    const win = photoWindow(formatOf(item('a')))
    const mid = px(c, (win.x + win.w / 2) * k, (win.y + win.h / 2) * k)
    expect(mid[0]).toBe(mid[1])
    expect(mid[1]).toBe(mid[2])
    expect(px(c, 2, 2).slice(0, 3)).toEqual([0xfb, 0xfb, 0xf8])
  })
  it('a custom frame colour is used for plain themes', () => {
    const c = render(item('a', { theme: 'pink', frameColor: '#00ff00' }), k, 0)
    expect(px(c, 2, 2).slice(0, 3)).toEqual([0, 255, 0])
  })
  it('every theme and filter draws without errors, with a caption', () => {
    for (const t of THEMES) {
      const c = render(item(`t-${t.id}`, { theme: t.id, filter: 'vintage', caption: { text: 'Summer 2026\nGoa', font: 'caveat', sizeMm: 6, align: 'center' } }), 3, 1.5)
      expect(c.width, t.id).toBeGreaterThan(0)
    }
  })
  it('filters keep values in range', () => {
    const d = new Uint8ClampedArray([255, 255, 255, 255, 0, 0, 0, 255, 200, 30, 90, 255])
    for (const f of ['bw', 'noir', 'sepia', 'vintage', 'warm', 'cool', 'fade', 'vivid'] as const) {
      const copy = new Uint8ClampedArray(d)
      applyFilter(copy, f)
      for (const v of copy) expect(v).toBeGreaterThanOrEqual(0)
    }
  })
})

describe('sheet layout', () => {
  it('fits 12 classic polaroids on a 13 × 19 sheet with crop-mark gaps', () => {
    const s = sheetOf(crop)
    const r = nest(polaroidNestDesigns([item('a', { copies: 12 })], crop), s)
    expect(r.capacity.a.perSheet).toBeGreaterThanOrEqual(12)
    expect(r.sheets).toHaveLength(1)
    const shapes = { a: polaroidShape(item('a'), crop) }
    const p = layoutProblems(r.sheets[0], shapes, s)
    expect(p.overlapping.size + p.outside.size).toBe(0)
  })
  it('mixes sizes and flows onto more sheets', () => {
    const s = sheetOf(crop)
    const r = nest(polaroidNestDesigns([item('a', { copies: 14 }), item('b', { formatId: 'mini', copies: 10 })], crop), s)
    expect(r.sheets.length).toBeGreaterThanOrEqual(2)
    expect(r.sheets.reduce((n, sh) => n + sh.placements.length, 0)).toBe(24)
  })
  it('print & cut uses the cutter marks and rounded corners', () => {
    const s = sheetOf(printcut)
    expect(s.marks.style).toBe(DEFAULT_PRINTCUT_SETTINGS.marks.style)
    const sh = polaroidShape(item('a'), printcut)
    const sq = polaroidShape(item('a'), crop)
    expect(sh.cut).not.toBe(sq.cut) // a rounded rectangle, not the square one
  })
})

describe('crop marks', () => {
  it('sit at the corners and never touch another polaroid (or its bleed)', () => {
    const s = sheetOf(crop)
    const r = nest(polaroidNestDesigns([item('a', { copies: 12 })], crop), s)
    const shapes = { a: polaroidShape(item('a'), crop) }
    const lines = cropMarks(r.sheets[0], shapes, s)
    // every corner of the outer ring gets marks; at least two per polaroid overall
    expect(lines.length).toBeGreaterThanOrEqual(24)
    const rects = r.sheets[0].placements.map((p) => expand(placementRect(p, shapes.a.bounds, s), s.bleedMm))
    for (const l of lines) {
      expect(Math.hypot(l.x2 - l.x1, l.y2 - l.y1)).toBeGreaterThanOrEqual(1.5)
      for (const rr of rects)
        for (const t of [0, 0.25, 0.5, 0.75, 1]) {
          const x = l.x1 + (l.x2 - l.x1) * t
          const y = l.y1 + (l.y2 - l.y1) * t
          const inside = x > rr.x + 0.01 && x < rr.x + rr.w - 0.01 && y > rr.y + 0.01 && y < rr.y + rr.h - 0.01
          expect(inside).toBe(false)
        }
      for (const v of [l.x1, l.x2]) expect(v).toBeGreaterThan(0)
      for (const v of [l.y1, l.y2]) expect(v).toBeGreaterThan(0)
    }
  })
})

describe('PDF', () => {
  const renderer = async (it: PolaroidItem, bleed: number) => {
    const c = render(it, 4, bleed)
    return { bytes: new Uint8Array(c.toBuffer('image/jpeg')), kind: 'jpg' as const }
  }
  it('crop-mark PDF: one page per sheet at the sheet size, no cut layer', async () => {
    const s = sheetOf(crop)
    const items = [item('a', { copies: 13 })]
    const r = nest(polaroidNestDesigns(items, crop), s)
    const bytes = await buildPolaroidPdf(r.sheets, items, crop, s, renderer)
    const doc = await PDFDocument.load(bytes)
    expect(doc.getPageCount()).toBe(2)
    const { width, height } = doc.getPage(0).getSize()
    expect(width / (72 / 25.4)).toBeCloseTo(13 * 25.4, 1)
    expect(height / (72 / 25.4)).toBeCloseTo(19 * 25.4, 1)
    expect(new TextDecoder('latin1').decode(bytes)).not.toContain('/CutContour')
  })
  it('print & cut PDF has the CutContour spot colour and layer', async () => {
    const s = sheetOf(printcut)
    const items = [item('a', { copies: 4 }), item('b', { formatId: 'wide', copies: 2 })]
    const r = nest(polaroidNestDesigns(items, printcut), s)
    const bytes = await buildPolaroidPdf(r.sheets, items, printcut, s, renderer)
    const doc = await PDFDocument.load(bytes)
    expect(doc.catalog.has(PDFName.of('OCProperties'))).toBe(true)
    expect(new TextDecoder('latin1').decode(bytes)).toContain('/CutContour')
  })
  it('a cut-only file renders no photos', async () => {
    const s = sheetOf(printcut)
    const items = [item('a', { copies: 2 })]
    const r = nest(polaroidNestDesigns(items, printcut), s)
    let calls = 0
    await buildPolaroidPdf(r.sheets, items, printcut, s, async (it, b) => (calls++, renderer(it, b)), { mode: 'cut' })
    expect(calls).toBe(0)
  })
})

describe('enhance', () => {
  /** A dull, low-contrast gradient photo. */
  function dull(w = 300, h = 200) {
    const c = createCanvas(w, h)
    const ctx = c.getContext('2d')
    const g = ctx.createLinearGradient(0, 0, w, 0)
    g.addColorStop(0, '#6e665c')
    g.addColorStop(1, '#9a9286')
    ctx.fillStyle = g
    ctx.fillRect(0, 0, w, h)
    return c
  }
  const spread = (d: Uint8ClampedArray) => {
    let lo = 255
    let hi = 0
    for (let i = 0; i < d.length; i += 4) {
      lo = Math.min(lo, d[i + 1])
      hi = Math.max(hi, d[i + 1])
    }
    return hi - lo
  }
  it('off leaves the pixels alone; auto and strong add contrast, strong more', () => {
    const src = dull().getContext('2d').getImageData(0, 0, 300, 200).data
    const run = (lvl: 'off' | 'auto' | 'strong') => {
      const d = new Uint8ClampedArray(src)
      enhancePixels(d, 300, 200, lvl, 6)
      return d
    }
    expect([...run('off')]).toEqual([...src])
    expect(spread(run('auto'))).toBeGreaterThan(spread(src) * 1.3)
    expect(spread(run('strong'))).toBeGreaterThan(spread(run('auto')))
  })
  it('only the photo is enhanced – never the frame, nor the backdrop when zoomed out', () => {
    const k = 6
    const base = item('a', { enhance: 'strong' })
    const zoomedOut = { ...base, crop: { ...base.crop, zoom: 0.1 } } // whole photo, frame colour above and below it
    const c = render(zoomedOut, k, 0, dull(400, 100))
    const win = photoWindow(formatOf(base))
    expect(px(c, 2, 2).slice(0, 3)).toEqual([0xfb, 0xfb, 0xf8]) // frame
    expect(px(c, (win.x + win.w / 2) * k, (win.y + 2) * k).slice(0, 3)).toEqual([0xfb, 0xfb, 0xf8]) // backdrop above the photo
  })
  it('a missing enhance (older saved jobs) means off', () => {
    const { enhance: _e, ...old } = item('a')
    const a = render(old as PolaroidItem, 4, 0, dull())
    const b = render(item('a', { enhance: 'off' }), 4, 0, dull())
    expect([...a.getContext('2d').getImageData(0, 0, a.width, a.height).data]).toEqual([...b.getContext('2d').getImageData(0, 0, b.width, b.height).data])
  })
})
