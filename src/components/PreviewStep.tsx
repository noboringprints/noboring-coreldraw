import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { PrintSettings } from '../config/defaults'
import { buildPrintPdf } from '../lib/exportPdf'
import { expand } from '../lib/geometry'
import type { ArtRef, Design, DesignCheck } from '../lib/job'
import type { PlacementOverride, Sheet } from '../lib/layout'
import { browserRasterizer, renderPdfPage } from '../lib/pdfRender'
import type { SourceFile } from '../lib/sources'
import { AlertTriangle, ChevronDown, ChevronLeft, ChevronRight, Eye, Maximize, MousePointerClick, Plus, Ruler, RotateCw, Undo2, X, ZoomIn, ZoomOut } from 'lucide-react'
import { DESIGN_COLORS, SheetDiagram, Stepper, fmtMm } from './ui'
import FillSpace from './FillSpace'

/** CSS pixels per mm at 100 % zoom (96 px per inch). */
const PX_PER_MM_100 = 96 / 25.4
const RULER = 26

type Overlays = { trim: boolean; bleed: boolean; safe: boolean; marks: boolean; margin: boolean }

export default function PreviewStep(props: {
  sheets: Sheet<ArtRef>[]
  sources: Record<string, SourceFile>
  settings: PrintSettings
  designs: Design[]
  checks: Record<string, DesignCheck>
  trimNames: Record<string, string>
  overrides: Record<string, PlacementOverride | undefined>
  setOverride: (id: string, o: PlacementOverride | undefined) => void
  onUpdateDesign: (id: string, patch: Partial<Design>) => void
  thumbs?: Record<string, string>
  onAddFiles: (files: File[], trim: { name: string; w: number; h: number }) => void
  onRepeat: (designId: string, pageIndex: number) => void
}) {
  const { sheets, settings } = props
  const W = settings.sheet.widthMm
  const H = settings.sheet.heightMm
  const [sheetIdx, setSheetIdx] = useState(0)
  const sheet = sheets[Math.min(sheetIdx, sheets.length - 1)]
  const [zoom, setZoom] = useState(1.5) // px per mm
  const [pan, setPan] = useState({ x: 40, y: 40 }) // screen position of the sheet's top-left corner
  const [overlays, setOverlays] = useState<Overlays>({ trim: true, bleed: true, safe: true, marks: true, margin: false })
  const [selected, setSelected] = useState<string | null>(null)
  const [showLayers, setShowLayers] = useState(false)
  const [fillOpen, setFillOpen] = useState(false)
  const [drag, setDrag] = useState<{ id: string; dx: number; dy: number } | null>(null)
  const [cursor, setCursor] = useState<{ x: number; y: number } | null>(null)
  const [img, setImg] = useState<{ url: string; key: string } | null>(null)
  const [busy, setBusy] = useState(false)
  const [renderError, setRenderError] = useState<string | null>(null)
  const viewport = useRef<HTMLDivElement>(null)
  const topRuler = useRef<HTMLCanvasElement>(null)
  const leftRuler = useRef<HTMLCanvasElement>(null)
  const [vp, setVp] = useState({ w: 800, h: 600 })

  useEffect(() => {
    if (sheetIdx >= sheets.length && sheets.length) setSheetIdx(sheets.length - 1)
  }, [sheets.length, sheetIdx])

  // ---- viewport size ----
  useEffect(() => {
    const el = viewport.current
    if (!el) return
    const ro = new ResizeObserver(() => setVp({ w: el.clientWidth, h: el.clientHeight }))
    ro.observe(el)
    setVp({ w: el.clientWidth, h: el.clientHeight })
    return () => ro.disconnect()
  }, [])

  const fit = useCallback(() => {
    const z = Math.min((vp.w - 60) / W, (vp.h - 60) / H)
    setZoom(z)
    setPan({ x: (vp.w - W * z) / 2, y: (vp.h - H * z) / 2 })
  }, [vp.w, vp.h, W, H])
  const fitted = useRef(false)
  useEffect(() => {
    if (!fitted.current && vp.w > 100) {
      fitted.current = true
      fit()
    }
  }, [vp.w, fit])

  const zoomAt = useCallback(
    (factor: number, cx = vp.w / 2, cy = vp.h / 2) => {
      setZoom((z) => {
        const nz = Math.min(40, Math.max(0.3, z * factor))
        setPan((p) => ({ x: cx - ((cx - p.x) / z) * nz, y: cy - ((cy - p.y) / z) * nz }))
        return nz
      })
    },
    [vp.w, vp.h],
  )

  // wheel = zoom around the mouse (needs a non-passive listener to stop page scrolling)
  useEffect(() => {
    const el = viewport.current
    if (!el) return
    const onWheel = (e: WheelEvent) => {
      e.preventDefault()
      const r = el.getBoundingClientRect()
      zoomAt(Math.exp(-e.deltaY * 0.0015), e.clientX - r.left, e.clientY - r.top)
    }
    el.addEventListener('wheel', onWheel, { passive: false })
    return () => el.removeEventListener('wheel', onWheel)
  }, [zoomAt])

  // ---- render the real output PDF for this sheet with pdf.js ----
  const dpr = typeof window !== 'undefined' ? window.devicePixelRatio || 1 : 1
  const res = Math.min(14, Math.max(2, 2 ** Math.ceil(Math.log2(zoom * dpr)))) // px/mm, in steps so we don't re-render on every wheel tick
  const sheetKey = useMemo(
    () => (sheet ? JSON.stringify([sheet.placements.map((p) => [p.item.id, p.trim, p.rotation, p.item.art]), sheet.index, sheets.length, settings, props.trimNames]) : ''),
    [sheet, sheets.length, settings, props.trimNames],
  )
  useEffect(() => {
    if (!sheet) return
    const signal = { cancelled: false }
    setBusy(true)
    const t = setTimeout(async () => {
      try {
        const bytes = await buildPrintPdf([sheet], props.sources, settings, { totalSheets: sheets.length, trimNames: props.trimNames, rasterizer: browserRasterizer })
        const canvas = await renderPdfPage(bytes, 0, res, signal)
        if (!canvas || signal.cancelled) return
        canvas.toBlob((b) => {
          if (!b || signal.cancelled) return
          setImg((old) => {
            if (old) URL.revokeObjectURL(old.url)
            return { url: URL.createObjectURL(b), key: sheetKey }
          })
          setRenderError(null)
          setBusy(false)
        })
      } catch (e) {
        if (!signal.cancelled) {
          setRenderError((e as Error).message)
          setBusy(false)
        }
      }
    }, 120)
    return () => {
      signal.cancelled = true
      clearTimeout(t)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sheetKey, res])

  // ---- rulers ----
  useEffect(() => {
    const draw = (cv: HTMLCanvasElement | null, horizontal: boolean) => {
      if (!cv) return
      const len = horizontal ? vp.w : vp.h
      cv.width = len * dpr
      cv.height = RULER * dpr
      if (!horizontal) {
        cv.width = RULER * dpr
        cv.height = len * dpr
      }
      const ctx = cv.getContext('2d')!
      ctx.scale(dpr, dpr)
      ctx.fillStyle = '#1f1e29'
      ctx.fillRect(0, 0, horizontal ? len : RULER, horizontal ? RULER : len)
      ctx.strokeStyle = '#4a4860'
      ctx.fillStyle = '#9a98ad'
      ctx.font = '500 10px Inter Variable, system-ui, sans-serif'
      ctx.lineWidth = 1
      const minor = [0.5, 1, 2, 5, 10, 20, 50, 100].find((s) => s * zoom >= 5) ?? 100
      const label = [1, 5, 10, 20, 50, 100, 200, 500].find((s) => s * zoom >= 55) ?? 500
      // mm visible at the edges
      const toMm = (px: number) => (horizontal ? (px - pan.x) / zoom : H - (px - pan.y) / zoom)
      const toPx = (mm: number) => (horizontal ? pan.x + mm * zoom : pan.y + (H - mm) * zoom)
      const a = toMm(0)
      const b = toMm(len)
      const lo = Math.floor(Math.min(a, b) / minor) * minor
      const hi = Math.max(a, b)
      ctx.beginPath()
      for (let mm = lo; mm <= hi; mm += minor) {
        const px = Math.round(toPx(mm)) + 0.5
        const isLabel = Math.abs(mm / label - Math.round(mm / label)) < 1e-6
        const tick = isLabel ? RULER * 0.6 : Math.abs(mm / (minor * 5) - Math.round(mm / (minor * 5))) < 1e-6 ? RULER * 0.35 : RULER * 0.2
        if (horizontal) {
          ctx.moveTo(px, RULER)
          ctx.lineTo(px, RULER - tick)
          if (isLabel) ctx.fillText(String(Math.round(mm * 10) / 10), px + 2, 10)
        } else {
          ctx.moveTo(RULER, px)
          ctx.lineTo(RULER - tick, px)
          if (isLabel) {
            ctx.save()
            ctx.translate(10, px - 2)
            ctx.rotate(-Math.PI / 2)
            ctx.fillText(String(Math.round(mm * 10) / 10), 0, 0)
            ctx.restore()
          }
        }
      }
      ctx.stroke()
      // cursor line
      if (cursor) {
        ctx.strokeStyle = '#8f78ff'
        ctx.beginPath()
        const px = Math.round(toPx(horizontal ? cursor.x : cursor.y)) + 0.5
        if (horizontal) {
          ctx.moveTo(px, 0)
          ctx.lineTo(px, RULER)
        } else {
          ctx.moveTo(0, px)
          ctx.lineTo(RULER, px)
        }
        ctx.stroke()
      }
    }
    draw(topRuler.current, true)
    draw(leftRuler.current, false)
  }, [zoom, pan, vp, H, dpr, cursor])

  // ---- pointer handling: drag a design to move it, drag empty space to pan ----
  const action = useRef<{ kind: 'pan' | 'move'; id?: string; sx: number; sy: number; px: number; py: number; moved: boolean } | null>(null)
  const onPointerDown = (e: React.PointerEvent, placementId?: string) => {
    e.stopPropagation()
    ;(e.currentTarget as Element).setPointerCapture?.(e.pointerId)
    action.current = { kind: placementId && e.button === 0 ? 'move' : 'pan', id: placementId, sx: e.clientX, sy: e.clientY, px: pan.x, py: pan.y, moved: false }
    if (placementId) setSelected(placementId)
    else if (e.button === 0) setSelected(null)
  }
  const onPointerMove = (e: React.PointerEvent) => {
    const r = viewport.current!.getBoundingClientRect()
    setCursor({ x: (e.clientX - r.left - pan.x) / zoom, y: H - (e.clientY - r.top - pan.y) / zoom })
    const a = action.current
    if (!a) return
    const dx = e.clientX - a.sx
    const dy = e.clientY - a.sy
    if (Math.abs(dx) + Math.abs(dy) > 3) a.moved = true
    if (a.kind === 'pan') setPan({ x: a.px + dx, y: a.py + dy })
    else if (a.moved) setDrag({ id: a.id!, dx: snap(dx / zoom), dy: snap(-dy / zoom) })
  }
  const onPointerUp = () => {
    const a = action.current
    action.current = null
    if (a?.kind === 'move' && a.moved && drag) {
      const o = props.overrides[a.id!] ?? {}
      props.setOverride(a.id!, { ...o, dx: round(drag.dx + (o.dx ?? 0)), dy: round(drag.dy + (o.dy ?? 0)) })
    }
    setDrag(null)
  }

  const sel = sheet?.placements.find((p) => p.id === selected)
  const selDesign = sel ? props.designs.find((d) => d.id === sel.item.designId) : undefined
  const selWarnings = selDesign ? (props.checks[selDesign.id]?.warnings ?? []) : []

  const colorOf = (designId: string) => DESIGN_COLORS[Math.max(0, props.designs.findIndex((d) => d.id === designId)) % DESIGN_COLORS.length]

  if (!sheet) return <div className="grid h-full place-items-center bg-canvas text-slate-400">Nothing to preview yet – add designs first.</div>

  const b = settings.bleedMm
  const sizeName = props.trimNames[sheet.groupKey] ?? 'Custom'
  const imgFresh = img?.key === sheetKey
  const zoomPct = Math.round((zoom / PX_PER_MM_100) * 100)
  const problems = [
    ...(renderError ? [`Preview failed: ${renderError}`] : []),
    ...sheet.warnings,
    ...selWarnings.filter((w) => !w.startsWith('Bleed was added')).map((w) => `${sel?.item.name}: ${w}`),
  ]

  const LAYERS: [keyof Overlays, string, string][] = [
    ['trim', 'Cut line', '#e879f9'],
    ['bleed', 'Bleed', '#22d3ee'],
    ['safe', `Safe zone ${settings.safeZoneMm} mm`, '#34d399'],
    ['marks', 'Crop marks', '#fb923c'],
    ['margin', 'Margin', '#94a3b8'],
  ]

  return (
    <div className="flex h-full min-h-0 bg-canvas text-slate-200">
      {/* ---------- sheet strip ---------- */}
      <aside className="hidden w-64 shrink-0 flex-col border-r border-white/5 bg-canvas-2/50 md:flex">
        <div className="flex items-center justify-between px-4 pt-4 pb-3">
          <span className="text-[11px] font-semibold tracking-wider text-slate-400 uppercase">Sheets</span>
          <span className="rounded-full bg-white/10 px-2 py-0.5 text-xs font-semibold text-slate-200">{sheets.length}</span>
        </div>
        <div className="flex-1 space-y-1.5 overflow-y-auto px-3 pb-4">
          {sheets.map((s, i) => (
            <button
              key={s.id}
              onClick={() => {
                setSheetIdx(i)
                setSelected(null)
                setFillOpen(false)
              }}
              className={`flex w-full items-center gap-3 rounded-2xl p-2.5 text-left transition ${i === sheetIdx ? 'bg-brand-500/20 ring-1 ring-brand-400/50' : 'hover:bg-white/5'}`}
            >
              <SheetDiagram dark sheetW={W} sheetH={H} bleed={b} height={60} trims={s.placements.map((p) => ({ rect: p.trim, color: colorOf(p.item.designId) }))} />
              <div className="min-w-0 flex-1">
                <div className="flex items-center gap-2 text-sm font-semibold text-white">
                  Sheet {i + 1}
                  {s.warnings.length > 0 && <AlertTriangle size={13} className="text-amber-400" />}
                </div>
                <div className="text-xs text-slate-400">
                  {props.trimNames[s.groupKey] ?? `${fmtMm(s.trimW)}×${fmtMm(s.trimH)}`} · {s.placements.length} up
                  {s.freeSlots.length > 0 && <span className="text-amber-300"> · {s.freeSlots.length} empty</span>}
                </div>
                <div className="mt-0.5 truncate text-[11px] text-slate-500">
                  {[...new Set(s.placements.map((p) => p.item.name + (p.item.panel ? ` ${p.item.panel.index}/${p.item.panel.total}` : '')))].join(', ')}
                </div>
              </div>
            </button>
          ))}
        </div>
      </aside>

      {/* ---------- canvas ---------- */}
      <section className="relative min-w-0 flex-1" style={{ display: 'grid', gridTemplateColumns: `${RULER}px 1fr`, gridTemplateRows: `${RULER}px 1fr` }}>
        <div className="z-10 grid place-items-center border-r border-b border-white/5 bg-canvas-2 text-[9px] font-semibold text-slate-500">mm</div>
        <canvas ref={topRuler} className="z-10 border-b border-white/5" style={{ width: '100%', height: RULER }} />
        <canvas ref={leftRuler} className="z-10 border-r border-white/5" style={{ width: RULER, height: '100%' }} />
        <div
          ref={viewport}
          className="relative overflow-hidden"
          style={{
            cursor: action.current?.kind === 'pan' ? 'grabbing' : 'grab',
            touchAction: 'none',
            backgroundImage: 'radial-gradient(rgb(255 255 255 / 0.06) 1px, transparent 1px)',
            backgroundSize: '22px 22px',
          }}
          onPointerDown={(e) => onPointerDown(e)}
          onPointerMove={onPointerMove}
          onPointerUp={onPointerUp}
          onPointerLeave={() => setCursor(null)}
        >
          <div className="absolute rounded-[2px] bg-white shadow-[0_20px_60px_rgb(0_0_0/0.55)]" style={{ left: pan.x, top: pan.y, width: W * zoom, height: H * zoom }}>
            {img && <img src={img.url} alt={`Sheet ${sheetIdx + 1}`} draggable={false} className="h-full w-full transition-opacity select-none" style={{ opacity: imgFresh ? 1 : 0.55 }} />}
          </div>
          <svg className="absolute overflow-visible" style={{ left: pan.x, top: pan.y }} width={W * zoom} height={H * zoom} viewBox={`0 0 ${W} ${H}`}>
            <g transform={`translate(0 ${H}) scale(1 -1)`}>
              {overlays.margin && (
                <rect
                  x={settings.marginMm}
                  y={settings.marginMm}
                  width={W - 2 * settings.marginMm}
                  height={H - 2 * settings.marginMm}
                  fill="none"
                  stroke="#94a3b8"
                  strokeDasharray="4 3"
                  strokeWidth={1}
                  vectorEffect="non-scaling-stroke"
                />
              )}
              {sheet.placements.map((p) => {
                const isDrag = drag?.id === p.id
                const t = isDrag ? { ...p.trim, x: p.trim.x + drag.dx, y: p.trim.y + drag.dy } : p.trim
                const bl = expand(t, b)
                const sz = settings.safeZoneMm
                return (
                  <g key={p.id} onPointerDown={(e) => onPointerDown(e, p.id)} style={{ cursor: 'move' }}>
                    {overlays.bleed && (
                      <path
                        d={`M${bl.x} ${bl.y}h${bl.w}v${bl.h}h${-bl.w}z M${t.x} ${t.y}v${t.h}h${t.w}v${-t.h}z`}
                        fill="rgba(34,211,238,0.22)"
                        fillRule="evenodd"
                        stroke="#22d3ee"
                        strokeWidth={1}
                        vectorEffect="non-scaling-stroke"
                      />
                    )}
                    <rect x={t.x} y={t.y} width={t.w} height={t.h} fill={isDrag ? 'rgba(109,74,255,0.18)' : 'transparent'} />
                    {overlays.safe && t.w > 2 * sz && t.h > 2 * sz && (
                      <rect
                        x={t.x + sz}
                        y={t.y + sz}
                        width={t.w - 2 * sz}
                        height={t.h - 2 * sz}
                        fill="none"
                        stroke="#34d399"
                        strokeWidth={1}
                        strokeDasharray="3 3"
                        vectorEffect="non-scaling-stroke"
                        pointerEvents="none"
                      />
                    )}
                    {overlays.trim && <rect x={t.x} y={t.y} width={t.w} height={t.h} fill="none" stroke="#e879f9" strokeWidth={1.25} strokeDasharray="6 3" vectorEffect="non-scaling-stroke" />}
                    {selected === p.id && <rect x={bl.x} y={bl.y} width={bl.w} height={bl.h} fill="none" stroke="#6d4aff" strokeWidth={2.5} vectorEffect="non-scaling-stroke" />}
                  </g>
                )
              })}
              {overlays.marks &&
                sheet.marks.map((m, i) => (
                  <line key={i} x1={m.x1} y1={m.y1} x2={m.x2} y2={m.y2} stroke="#fb923c" strokeWidth={3} strokeOpacity={0.7} vectorEffect="non-scaling-stroke" pointerEvents="none" />
                ))}
              {sheet.label && overlays.margin && (
                <rect
                  x={sheet.label.box.x}
                  y={sheet.label.box.y}
                  width={sheet.label.box.w}
                  height={sheet.label.box.h}
                  fill="rgba(148,163,184,0.15)"
                  stroke="#94a3b8"
                  strokeDasharray="2 2"
                  vectorEffect="non-scaling-stroke"
                />
              )}
            </g>
          </svg>

          {/* ---------- empty spaces: click to fill ---------- */}
          {sheet.freeSlots.map((r, i) => (
            <button
              key={i}
              className="group absolute grid place-items-center rounded-[2px] border-2 border-dashed border-brand-400/70 bg-brand-500/5 text-brand-700 transition hover:border-brand-500 hover:bg-brand-500/10"
              style={{ left: pan.x + r.x * zoom, top: pan.y + (H - r.y - r.h) * zoom, width: r.w * zoom, height: r.h * zoom }}
              onPointerDown={(e) => e.stopPropagation()}
              onClick={() => {
                setSelected(null)
                setFillOpen(true)
              }}
            >
              <span className="flex flex-col items-center gap-1 px-2 text-center">
                <span className="grid h-10 w-10 place-items-center rounded-full bg-brand-600 text-white shadow-lift transition group-hover:scale-110">
                  <Plus size={22} />
                </span>
                {r.h * zoom > 90 && (
                  <>
                    <span className="text-sm font-semibold">Empty {sizeName !== 'Custom' ? sizeName : ''} space</span>
                    <span className="text-xs text-slate-500">
                      {fmtMm(r.w)} × {fmtMm(r.h)} mm · click to fill
                    </span>
                  </>
                )}
              </span>
            </button>
          ))}

          {/* ---------- measurements of the selected design ---------- */}
          {sel && !drag && (
            <>
              <div
                className="pointer-events-none absolute -translate-x-1/2 -translate-y-full rounded-md bg-brand-600 px-2 py-0.5 text-[11px] font-semibold whitespace-nowrap text-white tabular-nums shadow"
                style={{ left: pan.x + (sel.trim.x + sel.trim.w / 2) * zoom, top: pan.y + (H - sel.trim.y - sel.trim.h) * zoom - 4 }}
              >
                {fmtMm(sel.trim.w)} mm
              </div>
              <div
                className="pointer-events-none absolute -translate-y-1/2 rounded-md bg-brand-600 px-2 py-0.5 text-[11px] font-semibold whitespace-nowrap text-white tabular-nums shadow"
                style={{ left: pan.x + (sel.trim.x + sel.trim.w) * zoom + 6, top: pan.y + (H - sel.trim.y - sel.trim.h / 2) * zoom }}
              >
                {fmtMm(sel.trim.h)} mm
              </div>
            </>
          )}

          {/* ---------- floating controls ---------- */}
          <div className="pointer-events-none absolute inset-0">
            {/* sheet navigation */}
            <div className="pointer-events-auto absolute top-4 left-4 flex items-center gap-1 rounded-full bg-white/95 p-1 text-slate-800 shadow-lift backdrop-blur" onPointerDown={(e) => e.stopPropagation()}>
              <button className="btn-icon rounded-full hover:bg-slate-100" disabled={sheetIdx === 0} onClick={() => setSheetIdx(sheetIdx - 1)} aria-label="Previous sheet">
                <ChevronLeft size={18} />
              </button>
              <span className="px-1 text-sm font-semibold tabular-nums">
                Sheet {sheetIdx + 1} <span className="font-normal text-slate-400">of {sheets.length}</span>
              </span>
              <button className="btn-icon rounded-full hover:bg-slate-100" disabled={sheetIdx >= sheets.length - 1} onClick={() => setSheetIdx(sheetIdx + 1)} aria-label="Next sheet">
                <ChevronRight size={18} />
              </button>
            </div>

            {/* selected design, or a hint */}
            <div className="absolute top-4 left-1/2 flex -translate-x-1/2 flex-col items-center gap-2">
              {/* measurements: always visible */}
              <div
                className="pointer-events-auto flex items-center gap-2 rounded-full bg-white/95 px-3.5 py-1.5 text-xs whitespace-nowrap text-slate-700 shadow-lift backdrop-blur tabular-nums"
                onPointerDown={(e) => e.stopPropagation()}
              >
                <Ruler size={14} className="text-brand-600" />
                <span>
                  <b className="text-slate-900">Sheet</b> {settings.sheet.name} · {fmtMm(W)} × {fmtMm(H)} mm
                </span>
                <span className="h-4 w-px bg-slate-200" />
                {sel ? (
                  <span>
                    <b className="text-slate-900">{sel.item.panel ? `Panel ${sel.item.panel.index}` : 'Design'}</b> {sizeName !== 'Custom' ? sizeName + ' · ' : ''}
                    {fmtMm(sel.trim.w)} × {fmtMm(sel.trim.h)} mm
                    <span className="text-slate-400">
                      {' '}
                      · from left {fmtMm(sel.trim.x)} · from bottom {fmtMm(sel.trim.y)} mm
                    </span>
                  </span>
                ) : (
                  <span>
                    <b className="text-slate-900">
                      {sheet.placements.length} × {sizeName !== 'Custom' ? sizeName : 'design'}
                    </b>{' '}
                    {fmtMm(sheet.placements[0]?.trim.w ?? sheet.trimW)} × {fmtMm(sheet.placements[0]?.trim.h ?? sheet.trimH)} mm
                    {sheet.freeSlots.length > 0 && <span className="font-semibold text-amber-600"> · {sheet.freeSlots.length} empty</span>}
                  </span>
                )}
              </div>
              {sel && selDesign ? (
                <div className="pointer-events-auto flex animate-fade-up items-center gap-1.5 rounded-2xl bg-white/95 p-1.5 pl-3.5 text-slate-800 shadow-lift backdrop-blur" onPointerDown={(e) => e.stopPropagation()}>
                  <span className="h-2.5 w-2.5 shrink-0 rounded-full" style={{ background: colorOf(selDesign.id) }} />
                  <span className="max-w-48 truncate text-sm font-semibold">
                    {sel.item.name}
                    {sel.item.panel && (
                      <span className="font-normal text-slate-400">
                        {' '}
                        · panel {sel.item.panel.index}/{sel.item.panel.total}
                      </span>
                    )}
                  </span>
                  <span className="mx-1 h-5 w-px bg-slate-200" />
                  <button
                    className="btn-ghost px-2.5 py-1.5"
                    title="Rotate 90°"
                    onClick={() => props.setOverride(sel.id, { ...props.overrides[sel.id], quarterTurns: ((props.overrides[sel.id]?.quarterTurns ?? 0) + 1) % 4 })}
                  >
                    <RotateCw size={16} /> Rotate
                  </button>
                  <button className="btn-ghost px-2.5 py-1.5" disabled={!props.overrides[sel.id]} onClick={() => props.setOverride(sel.id, undefined)} title="Put it back where it was">
                    <Undo2 size={16} /> Reset
                  </button>
                  <span className="mx-1 h-5 w-px bg-slate-200" />
                  <Stepper size="sm" value={selDesign.copies} onChange={(n) => props.onUpdateDesign(selDesign.id, { copies: n })} label="Copies" />
                  <button className="btn-icon btn-ghost h-8 w-8 rounded-full" onClick={() => setSelected(null)} aria-label="Deselect">
                    <X size={16} />
                  </button>
                </div>
              ) : (
                <div className="rounded-full bg-white/10 px-4 py-2 text-xs font-medium whitespace-nowrap text-slate-300 backdrop-blur">
                  <MousePointerClick size={13} className="mr-1.5 inline -translate-y-px" />
                  Click a design to see its size, move or rotate it · scroll to zoom · drag to pan
                </div>
              )}
              {sheet.freeSlots.length > 0 && !fillOpen && (
                <button
                  className="btn pointer-events-auto animate-fade-up rounded-full bg-amber-400 px-4 py-2 text-sm font-semibold text-amber-950 shadow-lift hover:bg-amber-300"
                  onPointerDown={(e) => e.stopPropagation()}
                  onClick={() => setFillOpen(true)}
                >
                  <Plus size={16} /> {sheet.freeSlots.length === 1 ? '1 empty space' : `${sheet.freeSlots.length} empty spaces`} on this sheet – fill it
                </button>
              )}
              {fillOpen && sheet.freeSlots.length > 0 && (
                <div className="pointer-events-auto animate-fade-up" onPointerDown={(e) => e.stopPropagation()}>
                  <FillSpace
                    target={{ groupKey: sheet.groupKey, trimName: sizeName, trimW: sheet.trimW, trimH: sheet.trimH, free: sheet.freeSlots.length }}
                    designs={props.designs}
                    sources={props.sources}
                    thumbs={props.thumbs}
                    onAddFiles={props.onAddFiles}
                    onRepeat={props.onRepeat}
                    onClose={() => setFillOpen(false)}
                  />
                </div>
              )}
            </div>

            {/* what to show */}
            <div className="pointer-events-auto absolute top-4 right-4" onPointerDown={(e) => e.stopPropagation()}>
              <button className="btn rounded-full bg-white/95 px-3.5 py-2 text-slate-800 shadow-lift backdrop-blur hover:bg-white" onClick={() => setShowLayers(!showLayers)} aria-expanded={showLayers}>
                <Eye size={16} /> Show
                <ChevronDown size={14} className={`transition-transform ${showLayers ? 'rotate-180' : ''}`} />
              </button>
              {showLayers && (
                <div className="absolute right-0 mt-2 w-60 animate-fade-up rounded-2xl bg-white p-2 text-slate-800 shadow-lift">
                  {LAYERS.map(([k, label, color]) => (
                    <button
                      key={k}
                      role="switch"
                      aria-checked={overlays[k]}
                      onClick={() => setOverlays({ ...overlays, [k]: !overlays[k] })}
                      className="flex w-full items-center gap-3 rounded-xl px-2.5 py-2 text-left text-sm font-medium hover:bg-slate-50"
                    >
                      <span className="h-3 w-3 rounded-full" style={{ background: color, opacity: overlays[k] ? 1 : 0.25 }} />
                      <span className="flex-1">{label}</span>
                      <span className={`relative h-5 w-8 rounded-full transition-colors ${overlays[k] ? 'bg-brand-600' : 'bg-slate-200'}`}>
                        <span className={`absolute top-0.5 left-0.5 h-4 w-4 rounded-full bg-white shadow transition-transform ${overlays[k] ? 'translate-x-3' : ''}`} />
                      </span>
                    </button>
                  ))}
                </div>
              )}
            </div>

            {/* zoom */}
            <div
              className="pointer-events-auto absolute bottom-4 left-1/2 flex -translate-x-1/2 items-center gap-1 rounded-full bg-white/95 p-1 text-slate-800 shadow-lift backdrop-blur"
              onPointerDown={(e) => e.stopPropagation()}
            >
              <button className="btn-icon rounded-full hover:bg-slate-100" onClick={() => zoomAt(1 / 1.25)} aria-label="Zoom out">
                <ZoomOut size={17} />
              </button>
              <span className="w-12 text-center text-sm font-semibold tabular-nums">{zoomPct}%</span>
              <button className="btn-icon rounded-full hover:bg-slate-100" onClick={() => zoomAt(1.25)} aria-label="Zoom in">
                <ZoomIn size={17} />
              </button>
              <span className="mx-1 h-5 w-px bg-slate-200" />
              <button className="btn rounded-full px-3 py-1.5 hover:bg-slate-100" onClick={fit}>
                <Maximize size={15} /> Fit
              </button>
              <button
                className="btn rounded-full px-3 py-1.5 hover:bg-slate-100"
                title="Real size on screen"
                onClick={() => {
                  const z = PX_PER_MM_100
                  setPan((p) => ({ x: vp.w / 2 - ((vp.w / 2 - p.x) / zoom) * z, y: vp.h / 2 - ((vp.h / 2 - p.y) / zoom) * z }))
                  setZoom(z)
                }}
              >
                100%
              </button>
            </div>

            {/* cursor position */}
            <div className="absolute right-4 bottom-4 flex items-center gap-2 rounded-full bg-black/40 px-3.5 py-1.5 text-[11px] font-medium text-slate-300 tabular-nums backdrop-blur">
              {busy && <span className="h-3 w-3 animate-spin rounded-full border-2 border-slate-500 border-t-white" />}
              {cursor ? `x ${cursor.x.toFixed(1)} · y ${cursor.y.toFixed(1)} mm` : `${fmtMm(W)} × ${fmtMm(H)} mm`}
            </div>

            {/* problems */}
            {problems.length > 0 && (
              <div className="pointer-events-auto absolute bottom-16 left-4 max-w-sm animate-fade-up rounded-2xl bg-amber-50 p-3.5 text-amber-900 shadow-lift" onPointerDown={(e) => e.stopPropagation()}>
                <div className="mb-1.5 flex items-center gap-2 text-sm font-semibold">
                  <AlertTriangle size={15} className="text-amber-500" /> Check this
                </div>
                <ul className="list-disc space-y-1 pl-4 text-xs leading-snug">
                  {problems.map((w) => (
                    <li key={w}>{w}</li>
                  ))}
                </ul>
              </div>
            )}
          </div>
        </div>
      </section>
    </div>
  )
}

const snap = (mm: number) => Math.round(mm * 2) / 2 // 0.5 mm steps
const round = (mm: number) => Math.round(mm * 1000) / 1000
