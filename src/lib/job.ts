/** Turns the operator's choices (designs, sizes, copies) into items the layout engine can place. */
import type { PrintSettings } from '../config/defaults'
import { type BleedMode, type FitMode, detectBleed, effectiveDpi, planArtwork } from './artwork'
import type { LayoutItem } from './layout'
import type { SourceFile, SourcePageInfo } from './sources'

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
  /** Multi-page PDF: the pages to print when split (0-based, ascending). Missing = every page. */
  pages?: number[]
}

/** The pages of the source a design prints: the selected pages when split, else its one page. */
export function designPages(d: Design, src: SourceFile): SourcePageInfo[] {
  if (!d.split) return [src.pages[d.pageIndex] ?? src.pages[0]]
  if (!d.pages) return src.pages
  const picked = d.pages.map((i) => src.pages[i]).filter((p): p is SourcePageInfo => !!p)
  return picked.length ? picked : src.pages
}

/**
 * Reads a page range typed by the operator, e.g. "2-4", "1, 3, 5-7", "5-" (to the end) or "all".
 * Returns 0-based page indexes in ascending order, or an error message.
 */
export function parsePageRange(text: string, count: number): number[] | string {
  // "2 - 4" and "2–4" mean the same as "2-4"
  const t = text.trim().toLowerCase().replace(/\s*[-–]\s*/g, '-')
  if (t === '' || t === 'all') return [...Array(count).keys()]
  const out = new Set<number>()
  for (const raw of t.split(/[,;\s]+/).filter(Boolean)) {
    const m = /^(\d*)-(\d*)$/.exec(raw) ?? /^(\d+)$/.exec(raw)
    if (!m) return `“${raw}” is not a page or range (use e.g. 2-4, 6)`
    const single = m.length === 2
    const a = single ? Number(m[1]) : m[1] ? Number(m[1]) : 1
    const b = single ? a : m[2] ? Number(m[2]) : count
    if (!single && !m[1] && !m[2]) return `“${raw}” is not a page or range (use e.g. 2-4, 6)`
    if (a < 1 || b < 1) return 'Pages start at 1'
    if (a > count || b > count) return `This file has only ${count} page${count === 1 ? '' : 's'}`
    if (a > b) return `“${raw}” runs backwards – write ${b}-${a}`
    for (let i = a; i <= b; i++) out.add(i - 1)
  }
  return [...out].sort((x, y) => x - y)
}

/** "2-4, 6" for 0-based pages [1, 2, 3, 5]; "All" when every page is picked. */
export function formatPageRange(pages: number[] | undefined, count: number): string {
  if (!pages || (pages.length === count && pages.every((p, i) => p === i))) return 'All'
  const parts: string[] = []
  for (let i = 0; i < pages.length; i++) {
    const start = pages[i]
    while (i + 1 < pages.length && pages[i + 1] === pages[i] + 1) i++
    parts.push(start === pages[i] ? `${start + 1}` : `${start + 1}-${pages[i] + 1}`)
  }
  return parts.join(', ')
}

/**
 * The design change for a new page selection: several pages are each printed (split),
 * a single page is printed on its own.
 */
export function pageSelectionPatch(pages: number[], count: number): Partial<Design> {
  if (pages.length === 1) return { split: false, pageIndex: pages[0], pages: undefined }
  const all = pages.length === count
  return { split: true, pageIndex: pages[0], pages: all ? undefined : pages }
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
    const pages = designPages(d, src).map((p) => p.index)
    for (let c = 0; c < d.copies; c++)
      pages.forEach((pi) =>
        items.push({
          id: `${d.id}:${c}:${pi}`,
          designId: d.id,
          name: d.name,
          // numbered by page in the file, so a selection like 2-4 prints as panels 2, 3 and 4
          panel: d.split ? { index: pi + 1, total: src.pages.length } : undefined,
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
  const pages = designPages(d, src)
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
