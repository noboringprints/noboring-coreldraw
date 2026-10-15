/** Turns the operator's choices (designs, sizes, copies) into items the layout engine can place. */
import type { PrintSettings } from '../config/defaults'
import { type BleedMode, type FitMode, detectBleed, effectiveDpi, planArtwork } from './artwork'
import type { LayoutItem } from './layout'
import type { SourceFile } from './sources'

export interface Design {
  id: string
  sourceId: string
  name: string
  /** 'A3' | 'A4' | 'A5' | 'Custom' */
  trimName: string
  trimW: number
  trimH: number
  copies: number
  bleedMode: BleedMode
  /** Only used when the design's proportions don't match the trim size: keep it all (white bands) or fill & crop. */
  fit: FitMode
  /** true while the bleed mode is still the automatic suggestion (re-detected when size changes). */
  bleedAuto: boolean
  /** Multi-page PDF: every page is one panel of a split poster. */
  split: boolean
  /** Page used when not split. */
  pageIndex: number
}

/** What the PDF export needs to draw an item. */
export interface ArtRef {
  sourceId: string
  pageIndex: number
  bleedMode: BleedMode
  fit: FitMode
}

export function buildItems(designs: Design[], sources: Record<string, SourceFile>): LayoutItem<ArtRef>[] {
  const items: LayoutItem<ArtRef>[] = []
  for (const d of designs) {
    const src = sources[d.sourceId]
    if (!src || d.copies < 1) continue
    const pages = d.split ? src.pages.map((p) => p.index) : [d.pageIndex]
    for (let c = 0; c < d.copies; c++)
      pages.forEach((pi, n) =>
        items.push({
          id: `${d.id}:${c}:${pi}`,
          designId: d.id,
          name: d.name,
          panel: d.split ? { index: n + 1, total: pages.length } : undefined,
          trimW: d.trimW,
          trimH: d.trimH,
          art: { sourceId: d.sourceId, pageIndex: pi, bleedMode: d.bleedMode, fit: d.fit },
        }),
      )
  }
  return items
}

export interface DesignCheck {
  detectedNote: string
  suggestedMode: BleedMode
  /** The file really contains bleed (all pages, if split) – only then is 'included' allowed. */
  hasBleed: boolean
  /** Proportions differ from the trim size (so the fit option matters). */
  aspectMismatch: boolean
  warnings: string[]
  /** Neutral information (not a problem). */
  notes?: string[]
  /** Lowest DPI over the pages used (images only). */
  dpi: number | null
}

export function checkDesign(d: Design, src: SourceFile, s: PrintSettings): DesignCheck {
  const pages = d.split ? src.pages : [src.pages[d.pageIndex] ?? src.pages[0]]
  const warnings = new Set<string>()
  let dpi: number | null = null
  const dets = pages.map((p) => detectBleed(p.geometry, d.trimW, d.trimH, s.bleedMm))
  const det = dets.find((x) => !x.hasBleed) ?? dets[0]
  const hasBleed = dets.every((x) => x.hasBleed)
  let aspectMismatch = false
  for (const p of pages) {
    const plan = planArtwork(p.geometry, d.trimW, d.trimH, s.bleedMm, d.bleedMode, d.fit)
    plan.warnings.forEach((w) => warnings.add(w))
    if (plan.warnings.some((w) => w.startsWith('Design proportions'))) aspectMismatch = true
    const e = effectiveDpi(p.geometry, plan)
    if (e !== null) dpi = dpi === null ? e : Math.min(dpi, e)
  }
  if (dpi !== null && dpi < s.minDpi) warnings.add(`Low resolution: about ${dpi} DPI at this size (minimum ${s.minDpi}). It may print blurry.`)
  if (d.split && src.pages.length < 2) warnings.add('Split poster needs a PDF with one panel per page, but this file has only one page.')
  return { detectedNote: det.note, suggestedMode: det.mode, hasBleed, aspectMismatch, warnings: [...warnings], dpi }
}
