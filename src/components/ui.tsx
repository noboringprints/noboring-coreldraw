import { createContext, useCallback, useContext, useEffect, useRef, useState, type CSSProperties, type ReactNode } from 'react'
import { AlertTriangle, CheckCircle2, Info, Minus, Plus, X } from 'lucide-react'
import type { SourceFile } from '../lib/sources'
import { formatPageRange, parsePageRange } from '../lib/job'
import { expand, round3, type Rect } from '../lib/geometry'
import { describeSize } from '../lib/artwork'

/* ------------------------------------------------------------------ numbers */

/** Number box that lets you type freely and only commits valid numbers. */
export function NumberField(props: {
  value: number
  onChange: (n: number) => void
  min?: number
  max?: number
  className?: string
  suffix?: string
  'aria-label'?: string
}) {
  const [text, setText] = useState(String(props.value))
  useEffect(() => setText(String(props.value)), [props.value])
  const commit = (t: string) => {
    const n = Number(t.replace(',', '.'))
    if (t.trim() === '' || !Number.isFinite(n)) return setText(String(props.value))
    const c = Math.min(props.max ?? Infinity, Math.max(props.min ?? -Infinity, n))
    setText(String(c))
    if (c !== props.value) props.onChange(c)
  }
  return (
    <label className={`field inline-flex items-center gap-1.5 py-0 pr-3 ${props.className ?? ''}`}>
      <input
        aria-label={props['aria-label']}
        className="w-14 bg-transparent py-2 text-right font-medium tabular-nums outline-none"
        inputMode="decimal"
        value={text}
        onChange={(e) => setText(e.target.value)}
        onBlur={(e) => commit(e.target.value)}
        onKeyDown={(e) => e.key === 'Enter' && commit((e.target as HTMLInputElement).value)}
      />
      {props.suffix && <span className="text-xs text-slate-400">{props.suffix}</span>}
    </label>
  )
}

/** Up to this many pages, every page also gets a toggle chip. */
const PAGE_CHIPS_MAX = 40

/**
 * Picks which pages of a multi-page PDF to print: type a range ("2-4, 6") or click the page chips.
 * `value` and `onChange` use 0-based page indexes, ascending.
 */
export function PageRangeField(props: { count: number; value: number[]; onChange: (pages: number[]) => void; size?: 'sm' | 'md' }) {
  const { count, value } = props
  const sm = props.size === 'sm'
  const shown = formatPageRange(value, count)
  const [text, setText] = useState(shown)
  const [editing, setEditing] = useState(false)
  useEffect(() => {
    if (!editing) setText(shown)
  }, [shown, editing])
  const parsed = parsePageRange(text, count)
  const error = editing && typeof parsed === 'string' ? parsed : null
  const preview = editing && typeof parsed !== 'string' ? parsed : value

  const apply = (pages: number[]) => {
    if (pages.length && (pages.length !== value.length || pages.some((p, i) => p !== value[i]))) props.onChange(pages)
  }
  const commit = () => {
    setEditing(false)
    if (typeof parsed === 'string') setText(shown)
    else apply(parsed)
  }
  const toggle = (i: number) => {
    // a click while typing works on what is typed so far
    const base = preview
    const on = base.includes(i)
    setEditing(false)
    // the last page can't be switched off – something must print
    if (on && base.length === 1) return setText(shown)
    apply(on ? base.filter((p) => p !== i) : [...base, i].sort((a, b) => a - b))
  }

  return (
    <div className={`flex min-w-0 flex-col ${sm ? 'gap-1.5' : 'gap-2'}`}>
      <div className="flex flex-wrap items-center gap-2">
        <input
          aria-label="Pages to print"
          aria-invalid={!!error}
          className={`field tabular-nums ${sm ? 'w-28 px-2.5 py-1 text-xs' : 'w-40 py-1.5'} ${error ? 'ring-2 ring-red-400 focus:ring-red-500' : ''}`}
          placeholder="e.g. 2-4, 6"
          value={text}
          onFocus={(e) => {
            setEditing(true)
            e.target.select()
          }}
          onChange={(e) => {
            setEditing(true)
            setText(e.target.value)
          }}
          onBlur={commit}
          onKeyDown={(e) => {
            if (e.key === 'Enter') (e.target as HTMLInputElement).blur()
            if (e.key === 'Escape') {
              setText(shown)
              setEditing(false)
              ;(e.target as HTMLInputElement).blur()
            }
          }}
        />
        <span className={`tabular-nums ${sm ? 'text-[11px]' : 'text-xs'} ${error ? 'text-red-600' : 'text-slate-500'}`} aria-live="polite">
          {error ?? `${preview.length} of ${count} page${count === 1 ? '' : 's'}`}
        </span>
        {!editing && value.length !== count && (
          <button className={`font-semibold text-brand-700 hover:underline ${sm ? 'text-[11px]' : 'text-xs'}`} onClick={() => apply([...Array(count).keys()])}>
            All pages
          </button>
        )}
      </div>
      {count <= PAGE_CHIPS_MAX && (
        <div className="flex flex-wrap gap-1" role="group" aria-label="Pages">
          {Array.from({ length: count }, (_, i) => {
            const on = preview.includes(i)
            return (
              <button
                key={i}
                aria-pressed={on}
                title={on ? `Leave out page ${i + 1}` : `Print page ${i + 1}`}
                // keep focus in the text box while typing so a click doesn't commit a half-typed range first
                onMouseDown={(e) => editing && e.preventDefault()}
                onClick={() => toggle(i)}
                className={`grid place-items-center rounded-md font-semibold tabular-nums transition-colors ${sm ? 'h-6 min-w-6 px-1 text-[11px]' : 'h-7 min-w-7 px-1.5 text-xs'} ${
                  on ? 'bg-brand-600 text-white hover:bg-brand-700' : 'bg-slate-100 text-slate-400 line-through decoration-slate-300 hover:bg-slate-200 hover:text-slate-600'
                }`}
              >
                {i + 1}
              </button>
            )
          })}
        </div>
      )}
    </div>
  )
}

