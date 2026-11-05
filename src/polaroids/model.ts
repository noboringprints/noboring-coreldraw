/**
 * Polaroids: photos turned into instant-film style prints (frame with a deep bottom strip for a caption),
 * ganged onto a production sheet (13 × 19 by default).
 *
 * Every polaroid is drawn by `render.ts` – the same code for the on-screen preview and for the 300 DPI print –
 * and then placed like any other rectangular piece: the sticker nesting puts them on sheets and the sticker
 * PDF export writes them, with either crop marks (guillotine) or a CutContour line + registration marks (plotter).
 *
 * "Local space" of a polaroid = its trim box [0, w] × [0, h], mm, origin top-left, y DOWN (canvas order).
 */
import { MM_PER_INCH } from '../config/defaults'
import type { EnhanceLevel } from './enhance'
import { round3 } from '../lib/geometry'
import { STICKER_SHEETS, type StickerSheet, type StickerSettings } from '../stickers/config'
import { DEFAULT_PRINTCUT_SETTINGS, loadPrintCutSettings } from '../printcut/model'

/* ------------------------------------------------------------------ formats */

export interface PolaroidFormat {
  id: string
  name: string
  /** What it's usually called / used for. */
  hint: string
  /** Finished card size. */
  widthMm: number
  heightMm: number
  /** Frame around the photo window. */
  sideMm: number
  topMm: number
  bottomMm: number
}

const IN = MM_PER_INCH

/**
 * Standard sizes. The instant-film ones follow the real film cards; the inch sizes are the usual print-shop
 * "polaroid style" prints, with a square photo and a deep caption strip.
 */
export const FORMATS: PolaroidFormat[] = [
  { id: 'classic', name: 'Classic', hint: '88 × 107 mm · Polaroid 600 / i-Type size', widthMm: 88, heightMm: 107, sideMm: 4.5, topMm: 6, bottomMm: 22 },
  { id: 'mini', name: 'Mini', hint: '54 × 86 mm · Instax Mini size', widthMm: 54, heightMm: 86, sideMm: 4, topMm: 6, bottomMm: 18 },
  { id: 'square', name: 'Square', hint: '72 × 86 mm · Instax Square size', widthMm: 72, heightMm: 86, sideMm: 5, topMm: 7, bottomMm: 17 },
  { id: 'wide', name: 'Wide', hint: '108 × 86 mm · Instax Wide size', widthMm: 108, heightMm: 86, sideMm: 4.5, topMm: 6, bottomMm: 18 },
  { id: 'go', name: 'Go', hint: '54 × 66.6 mm · Polaroid Go size', widthMm: 54, heightMm: 66.6, sideMm: 3.5, topMm: 4, bottomMm: 16.6 },
  { id: '2x3', name: '2 × 3 in', hint: '50.8 × 76.2 mm · wallet polaroid', widthMm: 2 * IN, heightMm: 3 * IN, sideMm: 4, topMm: 4, bottomMm: 18.2 },
  { id: '3x4', name: '3 × 4 in', hint: '76.2 × 101.6 mm · square photo', widthMm: 3 * IN, heightMm: 4 * IN, sideMm: 5, topMm: 5, bottomMm: 4 * IN - 5 - (3 * IN - 10) },
  { id: '3.5x4.2', name: '3.5 × 4.2 in', hint: '88.9 × 106.7 mm · classic in inches', widthMm: 3.5 * IN, heightMm: 4.2 * IN, sideMm: 5, topMm: 5, bottomMm: 4.2 * IN - 5 - (3.5 * IN - 10) },
  { id: '4x5', name: '4 × 5 in', hint: '101.6 × 127 mm · large square photo', widthMm: 4 * IN, heightMm: 5 * IN, sideMm: 6.35, topMm: 6.35, bottomMm: 5 * IN - 6.35 - (4 * IN - 12.7) },
]

export const CUSTOM_FORMAT_ID = 'custom'

export const DEFAULT_CUSTOM: Omit<PolaroidFormat, 'id' | 'name' | 'hint'> = { widthMm: 80, heightMm: 100, sideMm: 5, topMm: 5, bottomMm: 25 }

/** The format of an item, custom sizes included. */
export function formatOf(it: Pick<PolaroidItem, 'formatId' | 'custom'>): PolaroidFormat {
  if (it.formatId === CUSTOM_FORMAT_ID) {
    const c = { ...DEFAULT_CUSTOM, ...it.custom }
    return { id: CUSTOM_FORMAT_ID, name: 'Custom', hint: `${round3(c.widthMm)} × ${round3(c.heightMm)} mm`, ...c }
  }
  return FORMATS.find((f) => f.id === it.formatId) ?? FORMATS[0]
}

