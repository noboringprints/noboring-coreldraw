/**
 * Print & Cut: finished designs of ANY size and shape (coasters, mug wraps, labels, tags…) ganged onto one sheet,
 * with bleed, a CutContour line around every piece and registration marks for the plotter.
 *
 * Unlike stickers, the design is placed at its exact finished size and the cut line is an exact vector shape
 * (rectangle, rounded rectangle or circle/oval) on its trim edge – the same rules as posters: never scaled to
 * make bleed, missing bleed is built outside the cut line.
 * A 'contour' cut instead follows the design's own outline plus a border (white, printed colour or none),
 * like the sticker tool: the outline is traced from a picture of the design (see contourRaster).
 *
 * "Local space" of an item = its trim box [0, w] × [0, h], mm, y up.
 */
import { MM_PER_INCH } from '../config/defaults'
import { type ArtPiece, type BleedMode, type FitMode, type SourceGeometry, detectBleed, planArtwork } from '../lib/artwork'
import { type Matrix, type Rect, multiply, round3 } from '../lib/geometry'
import type { RGBAImage } from '../lib/bleedRaster'
import { type BorderStyle, type CutParams, type StickerSettings, STICKER_SHEETS, cloneStickerSettings } from '../stickers/config'
import { type CutRaster, analysisPxPerMm, borderOf } from '../stickers/lib/cutline'
import { fillHoles } from '../stickers/lib/edt'
import { type BezierPath, ellipsePath, roundedRectPath } from '../stickers/lib/paths'

export type CutShape = 'rect' | 'rounded' | 'circle' | 'contour'
/** 'grow' = an enlarged copy of the design under it, so the edge colour carries on past ANY cut shape (best for circles). */
export type ItemBleed = BleedMode | 'grow'

export const ITEM_BLEED_LABELS: Record<ItemBleed, string> = {
  included: 'File already has bleed',
  mirror: 'Mirror edges',
  stretch: 'Stretch edge pixels',
  grow: 'Extend edge (any shape)',
  none: 'None',
}

export interface PrintCutItem {
  id: string
  name: string
  sourceId: string
  pageIndex: number
  /** Finished (trim / cut) size. */
  widthMm: number
  heightMm: number
  shape: CutShape
  cornerMm: number
  bleedMode: ItemBleed
  fit: FitMode
  copies: number
  rotation: 'auto' | 0 | 90
  /**
   * Cut at the design's own edge: the part of the file (source mm, y up) that holds the design,
   * when the file has empty space around it. Unset = the whole file is the design.
   */
  crop?: Rect
  /** Contour cut only: the border between the design and the cut line (unset = DEFAULT_BORDER). */
  border?: ItemBorder
  /** Contour cut only: fills notches and gaps narrower than about twice this, so the blade makes one smooth pass (unset = 0, follow every curve). */
  smoothMm?: number
}

export interface ItemBorder {
  /** white = paper shows between design and cut, color = printed border, none = cut right on the design edge. */
  style: BorderStyle
  mm: number
  color: string
}

/** Cut right on the design edge; a border is opt-in (white / colour, `mm` wide). */
export const DEFAULT_BORDER: ItemBorder = { style: 'none', mm: 3, color: '#ffffff' }

/** A remembered product: files of this size get this name and cut shape automatically. */
export interface Product {
  id: string
  name: string
  widthMm: number
  heightMm: number
  shape: CutShape
  cornerMm: number
}

export const DEFAULT_PRODUCTS: Product[] = [
  { id: 'p-coaster-82', name: 'Round 82 mm', widthMm: 82, heightMm: 82, shape: 'circle', cornerMm: 0 },
  { id: 'p-mug-wrap', name: 'Mug wrap 250 × 84', widthMm: 250, heightMm: 84, shape: 'rect', cornerMm: 0 },
]

