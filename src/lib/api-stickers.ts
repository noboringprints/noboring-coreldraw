/**
 * Sticker API Engine
 *
 * The sticker tool without its screens: same defaults, background removal, cut lines, nesting and PDF
 * as the app. Runs in Node only – the app does the canvas work in src/stickers/workers/ instead.
 */
import { createCanvas } from '@napi-rs/canvas'
import { BG_MODEL, type BorderStyle, type CutParams, type CutShape, DEFAULT_STICKER_SETTINGS, DEFAULT_STICKER_SIZE_MM, STICKER_SHEETS, type StickerSettings, cloneStickerSettings, stickerSettingsProblems } from '../stickers/config'
import { computeCut, cutFrame } from '../stickers/lib/cutline'
import { type ExportDesign, type ExportMode, buildStickerPdf } from '../stickers/lib/exportStickers'
import { kindOf } from '../stickers/lib/imaging'
import { decodeImage, encodePngNode, imagePixels } from '../stickers/lib/imagingNode'
import { AI_MAX_SIDE, ANALYSIS_MAX_SIDE, AUTO_PLAIN, PLAIN_MAX_SIDE, type RGBA, applyAiMask, artInfoOf, removePlainBackground, trimCutOut } from '../stickers/lib/matte'
import { type NestDesign, type StickerSheetLayout, layoutProblems, nest } from '../stickers/lib/nest'
import { type Sticker, type StickerArt, artImageRect, artSize, defaultParams, effectiveDpi, newStickerDefaults, widthForLongest } from '../stickers/model'
import { newId } from './sources'

export type StickerBackground = 'auto' | 'keep' | 'plain' | 'ai'

export type StickerApiItem = {
  name: string
  bytes: Uint8Array | Buffer
  copies?: number
  /** Finished size: the longest side, border included (default 3 in). */
  longestMm?: number
  /** 'auto' removes a plain background, as the app does on upload. */
  background?: StickerBackground
  shape?: CutShape
  border?: BorderStyle
  borderMm?: number
  borderColor?: string
  cornerMm?: number
  smoothMm?: number
  rotation?: 'auto' | 0 | 90
}

export type SheetOptions = {
  sheet?: 'A4' | 'A3' | '13x19'
  bleedMm?: number
  gapMm?: number
  mode?: ExportMode
  title?: string
}

export type StickerJobOptions = SheetOptions & { items: StickerApiItem[] }

export function sheetSettings(base: StickerSettings, opts: SheetOptions): StickerSettings {
  const s = cloneStickerSettings(base)
  if (opts.sheet) {
    const i = ['A4', 'A3', '13x19'].indexOf(opts.sheet)
    if (i < 0) throw new Error(`Unknown sheet "${opts.sheet}". Use A4, A3 or 13x19.`)
    s.sheet = STICKER_SHEETS[i]
  }
  if (typeof opts.bleedMm === 'number') s.bleedMm = opts.bleedMm
  if (typeof opts.gapMm === 'number') s.gapMm = opts.gapMm
  return s
}

/** Throws when a design has copies missing from the sheets: an order must never come out short without anyone noticing. */
export function checkAllPlaced(designs: NestDesign[], sheets: StickerSheetLayout[]) {
  for (const d of designs) {
    const placed = sheets.reduce((n, sh) => n + sh.placements.filter((p) => p.designId === d.id).length, 0)
    if (placed < d.copies) throw new Error(`"${d.name}": only ${placed} of ${d.copies} copies fit. It may be too big for this sheet.`)
  }
}

type Segmenter = (img: unknown) => Promise<{ mask: { data: Uint8Array | Uint8ClampedArray; width: number; height: number; channels: number } }[]>
let model: Promise<{ run: Segmenter; RawImage: new (data: Uint8ClampedArray, w: number, h: number, channels: number) => unknown }> | null = null

/** Same model as the app, on the CPU. Downloaded from Hugging Face on first use, then kept on disk. */
function loadModel() {
  model ??= (async () => {
    const tf = await import('@huggingface/transformers')
    tf.env.allowLocalModels = false
    const pipe = await tf.pipeline('image-segmentation', BG_MODEL.id, { device: 'cpu', dtype: 'fp32' } as never)
    return { run: (img: unknown) => (pipe as unknown as (i: unknown) => Promise<never>)(img), RawImage: tf.RawImage as never }
  })()
  model.catch(() => (model = null)) // allow a retry (e.g. after going online)
  return model
}

async function cutOut(bytes: Uint8Array, method: 'plain' | 'ai'): Promise<RGBA> {
  const img = await decodeImage(bytes)
  if (method === 'plain') return trimCutOut(removePlainBackground(imagePixels(img, PLAIN_MAX_SIDE), { tolerance: 30, everywhere: false }))
  const m = await loadModel()
  const input = imagePixels(img, BG_MODEL.inputPx)
  const [{ mask }] = await m.run(new m.RawImage(input.data, input.w, input.h, 4))
  const data = mask.channels === 1 ? mask.data : Uint8Array.from({ length: mask.width * mask.height }, (_, i) => mask.data[i * mask.channels])
  return trimCutOut(applyAiMask(imagePixels(img, AI_MAX_SIDE), data, mask.width, mask.height))
}

async function loadArt(bytes: Uint8Array, kind: 'png' | 'jpg'): Promise<StickerArt> {
  const img = await decodeImage(bytes)
  return { key: newId('art'), bytes, kind, info: artInfoOf(imagePixels(img, ANALYSIS_MAX_SIDE), img.width, img.height), url: '' }
}