/** The photo window of a format, local mm (y down). */
export function photoWindow(f: PolaroidFormat): { x: number; y: number; w: number; h: number } {
  return { x: f.sideMm, y: f.topMm, w: Math.max(1, f.widthMm - 2 * f.sideMm), h: Math.max(1, f.heightMm - f.topMm - f.bottomMm) }
}

/** Problems with a custom size, in plain English. */
export function formatProblems(f: PolaroidFormat): string[] {
  const out: string[] = []
  if (f.widthMm - 2 * f.sideMm < 10) out.push('The side borders leave almost no room for the photo.')
  if (f.heightMm - f.topMm - f.bottomMm < 10) out.push('The top and bottom borders leave almost no room for the photo.')
  return out
}

/* ------------------------------------------------------------------ themes, filters, fonts */

export type ThemeId =
  | 'classic'
  | 'cream'
  | 'black'
  | 'pink'
  | 'blue'
  | 'mint'
  | 'lavender'
  | 'kraft'
  | 'sunset'
  | 'ocean'
  | 'dots'
  | 'stripes'
  | 'gingham'
  | 'hearts'
  | 'stars'
  | 'confetti'
  | 'wedding'
  | 'christmas'
  | 'film'
  | 'neon'
  | 'sunflowers'
  | 'bows'
  | 'cherries'
  | 'kisses'
  | 'tiny-hearts'
  | 'oranges'
  | 'daisies'
  | 'scallop-bows'
  | 'leopard'
  | 'gingham-lilac'
  | 'gingham-blue'
  | 'gingham-peach'

export interface ThemeInfo {
  id: ThemeId
  name: string
  group: 'Plain' | 'Colour' | 'Cute' | 'Pattern' | 'Occasion'
  /** Frame colour (the main one, for patterns the background). */
  base: string
  /** Default caption colour. */
  ink: string
  /** Default caption font. */
  font: FontId
  /** A plain frame whose colour can be changed. */
  recolorable?: boolean
}

export const THEMES: ThemeInfo[] = [
  { id: 'classic', name: 'Classic white', group: 'Plain', base: '#fbfbf8', ink: '#2b2b2b', font: 'caveat', recolorable: true },
  { id: 'cream', name: 'Vintage cream', group: 'Plain', base: '#f3ead6', ink: '#5b4632', font: 'special-elite', recolorable: true },
  { id: 'black', name: 'Midnight', group: 'Plain', base: '#151515', ink: '#f5f5f5', font: 'caveat', recolorable: true },
  { id: 'pink', name: 'Blush pink', group: 'Colour', base: '#f9d5dc', ink: '#8a2846', font: 'caveat', recolorable: true },
  { id: 'blue', name: 'Baby blue', group: 'Colour', base: '#cfe4f7', ink: '#1f4e79', font: 'caveat', recolorable: true },
  { id: 'mint', name: 'Mint', group: 'Colour', base: '#cdeedd', ink: '#1d5c43', font: 'caveat', recolorable: true },
  { id: 'lavender', name: 'Lavender', group: 'Colour', base: '#e3d9f5', ink: '#4b2d7f', font: 'caveat', recolorable: true },
  { id: 'kraft', name: 'Kraft paper', group: 'Colour', base: '#c9a57b', ink: '#3e2a17', font: 'special-elite' },
  { id: 'sunset', name: 'Sunset', group: 'Colour', base: '#ffb199', ink: '#ffffff', font: 'pacifico' },
  { id: 'ocean', name: 'Ocean', group: 'Colour', base: '#a1c4fd', ink: '#ffffff', font: 'pacifico' },
  { id: 'dots', name: 'Polka dots', group: 'Pattern', base: '#ffd6e0', ink: '#7a1f3d', font: 'caveat' },
  { id: 'stripes', name: 'Candy stripes', group: 'Pattern', base: '#ffffff', ink: '#c2185b', font: 'pacifico' },
  { id: 'gingham', name: 'Gingham', group: 'Pattern', base: '#ffffff', ink: '#b71c1c', font: 'caveat' },
  { id: 'hearts', name: 'Hearts', group: 'Occasion', base: '#fff0f3', ink: '#c2185b', font: 'dancing' },
  { id: 'stars', name: 'Starry night', group: 'Occasion', base: '#1b2140', ink: '#ffe9a8', font: 'caveat' },
  { id: 'confetti', name: 'Confetti', group: 'Occasion', base: '#ffffff', ink: '#333333', font: 'marker' },
  { id: 'wedding', name: 'Wedding gold', group: 'Occasion', base: '#fbf7ee', ink: '#a07c45', font: 'dancing' },
  { id: 'christmas', name: 'Christmas', group: 'Occasion', base: '#b3202a', ink: '#ffffff', font: 'marker' },
  { id: 'film', name: 'Film strip', group: 'Pattern', base: '#111111', ink: '#f2f2f2', font: 'special-elite' },
  { id: 'neon', name: 'Neon glow', group: 'Pattern', base: '#0d0d14', ink: '#ff4fd8', font: 'marker' },
  { id: 'sunflowers', name: 'Sunflowers', group: 'Cute', base: '#eef1d9', ink: '#5a4210', font: 'caveat' },
  { id: 'bows', name: 'Pink bows', group: 'Cute', base: '#e6a6b4', ink: '#8e2443', font: 'dancing' },
  { id: 'cherries', name: 'Cherries', group: 'Cute', base: '#fffaf3', ink: '#b3162f', font: 'caveat' },
  { id: 'kisses', name: 'Kisses', group: 'Cute', base: '#ffffff', ink: '#c8102e', font: 'dancing' },
  { id: 'tiny-hearts', name: 'Tiny hearts', group: 'Cute', base: '#ffffff', ink: '#c8102e', font: 'caveat' },
  { id: 'oranges', name: 'Oranges', group: 'Cute', base: '#fff4e3', ink: '#b85a0e', font: 'caveat' },
  { id: 'daisies', name: 'Daisies', group: 'Cute', base: '#ddd1ef', ink: '#4b2d7f', font: 'caveat' },
  { id: 'scallop-bows', name: 'Scallop bows', group: 'Cute', base: '#fffcf4', ink: '#3f66b0', font: 'dancing' },
  { id: 'leopard', name: 'Leopard', group: 'Pattern', base: '#d8b184', ink: '#2b1a0f', font: 'marker' },
  { id: 'gingham-lilac', name: 'Lilac check', group: 'Pattern', base: '#ffffff', ink: '#5b3f99', font: 'caveat' },
  { id: 'gingham-blue', name: 'Blue check', group: 'Pattern', base: '#ffffff', ink: '#2d5ea8', font: 'caveat' },
  { id: 'gingham-peach', name: 'Peach check', group: 'Pattern', base: '#ffffff', ink: '#b8561c', font: 'caveat' },
]

