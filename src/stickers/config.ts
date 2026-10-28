/**
 * ALL STICKER SETTINGS LIVE HERE.
 *
 * Defaults the sticker tool starts with (and what "Reset to defaults" goes back to).
 * Everything can also be changed in the app (⚙ Sheet settings), saved in this browser.
 *
 * The registration-mark values are common print-and-cut defaults, NOT taken from your
 * cutter's manual. Check them once against the plotter software (Graphtec Cutting Master,
 * Silhouette Studio, Summa GoProduce, VersaWorks…). All lengths are in millimetres.
 */
import { MM_PER_INCH } from '../config/defaults'

export type MarkStyle = 'dots' | 'l-corners' | 'squares' | 'silhouette' | 'none'
export type Units = 'in' | 'mm'

export interface StickerSheet {
  name: string
  widthMm: number
  heightMm: number
}

export interface StickerSettings {
  sheet: StickerSheet
  /** Empty strip between the sheet edge and the registration marks. */
  marginMm: number
  marks: {
    style: MarkStyle
    /** Side of a square mark, or diameter of a dot. */
    sizeMm: number
    /** Length of each arm of an L-shaped corner mark. */
    lengthMm: number
    /** Line thickness of an L-shaped mark. */
    thicknessMm: number
    /** Free space between the marks and the nearest sticker. */
    clearanceMm: number
  }
  /** Space between the cut lines of neighbouring stickers. */
  gapMm: number
  /** Print this far past the cut line, so a slightly shifted cut never shows white. */
  bleedMm: number
  cut: {
    /** Spot colour name the RIP / cutter software looks for. Must match exactly. */
    spotName: string
    /** How the cut line looks on screen and in viewers (it is a spot colour, the cutter ignores the look). */
    displayColor: string
    lineWidthPt: number
  }
  /** Small text in the margin: sheet number, size, date. */
  label: boolean
  /** Warn when a sticker would print below this resolution. */
  minDpi: number
  units: Units
}

export const STICKER_SHEETS: StickerSheet[] = [
  { name: 'A4', widthMm: 210, heightMm: 297 },
  { name: 'A3', widthMm: 297, heightMm: 420 },
  { name: '13 × 19 in', widthMm: 13 * MM_PER_INCH, heightMm: 19 * MM_PER_INCH },
]

export const DEFAULT_STICKER_SETTINGS: StickerSettings = {
  sheet: STICKER_SHEETS[0],
  marginMm: 10,
  marks: { style: 'dots', sizeMm: 5, lengthMm: 20, thicknessMm: 0.5, clearanceMm: 5 },
  gapMm: 3,
  bleedMm: 1.5,
  cut: { spotName: 'CutContour', displayColor: '#ec008c', lineWidthPt: 0.25 },
  label: true,
  minDpi: 200,
  units: 'in',
}

export type CutShape = 'contour' | 'rect' | 'rounded' | 'circle'
/** white = paper shows between art and cut, color = printed border, none = cut right on the art edge. */
export type BorderStyle = 'white' | 'color' | 'none'

/** How a sticker is cut. All lengths in mm. */
export interface CutParams {
  shape: CutShape
  border: BorderStyle
  /** Distance from the art edge to the cut line (ignored when border is 'none'). */
  borderMm: number
  borderColor: string
  /** Rounded rectangle corner radius. */
  cornerMm: number
  /** Fills notches and gaps narrower than about twice this, so the cutter makes one smooth pass. */
  smoothMm: number
}

export const DEFAULT_CUT: CutParams = {
  shape: 'contour',
  border: 'white',
  borderMm: 3,
  borderColor: '#000000',
  cornerMm: 4,
  smoothMm: 2,
}

/** Quick picks for a printed border. */
export const BORDER_SWATCHES = ['#000000', '#ffffff', '#ef4444', '#f59e0b', '#22c55e', '#3b82f6', '#a855f7', '#ec4899']

/** Finished sticker size (longest side) a new upload starts with. */
export const DEFAULT_STICKER_SIZE_MM = 3 * MM_PER_INCH

/** Quick size buttons, longest side in inches. */
export const QUICK_SIZES_IN = [1.5, 2, 2.5, 3, 4, 5]

/**
 * AI background removal model, run in the browser (downloaded once, then cached).
 * ORMBG – Apache-2.0, free for commercial use. https://huggingface.co/d30social/ormbg-ortweb
 */
export const BG_MODEL = { id: 'd30social/ormbg-ortweb', inputPx: 1024, licence: 'Apache-2.0' }

export function cloneStickerSettings(s: StickerSettings): StickerSettings {
  return JSON.parse(JSON.stringify(s))
}

/** Where stickers may go: inside the marks, plus clearance. */
export function contentInsetMm(s: StickerSettings): number {
  const m = s.marks
  if (m.style === 'none') return s.marginMm
  const extent = m.style === 'l-corners' ? m.thicknessMm : m.sizeMm
  return s.marginMm + extent + m.clearanceMm
}

/** Problems with a settings combination, in plain English. */
export function stickerSettingsProblems(s: StickerSettings): string[] {
  const out: string[] = []
  if (s.gapMm < 2 * s.bleedMm)
    out.push(`The gap between stickers (${s.gapMm} mm) is less than twice the bleed (${s.bleedMm} mm), so printed bleed of one sticker can reach into the next one's cut line.`)
  if (!s.cut.spotName.trim()) out.push('The cut line needs a spot colour name (usually “CutContour”).')
  const inset = contentInsetMm(s)
  if (s.sheet.widthMm - 2 * inset < 20 || s.sheet.heightMm - 2 * inset < 20) out.push('Margins and marks leave almost no room for stickers on this sheet.')
  return out
}