/** Sheet & cutter defaults: 13 × 19 with 4 corner crosshair '+' marks (7 mm, 0.8 mm thick) 6.35 mm in, 2 mm bleed, 5 mm between cut lines. */
export const DEFAULT_PRINTCUT_SETTINGS: StickerSettings = {
  sheet: STICKER_SHEETS.find((s) => s.name.startsWith('13'))!,
  marginMm: 6.35,
  marks: { style: 'crosshair', sizeMm: 7, lengthMm: 20, thicknessMm: 0.8, clearanceMm: 5 },
  gapMm: 5,
  bleedMm: 2,
  cut: { spotName: 'CutContour', displayColor: '#ec008c', lineWidthPt: 0.25 },
  label: false,
  minDpi: 200,
  units: 'mm',
}

/** File sizes within this of a product (or product + bleed) count as that product. */
export const PRODUCT_MATCH_MM = 1

/* ------------------------------------------------------------------ shapes */

const shapeCache = new Map<string, { cut: BezierPath[]; bleed: BezierPath[]; bounds: Rect }>()

/**
 * Cut line (the trim shape) and bleed outline of an item, local mm.
 * Cached by value, so the same shape is always the same array – the nesting and drawing caches key on it.
 */
export function itemShape(
  it: Pick<PrintCutItem, 'widthMm' | 'heightMm' | 'shape' | 'cornerMm'> & Partial<PrintCutItem>,
  bleedMm: number,
): { cut: BezierPath[]; bleed: BezierPath[]; bounds: Rect } {
  if (it.shape === 'contour') return getContour(it as PrintCutItem, bleedMm) ?? contourStandIn(it as PrintCutItem, bleedMm)
  const { widthMm: w, heightMm: h, shape } = it
  const r = shape === 'rounded' ? Math.max(0, it.cornerMm) : 0
  const key = `${shape}|${w}|${h}|${r}|${bleedMm}`
  let hit = shapeCache.get(key)
  if (!hit) {
    const b = Math.max(0, bleedMm)
    const make = (grow: number) =>
      shape === 'circle' ? ellipsePath(w / 2, h / 2, w / 2 + grow, h / 2 + grow) : roundedRectPath(-grow, -grow, w + 2 * grow, h + 2 * grow, r > 0 ? r + grow : 0)
    hit = { cut: [make(0)], bleed: [make(b)], bounds: { x: 0, y: 0, w, h } }
    shapeCache.set(key, hit)
    if (shapeCache.size > 500) shapeCache.delete(shapeCache.keys().next().value!)
  }
  return hit
}

/* ------------------------------------------------------------------ contour cut */

export const contourParams = (it: Pick<PrintCutItem, 'border' | 'smoothMm'>): CutParams => {
  const b = it.border ?? DEFAULT_BORDER
  return { shape: 'contour', border: b.style, borderMm: b.mm, borderColor: b.color, cornerMm: 0, smoothMm: Math.max(0, it.smoothMm ?? 0) }
}

/** A traced contour cut, in the item's local mm (the design's box is [0, w] × [0, h]). */
export interface ContourGeometry {
  cut: BezierPath[]
  bleed: BezierPath[]
  bounds: Rect
  /** Edge colours carried past the cut (border 'none'). */
  bleedImage?: { png: Uint8Array; rect: Rect }
  /** The design with its empty background taken away – printed for 'color' / 'none' borders. */
  art: { png: Uint8Array; rect: Rect }
  pieces: number
  warnings: string[]
}

/** Everything the traced outline depends on. */
export const contourKey = (it: PrintCutItem, bleedMm: number) =>
  ['contour', it.sourceId, it.pageIndex, it.widthMm, it.heightMm, it.fit, JSON.stringify(it.crop ?? null), JSON.stringify(it.border ?? DEFAULT_BORDER), it.smoothMm ?? 0, bleedMm].join('|')

const contours = new Map<string, ContourGeometry>()
export const getContour = (it: PrintCutItem, bleedMm: number) => contours.get(contourKey(it, bleedMm))
export function setContour(key: string, g: ContourGeometry) {
  contours.set(key, g)
  if (contours.size > 200) contours.delete(contours.keys().next().value!)
}

