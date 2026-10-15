/**
 * Makes simple test posters (as PDFs) for the automated tests and the sample output files.
 * Each test poster has:
 *  - a coloured background that runs into the bleed,
 *  - a thin white line exactly on the trim (cut) line,
 *  - a 5 mm inner frame and mm ticks so you can check the cut with a ruler.
 */
import { PDFDocument, StandardFonts, rgb } from 'pdf-lib'
import { PT_PER_MM } from '../config/defaults'

export const BORDER_MM = 2
export const BORDER_COLORS = {
  left: [0.9, 0.1, 0.1] as [number, number, number],
  right: [0.1, 0.7, 0.2] as [number, number, number],
  bottom: [0.1, 0.3, 0.9] as [number, number, number],
  top: [1, 0.6, 0] as [number, number, number],
}

export async function makeTestPoster(opts: {
  trimW: number
  trimH: number
  bleed: number
  title: string
  color?: [number, number, number]
  pages?: number
  /**
   * Draw a 2 mm border INSIDE the trim, one colour per side (left red, right green, bottom blue, top orange).
   * After cutting, the full 2 mm border must still be visible on every side.
   */
  border?: boolean
}): Promise<Uint8Array> {
  const { trimW, trimH, bleed, title } = opts
  const [r, g, b] = opts.color ?? [0.15, 0.45, 0.75]
  const doc = await PDFDocument.create()
  const font = await doc.embedFont(StandardFonts.HelveticaBold)
  const mm = (n: number) => n * PT_PER_MM
  const pages = opts.pages ?? 1
  for (let pi = 0; pi < pages; pi++) {
    const W = trimW + 2 * bleed
    const H = trimH + 2 * bleed
    const page = doc.addPage([mm(W), mm(H)])
    if (bleed > 0) {
      page.setTrimBox(mm(bleed), mm(bleed), mm(trimW), mm(trimH))
      page.setBleedBox(0, 0, mm(W), mm(H))
    }
    const shade = 1 - pi * 0.12
    // background including bleed
    page.drawRectangle({ x: 0, y: 0, width: mm(W), height: mm(H), color: rgb(r * shade, g * shade, b * shade) })
    // bleed band in a different tone so it is easy to see if it survives cutting
    if (bleed > 0) {
      page.drawRectangle({ x: 0, y: 0, width: mm(W), height: mm(bleed), color: rgb(0.9, 0.2, 0.3) })
      page.drawRectangle({ x: 0, y: mm(H - bleed), width: mm(W), height: mm(bleed), color: rgb(0.9, 0.2, 0.3) })
      page.drawRectangle({ x: 0, y: 0, width: mm(bleed), height: mm(H), color: rgb(0.9, 0.2, 0.3) })
      page.drawRectangle({ x: mm(W - bleed), y: 0, width: mm(bleed), height: mm(H), color: rgb(0.9, 0.2, 0.3) })
    }
    const ox = mm(bleed)
    const oy = mm(bleed)
    if (opts.border) {
      const k = mm(BORDER_MM)
      page.drawRectangle({ x: ox, y: oy, width: k, height: mm(trimH), color: rgb(...BORDER_COLORS.left) })
      page.drawRectangle({ x: ox + mm(trimW) - k, y: oy, width: k, height: mm(trimH), color: rgb(...BORDER_COLORS.right) })
      page.drawRectangle({ x: ox, y: oy, width: mm(trimW), height: k, color: rgb(...BORDER_COLORS.bottom) })
      page.drawRectangle({ x: ox, y: oy + mm(trimH) - k, width: mm(trimW), height: k, color: rgb(...BORDER_COLORS.top) })
    } else {
      // trim line (thin white)
      page.drawRectangle({ x: ox, y: oy, width: mm(trimW), height: mm(trimH), borderColor: rgb(1, 1, 1), borderWidth: 0.3 })
    }
    // 5 mm safe frame
    page.drawRectangle({ x: ox + mm(5), y: oy + mm(5), width: mm(trimW - 10), height: mm(trimH - 10), borderColor: rgb(1, 1, 0.6), borderWidth: 0.5 })
    // mm ticks along the bottom and left trim edges (every 10 mm, long every 50); with a border they start inside it
    const t0 = opts.border ? BORDER_MM : 0
    for (let x = 10; x < trimW; x += 10) {
      const len = x % 50 === 0 ? 4 : 2
      page.drawLine({ start: { x: ox + mm(x), y: oy + mm(t0) }, end: { x: ox + mm(x), y: oy + mm(t0 + len) }, thickness: 0.3, color: rgb(1, 1, 1) })
    }
    for (let y = 10; y < trimH; y += 10) {
      const len = y % 50 === 0 ? 4 : 2
      page.drawLine({ start: { x: ox + mm(t0), y: oy + mm(y) }, end: { x: ox + mm(t0 + len), y: oy + mm(y) }, thickness: 0.3, color: rgb(1, 1, 1) })
    }
    const size = Math.max(10, Math.min(36, trimW / 6))
    const label = pages > 1 ? `${title} – panel ${pi + 1}` : title
    page.drawText(label, { x: ox + mm(12), y: oy + mm(trimH / 2), size, font, color: rgb(1, 1, 1) })
    const sub = opts.border ? `trim ${trimW} × ${trimH} mm  ·  no bleed  ·  border must stay visible` : `trim ${trimW} × ${trimH} mm  ·  bleed ${bleed} mm`
    page.drawText(sub, {
      x: ox + mm(12),
      y: oy + mm(trimH / 2) - size * 1.4,
      size: size * 0.4,
      font,
      color: rgb(1, 1, 1),
    })
  }
  return doc.save()
}
