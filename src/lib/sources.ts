/**
 * Reads uploaded files (PDF / PNG / JPG) and works out their size.
 * Uses pdf-lib only, so it runs both in the browser and in Node (tests, sample script).
 */
import { PDFDocument, PDFArray, PDFNumber, type PDFPage } from 'pdf-lib'
import { PT_PER_MM } from '../config/defaults'
import type { Matrix, Rect } from './geometry'
import { multiply, ptToMm, round3, scale } from './geometry'
import type { SourceGeometry } from './artwork'

export type SourceKind = 'pdf' | 'png' | 'jpg'

export interface SourcePageInfo {
  index: number
  geometry: SourceGeometry
  /** Rotation set on the PDF page (/Rotate), clockwise degrees. */
  pdfRotate: 0 | 90 | 180 | 270
  /** The region embedded from the PDF page, in PDF points, unrotated (left, bottom, right, top). */
  pdfBox?: { left: number; bottom: number; right: number; top: number }
}

export interface SourceFile {
  id: string
  name: string
  kind: SourceKind
  bytes: Uint8Array
  pages: SourcePageInfo[]
}

/** Nominal resolution used to give images a physical size for display. Only proportions matter for layout. */
export const NOMINAL_IMAGE_DPI = 300

export function kindFromName(name: string, bytes: Uint8Array): SourceKind | null {
  if (bytes[0] === 0x25 && bytes[1] === 0x50 && bytes[2] === 0x44 && bytes[3] === 0x46) return 'pdf' // %PDF
  if (bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47) return 'png'
  if (bytes[0] === 0xff && bytes[1] === 0xd8) return 'jpg'
  const ext = name.toLowerCase().split('.').pop()
  if (ext === 'pdf') return 'pdf'
  if (ext === 'png') return 'png'
  if (ext === 'jpg' || ext === 'jpeg') return 'jpg'
  return null
}

/** Pixel size of a PNG (from its IHDR header). */
export function pngSize(b: Uint8Array): { w: number; h: number } {
  const dv = new DataView(b.buffer, b.byteOffset, b.byteLength)
  return { w: dv.getUint32(16), h: dv.getUint32(20) }
}

/** Resolution stored in a PNG (pHYs chunk), if any. */
export function pngDpi(b: Uint8Array): { x: number; y: number } | null {
  const dv = new DataView(b.buffer, b.byteOffset, b.byteLength)
  let i = 8
  while (i + 8 <= b.length) {
    const len = dv.getUint32(i)
    const type = String.fromCharCode(b[i + 4], b[i + 5], b[i + 6], b[i + 7])
    if (type === 'pHYs' && len >= 9) {
      const unit = b[i + 16]
      if (unit !== 1) return null // 0 = proportions only, no real size
      return { x: dv.getUint32(i + 8) * 0.0254, y: dv.getUint32(i + 12) * 0.0254 }
    }
    if (type === 'IDAT' || type === 'IEND') return null
    i += 12 + len
  }
  return null
}

/** Resolution stored in a JPEG (JFIF header), if any. */
export function jpgDpi(b: Uint8Array): { x: number; y: number } | null {
  // APP0 'JFIF' segment right after the start marker
  if (b[2] === 0xff && b[3] === 0xe0 && b[6] === 0x4a && b[7] === 0x46 && b[8] === 0x49 && b[9] === 0x46) {
    const unit = b[13]
    const x = (b[14] << 8) | b[15]
    const y = (b[16] << 8) | b[17]
    if (!x || !y) return null
    if (unit === 1) return { x, y }
    if (unit === 2) return { x: x * 2.54, y: y * 2.54 }
  }
  return null
}

/** Pixel size of a JPEG (from its SOF marker). */
export function jpgSize(b: Uint8Array): { w: number; h: number } {
  let i = 2
  while (i < b.length) {
    if (b[i] !== 0xff) {
      i++
      continue
    }
    const marker = b[i + 1]
    const len = (b[i + 2] << 8) | b[i + 3]
    // SOF0..SOF15 except DHT(C4), JPG(C8), DAC(CC)
    if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
      return { h: (b[i + 5] << 8) | b[i + 6], w: (b[i + 7] << 8) | b[i + 8] }
    }
    i += 2 + len
  }
  throw new Error('Could not read JPEG size')
}

function boxOf(arr: PDFArray | undefined): { left: number; bottom: number; right: number; top: number } | undefined {
  if (!arr || arr.size() !== 4) return undefined
  const n = [0, 1, 2, 3].map((i) => (arr.lookup(i) as PDFNumber).asNumber())
  return { left: Math.min(n[0], n[2]), bottom: Math.min(n[1], n[3]), right: Math.max(n[0], n[2]), top: Math.max(n[1], n[3]) }
}

type Box = { left: number; bottom: number; right: number; top: number }