async function stickerFrom(item: StickerApiItem): Promise<Sticker> {
  let bytes = new Uint8Array(item.bytes)
  let kind = kindOf(item.name, bytes)
  if (!kind) throw new Error(`"${item.name}" is not a PNG, JPG or WebP image.`)
  if (kind === 'webp') {
    // the PDF can't hold WebP: convert once, losslessly
    bytes = new Uint8Array(encodePngNode(imagePixels(await decodeImage(bytes))))
    kind = 'png'
  }
  const original = await loadArt(bytes, kind)
  let art = original
  let background: Sticker['background'] = 'original'
  let params: CutParams = defaultParams(original.info)

  const asked = item.background ?? 'auto'
  const plainEdge = !original.info.transparent && original.info.background.uniformity >= AUTO_PLAIN
  const method = asked === 'plain' || asked === 'ai' ? asked : asked === 'auto' && plainEdge ? 'plain' : null
  if (method) {
    art = await loadArt(encodePngNode(await cutOut(bytes, method)), 'png')
    background = method
    // a cut-out gets the classic die-cut look: follow the outline with a white border
    if (params.shape !== 'contour') params = { ...params, shape: 'contour', border: 'white' }
  }

  params = {
    ...params,
    ...(item.shape ? { shape: item.shape } : {}),
    ...(item.border ? { border: item.border } : {}),
    ...(item.borderMm !== undefined ? { borderMm: item.borderMm } : {}),
    ...(item.borderColor ? { borderColor: item.borderColor } : {}),
    ...(item.cornerMm !== undefined ? { cornerMm: item.cornerMm } : {}),
    ...(item.smoothMm !== undefined ? { smoothMm: item.smoothMm } : {}),
  }
  return {
    ...newStickerDefaults,
    id: newId('st'),
    name: item.name.replace(/\.(png|jpe?g|webp)$/i, ''),
    original,
    art,
    background,
    params,
    widthMm: widthForLongest({ art, params }, item.longestMm ?? DEFAULT_STICKER_SIZE_MM),
    copies: item.copies ?? newStickerDefaults.copies,
    rotation: item.rotation ?? newStickerDefaults.rotation,
  }
}

/** Draws the art into its cut frame and works out the cut line, as the cut worker does. */
async function cutOf(st: Sticker, bleedMm: number) {
  const a = artSize(st)
  const frame = cutFrame(a.w, a.h, st.params, bleedMm)
  const k = frame.pxPerMm
  const ctx = createCanvas(frame.w, frame.h).getContext('2d')
  ctx.imageSmoothingQuality = 'high'
  const { bbox } = st.art.info
  const top = frame.frame.y + frame.frame.h
  ctx.drawImage(await decodeImage(st.art.bytes), bbox.x, bbox.y, bbox.w, bbox.h, (frame.art.x - frame.frame.x) * k, (top - (frame.art.y + frame.art.h)) * k, frame.art.w * k, frame.art.h * k)
  const rgba = ctx.getImageData(0, 0, frame.w, frame.h).data
  return computeCut({ rgba, w: frame.w, h: frame.h, pxPerMm: k, originX: frame.frame.x, originTopY: top }, frame, st.params, bleedMm)
}

export async function runStickerJob(opts: StickerJobOptions): Promise<{
  pdfBytes: Uint8Array
  totalSheets: number
  totalStickers: number
  warnings: string[]
}> {
  if (!opts.items?.length) throw new Error('No items were sent.')
  const s = sheetSettings(DEFAULT_STICKER_SETTINGS, opts)
  const warnings = stickerSettingsProblems(s)

  const designs: Record<string, ExportDesign> = {}
  const nestDesigns: NestDesign[] = []
  for (const item of opts.items) {
    const st = await stickerFrom(item)
    const geo = await cutOf(st, s.bleedMm)
    if (!geo.cut.length) throw new Error(`"${st.name}": ${geo.warnings[0] ?? 'could not find an outline to cut around.'}`)
    for (const w of geo.warnings) warnings.push(`${st.name}: ${w}`)
    const dpi = effectiveDpi(st)
    if (dpi < s.minDpi) warnings.push(`${st.name}: prints at ${Math.round(dpi)} DPI – may look soft.`)
    const { bleedImage } = geo
    designs[st.id] = {
      id: st.id,
      name: st.name,
      cut: geo.cut,
      bleed: geo.bleed,
      bounds: geo.bounds,
      border: st.params.border,
      borderColor: st.params.borderColor,
      art: { bytes: st.art.bytes, kind: st.art.kind, rect: artImageRect(st, s.bleedMm) },
      ...(bleedImage ? { bleedImage: { png: encodePngNode({ data: bleedImage.rgba, w: bleedImage.w, h: bleedImage.h }), rect: bleedImage.rect } } : {}),
    }
    nestDesigns.push({ id: st.id, name: st.name, cut: geo.cut, bounds: geo.bounds, copies: st.copies, rotation: st.rotation })
  }

  const layout = nest(nestDesigns, s)
  checkAllPlaced(nestDesigns, layout.sheets)
  warnings.push(...layout.warnings)
  for (const sh of layout.sheets) {
    const p = layoutProblems(sh, designs, s)
    if (p.overlapping.size) warnings.push(`Sheet ${sh.index + 1}: some stickers are closer than the ${s.gapMm} mm gap.`)
    if (p.outside.size) warnings.push(`Sheet ${sh.index + 1}: a sticker is outside the printable area.`)
  }

  const pdfBytes = await buildStickerPdf(layout.sheets, designs, s, { mode: opts.mode ?? 'print-cut', title: opts.title })
  return { pdfBytes, totalSheets: layout.sheets.length, totalStickers: layout.sheets.reduce((n, sh) => n + sh.placements.length, 0), warnings }
}
