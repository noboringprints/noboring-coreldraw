/** Decoding / encoding images with OffscreenCanvas – works in workers and on the main thread. */
import type { RGBA } from './matte'

export type ArtKind = 'png' | 'jpg' | 'webp'

export const mimeOf = (kind: ArtKind) => (kind === 'png' ? 'image/png' : kind === 'jpg' ? 'image/jpeg' : 'image/webp')

export function kindOf(name: string, bytes: Uint8Array): ArtKind | null {
  if (bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47) return 'png'
  if (bytes[0] === 0xff && bytes[1] === 0xd8) return 'jpg'
  if (bytes[0] === 0x52 && bytes[1] === 0x49 && bytes[2] === 0x46 && bytes[3] === 0x46 && bytes[8] === 0x57 && bytes[9] === 0x45) return 'webp'
  const ext = name.toLowerCase().split('.').pop()
  if (ext === 'png') return 'png'
  if (ext === 'jpg' || ext === 'jpeg') return 'jpg'
  if (ext === 'webp') return 'webp'
  return null
}

export function decodeBitmap(bytes: Uint8Array, kind: ArtKind): Promise<ImageBitmap> {
  return createImageBitmap(new Blob([bytes as BlobPart], { type: mimeOf(kind) }), { premultiplyAlpha: 'none', colorSpaceConversion: 'none' })
}

/** Pixels of a bitmap (or a scaled-down copy so the longest side is at most `maxSide`). */
export function bitmapPixels(bmp: ImageBitmap, maxSide = Infinity): RGBA {
  const k = Math.min(1, maxSide / Math.max(bmp.width, bmp.height))
  const w = Math.max(1, Math.round(bmp.width * k))
  const h = Math.max(1, Math.round(bmp.height * k))
  const c = new OffscreenCanvas(w, h)
  const ctx = c.getContext('2d', { willReadFrequently: true })!
  ctx.imageSmoothingQuality = 'high'
  ctx.drawImage(bmp, 0, 0, w, h)
  return { data: ctx.getImageData(0, 0, w, h).data, w, h }
}

export async function encodePng(img: RGBA): Promise<Uint8Array> {
  const c = new OffscreenCanvas(img.w, img.h)
  const ctx = c.getContext('2d')!
  ctx.putImageData(new ImageData(img.data as Uint8ClampedArray<ArrayBuffer>, img.w, img.h), 0, 0)
  const blob = await c.convertToBlob({ type: 'image/png' })
  return new Uint8Array(await blob.arrayBuffer())
}