export const themeOf = (id: ThemeId | string): ThemeInfo => THEMES.find((t) => t.id === id) ?? THEMES[0]

export type FilterId = 'none' | 'bw' | 'noir' | 'sepia' | 'vintage' | 'warm' | 'cool' | 'fade' | 'vivid'

export const FILTERS: { id: FilterId; name: string }[] = [
  { id: 'none', name: 'Original' },
  { id: 'vivid', name: 'Vivid' },
  { id: 'warm', name: 'Warm' },
  { id: 'cool', name: 'Cool' },
  { id: 'fade', name: 'Faded' },
  { id: 'vintage', name: 'Vintage' },
  { id: 'sepia', name: 'Sepia' },
  { id: 'bw', name: 'B & W' },
  { id: 'noir', name: 'Noir' },
]

export type FontId = 'caveat' | 'marker' | 'typewriter' | 'special-elite' | 'dancing' | 'pacifico' | 'sans'

export const FONTS: { id: FontId; name: string; family: string; weight: number }[] = [
  { id: 'caveat', name: 'Handwritten', family: 'Caveat', weight: 600 },
  { id: 'marker', name: 'Marker', family: 'Permanent Marker', weight: 400 },
  { id: 'special-elite', name: 'Typewriter', family: 'Special Elite', weight: 400 },
  { id: 'dancing', name: 'Script', family: 'Dancing Script', weight: 600 },
  { id: 'pacifico', name: 'Retro', family: 'Pacifico', weight: 400 },
  { id: 'sans', name: 'Clean', family: 'Inter Variable', weight: 500 },
]

export const fontOf = (id: FontId | string) => FONTS.find((f) => f.id === id) ?? (id === 'typewriter' ? FONTS[2] : FONTS[0])

/** Quick picks for caption and frame colours. */
export const SWATCHES = ['#2b2b2b', '#ffffff', '#8a2846', '#c2185b', '#e65100', '#a07c45', '#1d5c43', '#1f4e79', '#4b2d7f', '#f9d5dc', '#cfe4f7', '#cdeedd', '#fff3c4', '#e3d9f5']

/* ------------------------------------------------------------------ items */

