/**
 * Print & Cut: finished designs of ANY size and shape (coasters, mug wraps, labels, tags…) ganged onto one sheet,
 * with bleed, a CutContour line around every piece and registration marks for the plotter.
 *
 * Unlike stickers, the design is placed at its exact finished size and the cut line is an exact vector shape
 * (rectangle, rounded rectangle or circle/oval) on its trim edge – the same rules as posters: never scaled to
 * make bleed, missing bleed is built outside the cut line.
 *
 * "Local space" of an item = its trim box [0, w] × [0, h], mm, y up.
 */
import { MM_PER_INCH } from '../config/defaults'
import { type ArtPiece, type BleedMode, type FitMode, type SourceGeometry, detectBleed, planArtwork } from '../lib/artwork'
import { type Matrix, type Rect, multiply, round3 } from '../lib/geometry'
import { type StickerSettings, STICKER_SHEETS, cloneStickerSettings } from '../stickers/config'
import { type BezierPath, ellipsePath, roundedRectPath } from '../stickers/lib/paths'

export type CutShape = 'rect' | 'rounded' | 'circle'
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
}

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

/** Sheet & cutter defaults: 13 × 19 with L-corner registration marks, 2 mm bleed, 5 mm between cut lines. */
export const DEFAULT_PRINTCUT_SETTINGS: StickerSettings = {
  sheet: STICKER_SHEETS.find((s) => s.name.startsWith('13'))!,
  marginMm: 10,
  marks: { style: 'l-corners', sizeMm: 5, lengthMm: 20, thicknessMm: 0.5, clearanceMm: 5 },
  gapMm: 5,
  bleedMm: 2,
  cut: { spotName: 'CutContour', displayColor: '#ec008c', lineWidthPt: 0.25 },
  label: true,
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
export function itemShape(it: Pick<PrintCutItem, 'widthMm' | 'heightMm' | 'shape' | 'cornerMm'>, bleedMm: number) {
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

/** Maps source → local trim mm for every piece of the item's artwork, with the chosen bleed. */
export function planItem(it: PrintCutItem, g: SourceGeometry, bleedMm: number): ItemPlan {
  const { widthMm: w, heightMm: h } = it
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
  const plan = planArtwork(g, w, h, bleedMm, it.bleedMode, it.fit)
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
  return Math.round(Math.min(g.pxW / ((g.widthMm * p.plan.scaleX) / MM_PER_INCH), g.pxH / ((g.heightMm * p.plan.scaleY) / MM_PER_INCH)))
}

/* ------------------------------------------------------------------ new items */

const near = (a: number, b: number, tol: number) => Math.abs(a - b) <= tol
const sameSize = (w: number, h: number, W: number, H: number, tol: number): 'same' | 'turned' | null =>
  near(w, W, tol) && near(h, H, tol) ? 'same' : near(w, H, tol) && near(h, W, tol) ? 'turned' : null

/** Finds the product a file size belongs to – as is, or with bleed already in the file. */
export function matchProduct(g: SourceGeometry, products: Product[], bleedMm: number): { product: Product; w: number; h: number } | null {
  const sizes: [number, number][] = []
  if (g.trimBox) sizes.push([g.trimBox.w, g.trimBox.h])
  if (g.physicalSize !== false) {
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
    const a = g.widthMm / g.heightMm
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
): PrintCutItem & { product?: string } {
  const match = matchProduct(g, products, bleedMm)
  let w: number
  let h: number
  if (match) [w, h] = [match.w, match.h]
  else if (g.trimBox) [w, h] = [round3(g.trimBox.w), round3(g.trimBox.h)]
  else [w, h] = [round3(g.widthMm), round3(g.heightMm)]
  const shape = match?.product.shape ?? 'rect'
  let bleedMode: ItemBleed = detectBleed(g, w, h, bleedMm).mode
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
    product: match?.product.name,
  }
}

/** Which bleed choices make sense for this file at this size. */
export function bleedOptions(it: PrintCutItem, g: SourceGeometry, bleedMm: number): ItemBleed[] {
  if (bleedMm <= 0) return ['none']
  const out: ItemBleed[] = []
  if (detectBleed(g, it.widthMm, it.heightMm, bleedMm).hasBleed) out.push('included')
  out.push('grow', 'mirror', 'stretch', 'none')
  return out
}

/* ------------------------------------------------------------------ saved settings & products */

const SETTINGS_KEY = 'print-ready.printcut.settings.v1'
const PRODUCTS_KEY = 'print-ready.printcut.products.v1'

export function loadPrintCutSettings(): StickerSettings {
  const d = cloneStickerSettings(DEFAULT_PRINTCUT_SETTINGS)
  try {
    const raw = localStorage.getItem(SETTINGS_KEY)
    if (!raw) return d
    const saved = JSON.parse(raw) as Partial<StickerSettings>
    return { ...d, ...saved, marks: { ...d.marks, ...saved.marks }, cut: { ...d.cut, ...saved.cut }, sheet: saved.sheet ?? d.sheet }
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
