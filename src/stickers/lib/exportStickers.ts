/**
 * Print-and-cut files for sticker sheets.
 *
 * PDF, one page per sheet, exactly the sheet size, with two layers (optional content groups):
 *   "Print"      – artwork (original pixels), printed borders, edge bleed, registration marks, label
 *   "CutContour" – the cut lines: stroked in a SPOT colour named "CutContour" (100 % magenta look),
 *                  set to overprint, so RIPs (VersaWorks, Fiery XF, Onyx, Caldera…) cut it instead of printing it,
 *                  and CorelDRAW / Illustrator show it as a separate layer.
 * SVG, one per sheet: only the cut lines and registration marks, in mm – for cutter software that wants a cut file.
 */
import {
  PDFDict,
  PDFDocument,
  PDFName,
  PDFOperator,
  PDFOperatorNames as Ops,
  PDFNumber,
  PDFString,
  type PDFImage,
  type PDFPage,
  type PDFRef,
  StandardFonts,
  appendBezierCurve,
  clip,
  closePath,
  cmyk,
  drawObject,
  endPath,
  fill,
  moveTo,
  popGraphicsState,
  pushGraphicsState,
  rectangle,
  setFillingCmykColor,
  setFillingRgbColor,
  setLineJoin,
  setLineWidth,
  stroke,
  LineJoinStyle,
} from 'pdf-lib'
import { PT_PER_MM } from '../../config/defaults'
import { type Matrix, type Rect, apply, multiply, scale } from '../../lib/geometry'
import { cm } from '../../lib/pdfDraw'
import type { BorderStyle, StickerSettings } from '../config'
import { type StickerSheetLayout, placementMatrix } from './nest'
import { markDots, markRects } from './marks'
import { type BezierPath, ellipsePath, mapPath, svgPathData } from './paths'

export { markDots, markRects }

/** Everything the export needs to know about one sticker design. */
export interface ExportDesign {
  id: string
  name: string
  cut: BezierPath[]
  bleed: BezierPath[]
  bounds: Rect
  border: BorderStyle
  borderColor: string
  art?: { bytes: Uint8Array; kind: 'png' | 'jpg'; rect: Rect }
  bleedImage?: { png: Uint8Array; rect: Rect }
  /** Draws the artwork itself instead of `art` (e.g. a vector PDF page), in local mm: the transform and the bleed clip are already set. */
  drawArt?: (doc: PDFDocument, page: PDFPage) => Promise<void>
}

export type ExportMode = 'print-cut' | 'print' | 'cut'

export interface StickerExportOptions {
  mode: ExportMode
  date?: Date
  title?: string
  /** What one placed piece is called in the sheet label. */
  noun?: string
}

export function sheetLabel(sheet: StickerSheetLayout, total: number, s: StickerSettings, names: Record<string, string>, date: Date, noun = 'sticker'): string {
  const n = sheet.placements.length
  const designs = [...new Set(sheet.placements.map((p) => names[p.designId] ?? ''))].filter(Boolean)
  const d = date.toISOString().slice(0, 10)
  return `Sheet ${sheet.index + 1} of ${total}  |  ${s.sheet.name}  |  ${n} ${noun}${n === 1 ? '' : 's'}: ${designs.join(', ')}  |  cut: ${s.cut.spotName}  |  ${d}`
}

/* ------------------------------------------------------------------ PDF */

export function pathOps(paths: BezierPath[], m: Matrix): PDFOperator[] {
  const ops: PDFOperator[] = []
  for (const p of paths) {
    const [x0, y0] = apply(m, p.start[0], p.start[1])
    ops.push(moveTo(x0, y0))
    for (const [a, b, c, d, e, f] of p.segs) {
      const p1 = apply(m, a, b)
      const p2 = apply(m, c, d)
      const p3 = apply(m, e, f)
      ops.push(appendBezierCurve(p1[0], p1[1], p2[0], p2[1], p3[0], p3[1]))
    }
    ops.push(closePath())
  }
  return ops
}

const hexRgb = (hex: string): [number, number, number] => {
  const h = hex.replace('#', '')
  const v = h.length === 3 ? h.split('').map((c) => c + c).join('') : h.padEnd(6, '0')
  return [0, 2, 4].map((i) => parseInt(v.slice(i, i + 2), 16) / 255) as [number, number, number]
}

function resourcesOf(page: PDFPage, key: string, doc: PDFDocument): PDFDict {
  const { Resources } = page.node.normalizedEntries()
  let d = Resources.lookupMaybe(PDFName.of(key), PDFDict)
  if (!d) {
    d = doc.context.obj({})
    Resources.set(PDFName.of(key), d)
  }
  return d
}

