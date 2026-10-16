/**
 * All sticker state and actions in one hook: uploads, background removal, cut-line computation (in a worker,
 * debounced, stale results dropped), preview bitmaps, and clean-up of everything a removed sticker used.
 */
import { useCallback, useEffect, useRef, useState } from 'react'
import { newId } from '../lib/sources'
import type { CutParams, StickerSettings } from './config'
import { type ArtKind, bitmapPixels, decodeBitmap, encodePng, kindOf } from './lib/imaging'
import type { PlainRemoveOptions } from './lib/matte'
import { type Sticker, type StickerArt, artSize, defaultParams, newStickerDefaults, stickerSize, widthForLongest } from './model'
import type { ArtInfo, CutRequest, CutResult } from './workers/cut.worker'
import type { AiProgress, MatteResult } from './workers/matte.worker'
import { RpcClient } from './workers/rpc'

export interface CutState {
  key: string
  result?: CutResult
  bleedBitmap?: ImageBitmap | null
  error?: string
}

export interface BusyState {
  label: string
  fraction?: number
}

/** Longest side of preview bitmaps (the print always uses the full file). */
const PREVIEW_MAX = 2048
/** Auto-remove a background when the image edge is at least this plain. */
const AUTO_PLAIN = 0.985

const cutKey = (s: Sticker, bleedMm: number) => {
  const a = artSize(s)
  return JSON.stringify([s.art.key, Math.round(a.w * 100), Math.round(a.h * 100), s.params, bleedMm])
}

async function previewBitmap(art: StickerArt): Promise<ImageBitmap> {
  const blob = new Blob([art.bytes as BlobPart], { type: art.kind === 'png' ? 'image/png' : 'image/jpeg' })
  const { pxW, pxH } = art.info
  const k = Math.min(1, PREVIEW_MAX / Math.max(pxW, pxH))
  return createImageBitmap(blob, k < 1 ? { resizeWidth: Math.round(pxW * k), resizeHeight: Math.round(pxH * k), resizeQuality: 'high' } : {})
}

