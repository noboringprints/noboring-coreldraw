/** The sticker job: what each sticker is, how big, how it is cut. Plus helpers that turn that into geometry. */
import type { Rect } from '../lib/geometry'
import { MM_PER_INCH } from '../config/defaults'
import { type CutParams, DEFAULT_CUT, DEFAULT_STICKER_SETTINGS, DEFAULT_STICKER_SIZE_MM, type StickerSettings, type Units, cloneStickerSettings } from './config'
import { borderOf, cutFrame } from './lib/cutline'
import type { ArtKind } from './lib/imaging'
import type { ArtInfo } from './workers/cut.worker'

export type BackgroundState = 'original' | 'plain' | 'ai'

/** One version of a sticker's artwork (the original upload, or a cut-out made from it). */
export interface StickerArt {
  /** Unique per version – the worker caches decoded pixels under it. */
  key: string
  bytes: Uint8Array
  kind: Exclude<ArtKind, 'webp'>
  info: ArtInfo
  /** Object URL for <img> thumbnails. */
  url: string
}

export interface Sticker {
  id: string
  name: string
  original: StickerArt
  art: StickerArt
  background: BackgroundState
  /** Finished sticker (cut box) width. Height follows from the artwork's proportions. */
  widthMm: number
  params: CutParams
  copies: number
  rotation: 'auto' | 0 | 90
}

/** Proportions of the visible artwork (height / width). */
export const aspectOf = (s: Pick<Sticker, 'art'>) => s.art.info.bbox.h / s.art.info.bbox.w

/** Size of the artwork itself (inside the border). */
export function artSize(s: Pick<Sticker, 'art' | 'widthMm' | 'params'>): { w: number; h: number } {
  const r = borderOf(s.params)
  const w = Math.max(1, s.widthMm - 2 * r)
  return { w, h: w * aspectOf(s) }
}

/** Finished size: art + border all round. */
export function stickerSize(s: Pick<Sticker, 'art' | 'widthMm' | 'params'>): { w: number; h: number } {
  const r = borderOf(s.params)
  const a = artSize(s)
  return { w: a.w + 2 * r, h: a.h + 2 * r }
}

/** Width that gives a finished height of `h`. */
export function widthForHeight(s: Pick<Sticker, 'art' | 'params'>, h: number): number {
  const r = borderOf(s.params)
  return Math.max(1, h - 2 * r) / aspectOf(s) + 2 * r
}

/** Width that makes the longest finished side `l`. */
export function widthForLongest(s: Pick<Sticker, 'art' | 'params'>, l: number): number {
  return aspectOf(s) <= 1 ? l : widthForHeight(s, l)
}

/** Where the whole image file goes in the sticker's frame (mm, y up), so its visible part lands on the art box. */
export function artImageRect(s: Pick<Sticker, 'art' | 'widthMm' | 'params'>, bleedMm: number): Rect {
  const { w, h } = artSize(s)
  const art = cutFrame(w, h, s.params, bleedMm).art
  const { bbox, pxW, pxH } = s.art.info
  const k = art.w / bbox.w // mm per pixel
  return { x: art.x - bbox.x * k, y: art.y - (pxH - bbox.y - bbox.h) * k, w: pxW * k, h: pxH * k }
}

/** Print resolution of the artwork at this size. */
export const effectiveDpi = (s: Pick<Sticker, 'art' | 'widthMm' | 'params'>) => s.art.info.bbox.w / (artSize(s).w / MM_PER_INCH)

/** Good starting cut settings for a new upload. */
export function defaultParams(info: ArtInfo): CutParams {
  // cut-outs follow their outline with a white border; full photos become rounded rectangles, cut on the edge
  return info.transparent ? { ...DEFAULT_CUT } : { ...DEFAULT_CUT, shape: 'rounded', border: 'none', cornerMm: 3 }
}

export const newStickerDefaults = { widthMm: DEFAULT_STICKER_SIZE_MM, copies: 1, rotation: 'auto' as const }

/* ------------------------------------------------------------------ units */

export function fmtLen(mm: number, units: Units, digits?: number): string {
  if (units === 'in') return `${(mm / MM_PER_INCH).toFixed(digits ?? 2)}″`
  return `${(Math.round(mm * 10 ** (digits ?? 1)) / 10 ** (digits ?? 1)).toString()} mm`
}
export const toUnits = (mm: number, u: Units) => (u === 'in' ? Math.round((mm / MM_PER_INCH) * 1000) / 1000 : Math.round(mm * 10) / 10)
export const fromUnits = (v: number, u: Units) => (u === 'in' ? v * MM_PER_INCH : v)

/* ------------------------------------------------------------------ saved settings */

const KEY = 'print-ready.stickers.settings.v1'

export function loadStickerSettings(): StickerSettings {
  const d = cloneStickerSettings(DEFAULT_STICKER_SETTINGS)
  try {
    const raw = localStorage.getItem(KEY)
    if (!raw) return d
    const saved = JSON.parse(raw) as Partial<StickerSettings>
    return { ...d, ...saved, marks: { ...d.marks, ...saved.marks }, cut: { ...d.cut, ...saved.cut }, sheet: saved.sheet ?? d.sheet }
  } catch {
    return d
  }
}

export function saveStickerSettings(s: StickerSettings) {
  try {
    localStorage.setItem(KEY, JSON.stringify(s))
  } catch {
    /* storage unavailable – settings just won't be remembered */
  }
}
