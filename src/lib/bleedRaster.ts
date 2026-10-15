/**
 * Automatic bleed for vector PDFs, made from high-resolution images.
 *
 * The design itself stays vector. Only the 8 bleed strips OUTSIDE the trim (4 sides, 4 corners)
 * are pictures: the outer edge of the design is rendered at 300 DPI and mirrored (or its
 * outermost pixel row stretched) into the bleed.
 *
 * How: a small temporary PDF is made with 4 pages – the left, right, bottom and top edge bands
 * of the placed design – rendered by a Rasterizer (pdf.js in the browser, pdf.js + @napi-rs/canvas
 * in Node), then cut into strips here. The strip maths is pure and tested.
 */
import { PDFDocument, type PDFPage, type PDFRef, drawObject, popGraphicsState, pushGraphicsState, rectangle, clip, endPath } from 'pdf-lib'
import { PT_PER_MM } from '../config/defaults'
import type { ArtPlan } from './artwork'
import { type Matrix, type Rect, multiply, scale, translate } from './geometry'
import { SourceEmbedder, cm, drawPiece } from './pdfDraw'
import type { SourceFile } from './sources'

/** RGBA pixels, row 0 = top. */
export interface RGBAImage {
  width: number
  height: number
  data: Uint8Array | Uint8ClampedArray
}

/** Renders every page of a PDF at `pxPerMm`, on a white background. */
export interface Rasterizer {
  render(pdf: Uint8Array, pxPerMm: number): Promise<RGBAImage[]>
}

/** One bleed strip: RGB pixels (row 0 = top) and where it goes, in local trim-space mm. */
export interface Strip {
  name: 'left' | 'right' | 'bottom' | 'top' | 'bottom-left' | 'bottom-right' | 'top-left' | 'top-right'
  rect: Rect
  width: number
  height: number
  rgb: Uint8Array
}

/** The four edge bands of the trim box that get rendered (local mm). */
export function edgeBands(trimW: number, trimH: number, bandMm: number): { left: Rect; right: Rect; bottom: Rect; top: Rect } {
  const c = Math.min(bandMm, trimW, trimH)
  return {
    left: { x: 0, y: 0, w: c, h: trimH },
    right: { x: trimW - c, y: 0, w: c, h: trimH },
    bottom: { x: 0, y: 0, w: trimW, h: c },
    top: { x: 0, y: trimH - c, w: trimW, h: c },
  }
}

/** Builds the temporary 4-page PDF of the edge bands (vector, exactly as placed in the trim box). */
export async function buildBandPdf(src: SourceFile, pageIndex: number, plan: ArtPlan, trimW: number, trimH: number, bandMm: number): Promise<Uint8Array> {
  const doc = await PDFDocument.create()
  const embedder = new SourceEmbedder(doc)
  const d = await embedder.get(src, pageIndex)
  const bands = edgeBands(trimW, trimH, bandMm)
  for (const r of [bands.left, bands.right, bands.bottom, bands.top]) {
    const page = doc.addPage([r.w * PT_PER_MM, r.h * PT_PER_MM])
    const outer: Matrix = multiply(scale(PT_PER_MM), translate(-r.x, -r.y))
    drawPiece(page, outer, plan.main, d)
  }
  return doc.save()
}

/**
 * Cuts the 8 bleed strips out of the rendered edge bands.
 * mirror  = the outer `bleed` mm of the design, flipped across the cut line.
 * stretch = the outermost pixel row/column, repeated across the bleed.
 */