export function useStickerJob(settings: StickerSettings, toast: (msg: string) => void) {
  const [stickers, setStickers] = useState<Sticker[]>([])
  const [cuts, setCuts] = useState<Record<string, CutState>>({})
  const [bitmaps, setBitmaps] = useState<Record<string, ImageBitmap>>({})
  const [busy, setBusy] = useState<Record<string, BusyState | undefined>>({})
  const [errors, setErrors] = useState<string[]>([])
  const [loading, setLoading] = useState(0)
  const stickersRef = useRef(stickers)
  stickersRef.current = stickers

  // ---------- workers (created on first use)
  const cutRpc = useRef<RpcClient | null>(null)
  const matteRpc = useRef<RpcClient | null>(null)
  const cutWorker = () => (cutRpc.current ??= new RpcClient(new Worker(new URL('./workers/cut.worker.ts', import.meta.url), { type: 'module' })))
  const matteWorker = () => (matteRpc.current ??= new RpcClient(new Worker(new URL('./workers/matte.worker.ts', import.meta.url), { type: 'module' })))
  useEffect(
    () => () => {
      // clear the refs too: React's dev mode unmounts and remounts once, and a later call must get a live worker
      cutRpc.current?.terminate()
      matteRpc.current?.terminate()
      cutRpc.current = null
      matteRpc.current = null
    },
    [],
  )

  /** Registers a version of an artwork with the cut worker and makes its preview. */
  const loadArt = useCallback(async (bytes: Uint8Array, kind: Exclude<ArtKind, 'webp'>): Promise<StickerArt> => {
    const key = newId('art')
    // the worker gets its own copy; we keep ours for the PDF
    const info = await cutWorker().call<ArtInfo>('load', { key, bytes: bytes.slice(), kind })
    const art: StickerArt = { key, bytes, kind, info, url: URL.createObjectURL(new Blob([bytes as BlobPart], { type: kind === 'png' ? 'image/png' : 'image/jpeg' })) }
    previewBitmap(art)
      .then((bmp) => setBitmaps((b) => ({ ...b, [key]: bmp })))
      .catch(() => {})
    return art
  }, [])

  const update = useCallback((id: string, patch: Partial<Sticker> | ((s: Sticker) => Partial<Sticker>)) => {
    setStickers((list) => list.map((s) => (s.id === id ? { ...s, ...(typeof patch === 'function' ? patch(s) : patch) } : s)))
  }, [])

  const setBusyFor = (id: string, b: BusyState | undefined) => setBusy((m) => ({ ...m, [id]: b }))

  // ---------- background removal
  /** Works on the sticker given (a just-added sticker isn't in state yet). */
  const removeBackgroundOf = useCallback(
    async (s: Sticker, method: 'plain' | 'ai', options: PlainRemoveOptions = { tolerance: 30, everywhere: false }, auto = false) => {
      const id = s.id
      setBusyFor(id, { label: method === 'ai' ? 'Starting background remover…' : 'Removing background…' })
      try {
        const src = s.original
        const res = await matteWorker().call<MatteResult, AiProgress>(method, { bytes: src.bytes.slice(), kind: src.kind, options }, {
          onProgress: (p) =>
            setBusyFor(id, p.stage === 'download' ? { label: 'Downloading background remover (once)…', fraction: p.fraction } : { label: `Removing background${p.device === 'webgpu' ? ' (GPU)' : ''}…` }),
        })
        const art = await loadArt(res.png, 'png')
        const longest = Math.max(stickerSize(s).w, stickerSize(s).h)
        setStickers((list) =>
          list.map((x) => {
            if (x.id !== id) return x
            // a cut-out gets the classic die-cut look: follow the outline with a white border
            const params: CutParams = x.params.shape === 'contour' ? x.params : { ...x.params, shape: 'contour', border: 'white' }
            const next = { ...x, art, background: method, params }
            return { ...next, widthMm: widthForLongest(next, longest) }
          }),
        )
        toast(auto ? `Plain background removed from “${s.name}” – undo in step 2 if needed` : 'Background removed')
      } catch (e) {
        setErrors((er) => [...er, `${s.name}: ${(e as Error).message}`])
      } finally {
        setBusyFor(id, undefined)
      }
    },
    [loadArt, toast],
  )
  const removeBackground = useCallback(
    (id: string, method: 'plain' | 'ai', options?: PlainRemoveOptions) => {
      const s = stickersRef.current.find((x) => x.id === id)
      if (s) void removeBackgroundOf(s, method, options)
    },
    [removeBackgroundOf],
  )

  const restoreBackground = useCallback((id: string) => {
    setStickers((list) =>
      list.map((x) => {
        if (x.id !== id) return x
        const longest = Math.max(stickerSize(x).w, stickerSize(x).h)
        const next = { ...x, art: x.original, background: 'original' as const, params: defaultParams(x.original.info) }
        return { ...next, widthMm: widthForLongest(next, longest) }
      }),
    )
  }, [])

  // ---------- adding files
  const addFiles = useCallback(
    async (files: File[]) => {
      setErrors([])
      setLoading((n) => n + files.length)
      for (const f of files) {
        try {
          let bytes: Uint8Array = new Uint8Array(await f.arrayBuffer())
          let kind = kindOf(f.name, bytes)
          if (!kind) {
            const pdf = /\.pdf$/i.test(f.name)
            throw new Error(pdf ? `“${f.name}”: PDF stickers aren't supported yet – export it as a PNG (300 DPI or more, transparent background).` : `“${f.name}” is not a PNG, JPG or WebP image.`)
          }
          if (kind === 'webp') {
            // the PDF can't hold WebP: convert once, losslessly
            const bmp = await decodeBitmap(bytes, kind)
            bytes = await encodePng(bitmapPixels(bmp))
            bmp.close()
            kind = 'png'
          }
          const art = await loadArt(bytes, kind)
          const base = { art, params: defaultParams(art.info) }
          const sticker: Sticker = {
            id: newId('st'),
            name: f.name.replace(/\.(png|jpe?g|webp)$/i, ''),
            original: art,
            background: 'original',
            ...newStickerDefaults,
            ...base,
            widthMm: widthForLongest(base, newStickerDefaults.widthMm),
          }
          setStickers((list) => [...list, sticker])
          // logos on a plain white (or flat) background: take it away straight away
          if (!art.info.transparent && art.info.background.uniformity >= AUTO_PLAIN) void removeBackgroundOf(sticker, 'plain', { tolerance: 30, everywhere: false }, true)
        } catch (e) {
          setErrors((er) => [...er, (e as Error).message])
        } finally {
          setLoading((n) => n - 1)
        }
      }
    },
    [loadArt, removeBackgroundOf],
  )

  const remove = useCallback((id: string) => setStickers((list) => list.filter((s) => s.id !== id)), [])

  const duplicate = useCallback((id: string) => {
    setStickers((list) => {
      const i = list.findIndex((s) => s.id === id)
      if (i < 0) return list
      const copy: Sticker = { ...list[i], id: newId('st'), name: `${list[i].name} (copy)` }
      return [...list.slice(0, i + 1), copy, ...list.slice(i + 1)]
    })
  }, [])

  /** Copies one sticker's cut style (shape, border, smoothing…) to every sticker, keeping each one's size. */
  const applyCutToAll = useCallback((id: string) => {
    setStickers((list) => {
      const from = list.find((s) => s.id === id)
      if (!from) return list
      return list.map((s) => {
        if (s.id === id) return s
        const longest = Math.max(stickerSize(s).w, stickerSize(s).h)
        const next = { ...s, params: { ...from.params } }
        return { ...next, widthMm: widthForLongest(next, longest) }
      })
    })
  }, [])

  // ---------- cut lines: recompute whatever is out of date
  /** The key each sticker's cut should end up with; results for any other key are stale and dropped. */
  const latest = useRef<Record<string, string>>({})
  const timers = useRef<Record<string, ReturnType<typeof setTimeout>>>({})
  useEffect(() => () => Object.values(timers.current).forEach(clearTimeout), [])
  useEffect(() => {
    for (const s of stickers) {
      const key = cutKey(s, settings.bleedMm)
      if (cuts[s.id]?.key === key || latest.current[s.id] === key) continue
      latest.current[s.id] = key
      // debounce: dragging a slider only computes once it pauses
      clearTimeout(timers.current[s.id])
      timers.current[s.id] = setTimeout(async () => {
        const a = artSize(s)
        const req: CutRequest = { key: s.art.key, artW: a.w, artH: a.h, params: s.params, bleedMm: settings.bleedMm }
        try {
          let result: CutResult
          try {
            result = await cutWorker().call<CutResult>('cut', req)
          } catch (e) {
            if ((e as Error).message !== 'not-loaded') throw e
            await cutWorker().call('load', { key: s.art.key, bytes: s.art.bytes.slice(), kind: s.art.kind })
            result = await cutWorker().call<CutResult>('cut', req)
          }
          if (latest.current[s.id] !== key) return // a newer request is on its way
          const bleedBitmap = result.bleedImage ? await createImageBitmap(new Blob([result.bleedImage.png as BlobPart], { type: 'image/png' })) : null
          if (latest.current[s.id] !== key) return bleedBitmap?.close()
          setCuts((c) => {
            c[s.id]?.bleedBitmap?.close()
            return { ...c, [s.id]: { key, result, bleedBitmap } }
          })
        } catch (e) {
          if (latest.current[s.id] === key) setCuts((c) => ({ ...c, [s.id]: { key, error: (e as Error).message } }))
        }
      }, 90)
    }
  }, [stickers, settings.bleedMm, cuts])

  /** Raises smoothing step by step until the cut line is one piece. */
  const joinPieces = useCallback(
    async (id: string) => {
      const s = stickersRef.current.find((x) => x.id === id)
      if (!s) return
      setBusyFor(id, { label: 'Joining into one sticker…' })
      try {
        const a = artSize(s)
        let smooth = s.params.smoothMm
        for (let i = 0; i < 12; i++) {
          smooth = Math.round((smooth + Math.max(1, smooth * 0.4)) * 2) / 2
          const r = await cutWorker().call<CutResult>('cut', { key: s.art.key, artW: a.w, artH: a.h, params: { ...s.params, smoothMm: smooth }, bleedMm: settings.bleedMm } satisfies CutRequest)
          if (r.pieces <= 1) {
            update(id, (x) => ({ params: { ...x.params, smoothMm: smooth } }))
            toast(`Joined – smoothing set to ${smooth} mm`)
            return
          }
        }
        toast('Could not join the pieces – try a bigger border')
      } finally {
        setBusyFor(id, undefined)
      }
    },
    [settings.bleedMm, update, toast],
  )

  // ---------- clean up what removed stickers / replaced artwork used
  const known = useRef(new Map<string, StickerArt>())
  useEffect(() => {
    const live = new Set<string>()
    for (const s of stickers) {
      live.add(s.art.key)
      live.add(s.original.key)
      known.current.set(s.art.key, s.art)
      known.current.set(s.original.key, s.original)
    }
    for (const [key, art] of known.current) {
      if (live.has(key)) continue
      known.current.delete(key)
      URL.revokeObjectURL(art.url)
      void cutRpc.current?.call('forget', { key }).catch(() => {})
      setBitmaps((b) => {
        if (!b[key]) return b
        b[key].close()
        const { [key]: _gone, ...rest } = b
        return rest
      })
    }
    setCuts((c) => {
      const ids = new Set(stickers.map((s) => s.id))
      const stale = Object.keys(c).filter((id) => !ids.has(id))
      if (!stale.length) return c
      const next = { ...c }
      for (const id of stale) {
        next[id].bleedBitmap?.close()
        delete next[id]
        delete latest.current[id]
        clearTimeout(timers.current[id])
      }
      return next
    })
  }, [stickers])

  /** Stickers whose cut line is being (re)computed. */
  const stale = new Set(stickers.filter((s) => cuts[s.id]?.key !== cutKey(s, settings.bleedMm)).map((s) => s.id))

  return {
    stickers,
    cuts,
    bitmaps,
    busy,
    errors,
    loading: loading > 0,
    pending: stale.size,
    stale,
    addFiles,
    update,
    remove,
    duplicate,
    applyCutToAll,
    removeBackground,
    restoreBackground,
    joinPieces,
    dismissErrors: () => setErrors([]),
  }
}

export type StickerJob = ReturnType<typeof useStickerJob>