const bdc = (tag: string) => PDFOperator.of(Ops.BeginMarkedContentSequence, [PDFName.of('OC'), PDFName.of(tag)])
const emc = () => PDFOperator.of(Ops.EndMarkedContent)

export async function buildStickerPdf(
  sheets: StickerSheetLayout[],
  designs: Record<string, ExportDesign>,
  s: StickerSettings,
  opts: StickerExportOptions,
): Promise<Uint8Array> {
  const doc = await PDFDocument.create()
  const date = opts.date ?? new Date()
  doc.setTitle(opts.title ?? 'Sticker sheets')
  doc.setCreator('Print Ready – Stickers')
  doc.setProducer('Print Ready (pdf-lib)')
  doc.setCreationDate(date)
  doc.setModificationDate(date)
  const font = await doc.embedFont(StandardFonts.Helvetica)
  const withPrint = opts.mode !== 'cut'
  const withCut = opts.mode !== 'print'

  // layers
  const layer = (name: string) => doc.context.register(doc.context.obj({ Type: 'OCG', Name: PDFString.of(name) }))
  const ocPrint = withPrint ? layer('Print') : null
  const ocCut = withCut ? layer(s.cut.spotName || 'CutContour') : null
  const groups = [ocPrint, ocCut].filter((g): g is PDFRef => !!g)
  doc.catalog.set(PDFName.of('OCProperties'), doc.context.obj({ OCGs: groups, D: { Order: groups, ON: groups } }))

  // the cut colour: a spot colour the RIP recognises by name (only written when the file has cut lines)
  const cutCS = withCut
    ? doc.context.register(
        doc.context.obj([
          PDFName.of('Separation'),
          PDFName.of(s.cut.spotName || 'CutContour'),
          PDFName.of('DeviceCMYK'),
          doc.context.obj({ FunctionType: 2, Domain: [0, 1], C0: [0, 0, 0, 0], C1: [0, 1, 0, 0], N: 1 }),
        ]),
      )
    : null
  const overprint = withCut ? doc.context.register(doc.context.obj({ Type: 'ExtGState', OP: true, op: true, OPM: 1 })) : null

  const images = new Map<string, Promise<PDFImage>>()
  const image = (key: string, bytes: Uint8Array, kind: 'png' | 'jpg') => {
    let p = images.get(key)
    if (!p) images.set(key, (p = kind === 'png' ? doc.embedPng(bytes) : doc.embedJpg(bytes)))
    return p
  }
  const names = Object.fromEntries(Object.values(designs).map((d) => [d.id, d.name]))
  const W = s.sheet.widthMm * PT_PER_MM
  const H = s.sheet.heightMm * PT_PER_MM
  const toPt = scale(PT_PER_MM)

  for (const sheet of sheets) {
    const page = doc.addPage([W, H])
    const props = resourcesOf(page, 'Properties', doc)
    if (ocPrint) props.set(PDFName.of('OCPrint'), ocPrint)
    if (ocCut) props.set(PDFName.of('OCCut'), ocCut)

    // ---------------- print layer
    if (withPrint) {
      page.pushOperators(bdc('OCPrint'))
      for (const pl of sheet.placements) {
        const d = designs[pl.designId]
        if (!d) continue
        const M = multiply(toPt, placementMatrix(pl, d.bounds, s)) // local mm → page pt
        page.pushOperators(pushGraphicsState(), cm(M), ...pathOps(d.bleed, [1, 0, 0, 1, 0, 0]), clip(), endPath())
        if (d.border === 'color') {
          const [r, g, b] = hexRgb(d.borderColor)
          page.pushOperators(setFillingRgbColor(r, g, b), ...pathOps(d.bleed, [1, 0, 0, 1, 0, 0]), fill())
        }
        if (d.bleedImage) {
          const img = await image(`${d.id}:bleed`, d.bleedImage.png, 'png')
          const r = d.bleedImage.rect
          page.pushOperators(pushGraphicsState(), cm([r.w, 0, 0, r.h, r.x, r.y]), drawObject(page.node.newXObject('Bleed', img.ref)), popGraphicsState())
        }
        if (d.drawArt) await d.drawArt(doc, page)
        else if (d.art) {
          const art = await image(`${d.id}:art`, d.art.bytes, d.art.kind)
          const r = d.art.rect
          page.pushOperators(pushGraphicsState(), cm([r.w, 0, 0, r.h, r.x, r.y]), drawObject(page.node.newXObject('Art', art.ref)), popGraphicsState())
        }
        page.pushOperators(popGraphicsState())
      }
      page.pushOperators(emc())
    }

    // ---------------- registration marks + label (printed; the cutter's sensor reads the marks)
    page.pushOperators(bdc(withPrint ? 'OCPrint' : 'OCCut'), pushGraphicsState(), setFillingCmykColor(0, 0, 0, 1))
    for (const r of markRects(s)) page.pushOperators(rectangle(r.x * PT_PER_MM, r.y * PT_PER_MM, r.w * PT_PER_MM, r.h * PT_PER_MM))
    page.pushOperators(...pathOps(markDots(s).map((d) => ellipsePath(d.cx, d.cy, d.r, d.r)), toPt))
    if (markRects(s).length || markDots(s).length) page.pushOperators(fill())
    page.pushOperators(popGraphicsState(), emc())
    if (s.label && s.marginMm >= 4) {
      const size = 6
      const max = W - 2 * (s.marginMm + s.marks.lengthMm + 4) * PT_PER_MM
      let text = sheetLabel(sheet, sheets.length, s, names, date, opts.noun).replace(/[^\x20-\x7e]/g, '?')
      while (text.length > 4 && font.widthOfTextAtSize(text, size) > max) text = text.slice(0, -2)
      const tw = font.widthOfTextAtSize(text, size)
      page.pushOperators(bdc(withPrint ? 'OCPrint' : 'OCCut'))
      page.drawText(text, { x: (W - tw) / 2, y: (s.marginMm * PT_PER_MM) / 2 - size / 3, size, font, color: cmyk(0, 0, 0, 1) })
      page.pushOperators(emc())
    }

    // ---------------- cut layer
    if (cutCS && overprint) {
      resourcesOf(page, 'ColorSpace', doc).set(PDFName.of('CSCut'), cutCS)
      resourcesOf(page, 'ExtGState', doc).set(PDFName.of('GSCut'), overprint)
      const ops: PDFOperator[] = [
        bdc('OCCut'),
        pushGraphicsState(),
        PDFOperator.of(Ops.SetGraphicsStateParams, [PDFName.of('GSCut')]),
        PDFOperator.of(Ops.StrokingColorspace, [PDFName.of('CSCut')]),
        PDFOperator.of(Ops.StrokingColorN, [PDFNumber.of(1)]),
        setLineWidth(s.cut.lineWidthPt),
        setLineJoin(LineJoinStyle.Round),
      ]
      for (const pl of sheet.placements) {
        const d = designs[pl.designId]
        if (!d) continue
        ops.push(...pathOps(d.cut, multiply(toPt, placementMatrix(pl, d.bounds, s))), stroke())
      }
      ops.push(popGraphicsState(), emc())
      page.pushOperators(...ops)
    }
  }
  return doc.save({ useObjectStreams: false })
}

