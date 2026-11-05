import { type KeyboardEvent, type MouseEvent, type PointerEvent, type ReactNode, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import {
  AlertTriangle,
  AlignCenter,
  Check,
  Crop,
  Eye,
  Layers,
  Palette,
  Ruler,
  Sparkles,
  Type,
  AlignLeft,
  AlignRight,
  Copy,
  Crosshair,
  FlipHorizontal2,
  Maximize,
  Minimize,
  Minus,
  PackagePlus,
  Plus,
  RotateCw,
  Trash2,
  Wand2,
  X,
} from 'lucide-react'
import { NumberField, Segmented, Stepper } from '../components/ui'
import { ENHANCE_LEVELS } from './enhance'
import {
  CUSTOM_FORMAT_ID,
  DEFAULT_CUSTOM,
  FILTERS,
  FONTS,
  FORMATS,
  MAX_ZOOM,
  type PhotoCrop,
  type PolaroidItem,
  type PolaroidSettings,
  SWATCHES,
  THEMES,
  type ThemeInfo,
  fmtMm,
  formatOf,
  formatProblems,
  minZoom,
  photoDpi,
  photoWindow,
  placePhoto,
  themeOf,
} from './model'
import { type Photo, type PolaroidJob, renderToCanvas } from './usePolaroidJob'

/* ------------------------------------------------------------------ small pictures */

/** One polaroid drawn at a given CSS width (sharp on high-DPI screens). */
export function PolaroidThumb(props: { it: PolaroidItem; photo?: Photo; width: number; fontsReady: boolean; className?: string }) {
  const ref = useRef<HTMLCanvasElement>(null)
  const f = formatOf(props.it)
  const key = JSON.stringify([props.it, props.photo?.id, !!props.photo?.preview, props.width, props.fontsReady])
  useEffect(() => {
    if (!ref.current) return
    const dpr = Math.min(2, window.devicePixelRatio || 1)
    renderToCanvas(props.it, props.photo, (props.width * dpr) / f.widthMm, 0, ref.current)
  }, [key]) // eslint-disable-line react-hooks/exhaustive-deps
  return (
    <canvas
      ref={ref}
      className={`block rounded-[2px] shadow-[0_1px_3px_rgb(0_0_0/0.18),0_4px_12px_rgb(0_0_0/0.08)] ${props.className ?? ''}`}
      style={{ width: props.width, height: (props.width * f.heightMm) / f.widthMm }}
    />
  )
}

/* ------------------------------------------------------------------ the crop canvas */

const NUDGE_MM = 0.5

/** The polaroid, big: drag the photo to place it, wheel or two-finger pinch to zoom, arrow keys to nudge. */
function CropCanvas(props: { it: PolaroidItem; photo?: Photo; fontsReady: boolean; onCrop: (c: PhotoCrop) => void; compare?: boolean }) {
  const { it, photo } = props
  const host = useRef<HTMLDivElement>(null)
  const canvas = useRef<HTMLCanvasElement>(null)
  const [box, setBox] = useState({ w: 0, vh: 800 })
  const [draft, setDraft] = useState<PhotoCrop | null>(null)
  const [dragging, setDragging] = useState(false)
  const drag = useRef<{ sx: number; sy: number; crop: PhotoCrop; scale: number; rw: number; rh: number } | null>(null)
  /** Fingers on the canvas, for pinch zoom. */
  const touches = useRef(new Map<number, { x: number; y: number }>())
  const pinch = useRef<{ d0: number; crop: PhotoCrop } | null>(null)
  const wheelTimer = useRef<ReturnType<typeof setTimeout>>(undefined)
  const f = formatOf(it)
  const win = photoWindow(f)
  const shown = useMemo(() => {
    const x = draft ? { ...it, crop: draft } : it
    // "compare": the photo exactly as uploaded – no enhance, no colour look
    return props.compare ? { ...x, enhance: 'off' as const, filter: 'none' as const } : x
  }, [it, draft, props.compare])

  useLayoutEffect(() => {
    const el = host.current
    if (!el) return
    const measure = () => setBox({ w: el.clientWidth, vh: window.innerHeight })
    const ro = new ResizeObserver(measure)
    ro.observe(el)
    measure()
    return () => ro.disconnect()
  }, [])
  // fit the card in the panel: full width, but never taller than 440 px or half the screen (phones)
  const maxH = Math.max(220, Math.min(440, box.vh * 0.5))
  const cssW = Math.max(120, Math.min(box.w, (maxH * f.widthMm) / f.heightMm))
  const cssH = (cssW * f.heightMm) / f.widthMm
  const pxPerCss = cssW / f.widthMm // css px per mm

  useEffect(() => {
    const c = canvas.current
    if (!c || !cssW) return
    const dpr = Math.min(2.5, window.devicePixelRatio || 1)
    const k = (cssW * dpr) / f.widthMm
    renderToCanvas(shown, photo, k, 0, c)
    if (dragging) {
      // rule-of-thirds guides while positioning
      const ctx = c.getContext('2d')!
      ctx.save()
      ctx.strokeStyle = 'rgba(255,255,255,0.75)'
      ctx.lineWidth = Math.max(1, dpr)
      ctx.shadowColor = 'rgba(0,0,0,0.5)'
      ctx.shadowBlur = 2
      ctx.beginPath()
      for (const t of [1 / 3, 2 / 3]) {
        ctx.moveTo((win.x + win.w * t) * k, win.y * k)
        ctx.lineTo((win.x + win.w * t) * k, (win.y + win.h) * k)
        ctx.moveTo(win.x * k, (win.y + win.h * t) * k)
        ctx.lineTo((win.x + win.w) * k, (win.y + win.h * t) * k)
      }
      ctx.stroke()
      ctx.restore()
    }
  }, [shown, photo, cssW, dragging, props.fontsReady, f.widthMm, win.x, win.y, win.w, win.h])

  const place = (c: PhotoCrop) => (photo ? placePhoto(c, photo.pxW, photo.pxH, win.w, win.h) : null)
  const current = () => draft ?? it.crop

  // wheel zoom needs a non-passive listener to keep the page from scrolling
  const latest = useRef({ current, place, onCrop: props.onCrop })
  latest.current = { current, place, onCrop: props.onCrop }
  useEffect(() => {
    const el = canvas.current
    if (!el) return
    const wheel = (e: WheelEvent) => {
      const { current, place, onCrop } = latest.current
      const p = place(current())
      if (!p) return
      e.preventDefault()
      const next = place({ ...p.crop, zoom: p.crop.zoom * Math.exp(-e.deltaY * 0.0015) })!.crop
      setDraft(next)
      clearTimeout(wheelTimer.current)
      wheelTimer.current = setTimeout(() => {
        onCrop(next)
        setDraft(null)
      }, 250)
    }
    el.addEventListener('wheel', wheel, { passive: false })
    return () => el.removeEventListener('wheel', wheel)
  }, [])

  const nudge = (dxMm: number, dyMm: number) => {
    const p = place(current())
    if (!p) return
    props.onCrop(place({ ...p.crop, cx: p.crop.cx + dxMm / (p.scale * p.rw), cy: p.crop.cy + dyMm / (p.scale * p.rh) })!.crop)
  }

  return (
    <div ref={host} className="flex w-full justify-center">
      <div
        tabIndex={0}
        className="rounded-[3px] outline-none focus-visible:ring-4 focus-visible:ring-brand-200"
        onKeyDown={(e) => {
          const s = e.shiftKey ? 4 : 1
          const map: Record<string, [number, number]> = { ArrowLeft: [-1, 0], ArrowRight: [1, 0], ArrowUp: [0, -1], ArrowDown: [0, 1] }
          const d = map[e.key]
          if (!d) return
          e.preventDefault()
          // the arrow moves the PHOTO, so the view point moves the other way
          nudge(-d[0] * NUDGE_MM * s, -d[1] * NUDGE_MM * s)
        }}
      >
        <canvas
          ref={canvas}
          aria-label="Polaroid – drag the photo to position it"
          className={`block touch-none rounded-[3px] shadow-[0_2px_6px_rgb(0_0_0/0.15),0_12px_32px_rgb(0_0_0/0.14)] ${photo ? (dragging ? 'cursor-grabbing' : 'cursor-grab') : ''}`}
          style={{ width: cssW, height: cssH }}
          onPointerDown={(e) => {
            const p = place(current())
            if (!p) return
            e.currentTarget.setPointerCapture(e.pointerId)
            touches.current.set(e.pointerId, { x: e.clientX, y: e.clientY })
            if (touches.current.size === 2) {
              // second finger: switch from moving to pinch-zooming
              const [a, b] = [...touches.current.values()]
              pinch.current = { d0: Math.hypot(a.x - b.x, a.y - b.y) || 1, crop: p.crop }
              drag.current = null
            } else if (touches.current.size === 1) drag.current = { sx: e.clientX, sy: e.clientY, crop: p.crop, scale: p.scale, rw: p.rw, rh: p.rh }
            setDragging(true)
          }}
          onPointerMove={(e) => {
            if (touches.current.has(e.pointerId)) touches.current.set(e.pointerId, { x: e.clientX, y: e.clientY })
            const pz = pinch.current
            if (pz && touches.current.size >= 2) {
              const [a, b] = [...touches.current.values()]
              const d = Math.hypot(a.x - b.x, a.y - b.y)
              setDraft(place({ ...pz.crop, zoom: (pz.crop.zoom * d) / pz.d0 })!.crop)
              return
            }
            const d = drag.current
            if (!d) return
            const dx = (e.clientX - d.sx) / pxPerCss
            const dy = (e.clientY - d.sy) / pxPerCss
            setDraft(place({ ...d.crop, cx: d.crop.cx - dx / (d.scale * d.rw), cy: d.crop.cy - dy / (d.scale * d.rh) })!.crop)
          }}
          onPointerUp={(e) => {
            touches.current.delete(e.pointerId)
            if (touches.current.size > 0) {
              // one finger lifted after a pinch: carry on moving with the other one, from the zoomed crop
              const rest = [...touches.current.values()][0]
              const p = place(draft ?? current())
              pinch.current = null
              if (p) drag.current = { sx: rest.x, sy: rest.y, crop: p.crop, scale: p.scale, rw: p.rw, rh: p.rh }
              if (draft) setDraft(p!.crop)
              return
            }
            drag.current = null
            pinch.current = null
            setDragging(false)
            if (draft) props.onCrop(draft)
            setDraft(null)
          }}
          onPointerCancel={(e) => {
            touches.current.delete(e.pointerId)
            if (touches.current.size) return
            drag.current = null
            pinch.current = null
            setDragging(false)
            setDraft(null)
          }}
        />
      </div>
    </div>
  )
}

/* ------------------------------------------------------------------ the editor panel */

function Section(props: { title: string; hint?: string; icon?: ReactNode; children: ReactNode; right?: ReactNode }) {
  return (
    <section className="border-t border-slate-100 px-4 py-4 sm:px-5">
      <div className="mb-3 flex items-start justify-between gap-2">
        <div className="flex items-start gap-2.5">
          {props.icon && <span className="mt-0.5 grid h-7 w-7 shrink-0 place-items-center rounded-lg bg-brand-50 text-brand-600">{props.icon}</span>}
          <div>
            <h3 className="text-sm font-bold text-slate-800">{props.title}</h3>
            {props.hint && <p className="text-xs text-slate-500">{props.hint}</p>}
          </div>
        </div>
        {props.right}
      </div>
      {props.children}
    </section>
  )
}

function Swatches(props: { value?: string; onChange: (c: string | undefined) => void; autoLabel: string; autoColor: string }) {
  return (
    <div className="flex flex-wrap items-center gap-1.5">
      <button
        title={props.autoLabel}
        onClick={() => props.onChange(undefined)}
        className={`h-7 rounded-full px-2.5 text-xs font-semibold ring-1 transition ${!props.value ? 'bg-brand-50 text-brand-700 ring-brand-300' : 'text-slate-500 ring-slate-200 hover:ring-slate-300'}`}
      >
        <span className="mr-1 inline-block h-2.5 w-2.5 rounded-full align-[-1px] ring-1 ring-black/10" style={{ background: props.autoColor }} />
        Theme
      </button>
      {SWATCHES.map((c) => (
        <button
          key={c}
          title={c}
          aria-label={`Colour ${c}`}
          onClick={() => props.onChange(c)}
          className={`h-7 w-7 rounded-full ring-1 ring-black/10 transition hover:scale-110 ${props.value?.toLowerCase() === c ? 'outline-2 outline-offset-2 outline-brand-500' : ''}`}
          style={{ background: c }}
        />
      ))}
      <label className="relative h-7 w-7 cursor-pointer overflow-hidden rounded-full bg-[conic-gradient(red,yellow,lime,cyan,blue,magenta,red)] ring-1 ring-black/10" title="Any colour">
        <input type="color" className="absolute inset-0 cursor-pointer opacity-0" value={props.value ?? props.autoColor} onChange={(e) => props.onChange(e.target.value)} />
      </label>
    </div>
  )
}

function ThemeTile(props: { it: PolaroidItem; theme: ThemeInfo; photo?: Photo; on: boolean; fontsReady: boolean; onClick: () => void }) {
  const it = useMemo<PolaroidItem>(() => ({ ...props.it, theme: props.theme.id, frameColor: undefined, caption: { ...props.it.caption, text: props.it.caption.text || ' ' } }), [props.it, props.theme.id])
  return (
    <button
      onClick={props.onClick}
      title={props.theme.name}
      className={`flex flex-col items-center gap-1.5 rounded-xl p-1.5 pt-2 transition ${props.on ? 'bg-brand-50 ring-2 ring-brand-500' : 'hover:bg-slate-50'}`}
    >
      <PolaroidThumb it={it} photo={props.photo} width={52} fontsReady={props.fontsReady} />
      <span className={`line-clamp-1 text-[11px] leading-tight ${props.on ? 'font-semibold text-brand-800' : 'text-slate-500'}`}>{props.theme.name}</span>
    </button>
  )
}

export default function PolaroidEditor(props: {
  it: PolaroidItem
  photo?: Photo
  job: PolaroidJob
  settings: PolaroidSettings
  fontsReady: boolean
  perSheet?: number
  onClose: () => void
  onFill: () => void
  onRemember: (patch: Partial<{ formatId: string; theme: PolaroidItem['theme']; filter: PolaroidItem['filter']; font: PolaroidItem['caption']['font']; enhance: NonNullable<PolaroidItem['enhance']> }>) => void
  onSelect: (id: string | null) => void
  toast: (msg: string) => void
}) {
  const { it, photo, job } = props
  const set = (patch: Partial<PolaroidItem>) => job.update(it.id, patch)
  const f = formatOf(it)
  const win = photoWindow(f)
  const theme = themeOf(it.theme)
  const dpi = photo ? photoDpi(it, photo.pxW, photo.pxH) : null
  const minZ = photo ? minZoom(photo.pxW, photo.pxH, it.crop.turn, win.w, win.h) : 1
  const zoom = photo ? placePhoto(it.crop, photo.pxW, photo.pxH, win.w, win.h).crop.zoom : 1
  const setCrop = (c: Partial<PhotoCrop>) => set({ crop: { ...it.crop, ...c } })
  const setCaption = (c: Partial<PolaroidItem['caption']>) => set({ caption: { ...it.caption, ...c } })
  const lz = (z: number) => Math.log(z)
  const many = job.items.length > 1
  const enhance = it.enhance ?? 'off'
  const changed = enhance !== 'off' || it.filter !== 'none'
  /** Held down: show the photo exactly as uploaded. */
  const [compare, setCompare] = useState(false)
  const hold = {
    onPointerDown: (e: PointerEvent) => {
      e.preventDefault()
      setCompare(true)
    },
    onPointerUp: () => setCompare(false),
    onPointerLeave: () => setCompare(false),
    onPointerCancel: () => setCompare(false),
    onKeyDown: (e: KeyboardEvent) => (e.key === ' ' || e.key === 'Enter') && setCompare(true),
    onKeyUp: () => setCompare(false),
    onContextMenu: (e: MouseEvent) => e.preventDefault(),
  }

  return (
    <div className="flex h-full flex-col">
      <div className="flex items-center gap-2 border-b border-slate-100 px-4 py-2.5 sm:px-5 sm:py-3">
        <span className="hidden shrink-0 rounded-full bg-brand-50 px-2 py-0.5 text-[11px] font-bold text-brand-700 ring-1 ring-brand-200 max-lg:inline">Editing</span>
        <input
          className="min-w-0 flex-1 rounded-lg bg-transparent px-2 py-1 -ml-2 font-semibold text-slate-900 outline-none hover:bg-slate-50 focus:bg-slate-50 focus:ring-2 focus:ring-brand-200"
          value={it.name}
          onChange={(e) => set({ name: e.target.value })}
          aria-label="Name"
        />
        <button className="btn-icon btn-ghost -mr-2" onClick={props.onClose} aria-label="Close editor">
          <X size={18} />
        </button>
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto">
        {/* ---------------- photo position */}
        <div className="relative bg-[radial-gradient(circle_at_50%_35%,#f8f7fc,#ecebf3)] px-4 pt-4 pb-4 sm:px-5 sm:pt-5">
          <CropCanvas it={it} photo={photo} fontsReady={props.fontsReady} compare={compare} onCrop={(c) => set({ crop: c })} />
          {compare && <div className="pointer-events-none absolute top-6 left-1/2 -translate-x-1/2 rounded-full bg-black/70 px-3 py-1 text-xs font-semibold text-white">Original photo</div>}
          <div className="mt-4 flex items-center gap-2">
            <button className="btn-icon btn-ghost h-8 w-8" aria-label="Zoom out" onClick={() => setCrop({ zoom: Math.max(minZ, zoom / 1.15) })}>
              <Minus size={15} />
            </button>
            <input
              type="range"
              aria-label="Zoom"
              className="flex-1 accent-brand-600"
              min={lz(minZ)}
              max={lz(MAX_ZOOM)}
              step={0.005}
              value={lz(zoom)}
              disabled={!photo}
              onChange={(e) => setCrop({ zoom: Math.exp(Number(e.target.value)) })}
            />
            <button className="btn-icon btn-ghost h-8 w-8" aria-label="Zoom in" onClick={() => setCrop({ zoom: Math.min(MAX_ZOOM, zoom * 1.15) })}>
              <Plus size={15} />
            </button>
            <span className="w-11 text-right text-xs font-semibold text-slate-500 tabular-nums">{Math.round(zoom * 100)}%</span>
          </div>
          <div className="mt-2 grid grid-cols-5 gap-1">
            {(
              [
                ['Fill', <Maximize size={15} />, () => setCrop({ zoom: 1 }), 'Photo fills the window'],
                ['Whole', <Minimize size={15} />, () => setCrop({ zoom: minZ, cx: 0.5, cy: 0.5 }), 'Show the whole photo'],
                ['Centre', <Crosshair size={15} />, () => setCrop({ cx: 0.5, cy: 0.5 }), 'Centre the photo'],
                ['Rotate', <RotateCw size={15} />, () => setCrop({ turn: ((it.crop.turn + 1) % 4) as PhotoCrop['turn'], cx: 0.5, cy: 0.5, zoom: 1 }), 'Turn the photo 90°'],
                ['Flip', <FlipHorizontal2 size={15} />, () => setCrop({ flip: !it.crop.flip, cx: 1 - it.crop.cx }), 'Mirror the photo'],
              ] as const
            ).map(([label, icon, onClick, title]) => (
              <button key={label} title={title} disabled={!photo} onClick={onClick} className="flex flex-col items-center gap-0.5 rounded-lg py-1.5 text-[11px] font-medium text-slate-600 transition hover:bg-white hover:text-slate-900 disabled:opacity-40">
                {icon}
                {label}
              </button>
            ))}
          </div>
          <p className="mt-2 flex items-center justify-center gap-1.5 text-center text-xs text-slate-500">
            <Crop size={13} className="shrink-0 text-brand-500" />
            <span className="hidden sm:inline">Drag the photo to place it · scroll to zoom · arrow keys nudge</span>
            <span className="sm:hidden">Drag the photo to place it · pinch with two fingers to zoom</span>
          </p>
          {dpi !== null && dpi < props.settings.minDpi && (
            <div className="mt-3 flex items-start gap-2 rounded-xl bg-amber-50 px-3 py-2 text-xs text-amber-800 ring-1 ring-amber-600/20">
              <AlertTriangle size={14} className="mt-px shrink-0" />
              <span>
                Prints at about <b>{dpi} DPI</b> – it may look soft. Zoom out, or use a bigger photo.
              </span>
            </div>
          )}
        </div>

        {/* ---------------- enhance & look */}
        <Section title="Enhance" icon={<Sparkles size={15} />} hint="Clearer, brighter, sharper – your original photo is never changed">
          <Segmented
            full
            aria-label="Enhance"
            value={enhance}
            onChange={(v) => {
              set({ enhance: v })
              props.onRemember({ enhance: v })
            }}
            options={ENHANCE_LEVELS.map((l) => ({ value: l.id, label: <>{l.id !== 'off' && <Sparkles size={13} />}{l.name}</>, hint: l.hint }))}
          />
          <p className="mt-2 text-xs text-slate-500">{ENHANCE_LEVELS.find((l) => l.id === enhance)?.hint}.</p>
          <div className="mt-4 mb-2 text-sm font-medium text-slate-700">Colour look</div>
          <div className="flex flex-wrap gap-1.5">
            {FILTERS.map((x) => (
              <button
                key={x.id}
                onClick={() => {
                  set({ filter: x.id })
                  props.onRemember({ filter: x.id })
                }}
                className={`rounded-full px-3 py-1.5 text-xs font-semibold ring-1 transition ${it.filter === x.id ? 'bg-brand-600 text-white ring-brand-600' : 'text-slate-600 ring-slate-200 hover:ring-slate-300'}`}
              >
                {x.name}
              </button>
            ))}
          </div>
          <button
            {...hold}
            disabled={!changed || !photo}
            className={`btn-secondary mt-4 w-full touch-none select-none ${compare ? 'bg-slate-100 ring-slate-300' : ''}`}
            title="Hold to see the photo as uploaded"
          >
            <Eye size={15} /> {changed ? (compare ? 'Showing the original…' : 'Hold to compare with the original') : 'Nothing changed yet'}
          </button>
        </Section>

        {/* ---------------- size */}
        <Section title="Size" icon={<Ruler size={15} />} hint="Finished size of the polaroid" right={<span className="text-xs text-slate-400 tabular-nums">{fmtMm(f.widthMm)} × {fmtMm(f.heightMm)} mm</span>}>
          <div className="grid grid-cols-3 gap-1.5">
            {[...FORMATS, { id: CUSTOM_FORMAT_ID, name: 'Custom', hint: 'Your own size and borders', widthMm: 0, heightMm: 0 }].map((x) => {
              const on = it.formatId === x.id
              return (
                <button
                  key={x.id}
                  title={x.hint}
                  onClick={() => {
                    set({ formatId: x.id, ...(x.id === CUSTOM_FORMAT_ID && !it.custom ? { custom: { ...DEFAULT_CUSTOM } } : {}) })
                    props.onRemember({ formatId: x.id })
                  }}
                  className={`rounded-xl px-2 py-2 text-left ring-1 transition ${on ? 'bg-brand-50 ring-2 ring-brand-500' : 'ring-slate-200 hover:ring-slate-300'}`}
                >
                  <div className={`text-sm font-semibold ${on ? 'text-brand-800' : 'text-slate-800'}`}>{x.name}</div>
                  <div className="text-[11px] text-slate-400 tabular-nums">{x.widthMm ? `${fmtMm(x.widthMm)}×${fmtMm(x.heightMm)}` : 'any'}</div>
                </button>
              )
            })}
          </div>
          <p className="mt-2 text-xs text-slate-400">{f.hint}</p>
          {it.formatId === CUSTOM_FORMAT_ID && (
            <div className="mt-3 grid grid-cols-2 gap-x-3 gap-y-2 text-sm">
              {(
                [
                  ['Width', 'widthMm'],
                  ['Height', 'heightMm'],
                  ['Side border', 'sideMm'],
                  ['Top border', 'topMm'],
                  ['Bottom border', 'bottomMm'],
                ] as const
              ).map(([label, key]) => (
                <label key={key} className="flex items-center justify-between gap-2">
                  <span className="text-slate-600">{label}</span>
                  <NumberField value={f[key]} min={key.endsWith('Mm') && (key === 'widthMm' || key === 'heightMm') ? 20 : 0} max={400} suffix="mm" onChange={(v) => set({ custom: { ...DEFAULT_CUSTOM, ...it.custom, [key]: v } })} />
                </label>
              ))}
              {formatProblems(f).map((p) => (
                <p key={p} className="col-span-2 text-xs text-amber-700">
                  {p}
                </p>
              ))}
            </div>
          )}
        </Section>

        {/* ---------------- caption */}
        <Section title="Caption" icon={<Type size={15} />} hint="Written on the bottom strip – leave empty for none">
          <textarea
            rows={2}
            value={it.caption.text}
            onChange={(e) => setCaption({ text: e.target.value })}
            placeholder="Write something… (Enter for a new line)"
            className="field w-full resize-none py-2 text-sm"
            style={{ fontFamily: `"${FONTS.find((x) => x.id === it.caption.font)?.family ?? 'Caveat'}"`, fontSize: 18 }}
          />
          <div className="mt-3 grid grid-cols-3 gap-1.5">
            {FONTS.map((x) => {
              const on = it.caption.font === x.id
              return (
                <button
                  key={x.id}
                  onClick={() => {
                    setCaption({ font: x.id })
                    props.onRemember({ font: x.id })
                  }}
                  className={`truncate rounded-lg px-2 py-1.5 text-[15px] ring-1 transition ${on ? 'bg-brand-50 text-brand-800 ring-2 ring-brand-500' : 'text-slate-700 ring-slate-200 hover:ring-slate-300'}`}
                  style={{ fontFamily: `"${x.family}"`, fontWeight: x.weight }}
                >
                  {x.name}
                </button>
              )
            })}
          </div>
          <div className="mt-3 flex items-center gap-3">
            <span className="w-10 text-sm text-slate-600">Size</span>
            <input type="range" min={2.5} max={14} step={0.25} value={it.caption.sizeMm} onChange={(e) => setCaption({ sizeMm: Number(e.target.value) })} className="flex-1 accent-brand-600" aria-label="Caption size" />
            <Segmented
              size="sm"
              aria-label="Alignment"
              value={it.caption.align}
              onChange={(align) => setCaption({ align })}
              options={[
                { value: 'left', label: <AlignLeft size={14} />, hint: 'Left' },
                { value: 'center', label: <AlignCenter size={14} />, hint: 'Centre' },
                { value: 'right', label: <AlignRight size={14} />, hint: 'Right' },
              ]}
            />
          </div>
          <div className="mt-3">
            <Swatches value={it.caption.color} onChange={(color) => setCaption({ color })} autoLabel="The theme's colour" autoColor={theme.ink} />
          </div>
        </Section>

        {/* ---------------- theme */}
        <Section title="Frame theme" icon={<Palette size={15} />} hint="The design around the photo">
          {(['Plain', 'Colour', 'Cute', 'Pattern', 'Occasion'] as const).map((g) => (
            <div key={g} className="mb-2">
              <div className="mb-1 text-[11px] font-semibold text-slate-400">{g}</div>
              <div className="grid grid-cols-4 gap-1">
                {THEMES.filter((t) => t.group === g).map((t) => (
                  <ThemeTile
                    key={t.id}
                    it={it}
                    theme={t}
                    photo={photo}
                    on={it.theme === t.id}
                    fontsReady={props.fontsReady}
                    onClick={() => {
                      set({ theme: t.id, frameColor: undefined })
                      props.onRemember({ theme: t.id })
                    }}
                  />
                ))}
              </div>
            </div>
          ))}
          {theme.recolorable && (
            <div className="mt-3">
              <div className="mb-2 text-sm text-slate-600">Frame colour</div>
              <Swatches value={it.frameColor} onChange={(frameColor) => set({ frameColor })} autoLabel="The theme's colour" autoColor={theme.base} />
            </div>
          )}
        </Section>

        {/* ---------------- copies & sheet */}
        <Section title="Copies" icon={<Layers size={15} />} hint="How many of this polaroid to print">
          <div className="flex flex-wrap items-center gap-3">
            <Stepper value={it.copies} min={0} onChange={(copies) => set({ copies })} label="Copies" />
            <button className="btn-secondary px-3 py-2 text-xs" onClick={props.onFill} title="Add copies until the last sheet is full">
              <PackagePlus size={14} /> Fill the sheet
            </button>
            {props.perSheet ? <span className="text-xs text-slate-400">{props.perSheet} fit on a sheet</span> : null}
          </div>
          <div className="mt-3 flex items-center gap-3">
            <span className="text-sm text-slate-600">On the sheet</span>
            <Segmented
              size="sm"
              value={String(it.rotation) as 'auto' | '0' | '90'}
              onChange={(v) => set({ rotation: v === 'auto' ? 'auto' : (Number(v) as 0 | 90) })}
              options={[
                { value: 'auto', label: 'Auto', hint: 'Turned when more fit' },
                { value: '0', label: 'Upright' },
                { value: '90', label: 'Sideways' },
              ]}
            />
          </div>
        </Section>

        {/* ---------------- all photos */}
        {many && (
          <Section title="Use for all photos" icon={<Wand2 size={15} />} hint="Copy this polaroid's settings to every photo">
            <div className="grid grid-cols-2 gap-1.5">
              {(
                [
                  ['This size', () => job.updateAll(() => ({ formatId: it.formatId, custom: it.custom }))],
                  ['This theme', () => job.updateAll(() => ({ theme: it.theme, frameColor: it.frameColor }))],
                  ['This enhance', () => job.updateAll(() => ({ enhance }))],
                  ['This photo look', () => job.updateAll(() => ({ filter: it.filter }))],
                  ['This caption style', () => job.updateAll((o) => ({ caption: { ...it.caption, text: o.caption.text } }))],
                  ['This caption text', () => job.updateAll((o) => ({ caption: { ...o.caption, text: it.caption.text } }))],
                  ['This number of copies', () => job.updateAll(() => ({ copies: it.copies }))],
                ] as const
              ).map(([label, fn]) => (
                <button
                  key={label}
                  className="btn-secondary justify-start px-3 py-2 text-xs"
                  onClick={() => {
                    fn()
                    props.toast(`${label.replace('This ', '')[0].toUpperCase()}${label.replace('This ', '').slice(1)} used for all ${job.items.length} photos`)
                  }}
                >
                  <Wand2 size={13} className="text-brand-500" /> {label}
                </button>
              ))}
            </div>
          </Section>
        )}

        <div className="flex gap-2 border-t border-slate-100 px-5 py-4">
          <button className="btn-secondary flex-1 px-3 text-xs" onClick={() => props.onSelect(job.duplicate(it.id))} title="Another polaroid of this photo – e.g. with a different crop or caption">
            <Copy size={14} /> Another with this photo
          </button>
          <button
            className="btn-ghost px-3 text-xs text-red-600 hover:bg-red-50 hover:text-red-700"
            onClick={() => {
              job.remove(it.id)
              props.onSelect(null)
            }}
          >
            <Trash2 size={14} /> Remove
          </button>
        </div>
      </div>
      <div className="border-t border-slate-200/70 bg-white/90 px-4 py-2.5 pb-[max(0.625rem,env(safe-area-inset-bottom))] backdrop-blur lg:hidden">
        <button className="btn-primary w-full" onClick={props.onClose}>
          <Check size={16} /> Done – back to photos
        </button>
      </div>
    </div>
  )
}
