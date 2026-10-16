import { useMemo, useState, type ReactNode } from 'react'
import { Circle, Copy, Eye, ImageMinus, Layers, Link2, RectangleHorizontal, RotateCcw, Ruler, Scissors, Shapes, Square, Trash2, Wand2 } from 'lucide-react'
import { Badge, NumberField, Notice, Segmented, Switch } from '../../components/ui'
import { BORDER_SWATCHES, type BorderStyle, type CutShape, QUICK_SIZES_IN, type StickerSettings } from '../config'
import { borderOf } from '../lib/cutline'
import { pathLength } from '../lib/paths'
import { type Sticker, effectiveDpi, fmtLen, fromUnits, stickerSize, toUnits, widthForHeight, widthForLongest } from '../model'
import { CHECKER } from '../render'
import type { StickerJob } from '../useStickerJob'
import { visualOf } from '../visual'
import { BackgroundBadge, BusyOverlay } from './AddStep'
import DarkToggle from './DarkToggle'
import StickerPreview, { type PreviewMode } from './StickerPreview'

export function Section({ icon, title, right, children }: { icon: ReactNode; title: string; right?: ReactNode; children: ReactNode }) {
  return (
    <section className="mb-5">
      <h3 className="mb-2.5 flex items-center gap-2 text-sm font-bold">
        <span className="grid h-7 w-7 place-items-center rounded-lg bg-brand-50 text-brand-600">{icon}</span>
        <span className="flex-1">{title}</span>
        {right}
      </h3>
      <div className="flex flex-col gap-3.5 rounded-2xl bg-slate-50/70 p-4 ring-1 ring-slate-900/[0.04]">{children}</div>
    </section>
  )
}

export function Row({ label, hint, children }: { label: string; hint?: string; children: ReactNode }) {
  return (
    <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-2">
      <div className="min-w-0 flex-1">
        <div className="text-sm font-semibold">{label}</div>
        {hint && <div className="text-xs leading-snug text-slate-500">{hint}</div>}
      </div>
      <div className="flex shrink-0 items-center gap-2">{children}</div>
    </div>
  )
}

/** Slider + exact number box. */
function RangeRow(props: { label: string; hint?: string; value: number; min: number; max: number; step: number; onChange: (n: number) => void; suffix: string }) {
  return (
    <div>
      <Row label={props.label} hint={props.hint}>
        <NumberField aria-label={props.label} value={props.value} min={props.min} max={props.max * 3} onChange={props.onChange} suffix={props.suffix} />
      </Row>
      <input
        type="range"
        aria-label={`${props.label} slider`}
        className="mt-2 w-full accent-brand-600"
        min={props.min}
        max={props.max}
        step={props.step}
        value={Math.min(props.max, props.value)}
        onChange={(e) => props.onChange(Number(e.target.value))}
      />
    </div>
  )
}

const SHAPES: { value: CutShape; icon: ReactNode; label: string; hint: string }[] = [
  { value: 'contour', icon: <Shapes size={18} />, label: 'Contour', hint: 'Follows the outline of the design (die-cut)' },
  { value: 'rounded', icon: <RectangleHorizontal size={18} />, label: 'Rounded', hint: 'Rectangle with rounded corners' },
  { value: 'rect', icon: <Square size={18} />, label: 'Square', hint: 'Sharp-cornered rectangle' },
  { value: 'circle', icon: <Circle size={18} />, label: 'Circle', hint: 'Circle or oval' },
]

function ShapePicker({ value, onChange }: { value: CutShape; onChange: (v: CutShape) => void }) {
  return (
    <div role="radiogroup" aria-label="Cut shape" className="grid grid-cols-4 gap-1.5">
      {SHAPES.map((o) => {
        const on = o.value === value
        return (
          <button
            key={o.value}
            role="radio"
            aria-checked={on}
            title={o.hint}
            onClick={() => onChange(o.value)}
            className={`flex flex-col items-center gap-1 rounded-xl px-1 py-2 text-xs font-semibold transition ${on ? 'bg-white text-brand-700 shadow-sm ring-2 ring-brand-500' : 'text-slate-500 ring-1 ring-slate-200 hover:bg-white hover:text-slate-800'}`}
          >
            {o.icon}
            {o.label}
          </button>
        )
      })}
    </div>
  )
}