export function makeStrips(
  bands: { left: RGBAImage; right: RGBAImage; bottom: RGBAImage; top: RGBAImage },
  bandRects: ReturnType<typeof edgeBands>,
  trimW: number,
  trimH: number,
  bleed: number,
  mode: 'mirror' | 'stretch',
): Strip[] {
  const { left: L, right: R, bottom: B, top: T } = bands
  const ppmX = L.width / bandRects.left.w // pixels per mm across the side bands
  const ppmY = B.height / bandRects.bottom.h
  const nx = Math.max(1, Math.round(bleed * ppmX)) // strip thickness in pixels
  const ny = Math.max(1, Math.round(bleed * ppmY))
  const mirror = mode === 'mirror'
  const clampI = (v: number, n: number) => Math.max(0, Math.min(n - 1, v))

  /** d = distance from the cut line in pixels; returns the source index for that distance. */
  const pick = (d: number, n: number) => clampI(mirror ? d : 0, n)

  const make = (name: Strip['name'], rect: Rect, w: number, h: number, sample: (x: number, y: number) => [RGBAImage, number, number]): Strip => {
    const rgb = new Uint8Array(w * h * 3)
    for (let y = 0; y < h; y++)
      for (let x = 0; x < w; x++) {
        const [img, sx, sy] = sample(x, y)
        const si = (clampI(sy, img.height) * img.width + clampI(sx, img.width)) * 4
        const di = (y * w + x) * 3
        rgb[di] = img.data[si]
        rgb[di + 1] = img.data[si + 1]
        rgb[di + 2] = img.data[si + 2]
      }
    return { name, rect, width: w, height: h, rgb }
  }

  const b = bleed
  const W = trimW
  const H = trimH
  return [
    // sides: x/y = pixel in the strip; the cut line is at the strip's inner edge
    make('left', { x: -b, y: 0, w: b, h: H }, nx, L.height, (x, y) => [L, pick(nx - 1 - x, L.width), y]),
    make('right', { x: W, y: 0, w: b, h: H }, nx, R.height, (x, y) => [R, R.width - 1 - pick(x, R.width), y]),
    make('bottom', { x: 0, y: -b, w: W, h: b }, B.width, ny, (x, y) => [B, x, B.height - 1 - pick(y, B.height)]),
    make('top', { x: 0, y: H, w: W, h: b }, T.width, ny, (x, y) => [T, x, pick(ny - 1 - y, T.height)]),
    // corners: mirrored (or stretched) in both directions, taken from the side bands
    make('bottom-left', { x: -b, y: -b, w: b, h: b }, nx, ny, (x, y) => [L, pick(nx - 1 - x, L.width), L.height - 1 - pick(y, L.height)]),
    make('bottom-right', { x: W, y: -b, w: b, h: b }, nx, ny, (x, y) => [R, R.width - 1 - pick(x, R.width), R.height - 1 - pick(y, R.height)]),
    make('top-left', { x: -b, y: H, w: b, h: b }, nx, ny, (x, y) => [L, pick(nx - 1 - x, L.width), pick(ny - 1 - y, L.height)]),
    make('top-right', { x: W, y: H, w: b, h: b }, nx, ny, (x, y) => [R, R.width - 1 - pick(x, R.width), pick(ny - 1 - y, R.height)]),
  ]
}

const cache = new Map<string, Promise<Strip[]>>()
const CACHE_MAX = 40

/** Renders (or reuses) the bleed strips for one design page. */
export function rasterBleedStrips(
  src: SourceFile,
  pageIndex: number,
  plan: ArtPlan,
  trimW: number,
  trimH: number,
  bleed: number,
  mode: 'mirror' | 'stretch',
  dpi: number,
  rasterizer: Rasterizer,
): Promise<Strip[]> {
  const key = [src.id, pageIndex, trimW, trimH, bleed, mode, dpi, plan.main.matrix.join(','), JSON.stringify(plan.main.clip)].join('|')
  let p = cache.get(key)
  if (!p) {
    p = (async () => {
      // mirror needs the outer `bleed` mm; stretch only needs the outermost pixels
      const bandMm = mode === 'mirror' ? bleed : Math.min(bleed, 1)
      const pdf = await buildBandPdf(src, pageIndex, plan, trimW, trimH, bandMm)
      const [left, right, bottom, top] = await rasterizer.render(pdf, dpi / 25.4)
      return makeStrips({ left, right, bottom, top }, edgeBands(trimW, trimH, bandMm), trimW, trimH, bleed, mode)
    })()
    p.catch(() => cache.delete(key))
    cache.set(key, p)
    if (cache.size > CACHE_MAX) cache.delete(cache.keys().next().value!)
  }
  return p
}

/** Puts strips on the page as RGB images, clipped to the bleed box. `outer` maps local mm → page points. */
export function drawStrips(doc: PDFDocument, page: PDFPage, outer: Matrix, strips: Strip[], bleedRect: Rect) {
  const e = 0.05 // mm overlap so neighbouring strips never show a hairline gap
  page.pushOperators(pushGraphicsState(), cm(outer), rectangle(bleedRect.x, bleedRect.y, bleedRect.w, bleedRect.h), clip(), endPath())
  for (const s of strips) {
    const ref: PDFRef = doc.context.register(
      doc.context.flateStream(s.rgb, {
        Type: 'XObject',
        Subtype: 'Image',
        Width: s.width,
        Height: s.height,
        BitsPerComponent: 8,
        ColorSpace: 'DeviceRGB',
        Interpolate: false,
      }),
    )
    const name = page.node.newXObject('BleedStrip', ref)
    const r = s.rect
    page.pushOperators(pushGraphicsState(), cm([r.w + 2 * e, 0, 0, r.h + 2 * e, r.x - e, r.y - e]), drawObject(name), popGraphicsState())
  }
  page.pushOperators(popGraphicsState())
}