/** Converts an unrotated PDF rectangle (pt) inside `outer` into displayed mm coordinates relative to `outer`. */
function toDisplayedMm(r: Box, outer: Box, rot: 0 | 90 | 180 | 270): Rect {
  const W = outer.right - outer.left
  const H = outer.top - outer.bottom
  const u1 = r.left - outer.left
  const u2 = r.right - outer.left
  const v1 = r.bottom - outer.bottom
  const v2 = r.top - outer.bottom
  let x1: number, x2: number, y1: number, y2: number
  switch (rot) {
    case 0:
      ;[x1, x2, y1, y2] = [u1, u2, v1, v2]
      break
    case 90: // displayed (x,y) = (v, W-u)
      ;[x1, x2, y1, y2] = [v1, v2, W - u2, W - u1]
      break
    case 180:
      ;[x1, x2, y1, y2] = [W - u2, W - u1, H - v2, H - v1]
      break
    case 270: // displayed (x,y) = (H-v, u)
      ;[x1, x2, y1, y2] = [H - v2, H - v1, u1, u2]
      break
  }
  return { x: ptToMm(x1), y: ptToMm(y1), w: ptToMm(x2 - x1), h: ptToMm(y2 - y1) }
}

function pageInfo(page: PDFPage, index: number): SourcePageInfo {
  const node = page.node
  const media = boxOf(node.MediaBox())!
  const bleed = boxOf(node.BleedBox())
  const trim = boxOf(node.TrimBox())
  const angle = ((((page.getRotation().angle % 360) + 360) % 360) as 0 | 90 | 180 | 270)
  // What we embed: the BleedBox if the file defines one, else the whole MediaBox.
  const clampTo = (b: Box, o: Box): Box => ({
    left: Math.max(b.left, o.left),
    bottom: Math.max(b.bottom, o.bottom),
    right: Math.min(b.right, o.right),
    top: Math.min(b.top, o.top),
  })
  const outer = bleed ? clampTo(bleed, media) : media
  const W = outer.right - outer.left
  const H = outer.top - outer.bottom
  const sideways = angle === 90 || angle === 270
  const geometry: SourceGeometry = {
    kind: 'pdf',
    physicalSize: true,
    widthMm: ptToMm(sideways ? H : W),
    heightMm: ptToMm(sideways ? W : H),
  }
  if (trim) {
    const t = clampTo(trim, outer)
    const tw = t.right - t.left
    const th = t.top - t.bottom
    // only meaningful if the trim box is smaller than what we embed
    if (tw > 0 && th > 0 && (W - tw > 0.5 || H - th > 0.5)) {
      const r = toDisplayedMm(t, outer, angle)
      geometry.trimBox = { x: round3(r.x), y: round3(r.y), w: round3(r.w), h: round3(r.h) }
    }
  }
  return { index, geometry, pdfRotate: angle, pdfBox: outer }
}

/** Maps an embedded (unrotated) PDF page, in points from its box corner, to displayed millimetres. */
export function pdfPageToDisplayedMm(info: SourcePageInfo): Matrix {
  const b = info.pdfBox!
  const W = b.right - b.left
  const H = b.top - b.bottom
  let rot: Matrix
  switch (info.pdfRotate) {
    case 0:
      rot = [1, 0, 0, 1, 0, 0]
      break
    case 90: // shown turned clockwise: (x,y) = (v, W-u)
      rot = [0, -1, 1, 0, 0, W]
      break
    case 180:
      rot = [-1, 0, 0, -1, W, H]
      break
    case 270: // (x,y) = (H-v, u)
      rot = [0, 1, -1, 0, H, 0]
      break
  }
  return multiply(scale(1 / PT_PER_MM), rot)
}

let idCounter = 0
export const newId = (prefix = 'id') => `${prefix}${Date.now().toString(36)}${(idCounter++).toString(36)}`

/** Reads a file and returns its pages with sizes. Throws a readable error for bad files. */
export async function readSource(name: string, bytes: Uint8Array, id = newId('src')): Promise<SourceFile> {
  const kind = kindFromName(name, bytes)
  if (!kind) throw new Error(`"${name}" is not a PDF, PNG or JPG file.`)
  if (kind === 'pdf') {
    let doc: PDFDocument
    try {
      doc = await PDFDocument.load(bytes, { ignoreEncryption: true, updateMetadata: false })
    } catch (e) {
      throw new Error(`"${name}" could not be opened as a PDF (${(e as Error).message}).`)
    }
    const pages = doc.getPages().map((p, i) => pageInfo(p, i))
    if (!pages.length) throw new Error(`"${name}" has no pages.`)
    return { id, name, kind, bytes, pages }
  }
  const { w, h } = kind === 'png' ? pngSize(bytes) : jpgSize(bytes)
  const dpi = kind === 'png' ? pngDpi(bytes) : jpgDpi(bytes)
  // Images only have a real size when they store a sensible DPI; otherwise use a nominal 300 DPI for display.
  const real = dpi && dpi.x >= 30 && dpi.y >= 30 && dpi.x <= 5000 && dpi.y <= 5000 ? dpi : null
  const geometry: SourceGeometry = {
    kind: 'image',
    widthMm: (w * 25.4) / (real ? real.x : NOMINAL_IMAGE_DPI),
    heightMm: (h * 25.4) / (real ? real.y : NOMINAL_IMAGE_DPI),
    pxW: w,
    pxH: h,
    physicalSize: !!real,
  }
  return { id, name, kind, bytes, pages: [{ index: 0, pdfRotate: 0, geometry }] }
}