const standIns = new Map<string, { cut: BezierPath[]; bleed: BezierPath[]; bounds: Rect }>()
/** Until the outline is traced: the design's box plus the border, so the layout is close already. */
function contourStandIn(it: PrintCutItem, bleedMm: number) {
  const g = borderOf(contourParams(it))
  const key = `${it.widthMm}|${it.heightMm}|${g}|${bleedMm}`
  let hit = standIns.get(key)
  if (!hit) {
    const b = Math.max(0, bleedMm)
    const make = (grow: number) => roundedRectPath(-g - grow, -g - grow, it.widthMm + 2 * (g + grow), it.heightMm + 2 * (g + grow), g + grow)
    hit = { cut: [make(0)], bleed: [make(b)], bounds: { x: -g, y: -g, w: it.widthMm + 2 * g, h: it.heightMm + 2 * g } }
    standIns.set(key, hit)
  }
  return hit
}

/** Empty space rendered around the design for tracing: room for the border, smoothing and bleed. */
export const contourPadMm = (it: PrintCutItem, bleedMm: number) => borderOf(contourParams(it)) + Math.max(it.smoothMm ?? 0, bleedMm) + 1

/** Tracing / printing resolution: about 300 DPI (12 px/mm), less for very big pieces. */
export const contourPxPerMm = (it: PrintCutItem, bleedMm: number) => {
  const P = contourPadMm(it, bleedMm)
  return analysisPxPerMm(it.widthMm + 2 * P, it.heightMm + 2 * P, 6_000_000)
}

/**
 * The design rendered on white with the pad around it (`contourPadMm`) → a raster for computeCut.
 * Everything that isn't white counts as design; white areas enclosed by the design stay part of it
 * (printed white, not cut out). Pale creams and pinks count, anti-aliasing haze doesn't.
 */
export function contourRaster(img: RGBAImage, it: PrintCutItem, bleedMm: number): CutRaster {
  const { width: w, height: h, data } = img
  const n = w * h
  const ink = new Uint8Array(n)
  for (let i = 0; i < n; i++) ink[i] = data[i * 4 + 3] > 32 && 765 - data[i * 4] - data[i * 4 + 1] - data[i * 4 + 2] > 24 ? 1 : 0
  const solid = fillHoles(ink, w, h)
  const rgba = new Uint8ClampedArray(n * 4)
  for (let i = 0; i < n; i++) {
    if (!solid[i]) continue
    rgba[i * 4] = data[i * 4]
    rgba[i * 4 + 1] = data[i * 4 + 1]
    rgba[i * 4 + 2] = data[i * 4 + 2]
    rgba[i * 4 + 3] = 255
  }
  const P = contourPadMm(it, bleedMm)
  return { rgba, w, h, pxPerMm: w / (it.widthMm + 2 * P), originX: -P, originTopY: it.heightMm + P }
}

/* ------------------------------------------------------------------ artwork */

export interface ItemPlan {
  /** The design, clipped to its trim (or the file's own bleed). */
  main: ArtPiece
  /** Drawn first, under the design: mirrored/stretched strips or the enlarged copy. */
  under: ArtPiece[]
  /** Clip the design to the cut shape (so the enlarged copy shows in the bleed all round). */
  clipMainToCut: boolean
  /** Bleed strips for PDFs are best made as 300 DPI images (mirror / stretch). */
  rasterStrips: 'mirror' | 'stretch' | null
  plan: ReturnType<typeof planArtwork>
  warnings: string[]
}

/** The file as the item sees it: with a crop, only the design part counts (exactly like a PDF trim box). */
export const itemGeometry = (it: Pick<PrintCutItem, 'crop'>, g: SourceGeometry): SourceGeometry => (it.crop ? { ...g, trimBox: it.crop } : g)