/** − 3 + pill for copies. */
export function Stepper(props: { value: number; onChange: (n: number) => void; min?: number; label?: string; size?: 'sm' | 'md' }) {
  const min = props.min ?? 1
  const sm = props.size === 'sm'
  const b = `grid place-items-center rounded-full text-slate-600 transition hover:bg-white hover:text-slate-900 hover:shadow-sm disabled:opacity-30 ${sm ? 'h-7 w-7' : 'h-9 w-9'}`
  return (
    <span className="inline-flex items-center gap-1 rounded-full bg-slate-100 p-1">
      <button aria-label="Fewer" className={b} disabled={props.value <= min} onClick={() => props.onChange(props.value - 1)}>
        <Minus size={sm ? 14 : 16} strokeWidth={2.5} />
      </button>
      <input
        aria-label={props.label}
        className={`bg-transparent text-center font-semibold tabular-nums outline-none ${sm ? 'w-7 text-sm' : 'w-9 text-base'}`}
        value={props.value}
        onChange={(e) => {
          const n = parseInt(e.target.value, 10)
          if (Number.isFinite(n) && n >= min) props.onChange(n)
        }}
      />
      <button aria-label="More" className={b} onClick={() => props.onChange(props.value + 1)}>
        <Plus size={sm ? 14 : 16} strokeWidth={2.5} />
      </button>
    </span>
  )
}

/* ------------------------------------------------------------------ choices */

export interface SegOption<T extends string> {
  value: T
  label: ReactNode
  hint?: string
}

/** iOS-style segmented control. */
export function Segmented<T extends string>(props: { value: T; options: SegOption<T>[]; onChange: (v: T) => void; size?: 'sm' | 'md'; full?: boolean; 'aria-label'?: string }) {
  const sm = props.size === 'sm'
  return (
    <div role="radiogroup" aria-label={props['aria-label']} className={`inline-flex rounded-xl bg-slate-100 p-1 ${props.full ? 'flex w-full' : ''}`}>
      {props.options.map((o) => {
        const on = o.value === props.value
        return (
          <button
            key={o.value}
            role="radio"
            aria-checked={on}
            title={o.hint}
            onClick={() => props.onChange(o.value)}
            className={`flex items-center justify-center gap-1.5 rounded-lg font-semibold whitespace-nowrap transition-all ${sm ? 'px-2.5 py-1 text-xs' : 'px-3.5 py-1.5 text-sm'} ${
              props.full ? 'flex-1' : ''
            } ${on ? 'bg-white text-slate-900 shadow-sm ring-1 ring-slate-900/5' : 'text-slate-500 hover:text-slate-800'}`}
          >
            {o.label}
          </button>
        )
      })}
    </div>
  )
}

