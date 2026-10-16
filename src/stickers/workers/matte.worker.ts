/// <reference lib="webworker" />
/**
 * Background removal worker.
 *  - 'plain': flat-colour background (logos, clipart) – instant, no download.
 *  - 'ai':    ORMBG segmentation model via transformers.js, run locally (WebGPU when available, else WebAssembly).
 *             The model is downloaded once from Hugging Face and cached by the browser. The image never leaves the computer.
 * Both return a PNG with transparency, trimmed to the visible part.
 */
import { BG_MODEL } from '../config'
import { type ArtKind, bitmapPixels, decodeBitmap, encodePng } from '../lib/imaging'
import { type PlainRemoveOptions, type RGBA, applyAiMask, cropImage, opaqueBounds, removePlainBackground } from '../lib/matte'
import { serve } from './rpc'

/** Largest output for the instant remover (longest side, px). */
const PLAIN_MAX_SIDE = 4096
/** Largest output for the AI remover – the edge refinement step runs at this size. */
const AI_MAX_SIDE = 2048

export interface MatteResult {
  png: Uint8Array
  w: number
  h: number
}

export interface AiProgress {
  stage: 'download' | 'run'
  /** 0–1 while downloading. */
  fraction?: number
  device?: string
}

async function finish(img: RGBA) {
  const b = opaqueBounds(img)
  if (!b) throw new Error('Nothing was left after removing the background. Try a lower tolerance.')
  // keep a couple of transparent pixels around the art so its edge stays soft
  const x = Math.max(0, b.x - 2)
  const y = Math.max(0, b.y - 2)
  const out = cropImage(img, x, y, Math.min(img.w - x, b.w + 4), Math.min(img.h - y, b.h + 4))
  const png = await encodePng(out)
  return { result: { png, w: out.w, h: out.h } satisfies MatteResult, transfer: [png.buffer] }
}

type Segmenter = (img: unknown) => Promise<{ mask: { data: Uint8Array | Uint8ClampedArray; width: number; height: number; channels: number } }[]>
interface Model {
  run: Segmenter
  device: string
  RawImage: new (data: Uint8ClampedArray, w: number, h: number, channels: number) => unknown
}
let model: Promise<Model> | null = null

async function loadModel(progress: (p: AiProgress) => void): Promise<Model> {
  const tf = await import('@huggingface/transformers')
  tf.env.allowLocalModels = false
  const files = new Map<string, { loaded: number; total: number }>()
  const progress_callback = (p: { status: string; file?: string; loaded?: number; total?: number }) => {
    if (p.status !== 'progress' || !p.file) return
    files.set(p.file, { loaded: p.loaded ?? 0, total: p.total ?? 0 })
    let loaded = 0
    let total = 0
    for (const f of files.values()) {
      loaded += f.loaded
      total += f.total
    }
    if (total) progress({ stage: 'download', fraction: loaded / total })
  }
  const gpu = typeof navigator !== 'undefined' && 'gpu' in navigator && (await (navigator as unknown as { gpu: { requestAdapter(): Promise<unknown> } }).gpu.requestAdapter().catch(() => null))
  const attempts: { device: 'webgpu' | 'wasm'; dtype: 'fp16' | 'fp32' }[] = gpu ? [{ device: 'webgpu', dtype: 'fp16' }, { device: 'wasm', dtype: 'fp32' }] : [{ device: 'wasm', dtype: 'fp32' }]
  let lastError: unknown
  for (const a of attempts) {
    try {
      const pipe = await tf.pipeline('image-segmentation', BG_MODEL.id, { device: a.device, dtype: a.dtype, progress_callback } as never)
      const run: Segmenter = (img) => (pipe as unknown as (i: unknown) => Promise<never>)(img)
      return { run, device: a.device, RawImage: tf.RawImage as unknown as Model['RawImage'] }
    } catch (e) {
      lastError = e
    }
  }
  throw new Error(`The background remover could not start (${(lastError as Error)?.message ?? lastError}). An internet connection is needed the first time.`)
}

serve({
  async plain({ bytes, kind, options }: { bytes: Uint8Array; kind: ArtKind; options: PlainRemoveOptions }) {
    const bmp = await decodeBitmap(bytes, kind)
    const img = bitmapPixels(bmp, PLAIN_MAX_SIDE)
    bmp.close()
    return finish(removePlainBackground(img, options))
  },

  async ai({ bytes, kind }: { bytes: Uint8Array; kind: ArtKind }, progress) {
    if (!model) {
      model = loadModel(progress)
      model.catch(() => (model = null)) // allow a retry (e.g. after going online)
    }
    const m0 = await model
    progress({ stage: 'run', device: m0.device } satisfies AiProgress)
    const bmp = await decodeBitmap(bytes, kind)
    const work = bitmapPixels(bmp, AI_MAX_SIDE)
    const input = bitmapPixels(bmp, BG_MODEL.inputPx)
    bmp.close()
    const [{ mask }] = await m0.run(new m0.RawImage(input.data, input.w, input.h, 4))
    const m = mask.channels === 1 ? mask.data : Uint8Array.from({ length: mask.width * mask.height }, (_, i) => mask.data[i * mask.channels])
    return finish(applyAiMask(work, m, mask.width, mask.height))
  },
})
