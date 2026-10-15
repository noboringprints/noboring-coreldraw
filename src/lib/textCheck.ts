/**
 * Warns when text sits too close to the cut line (inside the "safe zone") or would be cut off.
 * Works for PDFs (text positions come from pdf.js). Images can't be checked automatically.
 * Pure maths – the text extraction itself lives in pdfRender.ts (browser) / scripts/rasterNode.ts (Node).
 */
import type { ArtPlan } from './artwork'
import { apply, multiply } from './geometry'
import { type SourcePageInfo, pdfPageToDisplayedMm } from './sources'

/** The fields we use from a pdf.js text item. `transform` is in PDF user space (points). */
export interface TextItemLite {
  str: string
  transform: number[]
  width: number
  height: number
}

export interface EdgeText {
  text: string
  /** Distance from the nearest cut line, mm (negative = partly outside the trim, will be cut off). */
  distanceMm: number
}

/** Text that comes closer than `safeMm` to the trim edge, closest first. */
export function textNearEdge(items: TextItemLite[], info: SourcePageInfo, plan: ArtPlan, trimW: number, trimH: number, safeMm: number): EdgeText[] {
  if (!info.pdfBox) return []
  // PDF user space (pt) → embedded box origin → displayed mm → local trim space
  const toLocal = multiply(plan.main.matrix, multiply(pdfPageToDisplayedMm(info), [1, 0, 0, 1, -info.pdfBox.left, -info.pdfBox.bottom]))
  const clip = plan.main.clip
  const out: EdgeText[] = []
  for (const it of items) {
    const [a, b, c, d, e, f] = it.transform
    const ul = Math.hypot(a, b) || 1
    const vl = Math.hypot(c, d) || 1
    const ux = (a / ul) * it.width
    const uy = (b / ul) * it.width
    const vx = (c / vl) * it.height
    const vy = (d / vl) * it.height
    const corners = [
      [e, f],
      [e + ux, f + uy],
      [e + vx, f + vy],
      [e + ux + vx, f + uy + vy],
    ].map(([x, y]) => apply(toLocal, x, y))
    const xs = corners.map((p) => p[0])
    const ys = corners.map((p) => p[1])
    const x0 = Math.min(...xs)
    const x1 = Math.max(...xs)
    const y0 = Math.min(...ys)
    const y1 = Math.max(...ys)
    // ignore text that is entirely outside what gets printed
    if (x1 < clip.x || x0 > clip.x + clip.w || y1 < clip.y || y0 > clip.y + clip.h) continue
    const dist = Math.min(x0, y0, trimW - x1, trimH - y1)
    if (dist < safeMm) out.push({ text: it.str.trim(), distanceMm: Math.round(dist * 10) / 10 })
  }
  return out.sort((p, q) => p.distanceMm - q.distanceMm)
}

/** Plain-English warning for a list of edge texts (or null). */
export function edgeTextWarning(found: EdgeText[], safeMm: number): string | null {
  if (!found.length) return null
  const cut = found.filter((t) => t.distanceMm < 0)
  const quote = (ts: EdgeText[]) =>
    ts
      .slice(0, 3)
      .map((t) => `“${t.text.length > 24 ? t.text.slice(0, 23) + '…' : t.text}”`)
      .join(', ') + (ts.length > 3 ? ` and ${ts.length - 3} more` : '')
  if (cut.length) return `Text will be cut off at the edge: ${quote(cut)}.`
  return `Text is closer than ${safeMm} mm to the cut line: ${quote(found)} (closest ${Math.max(0, found[0].distanceMm)} mm). Check the safe zone in the preview.`
}
