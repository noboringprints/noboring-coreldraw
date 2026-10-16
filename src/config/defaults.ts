/**
 * ALL PRINT SETTINGS LIVE HERE.
 *
 * These are the defaults the app starts with (and what "Reset to defaults"
 * goes back to). Every value can also be changed in the app's Settings screen.
 *
 * Values were NOT measured from a printer sample yet (no file was in
 * /print-reference/ when this was written). Confirm them with the printer.
 * All lengths are in millimetres unless the name says otherwise.
 */

export type MarkColor = 'registration' | 'black'

export interface SheetSize {
  name: string
  widthMm: number
  heightMm: number
}

export interface PrintSettings {
  /** The physical sheet that goes into the printer. PDF page = exactly this size. */
  sheet: SheetSize
  /** How far the design extends past the cut line, on every side. */
  bleedMm: number
  marks: {
    /** Length of each crop mark line. */
    lengthMm: number
    /** Gap between the cut line (trim corner) and the start of the mark. */
    offsetMm: number
    /** Line thickness in PDF points (0.25 pt ≈ 0.088 mm). */
    lineWidthPt: number
    /** 'registration' prints on every plate (C+M+Y+K); 'black' is 100% K only. */
    color: MarkColor
    /** Shortest piece of crop mark worth printing when space is tight. */
    minLengthMm: number
  }
  /**
   * Minimum blank space between the sheet edge and the artwork (incl. bleed).
   * Crop marks and the sheet label are allowed inside this margin, but never
   * closer to the edge than `minEdgeMm`.
   */
  marginMm: number
  /** Nothing at all (marks, label) is printed closer than this to the sheet edge. */
  minEdgeMm: number
  /** Extra space between neighbouring copies, measured bleed edge to bleed edge. 0 = bleeds touch. */
  gutterMm: number
  label: {
    enabled: boolean
    fontSizePt: number
  }
  /** Warn when a photo/image would print below this resolution. */
  minDpi: number
  /** Shown in the preview: keep text and important content at least this far inside the cut line. */
  safeZoneMm: number
  /**
   * How automatic bleed is made for vector PDFs:
   * 'image'  = only the bleed strips are rendered as images (at bleedStripDpi); the design itself stays vector.
   * 'vector' = the bleed strips are mirrored vector copies of the design (no rasterising at all, but heavier for the RIP).
   */
  bleedStrips: 'image' | 'vector'
  bleedStripDpi: number
}

export const MM_PER_INCH = 25.4
/** 1 mm in PDF points (1 pt = 1/72 inch). 72 / 25.4 = 2.834645669… */
export const PT_PER_MM = 72 / MM_PER_INCH

export const SHEETS: SheetSize[] = [
  { name: '13 × 19 in', widthMm: 13 * MM_PER_INCH, heightMm: 19 * MM_PER_INCH }, // 330.2 × 482.6
  { name: 'A3', widthMm: 297, heightMm: 420 },
]

export interface TrimSize {
  name: string
  widthMm: number
  heightMm: number
}

export const TRIM_SIZES: TrimSize[] = [
  { name: 'A3', widthMm: 297, heightMm: 420 },
  { name: 'A4', widthMm: 210, heightMm: 297 },
  { name: 'A5', widthMm: 148, heightMm: 210 },
]

/**
 * Defaults: the classic 3 mm bleed setup. Every design gets 3 mm of bleed on ALL four sides
 * (and the corners): the file's own bleed when it has it, otherwise mirrored from its edges.
 * The design itself is never scaled. Crop marks start 3 mm from the trim corner – just outside
 * the bleed, so they never touch the artwork – and are 5 mm long. Copies sit bleed to bleed.
 * Set the bleed to 0 in Settings to print a design exactly as it is (e.g. split posters).
 */
export const DEFAULT_SETTINGS: PrintSettings = {
  sheet: SHEETS[0],
  bleedMm: 3,
  marks: {
    lengthMm: 5,
    offsetMm: 3,
    lineWidthPt: 0.25,
    color: 'registration',
    minLengthMm: 2,
  },
  marginMm: 10,
  minEdgeMm: 3,
  gutterMm: 0,
  label: { enabled: true, fontSizePt: 6 },
  minDpi: 200,
  safeZoneMm: 5,
  bleedStrips: 'image',
  bleedStripDpi: 300,
}

/** Tolerance used to recognise standard sizes (A3/A4/A5) for display. */
export const SIZE_MATCH_TOLERANCE_MM = 1
/** A file only counts as "already has bleed" if every side is within this of trim + bleed. */
export const BLEED_MATCH_TOLERANCE_MM = 0.5

export function cloneSettings(s: PrintSettings): PrintSettings {
  return JSON.parse(JSON.stringify(s))
}
