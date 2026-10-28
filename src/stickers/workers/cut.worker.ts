/// <reference lib="webworker" />
/** Cut-line worker: keeps each artwork decoded and computes cut lines + bleed off the main thread. */
import type { CutParams } from '../config'
import { type CutGeometry, type CutRaster, computeCut, cutFrame } from '../lib/cutline'
import { type ArtKind, bitmapPixels, decodeBitmap, encodePng } from '../lib/imaging'
import { type BackgroundGuess, guessBackground, hasTransparency, opaqueBounds } from '../lib/matte'
import { serve } from './rpc'

export interface ArtInfo {
  pxW: number
  pxH: number
  /** Visible part of the image (pixels, top-left origin). */
  bbox: { x: number; y: number; w: number; h: number }
  transparent: boolean
  background: BackgroundGuess
}

export interface CutRequest {
  key: string
  artW: number
  artH: number
  params: CutParams
  bleedMm: number
}

export type CutResult = Omit<CutGeometry, 'bleedImage'> & { bleedImage?: { png: Uint8Array; rect: CutGeometry['bounds'] } }

const arts = new Map<string, { bitmap: ImageBitmap; info: ArtInfo }>()

/** Analysis happens on at most this many pixels (bigger photos are scaled down for it). */
const ANALYSIS_MAX_SIDE = 4096

serve({
  async load({ key, bytes, kind }: { key: string; bytes: Uint8Array; kind: ArtKind }) {
    const bitmap = await decodeBitmap(bytes, kind)
    const px = bitmapPixels(bitmap, ANALYSIS_MAX_SIDE)
    const k = bitmap.width / px.w
    const b = opaqueBounds(px)
    if (!b) throw new Error('This image is completely transparent.')
    // scale the box back to full-resolution pixels (rounded outward)
    const x0 = Math.max(0, Math.floor(b.x * k))
    const y0 = Math.max(0, Math.floor(b.y * k))
    const x1 = Math.min(bitmap.width, Math.ceil((b.x + b.w) * k))
    const y1 = Math.min(bitmap.height, Math.ceil((b.y + b.h) * k))
    const info: ArtInfo = {
      pxW: bitmap.width,
      pxH: bitmap.height,
      bbox: { x: x0, y: y0, w: x1 - x0, h: y1 - y0 },
      transparent: hasTransparency(px),
      background: guessBackground(px),
    }
    arts.get(key)?.bitmap.close()
    arts.set(key, { bitmap, info })
    return { result: info }
  },

  async forget({ key }: { key: string }) {
    arts.get(key)?.bitmap.close()
    arts.delete(key)
    return { result: true }
  },

  async cut(req: CutRequest) {
    const art = arts.get(req.key)
    if (!art) throw new Error('not-loaded')
    const frame = cutFrame(req.artW, req.artH, req.params, req.bleedMm)
    const k = frame.pxPerMm
    const c = new OffscreenCanvas(frame.w, frame.h)
    const ctx = c.getContext('2d', { willReadFrequently: true })!
    ctx.imageSmoothingQuality = 'high'
    const { bbox } = art.info
    const top = frame.frame.y + frame.frame.h
    ctx.drawImage(art.bitmap, bbox.x, bbox.y, bbox.w, bbox.h, (frame.art.x - frame.frame.x) * k, (top - (frame.art.y + frame.art.h)) * k, frame.art.w * k, frame.art.h * k)
    const rgba = ctx.getImageData(0, 0, frame.w, frame.h).data
    const geo = computeCut({ rgba, w: frame.w, h: frame.h, pxPerMm: k, originX: frame.frame.x, originTopY: top }, frame, req.params, req.bleedMm)
    return withPngs(geo)
  },

  /** A contour cut around pixels made elsewhere (Print & Cut), plus those pixels as a PNG to print. */
  async cutRaster({ raster, params, bleedMm }: { raster: CutRaster; params: CutParams; bleedMm: number }) {
    const frame = cutFrame(raster.w / raster.pxPerMm, raster.h / raster.pxPerMm, params, bleedMm)
    const { result, transfer } = await withPngs(computeCut(raster, frame, params, bleedMm))
    const art = await encodePng({ data: raster.rgba, w: raster.w, h: raster.h })
    const rect = { x: raster.originX, y: raster.originTopY - raster.h / raster.pxPerMm, w: raster.w / raster.pxPerMm, h: raster.h / raster.pxPerMm }
    return { result: { ...result, art: { png: art, rect } }, transfer: [...transfer, art.buffer] }
  },
})

async function withPngs(geo: CutGeometry): Promise<{ result: CutResult; transfer: Transferable[] }> {
  const { bleedImage, ...rest } = geo
  const result: CutResult = rest
  const transfer: Transferable[] = []
  if (bleedImage) {
    const png = await encodePng({ data: bleedImage.rgba, w: bleedImage.w, h: bleedImage.h })
    result.bleedImage = { png, rect: bleedImage.rect }
    transfer.push(png.buffer)
  }
  return { result, transfer }
}