const BORDERS: { value: BorderStyle; label: string; hint: string }[] = [
  { value: 'white', label: 'White', hint: 'Unprinted white border between design and cut' },
  { value: 'color', label: 'Colour', hint: 'Printed border in a colour you pick' },
  { value: 'none', label: 'None', hint: 'Cut right on the edge of the design (edge colours run into the bleed)' },
]

export default function CutStep(props: {
  job: StickerJob
  settings: StickerSettings
  setSettings: (s: StickerSettings) => void
  selected: string | null
  setSelected: (id: string) => void
}) {
  const { job, settings } = props
  const s = job.stickers.find((x) => x.id === props.selected) ?? job.stickers[0]
  const [mode, setMode] = useState<PreviewMode>('print')
  const [showBleed, setShowBleed] = useState(false)

  if (!s) return <div className="grid h-full place-items-center text-slate-400">Add a sticker first.</div>
  return (
    <div className="flex h-full min-h-0 flex-col lg:flex-row">
      {/* sticker list */}
      <aside className="flex shrink-0 gap-2 overflow-x-auto border-b border-slate-200/70 bg-white/60 p-3 lg:w-56 lg:flex-col lg:overflow-y-auto lg:border-r lg:border-b-0">
        {job.stickers.map((x) => {
          const on = x.id === s.id
          const c = job.cuts[x.id]
          const warn = !!c?.result?.warnings.length || !!c?.error
          return (
            <button
              key={x.id}
              onClick={() => props.setSelected(x.id)}
              className={`relative flex shrink-0 items-center gap-2.5 rounded-2xl p-2 text-left transition lg:w-full ${on ? 'bg-brand-50 ring-2 ring-brand-500' : 'hover:bg-slate-100'}`}
            >
              <span className="relative h-12 w-12 shrink-0 overflow-hidden rounded-xl" style={CHECKER}>
                <img src={x.art.url} alt="" className="h-full w-full object-contain p-1" />
                {job.busy[x.id] && <span className="absolute inset-0 grid place-items-center bg-white/70"><span className="h-4 w-4 animate-spin rounded-full border-2 border-slate-300 border-t-brand-500" /></span>}
              </span>
              <span className="hidden min-w-0 lg:block">
                <span className="block truncate text-sm font-semibold">{x.name}</span>
                <span className="block truncate text-xs text-slate-500">
                  {fmtLen(stickerSize(x).w, settings.units)} × {fmtLen(stickerSize(x).h, settings.units)}
                </span>
              </span>
              {warn && <span className="absolute top-1.5 right-1.5 h-2 w-2 rounded-full bg-amber-500" />}
            </button>
          )
        })}
      </aside>

      {/* big preview */}
      <section className="relative min-h-[320px] flex-1 bg-canvas">
        <Preview job={job} s={s} settings={settings} mode={mode} showBleed={showBleed} />
        <div className="absolute top-3 left-3 flex items-center gap-2">
          <DarkToggle
            aria-label="Preview"
            value={mode}
            onChange={setMode}
            options={[
              { value: 'print', label: <><Scissors size={13} /> Print & cut</>, hint: 'As printed, with the cut line' },
              { value: 'finished', label: <><Eye size={13} /> Finished</>, hint: 'The sticker after cutting' },
            ]}
          />
          {mode === 'print' && (
            <label className="flex cursor-pointer items-center gap-1.5 rounded-xl bg-white/10 px-2.5 py-1.5 text-xs font-semibold text-white/80 backdrop-blur select-none">
              <input type="checkbox" className="accent-brand-500" checked={showBleed} onChange={(e) => setShowBleed(e.target.checked)} /> Bleed outline
            </label>
          )}
        </div>
        <div className="absolute bottom-3 left-3 flex items-center gap-3 rounded-xl bg-black/40 px-3 py-1.5 text-[11px] font-medium text-white/80 backdrop-blur">
          <span className="flex items-center gap-1.5">
            <span className="h-0.5 w-4 rounded" style={{ background: settings.cut.displayColor }} /> Cut line ({settings.cut.spotName})
          </span>
          {showBleed && mode === 'print' && (
            <span className="flex items-center gap-1.5">
              <span className="h-0 w-4 border-t border-dashed border-slate-300" /> Bleed {settings.bleedMm} mm
            </span>
          )}
        </div>
      </section>

      {/* controls */}
      <aside className="w-full shrink-0 overflow-y-auto border-l border-slate-200/70 bg-white px-5 py-5 lg:w-[380px]">
        <Controls job={job} s={s} settings={settings} setSettings={props.setSettings} />
      </aside>
    </div>
  )
}

