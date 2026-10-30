/**
 * Builds the print-ready PDF with pdf-lib.
 * - PDF designs are embedded as vector Form XObjects (never rasterised).
 * - Missing bleed is made OUTSIDE the trim: for PDFs from 300 DPI mirrored edge strips
 *   (or vector mirror copies, see settings.bleedStrips); for images by mirroring their own pixels.
 * - Images are embedded with their original pixels (no resampling).
 * - Every page is exactly the sheet size.
 * Runs in the browser and in Node.
 */
import {
  PDFDocument,
  PDFDict,
  PDFName,
  PDFOperator,
  PDFOperatorNames as Ops,
  PDFNumber,
  type PDFPage,
  type PDFRef,
  lineTo,
  moveTo,
  popGraphicsState,
  pushGraphicsState,
  setLineWidth,
  stroke,
} from 'pdf-lib'
import { PT_PER_MM, type PrintSettings } from '../config/defaults'
import { planArtwork } from './artwork'
import { type Rasterizer, drawStrips, rasterBleedStrips } from './bleedRaster'
import { expand, multiply, scale } from './geometry'
import type { ArtRef } from './job'
import { type Sheet, placementMatrix } from './layout'
import { SourceEmbedder, drawPiece } from './pdfDraw'
import type { SourceFile } from './sources'

export interface ExportOptions {
  date?: Date
  /** Total number of sheets in the job (for "Sheet 2 of 6" when exporting only some sheets). */
  totalSheets?: number
  /** Display names for trim sizes, by group key, e.g. { '210x297': 'A4' }. */
  trimNames?: Record<string, string>
  title?: string
  /**
   * Renders the 300 DPI bleed strips for vector PDFs. Without one, PDFs fall back to
   * vector-mirrored bleed (same look, no rasterising).
   */
  rasterizer?: Rasterizer
}

export async function buildPrintPdf(
  sheets: Sheet<ArtRef>[],
  sources: Record<string, SourceFile>,
  s: PrintSettings,
  opts: ExportOptions = {},
): Promise<Uint8Array> {
  const doc = await PDFDocument.create()
  const date = opts.date ?? new Date()
  doc.setTitle(opts.title ?? 'Print-ready sheets')
  doc.setCreator('Print Ready')
  doc.setProducer('Print Ready (pdf-lib)')
  doc.setCreationDate(date)
  doc.setModificationDate(date)

  // Registration colour: a Separation colour space named "All" prints on every plate.
  const regCS: PDFRef = doc.context.register(
    doc.context.obj([
      PDFName.of('Separation'),
      PDFName.of('All'),
      PDFName.of('DeviceCMYK'),
      doc.context.obj({ FunctionType: 2, Domain: [0, 1], C0: [0, 0, 0, 0], C1: [1, 1, 1, 1], N: 1 }),
    ]),
  )

  const embedder = new SourceEmbedder(doc)
  const W = s.sheet.widthMm * PT_PER_MM
  const H = s.sheet.heightMm * PT_PER_MM
  const toPt = scale(PT_PER_MM)

  for (const sheet of sheets) {
    const page: PDFPage = doc.addPage([W, H])

    // ---- artwork ----
    for (const p of sheet.placements) {
      const art = p.item.art
      if (!art) continue
      const src = sources[art.sourceId]
      const info = src?.pages[art.pageIndex]
      if (!src || !info) continue
      const { trimW, trimH } = p.item
      const plan = planArtwork(info.geometry, trimW, trimH, s.bleedMm, art.bleedMode, art.fit)
      const P = multiply(toPt, placementMatrix(p)) // local trim mm → sheet points
      const d = await embedder.get(src, art.pageIndex)
      const autoBleed = (art.bleedMode === 'mirror' || art.bleedMode === 'stretch') && s.bleedMm > 0
      if (autoBleed && src.kind === 'pdf' && s.bleedStrips === 'image' && opts.rasterizer) {
        // bleed strips as 300 DPI images outside the trim, design stays vector on top
        const strips = await rasterBleedStrips(src, art.pageIndex, plan, trimW, trimH, s.bleedMm, art.bleedMode as 'mirror' | 'stretch', s.bleedStripDpi, opts.rasterizer)
        drawStrips(doc, page, P, strips, expand({ x: 0, y: 0, w: trimW, h: trimH }, s.bleedMm))
      } else {
        for (const piece of plan.bleedPieces) drawPiece(page, P, piece, d)
      }
      drawPiece(page, P, plan.main, d)
    }

    // ---- crop marks ----
    if (sheet.marks.length) {
      const ops: PDFOperator[] = [pushGraphicsState(), setLineWidth(s.marks.lineWidthPt)]
      if (s.marks.color === 'registration') {
        const { Resources } = page.node.normalizedEntries()
        let csDict = Resources.lookupMaybe(PDFName.of('ColorSpace'), PDFDict)
        if (!csDict) {
          csDict = doc.context.obj({})
          Resources.set(PDFName.of('ColorSpace'), csDict)
        }
        csDict.set(PDFName.of('CSReg'), regCS)
        ops.push(PDFOperator.of(Ops.StrokingColorspace, [PDFName.of('CSReg')]), PDFOperator.of(Ops.StrokingColorN, [PDFNumber.of(1)]))
      } else {
        ops.push(PDFOperator.of(Ops.StrokingColorCmyk, [0, 0, 0, 1].map((n) => PDFNumber.of(n))))
      }
      for (const m of sheet.marks) ops.push(moveTo(m.x1 * PT_PER_MM, m.y1 * PT_PER_MM), lineTo(m.x2 * PT_PER_MM, m.y2 * PT_PER_MM))
      ops.push(stroke(), popGraphicsState())
      page.pushOperators(...ops)
    }

    // Margin label text intentionally disabled so printed pages remain completely plain without slug text
  }
  return doc.save({ useObjectStreams: false })
}
