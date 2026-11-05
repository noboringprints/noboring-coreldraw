import { createCanvas } from '@napi-rs/canvas'
import { PDFDocument, rgb } from 'pdf-lib'
import { describe, expect, it } from 'vitest'
import { PT_PER_MM } from '../src/config/defaults'
import { runCorelDrawImposition } from '../src/lib/api-impose'
import { runPrintCutJob } from '../src/lib/api-printcut'
import { runStickerJob } from '../src/lib/api-stickers'
import { nodeRasterizer } from '../scripts/rasterNode'

const SHEET_13X19 = [936, 1368]

/** A red disc on a white (or transparent) square. */
function discPng(px: number, background: string | null): Uint8Array {
  const c = createCanvas(px, px)
  const g = c.getContext('2d')
  if (background) {
    g.fillStyle = background
    g.fillRect(0, 0, px, px)
  }
  g.fillStyle = '#c81e1e'
  g.beginPath()
  g.arc(px / 2, px / 2, px * 0.4, 0, Math.PI * 2)
  g.fill()
  return new Uint8Array(c.toBuffer('image/png'))
}

async function designPdf(wMm: number, hMm: number, round = false): Promise<Uint8Array> {
  const doc = await PDFDocument.create()
  const W = wMm * PT_PER_MM
  const H = hMm * PT_PER_MM
  const page = doc.addPage([W, H])
  if (round) page.drawEllipse({ x: W / 2, y: H / 2, xScale: W / 2, yScale: H / 2, color: rgb(0.8, 0.1, 0.1) })
  else page.drawRectangle({ x: 0, y: 0, width: W, height: H, color: rgb(0.8, 0.1, 0.1) })
  return doc.save()
}

const pageSizes = async (pdf: Uint8Array) => (await PDFDocument.load(pdf)).getPages().map((p) => p.getSize())
const hasCutLayer = (pdf: Uint8Array) => new TextDecoder('latin1').decode(pdf).includes('CutContour')

/** Size in mm of everything red on the first sheet, rendered: what actually prints, short side first. */
async function redBoxMm(pdf: Uint8Array): Promise<number[]> {
  const k = 4
  const [img] = await nodeRasterizer.render(pdf, k)
  let [x0, y0, x1, y1] = [Infinity, Infinity, -1, -1]
  for (let y = 0; y < img.height; y++)
    for (let x = 0; x < img.width; x++) {
      const i = (y * img.width + x) * 4
      if (img.data[i] < 150 || img.data[i + 1] > 90 || img.data[i + 2] > 90) continue
      x0 = Math.min(x0, x)
      x1 = Math.max(x1, x)
      y0 = Math.min(y0, y)
      y1 = Math.max(y1, y)
    }
  return [(x1 + 1 - x0) / k, (y1 + 1 - y0) / k].sort((a, b) => a - b)
}

/** Red, with a 4 mm green band (wider than the bleed) just inside the edge: the size of the red shows the scale the design was placed at. */
async function bandedPdf(wMm: number, hMm: number): Promise<Uint8Array> {
  const doc = await PDFDocument.create()
  const W = wMm * PT_PER_MM
  const H = hMm * PT_PER_MM
  const page = doc.addPage([W, H])
  const band = 4 * PT_PER_MM
  page.drawRectangle({ x: 0, y: 0, width: W, height: H, color: rgb(0.1, 0.7, 0.2) })
  page.drawRectangle({ x: band, y: band, width: W - 2 * band, height: H - 2 * band, color: rgb(0.8, 0.1, 0.1) })
  return doc.save()
}