/** Maps source → local trim mm for every piece of the item's artwork, with the chosen bleed. */
export function planItem(it: PrintCutItem, file: SourceGeometry, bleedMm: number): ItemPlan {
  const { widthMm: w, heightMm: h } = it
  const g = itemGeometry(it, file)
  if (it.shape === 'contour') {
    // the border (or the traced edge colours) is what goes past the cut – the design itself is placed as is
    const plan = planArtwork(g, w, h, 0, 'none', it.fit)
    return { main: plan.main, under: [], clipMainToCut: false, rasterStrips: null, plan, warnings: plan.warnings }
  }
  if (it.bleedMode === 'grow') {
    const plan = planArtwork(g, w, h, 0, 'none', it.fit)
    const under: ArtPiece[] = []
    if (bleedMm > 0) {
      // the design enlarged about its centre so its outer edge lands on the bleed outline
      const sx = (w + 2 * bleedMm) / w
      const sy = (h + 2 * bleedMm) / h
      const grow: Matrix = [sx, 0, 0, sy, (w / 2) * (1 - sx), (h / 2) * (1 - sy)]
      under.push({ clip: { x: -bleedMm, y: -bleedMm, w: w + 2 * bleedMm, h: h + 2 * bleedMm }, matrix: multiply(grow, plan.main.matrix) })
    }
    const warnings = [...plan.warnings]
    if (bleedMm > 0) warnings.push('Bleed is made from a slightly enlarged copy of the design under it (outside the cut line only).')
    return { main: plan.main, under, clipMainToCut: bleedMm > 0, rasterStrips: null, plan, warnings }
  }
  // the empty space around a cropped design is not bleed
  const plan = planArtwork(g, w, h, bleedMm, it.crop && it.bleedMode === 'included' ? 'mirror' : it.bleedMode, it.fit)
  const auto = (it.bleedMode === 'mirror' || it.bleedMode === 'stretch') && bleedMm > 0
  const warnings = [...plan.warnings]
  if (auto && it.shape === 'circle')
    warnings.push('Mirrored edges suit rectangles. For a round design “Extend edge” gives an even bleed all the way round.')
  return {
    main: plan.main,
    under: plan.bleedPieces,
    clipMainToCut: false,
    rasterStrips: auto && g.kind === 'pdf' ? (it.bleedMode as 'mirror' | 'stretch') : null,
    plan,
    warnings,
  }
}

/** Print resolution of an image item (lower of the two directions), or null for PDFs. */
export function itemDpi(g: SourceGeometry, p: ItemPlan): number | null {
  if (g.kind !== 'image' || !g.pxW || !g.pxH) return null
  // pixels per source mm are the same everywhere in the file, cropped or not
  return Math.round(Math.min(g.pxW / ((g.widthMm * p.plan.scaleX) / MM_PER_INCH), g.pxH / ((g.heightMm * p.plan.scaleY) / MM_PER_INCH)))
}

/* ------------------------------------------------------------------ the design's own edge */

/** Where the design sits inside its file, when there is empty space around it. */
export interface ContentInfo {
  /** Source mm, y up (like a PDF trim box). */
  rect: Rect
  /** The design is round / oval (its bounding box corners are empty). */
  ellipse: boolean
}

/** Margins smaller than this are not worth cropping. */
export const CONTENT_MIN_MARGIN_MM = 0.5
/** The cut goes this far inside the found edge, so no sliver of paper shows at the cut. */
export const CONTENT_INSET_MM = 0.1

/**
 * Finds the design in a picture of the whole file (rendered on white): everything that isn't white or
 * transparent. Returns null when the design already fills the file.
 */