/* ------------------------------------------------------------------ SVG */

/** Cut lines + registration marks of one sheet, in mm (top-left origin, as SVG expects). */
export function buildCutSvg(sheet: StickerSheetLayout, designs: Record<string, Pick<ExportDesign, 'cut' | 'bounds'>>, s: StickerSettings): string {
  const W = s.sheet.widthMm
  const H = s.sheet.heightMm
  const r = (n: number) => String(Math.round(n * 1000) / 1000)
  const paths: string[] = []
  for (const pl of sheet.placements) {
    const d = designs[pl.designId]
    if (!d) continue
    const M = placementMatrix(pl, d.bounds, s)
    for (const p of d.cut) paths.push(`<path d="${svgPathData(mapPath(p, (x, y) => apply(M, x, y)), (x, y) => [x, H - y])}"/>`)
  }
  const marks = [
    ...markRects(s).map((m) => `<rect x="${r(m.x)}" y="${r(H - m.y - m.h)}" width="${r(m.w)}" height="${r(m.h)}"/>`),
    ...markDots(s).map((d) => `<circle cx="${r(d.cx)}" cy="${r(H - d.cy)}" r="${r(d.r)}"/>`),
  ]
  return [
    `<?xml version="1.0" encoding="UTF-8"?>`,
    `<svg xmlns="http://www.w3.org/2000/svg" width="${r(W)}mm" height="${r(H)}mm" viewBox="0 0 ${r(W)} ${r(H)}">`,
    `<g id="${s.cut.spotName.replace(/[^\w-]/g, '_')}" fill="none" stroke="${s.cut.displayColor}" stroke-width="0.1" stroke-linejoin="round">`,
    ...paths,
    `</g>`,
    `<g id="RegistrationMarks" fill="#000">`,
    ...marks,
    `</g>`,
    `</svg>`,
  ].join('\n')
}
