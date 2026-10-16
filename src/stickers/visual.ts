import type { StickerSettings } from './config'
import { type Sticker, artImageRect } from './model'
import type { StickerVisual } from './render'
import type { CutState } from './useStickerJob'

/** What the canvas needs to draw a sticker, or null until its cut line exists. */
export function visualOf(s: Sticker, cut: CutState | undefined, bitmaps: Record<string, ImageBitmap>, settings: StickerSettings): StickerVisual | null {
  const r = cut?.result
  if (!r || !r.cut.length) return null
  return {
    cut: r.cut,
    bleed: r.bleed,
    border: s.params.border,
    borderColor: s.params.borderColor,
    art: bitmaps[s.art.key] ?? null,
    artRect: artImageRect(s, settings.bleedMm),
    bleedImg: cut?.bleedBitmap ?? null,
    bleedRect: r.bleedImage?.rect,
  }
}