/**
 * Where the photo sits in its window. All in the photo's DISPLAY space (after the quarter turns and the flip):
 * `cx`, `cy` = the point of the photo shown at the window's centre, as a fraction of its width / height;
 * `zoom` 1 = the photo just covers the window, below 1 shows all of it with frame colour around.
 */
export interface PhotoCrop {
  zoom: number
  cx: number
  cy: number
  /** Clockwise quarter turns. */
  turn: 0 | 1 | 2 | 3
  flip: boolean
}

export const DEFAULT_CROP: PhotoCrop = { zoom: 1, cx: 0.5, cy: 0.5, turn: 0, flip: false }

export interface Caption {
  text: string
  font: FontId
  /** Letter height in mm (about the size of a capital letter + a bit). */
  sizeMm: number
  /** Unset = the theme's ink colour. */
  color?: string
  align: 'left' | 'center' | 'right'
}

export interface PolaroidItem {
  id: string
  name: string
  photoId: string
  formatId: string
  /** Only for the custom format. */
  custom?: Partial<Omit<PolaroidFormat, 'id' | 'name' | 'hint'>>
  copies: number
  /** On the sheet. */
  rotation: 'auto' | 0 | 90
  crop: PhotoCrop
  caption: Caption
  theme: ThemeId
  /** Unset = the theme's colour (plain themes only). */
  frameColor?: string
  filter: FilterId
  /** Makes the photo clearer when drawn – the uploaded file itself is never changed. Unset = off. */
  enhance?: EnhanceLevel
}

/** What a new photo starts with (the last choices are remembered). */
export interface NewItemDefaults {
  formatId: string
  theme: ThemeId
  filter: FilterId
  font: FontId
  enhance: EnhanceLevel
}

export const DEFAULT_NEW: NewItemDefaults = { formatId: 'classic', theme: 'classic', filter: 'none', font: 'caveat', enhance: 'off' }

export function newItem(id: string, photoId: string, name: string, d: NewItemDefaults): PolaroidItem {
  return {
    id,
    name,
    photoId,
    formatId: d.formatId,
    copies: 1,
    rotation: 'auto',
    crop: { ...DEFAULT_CROP },
    caption: { text: '', font: d.font, sizeMm: 6, align: 'center' },
    theme: d.theme,
    filter: d.filter,
    enhance: d.enhance ?? 'off',
  }
}

/* ------------------------------------------------------------------ crop maths */

export interface PhotoPlacement {
  /** Photo size after the quarter turns (original pixels). */
  rw: number
  rh: number
  /** mm per original pixel. */
  scale: number
  /** Top-left of the visible part, display pixels (may be negative when zoomed out). */
  ox: number
  oy: number
  /** The clamped crop actually used. */
  crop: PhotoCrop
}

export const MAX_ZOOM = 6

/** Smallest zoom: the whole photo visible inside the window. */
export function minZoom(pxW: number, pxH: number, turn: number, winW: number, winH: number): number {
  const [rw, rh] = turn % 2 ? [pxH, pxW] : [pxW, pxH]
  const cover = Math.max(winW / rw, winH / rh)
  const contain = Math.min(winW / rw, winH / rh)
  return contain / cover
}

/** Where the photo goes in a window of winW × winH mm – the crop clamped so the window never shows past the photo edge while zoomed in. */
export function placePhoto(crop: PhotoCrop, pxW: number, pxH: number, winW: number, winH: number): PhotoPlacement {
  const [rw, rh] = crop.turn % 2 ? [pxH, pxW] : [pxW, pxH]
  const cover = Math.max(winW / rw, winH / rh)
  const zoom = Math.min(MAX_ZOOM, Math.max(minZoom(pxW, pxH, crop.turn, winW, winH), crop.zoom || 1))
  const scale = cover * zoom
  const vw = winW / scale // visible display pixels
  const vh = winH / scale
  const clampC = (c: number, v: number, r: number) => (v >= r ? 0.5 : Math.min(1 - v / (2 * r), Math.max(v / (2 * r), c)))
  const cx = clampC(Number.isFinite(crop.cx) ? crop.cx : 0.5, vw, rw)
  const cy = clampC(Number.isFinite(crop.cy) ? crop.cy : 0.5, vh, rh)
  return { rw, rh, scale, ox: cx * rw - vw / 2, oy: cy * rh - vh / 2, crop: { ...crop, zoom, cx, cy } }
}

/** Print resolution of the photo in its window (dots per inch). */
export function photoDpi(it: PolaroidItem, pxW: number, pxH: number): number {
  const win = photoWindow(formatOf(it))
  const p = placePhoto(it.crop, pxW, pxH, win.w, win.h)
  return Math.round(MM_PER_INCH / p.scale)
}