/** On/off switch. */
export function Switch(props: { checked: boolean; onChange: (v: boolean) => void; label?: ReactNode }) {
  return (
    <label className="inline-flex cursor-pointer items-center gap-2.5 text-sm font-medium select-none">
      <button
        role="switch"
        aria-checked={props.checked}
        onClick={() => props.onChange(!props.checked)}
        className={`relative h-6 w-10 rounded-full transition-colors ${props.checked ? 'bg-brand-600' : 'bg-slate-300'}`}
      >
        <span className={`absolute top-0.5 left-0.5 h-5 w-5 rounded-full bg-white shadow transition-transform ${props.checked ? 'translate-x-4' : ''}`} />
      </button>
      {props.label}
    </label>
  )
}

/* ------------------------------------------------------------------ status */

type Tone = 'good' | 'warn' | 'info' | 'neutral' | 'brand'
const TONES: Record<Tone, string> = {
  good: 'bg-emerald-50 text-emerald-700 ring-emerald-600/15',
  warn: 'bg-amber-50 text-amber-800 ring-amber-600/20',
  info: 'bg-sky-50 text-sky-700 ring-sky-600/15',
  neutral: 'bg-slate-100 text-slate-600 ring-slate-500/10',
  brand: 'bg-brand-50 text-brand-700 ring-brand-600/15',
}

export function Badge({ tone = 'neutral', icon, children }: { tone?: Tone; icon?: ReactNode; children: ReactNode }) {
  return <span className={`inline-flex items-center gap-1 rounded-full px-2.5 py-0.5 text-xs font-semibold ring-1 ring-inset ${TONES[tone]}`}>{icon}{children}</span>
}

/** A short message line. */
export function Notice({ tone = 'warn', children }: { tone?: 'warn' | 'info' | 'good'; children: ReactNode }) {
  const Icon = tone === 'warn' ? AlertTriangle : tone === 'good' ? CheckCircle2 : Info
  const cls = tone === 'warn' ? 'bg-amber-50 text-amber-900' : tone === 'good' ? 'bg-emerald-50 text-emerald-900' : 'bg-slate-50 text-slate-600'
  const ic = tone === 'warn' ? 'text-amber-500' : tone === 'good' ? 'text-emerald-500' : 'text-slate-400'
  return (
    <div className={`flex items-start gap-2.5 rounded-xl px-3.5 py-2.5 text-sm leading-snug ${cls}`}>
      <Icon size={16} className={`mt-0.5 shrink-0 ${ic}`} />
      <span>{children}</span>
    </div>
  )
}

/** Old name, still used in a few places. */
export const Warning = ({ children }: { children: ReactNode }) => <Notice tone="warn">{children}</Notice>

/* ------------------------------------------------------------------ toasts */

const ToastCtx = createContext<(msg: string) => void>(() => {})
export const useToast = () => useContext(ToastCtx)

export function ToastHost({ children }: { children: ReactNode }) {
  const [items, setItems] = useState<{ id: number; msg: string }[]>([])
  const push = useCallback((msg: string) => {
    const id = Date.now() + Math.random()
    setItems((x) => [...x, { id, msg }])
    setTimeout(() => setItems((x) => x.filter((t) => t.id !== id)), 2600)
  }, [])
  return (
    <ToastCtx.Provider value={push}>
      {children}
      <div className="pointer-events-none fixed inset-x-0 bottom-24 z-[60] flex flex-col items-center gap-2">
        {items.map((t) => (
          <div key={t.id} className="flex animate-fade-up items-center gap-2 rounded-full bg-slate-900 px-4 py-2.5 text-sm font-medium text-white shadow-lift">
            <CheckCircle2 size={16} className="text-emerald-400" />
            {t.msg}
          </div>
        ))}
      </div>
    </ToastCtx.Provider>
  )
}

/* ------------------------------------------------------------------ panels */

/** Slide-over panel from the right. */
export function Drawer(props: { title: ReactNode; subtitle?: ReactNode; onClose: () => void; children: ReactNode; footer?: ReactNode }) {
  useEffect(() => {
    const k = (e: KeyboardEvent) => e.key === 'Escape' && props.onClose()
    window.addEventListener('keydown', k)
    return () => window.removeEventListener('keydown', k)
  }, [props])
  return (
    <div className="fixed inset-0 z-50 flex justify-end">
      <div className="absolute inset-0 animate-[fade-up_0.2s_both] bg-slate-900/30 backdrop-blur-[2px]" onClick={props.onClose} />
      <div role="dialog" aria-label={typeof props.title === 'string' ? props.title : undefined} className="relative flex h-full w-full max-w-lg animate-slide-in flex-col bg-white shadow-lift">
        <div className="flex items-start justify-between gap-4 border-b border-slate-100 px-6 py-5">
          <div>
            <h2 className="text-lg font-bold tracking-tight">{props.title}</h2>
            {props.subtitle && <p className="mt-0.5 text-sm text-slate-500">{props.subtitle}</p>}
          </div>
          <button className="btn-icon btn-ghost -mr-2" onClick={props.onClose} aria-label="Close">
            <X size={18} />
          </button>
        </div>
        <div className="min-h-0 flex-1 overflow-y-auto px-6 py-5">{props.children}</div>
        {props.footer && <div className="border-t border-slate-100 px-6 py-4">{props.footer}</div>}
      </div>
    </div>
  )
}