function Preview(props: { job: StickerJob; s: Sticker; settings: StickerSettings; mode: PreviewMode; showBleed: boolean }) {
  const { job, s, settings } = props
  const cut = job.cuts[s.id]
  const visual = useMemo(() => visualOf(s, cut, job.bitmaps, settings), [s, cut, job.bitmaps, settings])
  const size = stickerSize(s)
  const updating = job.stale.has(s.id) && !job.busy[s.id]
  return (
    <StickerPreview
      visual={visual}
      fallback={{ art: job.bitmaps[s.art.key] ?? null, box: { x: 0, y: 0, w: size.w, h: size.h } }}
      mode={props.mode}
      showBleed={props.showBleed}
      cutColor={settings.cut.displayColor}
      units={settings.units}
      updating={updating}
    />
  )
}

function Controls({ job, s, settings, setSettings }: { job: StickerJob; s: Sticker; settings: StickerSettings; setSettings: (s: StickerSettings) => void }) {
  const p = s.params
  const u = settings.units
  const size = stickerSize(s)
  const dpi = effectiveDpi(s)
  const cut = job.cuts[s.id]
  const res = cut?.result
  const busy = job.busy[s.id]
  const [tolerance, setTolerance] = useState(30)
  const [everywhere, setEverywhere] = useState(false)

  const setParams = (patch: Partial<Sticker['params']>) =>
    job.update(s.id, (x) => {
      // keep the finished size the same when the border changes
      const longest = Math.max(stickerSize(x).w, stickerSize(x).h)
      const next = { ...x, params: { ...x.params, ...patch } }
      return 'border' in patch || 'borderMm' in patch ? { params: next.params, widthMm: widthForLongest(next, longest) } : { params: next.params }
    })

  return (
    <div className="animate-fade-up">
      <div className="mb-5 flex items-start gap-3">
        <div className="min-w-0 flex-1">
          <input
            aria-label="Sticker name"
            className="w-full truncate rounded-lg bg-transparent text-lg font-bold tracking-tight outline-none focus:bg-slate-50 focus:px-1.5"
            value={s.name}
            onChange={(e) => job.update(s.id, { name: e.target.value })}
          />
          <div className="mt-1 flex flex-wrap gap-1.5">
            <BackgroundBadge s={s} />
            <Badge tone={dpi >= 300 ? 'good' : dpi >= settings.minDpi ? 'neutral' : 'warn'}>{Math.round(dpi)} DPI</Badge>
          </div>
        </div>
      </div>

      {/* ---------------- background */}
      <Section icon={<Wand2 size={15} />} title="Background">
        <div className="relative">
          <BusyOverlay busy={busy} />
          {s.background === 'original' ? (
            s.original.info.transparent ? (
              <div className="text-sm text-slate-600">Transparent image – the cut line follows the design.</div>
            ) : (
              <div className="flex flex-col gap-3">
                <div className="text-sm text-slate-600">
                  This image has a background.
                  {s.original.info.background.uniformity > 0.9 && <> It looks plain – <b>Plain colour</b> removes it instantly.</>}
                </div>
                <div className="grid grid-cols-2 gap-2">
                  <button className="btn-primary px-3" onClick={() => job.removeBackground(s.id, 'ai')} disabled={!!busy} title="AI, best for photos and complex images. Runs on this computer.">
                    <Wand2 size={15} /> Remove (AI)
                  </button>
                  <button className="btn-secondary px-3" onClick={() => job.removeBackground(s.id, 'plain', { tolerance, everywhere })} disabled={!!busy} title="For logos and clipart on white or one flat colour">
                    <ImageMinus size={15} /> Plain colour
                  </button>
                </div>
                {s.original.info.background.uniformity > 0.9 ? (
                  <PlainOptions tolerance={tolerance} setTolerance={setTolerance} everywhere={everywhere} setEverywhere={setEverywhere} color={s.original.info.background.color} />
                ) : (
                  <details className="group text-sm">
                    <summary className="cursor-pointer text-xs font-semibold text-slate-500 select-none hover:text-slate-700">Plain colour options</summary>
                    <div className="mt-2">
                      <PlainOptions tolerance={tolerance} setTolerance={setTolerance} everywhere={everywhere} setEverywhere={setEverywhere} color={s.original.info.background.color} />
                    </div>
                  </details>
                )}
              </div>
            )
          ) : (
            <div className="flex flex-col gap-3">
              <div className="text-sm text-slate-600">{s.background === 'ai' ? 'Background removed with AI.' : 'Plain background removed.'}</div>
              {s.background === 'plain' && (
                <>
                  <PlainOptions tolerance={tolerance} setTolerance={setTolerance} everywhere={everywhere} setEverywhere={setEverywhere} color={s.original.info.background.color} />
                  <button className="btn-secondary" onClick={() => job.removeBackground(s.id, 'plain', { tolerance, everywhere })} disabled={!!busy}>
                    Redo with these settings
                  </button>
                </>
              )}
              <div className="flex gap-2">
                {s.background === 'plain' && (
                  <button className="btn-ghost flex-1 px-2" onClick={() => job.removeBackground(s.id, 'ai')} disabled={!!busy}>
                    <Wand2 size={15} /> Try AI
                  </button>
                )}
                <button className="btn-ghost flex-1 px-2" onClick={() => job.restoreBackground(s.id)} disabled={!!busy}>
                  <RotateCcw size={15} /> Keep background
                </button>
              </div>
            </div>
          )}
        </div>
      </Section>

      {/* ---------------- size */}
      <Section
        icon={<Ruler size={15} />}
        title="Size"
        right={<Segmented size="sm" value={u} onChange={(v) => setSettings({ ...settings, units: v })} options={[{ value: 'in', label: 'in' }, { value: 'mm', label: 'mm' }]} />}
      >
        <div className="flex items-center gap-2">
          <NumberField aria-label="Width" value={toUnits(size.w, u)} min={u === 'in' ? 0.2 : 5} max={u === 'in' ? 40 : 1000} suffix={u === 'in' ? 'in' : 'mm'} onChange={(v) => job.update(s.id, { widthMm: fromUnits(v, u) })} />
          <Link2 size={15} className="text-slate-400" aria-label="Proportions locked" />
          <NumberField aria-label="Height" value={toUnits(size.h, u)} min={u === 'in' ? 0.2 : 5} max={u === 'in' ? 40 : 1000} suffix={u === 'in' ? 'in' : 'mm'} onChange={(v) => job.update(s.id, { widthMm: widthForHeight(s, fromUnits(v, u)) })} />
        </div>
        <div className="flex flex-wrap gap-1.5">
          {QUICK_SIZES_IN.map((inch) => {
            const mm = inch * 25.4
            const on = Math.abs(Math.max(size.w, size.h) - mm) < 0.3
            return (
              <button
                key={inch}
                onClick={() => job.update(s.id, { widthMm: widthForLongest(s, mm) })}
                className={`rounded-full px-2.5 py-1 text-xs font-semibold ring-1 transition ${on ? 'bg-brand-600 text-white ring-brand-600' : 'bg-white text-slate-600 ring-slate-200 hover:ring-slate-300'}`}
              >
                {u === 'in' ? `${inch}″` : `${Math.round(mm)} mm`}
              </button>
            )
          })}
        </div>
        <div className="text-xs text-slate-500">Finished size, including the border. {u === 'in' ? 'Quick sizes set the longest side.' : 'Quick sizes set the longest side (1.5–5 in).'}</div>
        {dpi < settings.minDpi && <Notice>At this size the image prints at {Math.round(dpi)} DPI and may look soft. Use a bigger image or a smaller size.</Notice>}
      </Section>

      {/* ---------------- cut line */}
      <Section icon={<Scissors size={15} />} title="Cut line">
        <ShapePicker value={p.shape} onChange={(v) => setParams({ shape: v })} />
        <Row label="Border" hint={BORDERS.find((b) => b.value === p.border)?.hint}>
          <Segmented size="sm" value={p.border} onChange={(v) => setParams({ border: v })} options={BORDERS} />
        </Row>
        {p.border !== 'none' && <RangeRow label="Border width" value={p.borderMm} min={0.5} max={10} step={0.5} suffix="mm" onChange={(v) => setParams({ borderMm: v })} />}
        {p.border === 'color' && (
          <div>
            <div className="mb-2 text-sm font-semibold">Border colour</div>
            <div className="flex flex-wrap items-center gap-1.5">
              {BORDER_SWATCHES.map((c) => (
                <button
                  key={c}
                  aria-label={`Border colour ${c}`}
                  onClick={() => setParams({ borderColor: c })}
                  className={`h-7 w-7 rounded-full ring-1 ring-slate-900/15 transition ${p.borderColor.toLowerCase() === c ? 'ring-2 ring-brand-500 ring-offset-2' : 'hover:scale-110'}`}
                  style={{ background: c }}
                />
              ))}
              <input type="color" aria-label="Custom border colour" title="Any colour" className="h-8 w-10 cursor-pointer rounded-lg border-0 bg-transparent" value={p.borderColor} onChange={(e) => setParams({ borderColor: e.target.value })} />
            </div>
          </div>
        )}
        {p.shape === 'contour' && (
          <RangeRow label="Smoothing" hint="Fills small gaps and notches so the blade cuts one clean line" value={p.smoothMm} min={0} max={10} step={0.5} suffix="mm" onChange={(v) => setParams({ smoothMm: v })} />
        )}
        {p.shape === 'rounded' && <RangeRow label="Corner radius" value={p.cornerMm} min={0.5} max={20} step={0.5} suffix="mm" onChange={(v) => setParams({ cornerMm: v })} />}

        {res && (
          <div className="flex flex-wrap gap-x-4 gap-y-1 text-xs text-slate-500">
            <span>
              {res.pieces} piece{res.pieces === 1 ? '' : 's'}
            </span>
            <span>cut length {fmtLen(res.cut.reduce((n, c) => n + pathLength(c), 0), u === 'in' ? 'in' : 'mm', u === 'in' ? 1 : 0)}</span>
            <span>
              {res.cut.reduce((n, c) => n + c.segs.length, 0)} nodes
            </span>
            {borderOf(p) > 0 && <span>border {fmtLen(borderOf(p), 'mm')}</span>}
          </div>
        )}
        {res?.warnings.map((w) => (
          <Notice key={w}>{w}</Notice>
        ))}
        {res && res.pieces > 1 && (
          <button className="btn-secondary" onClick={() => job.joinPieces(s.id)} disabled={!!busy}>
            <Layers size={15} /> Join into one sticker
          </button>
        )}
        {cut?.error && <Notice>Couldn't make the cut line: {cut.error}</Notice>}
      </Section>

      <div className="flex flex-col gap-2">
        {job.stickers.length > 1 && (
          <button className="btn-secondary" onClick={() => job.applyCutToAll(s.id)} title="Shape, border and smoothing – each sticker keeps its size">
            <Copy size={15} /> Use this cut style for all stickers
          </button>
        )}
        <div className="flex gap-2">
          <button className="btn-ghost flex-1" onClick={() => job.duplicate(s.id)} title="Same design, e.g. in another size">
            <Copy size={15} /> Duplicate
          </button>
          <button className="btn-ghost flex-1 hover:text-red-600" onClick={() => job.remove(s.id)}>
            <Trash2 size={15} /> Remove
          </button>
        </div>
      </div>
    </div>
  )
}

function PlainOptions(props: { tolerance: number; setTolerance: (n: number) => void; everywhere: boolean; setEverywhere: (v: boolean) => void; color: [number, number, number] }) {
  return (
    <div className="flex flex-col gap-3 rounded-xl bg-white p-3 ring-1 ring-slate-900/5">
      <Row label="Background colour" hint="Found along the image edge">
        <span className="h-6 w-10 rounded-md ring-1 ring-slate-900/10" style={{ background: `rgb(${props.color.join(',')})` }} />
      </Row>
      <RangeRow label="Tolerance" hint="Higher removes more similar shades" value={props.tolerance} min={0} max={100} step={1} suffix="%" onChange={props.setTolerance} />
      <Switch checked={props.everywhere} onChange={props.setEverywhere} label={<span className="text-sm">Also inside the design (e.g. inside letters)</span>} />
    </div>
  )
}
