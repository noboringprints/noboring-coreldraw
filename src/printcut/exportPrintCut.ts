/**
 * Print & Cut PDFs. The sheet itself (Print + CutContour layers, spot colour, registration marks, label) is the
 * sticker export; this module only draws each item's artwork into it: PDF pages as vectors, images with their
 * original pixels, and the bleed (300 DPI strips for PDFs, or the enlarged copy for any shape).
 * Runs in the browser and in Node.
 */
import { PDFDocument, type PDFPage, clip, endPath, popGraphicsState, pushGraphicsState } from 'pdf-lib'
import { PT_PER_MM } from '../config/defaults'
import { type Rasterizer, drawStrips, rasterBleedStrips } from '../lib/bleedRaster'
import { IDENTITY, type Matrix, expand, multiply, scale, translate } from '../lib/geometry'
import { SourceEmbedder, cm, drawPiece } from '../lib/pdfDraw'
import type { SourceFile } from '../lib/sources'
import type { StickerSettings } from '../stickers/config'
import { type ExportDesign, type ExportMode, buildStickerPdf, pathOps } from '../stickers/lib/exportStickers'
import type { StickerSheetLayout } from '../stickers/lib/nest'
import { type PrintCutItem, itemShape, planItem } from './model'

const embedders = new WeakMap<PDFDocument, SourceEmbedder>()
const embedderFor = (doc: PDFDocument) => {
  let e = embedders.get(doc)
  if (!e) embedders.set(doc, (e = new SourceEmbedder(doc)))
  return e
}

/** Draws one item's artwork with its bleed. `M` maps the item's local trim mm → page points. */
export async function drawItemArt(doc: PDFDocument, page: PDFPage, M: Matrix, it: PrintCutItem, src: SourceFile, bleedMm: number, rasterizer?: Rasterizer) {
  const info = src.pages[it.pageIndex]
  if (!info) return
  const p = planItem(it, info.geometry, bleedMm)
  const d = await embedderFor(doc).get(src, it.pageIndex)
  if (p.rasterStrips && rasterizer) {
    const strips = await rasterBleedStrips(src, it.pageIndex, p.plan, it.widthMm, it.heightMm, bleedMm, p.rasterStrips, 300, rasterizer)
    drawStrips(doc, page, M, strips, expand({ x: 0, y: 0, w: it.widthMm, h: it.heightMm }, bleedMm))
  } else for (const piece of p.under) drawPiece(page, M, piece, d)
  if (p.clipMainToCut) {
    page.pushOperators(pushGraphicsState(), cm(M), ...pathOps(itemShape(it, bleedMm).cut, IDENTITY), clip(), endPath())
    drawPiece(page, IDENTITY, p.main, d)
    page.pushOperators(popGraphicsState())
  } else drawPiece(page, M, p.main, d)
}

/** The sticker export's view of the items. */
export function exportDesigns(items: PrintCutItem[], sources: Record<string, SourceFile>, s: StickerSettings, rasterizer?: Rasterizer): Record<string, ExportDesign> {
  const out: Record<string, ExportDesign> = {}
  for (const it of items) {
    const src = sources[it.sourceId]
    if (!src) continue
    const { cut, bleed, bounds } = itemShape(it, s.bleedMm)
    out[it.id] = {
      id: it.id,
      name: it.name,
      cut,
      bleed,
      bounds,
      border: 'none',
      borderColor: '#000000',
      drawArt: (doc, page) => drawItemArt(doc, page, IDENTITY, it, src, s.bleedMm, rasterizer),
    }
  }
  return out
}

export function buildPrintCutPdf(
  sheets: StickerSheetLayout[],
  items: PrintCutItem[],
  sources: Record<string, SourceFile>,
  s: StickerSettings,
  opts: { mode: ExportMode; rasterizer?: Rasterizer; date?: Date; title?: string },
): Promise<Uint8Array> {
  return buildStickerPdf(sheets, exportDesigns(items, sources, s, opts.rasterizer), s, { mode: opts.mode, date: opts.date, title: opts.title ?? 'Print & cut sheets', noun: 'piece' })
}

/** One item on its own, cropped to its bleed outline (white outside) – rendered for the on-screen preview. */
export async function buildItemPreviewPdf(it: PrintCutItem, src: SourceFile, bleedMm: number, rasterizer?: Rasterizer): Promise<Uint8Array> {
  const doc = await PDFDocument.create()
  const b = Math.max(0, bleedMm)
  const page = doc.addPage([(it.widthMm + 2 * b) * PT_PER_MM, (it.heightMm + 2 * b) * PT_PER_MM])
  const M = multiply(scale(PT_PER_MM), translate(b, b))
  page.pushOperators(pushGraphicsState(), cm(M), ...pathOps(itemShape(it, b).bleed, IDENTITY), clip(), endPath())
  await drawItemArt(doc, page, IDENTITY, it, src, b, rasterizer)
  page.pushOperators(popGraphicsState())
  return doc.save()
}

/** The whole file page at its own size, on white – rendered to find where the design sits in it. */
export async function buildSourcePdf(src: SourceFile, pageIndex: number): Promise<Uint8Array> {
  const doc = await PDFDocument.create()
  const g = src.pages[pageIndex].geometry
  const page = doc.addPage([g.widthMm * PT_PER_MM, g.heightMm * PT_PER_MM])
  const d = await embedderFor(doc).get(src, pageIndex)
  drawPiece(page, scale(PT_PER_MM), { clip: { x: 0, y: 0, w: g.widthMm, h: g.heightMm }, matrix: IDENTITY }, d)
  return doc.save()
}