describe('stickers API', () => {
  it('takes a plain background away and cuts around the design, like an upload in the app', async () => {
    const r = await runStickerJob({ sheet: 'A4', items: [{ name: 'logo.png', bytes: discPng(1000, '#ffffff'), copies: 6, longestMm: 50 }] })
    expect(r.totalSheets).toBe(1)
    expect(r.totalStickers).toBe(6)
    expect(hasCutLayer(r.pdfBytes)).toBe(true)
    const [page] = await pageSizes(r.pdfBytes)
    expect(page.width).toBeCloseTo(210 * PT_PER_MM, 1)
    expect(r.warnings).toEqual([])
  })

  it('keeps a transparent PNG as it is and honours the requested shape', async () => {
    const r = await runStickerJob({ sheet: '13x19', mode: 'print', items: [{ name: 'cut-out.png', bytes: discPng(800, null), shape: 'circle', border: 'none' }] })
    expect(r.totalStickers).toBe(1)
    expect(new TextDecoder('latin1').decode(r.pdfBytes)).not.toContain('CutContour')
  })

  it('warns about low resolution', async () => {
    const r = await runStickerJob({ items: [{ name: 'tiny.png', bytes: discPng(120, null), longestMm: 100 }] })
    expect(r.warnings.join()).toMatch(/DPI/)
  })

  it('refuses anything it cannot deliver in full', async () => {
    await expect(runStickerJob({ items: [] })).rejects.toThrow(/No items/)
    await expect(runStickerJob({ items: [{ name: 'a.pdf', bytes: await designPdf(50, 50) }] })).rejects.toThrow(/not a PNG/)
    await expect(runStickerJob({ sheet: 'A5' as never, items: [{ name: 'a.png', bytes: discPng(200, null) }] })).rejects.toThrow(/Unknown sheet/)
    await expect(runStickerJob({ sheet: 'A4', items: [{ name: 'huge.png', bytes: discPng(2000, null), longestMm: 600 }] })).rejects.toThrow(/only 0 of 1/)
  })
})

describe('print & cut API', () => {
  it('recognises the 82 mm coaster and the mug wrap by size and gangs them on 13 × 19', async () => {
    const r = await runPrintCutJob({
      items: [
        { name: 'coaster.pdf', bytes: await designPdf(82, 82, true), copies: 4 },
        { name: 'wrap.pdf', bytes: await designPdf(250, 84), copies: 2 },
      ],
    })
    expect(r.totalPieces).toBe(6)
    expect(r.totalSheets).toBe(1)
    expect(hasCutLayer(r.pdfBytes)).toBe(true)
    const [page] = await pageSizes(r.pdfBytes)
    expect([Math.round(page.width), Math.round(page.height)]).toEqual(SHEET_13X19)
  })

  it('traces a contour cut around a design with empty space round it', async () => {
    const r = await runPrintCutJob({ items: [{ name: 'tag.png', bytes: discPng(600, null), widthMm: 40, shape: 'contour', border: { style: 'white', mm: 2 } }] })
    expect(r.totalPieces).toBe(1)
    const [short, long] = await redBoxMm(r.pdfBytes)
    expect(short).toBeCloseTo(40, 0)
    expect(long).toBeCloseTo(40, 0)
  })

  it('makes every page of a PDF its own piece', async () => {
    const doc = await PDFDocument.create()
    doc.addPage([100 * PT_PER_MM, 100 * PT_PER_MM])
    doc.addPage([100 * PT_PER_MM, 100 * PT_PER_MM])
    for (const p of doc.getPages()) p.drawRectangle({ x: 0, y: 0, width: p.getWidth(), height: p.getHeight(), color: rgb(0.8, 0.1, 0.1) })
    const r = await runPrintCutJob({ items: [{ name: 'two.pdf', bytes: await doc.save() }] })
    expect(r.totalPieces).toBe(2)
  })

  it('reports a piece too big for the sheet', async () => {
    await expect(runPrintCutJob({ sheet: 'A4', items: [{ name: 'banner.pdf', bytes: await designPdf(400, 84) }] })).rejects.toThrow(/too big/)
  })
})

describe('posters API', () => {
  it('auto bleed keeps a trim-size file at its exact size; without it the file is stretched into the bleed', async () => {
    const items = [{ name: 'a.pdf', bytes: await bandedPdf(210, 297) }]
    const auto = await runCorelDrawImposition({ size: 'A4', autoBleed: true, rasterizer: nodeRasterizer, items })
    const [page] = await pageSizes(auto.pdfBytes)
    expect([Math.round(page.width), Math.round(page.height)]).toEqual(SHEET_13X19)
    const exact = await redBoxMm(auto.pdfBytes)
    expect(exact[0]).toBeCloseTo(202, 0)
    expect(exact[1]).toBeCloseTo(289, 0)
    const stretched = await redBoxMm((await runCorelDrawImposition({ size: 'A4', items })).pdfBytes)
    expect(stretched[0]).toBeCloseTo((202 * 216) / 210, 0)
  })

  it('warns when a design has to be cropped to the trim size', async () => {
    const r = await runCorelDrawImposition({ size: 'A4', autoBleed: true, rasterizer: nodeRasterizer, items: [{ name: 'square.pdf', bytes: await designPdf(200, 200) }] })
    expect(r.warnings.join()).toMatch(/cut off/)
  })
})
