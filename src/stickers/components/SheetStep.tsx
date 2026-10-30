import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { AlertTriangle, ChevronLeft, ChevronRight, FileText, LayoutGrid, Maximize, MousePointerClick, PaintBucket, RotateCw, Scissors, Undo2, ZoomIn, ZoomOut } from 'lucide-react'
import { Notice, Segmented, Stepper, useToast } from '../../components/ui'
import { STICKER_SHEETS, type StickerSettings } from '../config'
import { type NestDesign, type NestResult, type StickerSheetLayout, contentArea, layoutProblems, placementMatrix, placementRect, roomOnLastSheet } from '../lib/nest'
import { type Sticker, fmtLen, stickerSize } from '../model'
import { CHECKER, type StickerVisual, drawCut, drawMarks, drawPrint, path2d } from '../render'
import type { StickerJob } from '../useStickerJob'
import { visualOf } from '../visual'
import { Section } from './CutStep'
import DarkToggle from './DarkToggle'
import type { Overrides } from '../StickerApp'

type View = 'both' | 'print' | 'cut'

export default function SheetStep(props: {
  job: StickerJob
  settings: StickerSettings
  setSettings: (s: StickerSettings) => void
  sheets: StickerSheetLayout[]
  layout: NestResult
  nestDesigns: NestDesign[]
  overrides: Overrides
  setOverride: (id: string, o: { x: number; y: number } | undefined) => void
  resetOverrides: () => void
}) {
  const { job, settings, sheets, layout } = props
  const toast = useToast()
  const [sheetIdx, setSheetIdx] = useState(0)
  const [view, setView] = useState<View>('both')
  const idx = Math.min(sheetIdx, Math.max(0, sheets.length - 1))
  const sheet = sheets[idx]
  const moved = Object.values(props.overrides).some(Boolean)

  const visuals = useMemo(() => {
    const out: Record<string, StickerVisual> = {}
    for (const s of job.stickers) {
      const v = visualOf(s, job.cuts[s.id], job.bitmaps, settings)
      if (v) out[s.id] = v
    }
    return out
  }, [job.stickers, job.cuts, job.bitmaps, settings])
  const shapes = useMemo(() => Object.fromEntries(props.nestDesigns.map((d) => [d.id, { cut: d.cut, bounds: d.bounds }])), [props.nestDesigns])
  const problems = useMemo(() => (sheet ? layoutProblems(sheet, shapes, settings) : { overlapping: new Set<string>(), outside: new Set<string>() }), [sheet, shapes, settings])

  const fill = (s: Sticker) => {
    const n = roomOnLastSheet(props.nestDesigns, s.id, settings)
    if (n > 0) {
      job.update(s.id, { copies: s.copies + n })
      toast(`Added ${n} – the last sheet is now full`)
    } else toast('The last sheet is already full')
  }
  const sheetIndex = STICKER_SHEETS.findIndex((x) => x.name === settings.sheet.name)

  return (
    <div className="flex h-full min-h-0 flex-col lg:flex-row">
      <aside className="w-full shrink-0 overflow-y-auto border-r border-slate-200/70 bg-white px-5 py-5 lg:w-[360px]">
        <Section icon={<FileText size={15} />} title="Sheet">
          <Segmented
            full
            aria-label="Sheet size"
            value={sheetIndex >= 0 ? String(sheetIndex) : 'custom'}
            onChange={(v) => v !== 'custom' && props.setSettings({ ...settings, sheet: STICKER_SHEETS[Number(v)] })}
            options={[...STICKER_SHEETS.map((x, i) => ({ value: String(i), label: x.name })), ...(sheetIndex < 0 ? [{ value: 'custom', label: 'Custom' }] : [])]}
          />
          <div className="text-xs text-slate-500">
            {fmtLen(settings.sheet.widthMm, 'mm')} × {fmtLen(settings.sheet.heightMm, 'mm')} · usable {fmtLen(layout.area.w, 'mm')} × {fmtLen(layout.area.h, 'mm')} inside the marks · gap {settings.gapMm} mm.
            Other sizes and marks: ⚙ top right.
          </div>
        </Section>

        <Section icon={<LayoutGrid size={15} />} title="Copies">
          {job.stickers.map((s) => {
            const cap = layout.capacity[s.id]
            const size = stickerSize(s)
            return (
              <div key={s.id} className="flex flex-col gap-2 rounded-xl bg-white p-2.5 ring-1 ring-slate-900/5">
                <div className="flex items-center gap-2.5">
                  <span className="h-11 w-11 shrink-0 overflow-hidden rounded-lg" style={CHECKER}>
                    <img src={s.art.url} alt="" className="h-full w-full object-contain p-0.5" />
                  </span>
                  <div className="min-w-0 flex-1">
                    <div className="truncate text-sm font-semibold">{s.name}</div>
                    <div className="truncate text-xs text-slate-500">
                      {fmtLen(size.w, settings.units)} × {fmtLen(size.h, settings.units)}
                      {cap && ` · ${cap.perSheet} fit on a sheet`}
                    </div>
                  </div>
                  <Stepper size="sm" value={s.copies} label={`Copies of ${s.name}`} onChange={(n) => job.update(s.id, { copies: n })} />
                </div>
                <div className="flex items-center gap-2">
                  <button className="btn-secondary flex-1 px-2 py-1.5 text-xs" onClick={() => fill(s)} disabled={!cap?.perSheet} title="Add copies until the last sheet is full">
                    <PaintBucket size={13} /> Fill sheet
                  </button>
                  <Segmented
                    size="sm"
                    aria-label="Rotation"
                    value={String(s.rotation)}
                    onChange={(v) => job.update(s.id, { rotation: v === 'auto' ? 'auto' : (Number(v) as 0 | 90) })}
                    options={[
                      { value: 'auto', label: 'Auto', hint: 'Turn it whichever way fits more' },
                      { value: '0', label: 'Upright', hint: 'Always upright' },
                      { value: '90', label: <><RotateCw size={12} /> 90°</>, hint: 'Always turned 90°' },
                    ]}
                  />
                </div>
                {cap && cap.perSheet === 0 && <Notice>Bigger than the usable area of this sheet.</Notice>}
              </div>
            )
          })}
        </Section>
        {layout.warnings.map((w) => (
          <Notice key={w}>{w}</Notice>
        ))}
      </aside>

      <section className="relative flex min-h-[420px] flex-1 flex-col bg-canvas">
        <div className="z-10 flex flex-wrap items-center gap-2 border-b border-white/5 px-3 py-2 text-white/80">
          <div className="flex items-center gap-1">
            <button className="btn-icon text-white/70 hover:bg-white/10" disabled={idx === 0} onClick={() => setSheetIdx(idx - 1)} aria-label="Previous sheet">
              <ChevronLeft size={18} />
            </button>
            <span className="min-w-[7.5rem] text-center text-sm font-semibold tabular-nums">
              {sheets.length ? `Sheet ${idx + 1} of ${sheets.length}` : 'No sheets'}
            </span>
            <button className="btn-icon text-white/70 hover:bg-white/10" disabled={idx >= sheets.length - 1} onClick={() => setSheetIdx(idx + 1)} aria-label="Next sheet">
              <ChevronRight size={18} />
            </button>
          </div>
          <DarkToggle
            aria-label="Show"
            value={view}
            onChange={setView}
            options={[
              { value: 'both', label: 'Print + cut' },
              { value: 'print', label: 'Print' },
              { value: 'cut', label: <><Scissors size={12} /> Cut lines</> },
            ]}
          />
          <span className="flex-1" />
          {moved && (
            <button className="btn rounded-lg px-2.5 py-1.5 text-xs text-white/80 hover:bg-white/10" onClick={props.resetOverrides}>
              <Undo2 size={14} /> Re-arrange automatically
            </button>
          )}
          <span className="hidden items-center gap-1.5 text-xs text-white/50 xl:flex">
            <MousePointerClick size={13} /> Drag a sticker to move it · wheel to zoom
          </span>
        </div>
        {sheet ? (
          <SheetCanvas
            sheet={sheet}
            settings={settings}
            visuals={visuals}
            shapes={shapes}
            view={view}
            problems={problems}
            onMove={(id, x, y) => props.setOverride(id, { x, y })}
          />
        ) : (
          <div className="grid flex-1 place-items-center text-white/50">Nothing to place yet.</div>
        )}
        {(problems.overlapping.size > 0 || problems.outside.size > 0) && (
          <div className="absolute bottom-3 left-1/2 flex -translate-x-1/2 items-center gap-2 rounded-full bg-amber-500 px-4 py-2 text-sm font-semibold text-amber-950 shadow-lift">
            <AlertTriangle size={16} />
            {problems.overlapping.size > 0 ? 'Some stickers are too close – their cut lines would touch.' : 'A sticker is outside the printable area.'}
          </div>
        )}
      </section>
    </div>
  )
}