export function findContent(img: { width: number; height: number; data: Uint8Array | Uint8ClampedArray }, widthMm: number, heightMm: number): ContentInfo | null {
  const { width: W, height: H, data } = img
  // ink = noticeably different from white (pale creams and pinks count, anti-aliasing haze doesn't)
  const ink = (x: number, y: number) => {
    const i = (y * W + x) * 4
    return data[i + 3] > 32 && 765 - data[i] - data[i + 1] - data[i + 2] > 24
  }
  let x0 = W
  let x1 = -1
  let y0 = H
  let y1 = -1
  for (let y = 0; y < H; y++)
    for (let x = 0; x < W; x++)
      if (ink(x, y)) {
        if (x < x0) x0 = x
        if (x > x1) x1 = x
        if (y < y0) y0 = y
        y1 = y
      }
  if (x1 < 0) return null
  const kx = W / widthMm // px per mm
  const ky = H / heightMm
  const margin = Math.max(x0 / kx, (W - 1 - x1) / kx, y0 / ky, (H - 1 - y1) / ky)
  if (margin < CONTENT_MIN_MARGIN_MM) return null

  // round? – almost nothing in the corners outside the ellipse that fits the box
  const cx = (x0 + x1 + 1) / 2
  const cy = (y0 + y1 + 1) / 2
  const rx = (x1 + 1 - x0) / 2
  const ry = (y1 + 1 - y0) / 2
  let outside = 0
  let filled = 0
  for (let y = y0; y <= y1; y++)
    for (let x = x0; x <= x1; x++) {
      const d = ((x + 0.5 - cx) / rx) ** 2 + ((y + 0.5 - cy) / ry) ** 2
      if (d <= 1.06) continue
      outside++
      if (ink(x, y)) filled++
    }
  const ellipse = outside > 20 && filled / outside < 0.03

  const t = CONTENT_INSET_MM
  const rect: Rect = {
    x: round3(x0 / kx + t),
    y: round3((H - 1 - y1) / ky + t),
    w: round3((x1 + 1 - x0) / kx - 2 * t),
    h: round3((y1 + 1 - y0) / ky - 2 * t),
  }
  return { rect, ellipse }
}

/* ------------------------------------------------------------------ new items */

const near = (a: number, b: number, tol: number) => Math.abs(a - b) <= tol
const sameSize = (w: number, h: number, W: number, H: number, tol: number): 'same' | 'turned' | null =>
  near(w, W, tol) && near(h, H, tol) ? 'same' : near(w, H, tol) && near(h, W, tol) ? 'turned' : null

/** Finds the product a file size belongs to – as is, or with bleed already in the file. */
export function matchProduct(g: SourceGeometry, products: Product[], bleedMm: number): { product: Product; w: number; h: number } | null {
  const sizes: [number, number][] = []
  if (g.trimBox && g.physicalSize !== false) sizes.push([g.trimBox.w, g.trimBox.h])
  if (g.physicalSize !== false && !g.trimBox) {
    sizes.push([g.widthMm, g.heightMm])
    if (bleedMm > 0) sizes.push([g.widthMm - 2 * bleedMm, g.heightMm - 2 * bleedMm])
  }
  for (const [w, h] of sizes)
    for (const product of products) {
      const m = sameSize(w, h, product.widthMm, product.heightMm, PRODUCT_MATCH_MM)
      // keep the file's own exact size (never rescale for a rounding difference), in the file's orientation
      if (m) return { product, w: round3(w), h: round3(h) }
    }
  if (g.physicalSize === false) {
    // an image with no real size: its proportions (within 1 %) say which product it is
    const a = g.trimBox ? g.trimBox.w / g.trimBox.h : g.widthMm / g.heightMm
    for (const product of products) {
      const pa = product.widthMm / product.heightMm
      if (Math.abs(a / pa - 1) <= 0.01) return { product, w: product.widthMm, h: product.heightMm }
      if (Math.abs(a * pa - 1) <= 0.01) return { product, w: product.heightMm, h: product.widthMm }
    }
  }
  return null
}