/* ------------------------------------------------------------------ pictures */

export function Thumb({ url, alt, size = 'md' }: { url?: string; alt: string; size?: 'sm' | 'md' | 'lg' }) {
  const s = size === 'lg' ? 'h-40' : size === 'sm' ? 'h-14 w-14' : 'h-24 w-24'
  return (
    <div className={`flex shrink-0 items-center justify-center overflow-hidden rounded-2xl bg-slate-100 ${size === 'lg' ? 'w-full p-4' : 'p-2'} ${s}`}>
      {url ? (
        <img src={url} alt={alt} className="max-h-full max-w-full rounded-sm object-contain shadow-[0_2px_8px_rgb(0_0_0/0.15)]" />
      ) : (
        <span className="h-6 w-6 animate-spin rounded-full border-2 border-slate-300 border-t-brand-500" />
      )}
    </div>
  )
}

export /** Shows a canvas rendered elsewhere (no PNG encode/decode round trip). */
function CanvasView({ canvas, className, style, label }: { canvas: HTMLCanvasElement; className?: string; style?: CSSProperties; label?: string }) {
  const host = useRef<HTMLDivElement>(null)
  useEffect(() => {
    const el = host.current
    if (!el) return
    canvas.style.cssText = 'display:block;width:100%;height:100%'
    el.replaceChildren(canvas)
    return () => {
      if (canvas.parentNode === el) el.removeChild(canvas)
    }
  }, [canvas])
  return <div ref={host} role="img" aria-label={label} className={className} style={style} />
}

/** Colours used to tell designs apart in diagrams. */
export const DESIGN_COLORS = ['#7c5cff', '#22b8a7', '#f59e0b', '#ef5da8', '#3b82f6', '#84cc16', '#f97316', '#06b6d4']

/** Tiny picture of a sheet with the copies on it. */
export function SheetDiagram(props: {
  sheetW: number
  sheetH: number
  trims: { rect: Rect; color: string }[]
  bleed: number
  height?: number
  dark?: boolean
}) {
  const { sheetW: W, sheetH: H } = props
  const h = props.height ?? 72
  return (
    <svg viewBox={`0 0 ${W} ${H}`} style={{ height: h, width: (h * W) / H }} className="shrink-0 overflow-visible">
      <rect x={0} y={0} width={W} height={H} rx={W * 0.02} fill="#fff" stroke={props.dark ? 'transparent' : '#e2e8f0'} strokeWidth={W * 0.006} />
      <g transform={`translate(0 ${H}) scale(1 -1)`}>
        {props.trims.map((t, i) => {
          const b = expand(t.rect, props.bleed)
          return (
            <g key={i}>
              <rect x={b.x} y={b.y} width={b.w} height={b.h} fill={t.color} opacity={0.25} />
              <rect x={t.rect.x} y={t.rect.y} width={t.rect.w} height={t.rect.h} fill={t.color} opacity={0.85} rx={W * 0.008} />
            </g>
          )
        })}
      </g>
    </svg>
  )
}

/* ------------------------------------------------------------------ text */

/** "216 × 303 mm · A4 + 3 mm bleed" or "3508 × 4961 px". */
export function detectedSizeText(src: SourceFile, pageIndex: number, bleed: number): string {
  const p = src.pages[pageIndex] ?? src.pages[0]
  const g = p.geometry
  if (g.kind === 'image') {
    const real = g.physicalSize ? ` · ${round1(g.widthMm)} × ${round1(g.heightMm)} mm` : ''
    return `${g.pxW} × ${g.pxH} px${real}`
  }
  const name = describeSize(g.widthMm, g.heightMm, bleed)
  return `${round1(g.widthMm)} × ${round1(g.heightMm)} mm${name ? ` · ${name}` : ''}`
}

export const round1 = (n: number) => String(Math.round(n * 10) / 10)
export const fmtMm = (n: number) => String(round3(n))
