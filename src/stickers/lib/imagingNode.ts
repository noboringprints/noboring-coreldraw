/** Decoding / encoding images in Node with @napi-rs/canvas – the API's counterpart of imaging.ts. */
import { type Image, createCanvas, loadImage } from '@napi-rs/canvas'
import type { RGBA } from './matte'

export const decodeImage = (bytes: Uint8Array): Promise<Image> => loadImage(Buffer.from(bytes))

/** Pixels of an image (or a scaled-down copy so the longest side is at most `maxSide`). */
export function imagePixels(img: Image, maxSide = Infinity): RGBA {
  const k = Math.min(1, maxSide / Math.max(img.width, img.height))
  const w = Math.max(1, Math.round(img.width * k))
  const h = Math.max(1, Math.round(img.height * k))
  const ctx = createCanvas(w, h).getContext('2d')
  ctx.imageSmoothingQuality = 'high'
  ctx.drawImage(img, 0, 0, w, h)
  return { data: ctx.getImageData(0, 0, w, h).data, w, h }
}

export function encodePngNode(img: RGBA): Uint8Array {
  const c = createCanvas(img.w, img.h)
  const ctx = c.getContext('2d')
  const out = ctx.createImageData(img.w, img.h)
  out.data.set(img.data)
  ctx.putImageData(out, 0, 0)
  return new Uint8Array(c.toBuffer('image/png'))
}