/** Good starting settings for one page of an uploaded file. */
export function newItemFor(
  id: string,
  name: string,
  sourceId: string,
  pageIndex: number,
  g: SourceGeometry,
  products: Product[],
  bleedMm: number,
  content?: ContentInfo | null,
): PrintCutItem & { product?: string } {
  const crop = content && !g.trimBox ? content.rect : undefined
  g = itemGeometry({ crop }, g)
  const match = matchProduct(g, products, bleedMm)
  let w: number
  let h: number
  if (match) [w, h] = [match.w, match.h]
  else if (g.trimBox) [w, h] = [round3(g.trimBox.w), round3(g.trimBox.h)]
  else[w, h] = [round3(g.widthMm), round3(g.heightMm)]
  // a design with empty space around it is cut on its own outline
  const shape: CutShape = match?.product.shape ?? (content ? 'contour' : 'rect')
  let bleedMode: ItemBleed = crop ? 'mirror' : detectBleed(g, w, h, bleedMm).mode
  if (bleedMode !== 'included' && bleedMm > 0 && shape !== 'rect') bleedMode = 'grow'
  return {
    id,
    name,
    sourceId,
    pageIndex,
    widthMm: w,
    heightMm: h,
    shape,
    cornerMm: match?.product.cornerMm ?? 3,
    bleedMode,
    fit: 'fit',
    copies: 1,
    rotation: 'auto',
    ...(crop ? { crop } : {}),
    product: match?.product.name,
  }
}

/** Which bleed choices make sense for this file at this size. */
export function bleedOptions(it: PrintCutItem, g: SourceGeometry, bleedMm: number): ItemBleed[] {
  if (bleedMm <= 0) return ['none']
  const out: ItemBleed[] = []
  if (!it.crop && detectBleed(g, it.widthMm, it.heightMm, bleedMm).hasBleed) out.push('included')
  out.push('grow', 'mirror', 'stretch', 'none')
  return out
}

/* ------------------------------------------------------------------ saved settings & products */

const SETTINGS_KEY = 'print-ready.printcut.settings.v2'
const OLD_SETTINGS_KEY = 'print-ready.printcut.settings.v1'
const PRODUCTS_KEY = 'print-ready.printcut.products.v1'

export function loadPrintCutSettings(): StickerSettings {
  const d = cloneStickerSettings(DEFAULT_PRINTCUT_SETTINGS)
  try {
    const raw = localStorage.getItem(SETTINGS_KEY)
    if (raw) {
      const saved = JSON.parse(raw) as Partial<StickerSettings>
      return { ...d, ...saved, marks: { ...d.marks, ...saved.marks }, cut: { ...d.cut, ...saved.cut }, sheet: saved.sheet ?? d.sheet }
    }
    const oldRaw = localStorage.getItem(OLD_SETTINGS_KEY)
    if (oldRaw) {
      const saved = JSON.parse(oldRaw) as Partial<StickerSettings>
      const migrated: StickerSettings = {
        ...d,
        ...saved,
        marks: { ...d.marks },
        marginMm: d.marginMm,
        cut: { ...d.cut, ...saved.cut },
        sheet: saved.sheet ?? d.sheet,
      }
      savePrintCutSettings(migrated)
      return migrated
    }
    return d
  } catch {
    return d
  }
}

export function savePrintCutSettings(s: StickerSettings) {
  try {
    localStorage.setItem(SETTINGS_KEY, JSON.stringify(s))
  } catch {
    /* storage unavailable – settings just won't be remembered */
  }
}

export function loadProducts(): Product[] {
  try {
    const raw = localStorage.getItem(PRODUCTS_KEY)
    if (raw) return JSON.parse(raw) as Product[]
  } catch {
    /* fall through to the defaults */
  }
  return DEFAULT_PRODUCTS.map((p) => ({ ...p }))
}

export function saveProducts(p: Product[]) {
  try {
    localStorage.setItem(PRODUCTS_KEY, JSON.stringify(p))
  } catch {
    /* not remembered – fine */
  }
}

export const fmtSize = (w: number, h: number) => `${round3(w)} × ${round3(h)} mm`