/** Sheet preview with zoom, pan and drag-to-move. Drawn with Canvas 2D in sheet millimetres. */
export function SheetCanvas(props: {
  sheet: StickerSheetLayout
  settings: StickerSettings
  visuals: Record<string, StickerVisual>
  shapes: Record<string, { bounds: NestDesign['bounds'] }>
  view: View
  problems: { overlapping: Set<string>; outside: Set<string> }
  onMove: (id: string, x: number, y: number) => void
  /** Called when a piece is clicked (null = empty space). */
  onSelect?: (designId: string | null) => void
  noun?: string
}) {
  const { sheet, settings, visuals, shapes, view, problems } = props
  const W = settings.sheet.widthMm
  const H = settings.sheet.heightMm
  const host = useRef<HTMLDivElement>(null)
  const canvas = useRef<HTMLCanvasElement>(null)
  const [vp, setVp] = useState({ w: 0, h: 0 })
  const [zoom, setZoom] = useState(1) // css px per mm
  const [pan, setPan] = useState({ x: 0, y: 0 }) // screen position of the sheet's top-left corner
  const [selected, setSelected] = useState<string | null>(null)
  const drag = useRef<{ kind: 'pan'; sx: number; sy: number; px: number; py: number } | { kind: 'move'; id: string; sx: number; sy: number; x0: number; y0: number } | null>(null)

  useEffect(() => {
    const el = host.current
    if (!el) return
    const ro = new ResizeObserver(() => setVp({ w: el.clientWidth, h: el.clientHeight }))
    ro.observe(el)
    return () => ro.disconnect()
  }, [])

  const fit = useCallback(() => {
    if (!vp.w) return
    const z = Math.min((vp.w - 64) / W, (vp.h - 64) / H)
    setZoom(z)
    setPan({ x: (vp.w - W * z) / 2, y: (vp.h - H * z) / 2 })
  }, [vp.w, vp.h, W, H])
  const fitKey = `${vp.w > 0}|${W}|${H}`
  useEffect(fit, [fitKey]) // eslint-disable-line react-hooks/exhaustive-deps

  const zoomAt = useCallback((f: number, cx: number, cy: number) => {
    setZoom((z) => {
      const nz = Math.min(60, Math.max(0.2, z * f))
      setPan((p) => ({ x: cx - ((cx - p.x) / z) * nz, y: cy - ((cy - p.y) / z) * nz }))
      return nz
    })
  }, [])
  useEffect(() => {
    const el = host.current
    if (!el) return
    const onWheel = (e: WheelEvent) => {
      e.preventDefault()
      const r = el.getBoundingClientRect()
      zoomAt(Math.exp(-e.deltaY * 0.0015), e.clientX - r.left, e.clientY - r.top)
    }
    el.addEventListener('wheel', onWheel, { passive: false })
    return () => el.removeEventListener('wheel', onWheel)
  }, [zoomAt])

  // ---- draw
  const dpr = typeof window !== 'undefined' ? window.devicePixelRatio || 1 : 1
  const base = (ctx: CanvasRenderingContext2D) => ctx.setTransform(dpr * zoom, 0, 0, -dpr * zoom, dpr * pan.x, dpr * (pan.y + H * zoom))
  useEffect(() => {
    const c = canvas.current
    if (!c || !vp.w) return
    c.width = Math.round(vp.w * dpr)
    c.height = Math.round(vp.h * dpr)
    const ctx = c.getContext('2d')!
    base(ctx)
    const px = dpr * zoom

    // paper
    ctx.save()
    ctx.shadowColor = 'rgba(0,0,0,.4)'
    ctx.shadowBlur = 20 * dpr
    ctx.shadowOffsetY = -4 * dpr
    ctx.fillStyle = '#fff'
    ctx.fillRect(0, 0, W, H)
    ctx.restore()
    // usable area
    const area = contentArea(settings)
    ctx.save()
    ctx.strokeStyle = '#cbd5e1'
    ctx.lineWidth = 1 / px
    ctx.setLineDash([4 / px, 4 / px])
    ctx.strokeRect(area.x, H - area.y - area.h, area.w, area.h)
    ctx.restore()
    drawMarks(ctx, settings)

    for (const p of sheet.placements) {
      const v = visuals[p.designId]
      const b = shapes[p.designId]?.bounds
      if (!v || !b) continue
      const m = placementMatrix(p, b, settings)
      ctx.save()
      ctx.transform(m[0], m[1], m[2], m[3], m[4], m[5])
      if (view !== 'cut') drawPrint(ctx, v, 'bleed')
      const bad = problems.overlapping.has(p.id) || problems.outside.has(p.id)
      if (bad) {
        ctx.fillStyle = 'rgba(239,68,68,.25)'
        ctx.fill(path2d(v.cut))
      }
      if (view !== 'print') drawCut(ctx, v, bad ? '#ef4444' : view === 'cut' ? '#111' : settings.cut.displayColor, (bad ? 2 : 1.2) * dpr, px)
      if (p.id === selected) drawCut(ctx, v, '#5b2ff5', 2.5 * dpr, px, [6, 4])
      ctx.restore()
    }

    // label in the bottom margin removed so canvas preview remains completely plain
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sheet, settings, visuals, shapes, view, problems, selected, zoom, pan, vp, dpr])

  // ---- pointer
  const hit = (sx: number, sy: number): string | null => {
    const ctx = canvas.current?.getContext('2d')
    if (!ctx) return null
    for (let i = sheet.placements.length - 1; i >= 0; i--) {
      const p = sheet.placements[i]
      const v = visuals[p.designId]
      const b = shapes[p.designId]?.bounds
      if (!v || !b) continue
      // quick box test first
      const r = placementRect(p, b, settings)
      const mx = (sx - pan.x) / zoom
      const my = H - (sy - pan.y) / zoom
      if (mx < r.x - 1 || mx > r.x + r.w + 1 || my < r.y - 1 || my > r.y + r.h + 1) continue
      base(ctx)
      const m = placementMatrix(p, b, settings)
      ctx.transform(m[0], m[1], m[2], m[3], m[4], m[5])
      if (ctx.isPointInPath(path2d(v.cut), sx * dpr, sy * dpr)) return p.id
    }
    return null
  }

  return (
    <div
      ref={host}
      className="relative min-h-0 flex-1 cursor-grab touch-none overflow-hidden active:cursor-grabbing"
      onPointerDown={(e) => {
        const r = host.current!.getBoundingClientRect()
        const sx = e.clientX - r.left
        const sy = e.clientY - r.top
        const id = hit(sx, sy)
        setSelected(id)
        props.onSelect?.(id ? (sheet.placements.find((q) => q.id === id)?.designId ?? null) : null)
        ;(e.target as HTMLElement).setPointerCapture(e.pointerId)
        if (id) {
          const p = sheet.placements.find((q) => q.id === id)!
          drag.current = { kind: 'move', id, sx, sy, x0: p.x, y0: p.y }
        } else drag.current = { kind: 'pan', sx, sy, px: pan.x, py: pan.y }
      }}
      onPointerMove={(e) => {
        const d = drag.current
        if (!d) return
        const r = host.current!.getBoundingClientRect()
        const sx = e.clientX - r.left
        const sy = e.clientY - r.top
        if (d.kind === 'pan') setPan({ x: d.px + sx - d.sx, y: d.py + sy - d.sy })
        else {
          const snap = (n: number) => Math.round(n * 4) / 4
          props.onMove(d.id, snap(d.x0 + (sx - d.sx) / zoom), snap(d.y0 + (sy - d.sy) / zoom))
        }
      }}
      onPointerUp={() => (drag.current = null)}
      onPointerCancel={() => (drag.current = null)}
    >
      <canvas ref={canvas} className="absolute inset-0 h-full w-full" />
      <div className="absolute right-3 bottom-3 flex items-center gap-1 rounded-xl bg-black/40 p-1 text-white/80 backdrop-blur">
        <button className="btn-icon h-8 w-8 hover:bg-white/10" onClick={() => zoomAt(1 / 1.25, vp.w / 2, vp.h / 2)} aria-label="Zoom out">
          <ZoomOut size={16} />
        </button>
        <span className="w-12 text-center text-xs font-semibold tabular-nums">{Math.round((zoom / (96 / 25.4)) * 100)}%</span>
        <button className="btn-icon h-8 w-8 hover:bg-white/10" onClick={() => zoomAt(1.25, vp.w / 2, vp.h / 2)} aria-label="Zoom in">
          <ZoomIn size={16} />
        </button>
        <button className="btn-icon h-8 w-8 hover:bg-white/10" onClick={fit} aria-label="Fit sheet">
          <Maximize size={15} />
        </button>
      </div>
    </div>
  )
}