/* ------------------------------------------------------------------ sheet settings */

/** crop = crop marks for a guillotine; printcut = CutContour line + registration marks for a plotter; none = just the prints. */
export type Finish = 'crop' | 'printcut' | 'none'

export interface PolaroidSettings {
  sheet: StickerSheet
  finish: Finish
  /** Space between neighbouring polaroids (crop marks go here). */
  gapMm: number
  /** Frame printed past the trim / cut line. */
  bleedMm: number
  /** Empty strip around the sheet edge (crop & none; print & cut uses the cutter settings). */
  marginMm: number
  /** Rounded corners (print & cut only – a guillotine cuts square corners). */
  cornerMm: number
  /** Warn when a photo prints below this. */
  minDpi: number
}

export const DEFAULT_POLAROID_SETTINGS: PolaroidSettings = {
  sheet: STICKER_SHEETS.find((s) => s.name.startsWith('13'))!,
  finish: 'crop',
  gapMm: 8,
  bleedMm: 1.5,
  marginMm: 10,
  cornerMm: 0,
  minDpi: 150,
}

/** Extra sheet sizes print shops use for polaroids. */
export const POLAROID_SHEETS: StickerSheet[] = [...STICKER_SHEETS, { name: '12 × 18 in', widthMm: 12 * IN, heightMm: 18 * IN }]

/** Crop marks (length, and how far they stay from the trim corner) – mm. */
export const CROP_MARK = { lengthMm: 5, offsetMm: 1, minMm: 1.5, lineWidthPt: 0.3 }

/**
 * The sticker engine's view of the polaroid settings. Print & cut takes the registration marks and cut colour
 * from the Print & Cut tool, so both tools always match the cutter.
 */
export function sheetSettings(p: PolaroidSettings, cutter: StickerSettings = loadPrintCutSettings()): StickerSettings {
  const base: StickerSettings = { ...DEFAULT_PRINTCUT_SETTINGS, sheet: p.sheet, gapMm: p.gapMm, bleedMm: p.bleedMm, label: false, minDpi: p.minDpi, units: 'mm' }
  if (p.finish === 'printcut') return { ...base, marginMm: cutter.marginMm, marks: { ...cutter.marks }, cut: { ...cutter.cut } }
  // crop marks need room outside the outermost polaroids
  const margin = p.finish === 'crop' ? Math.max(p.marginMm, p.bleedMm + CROP_MARK.offsetMm + CROP_MARK.lengthMm + 1) : p.marginMm
  return { ...base, marginMm: margin, marks: { ...base.marks, style: 'none', clearanceMm: 0 } }
}

export const cornerFor = (p: PolaroidSettings) => (p.finish === 'printcut' ? Math.max(0, p.cornerMm) : 0)

/** Problems with the settings, in plain English. */
export function settingsProblems(p: PolaroidSettings): string[] {
  const out: string[] = []
  if (p.gapMm < 2 * p.bleedMm) out.push(`The gap (${p.gapMm} mm) is less than twice the bleed (${p.bleedMm} mm): the bleed of one polaroid would print into the next one.`)
  if (p.finish === 'crop' && p.gapMm < 2 * p.bleedMm + 2 * (CROP_MARK.offsetMm + CROP_MARK.minMm))
    out.push('The gap is too small for crop marks between the polaroids – only the outer marks will be drawn.')
  return out
}

/* ------------------------------------------------------------------ remembered settings */

const SETTINGS_KEY = 'print-ready.polaroids.settings.v1'
const DEFAULTS_KEY = 'print-ready.polaroids.new.v1'

function loadJson<T extends object>(key: string, d: T): T {
  try {
    const raw = localStorage.getItem(key)
    if (raw) return { ...d, ...(JSON.parse(raw) as Partial<T>) }
  } catch {
    /* use the defaults */
  }
  return { ...d }
}
function saveJson(key: string, v: unknown) {
  try {
    localStorage.setItem(key, JSON.stringify(v))
  } catch {
    /* not remembered – fine */
  }
}

export const loadPolaroidSettings = () => loadJson(SETTINGS_KEY, DEFAULT_POLAROID_SETTINGS)
export const savePolaroidSettings = (s: PolaroidSettings) => saveJson(SETTINGS_KEY, s)
export const loadNewDefaults = () => loadJson(DEFAULTS_KEY, DEFAULT_NEW)
export const saveNewDefaults = (d: NewItemDefaults) => saveJson(DEFAULTS_KEY, d)

export const fmtMm = (n: number) => String(round3(n))
