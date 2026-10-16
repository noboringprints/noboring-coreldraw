import type { ReactNode } from 'react'
import { ArrowLeft, ArrowRight, Check, SlidersHorizontal } from 'lucide-react'
import type { PrintSettings } from '../config/defaults'

export type Step = 'upload' | 'size' | 'preview' | 'download'

export const STEPS: { id: Step; label: string }[] = [
  { id: 'upload', label: 'Upload' },
  { id: 'size', label: 'Size & copies' },
  { id: 'preview', label: 'Preview' },
  { id: 'download', label: 'Download' },
]

/** The app logo; it also leads back to the start screen (posters or stickers). */
export function Logo() {
  return (
    <a href="#/" title="Start screen – posters or stickers" className="flex items-center gap-2.5 rounded-xl focus-visible:ring-4 focus-visible:ring-brand-200 focus-visible:outline-none">
      <div className="relative grid h-9 w-9 place-items-center rounded-xl bg-gradient-to-br from-brand-500 to-brand-700 shadow-[0_4px_12px_rgb(91_47_245/0.35)]">
        <svg width="20" height="20" viewBox="0 0 20 20" aria-hidden>
          <rect x="5" y="5" width="10" height="10" rx="1.5" fill="#fff" />
          <path d="M5 0.5v2.5M15 0.5v2.5M5 17v2.5M15 17v2.5M0.5 5h2.5M0.5 15h2.5M17 5h2.5M17 15h2.5" stroke="#fff" strokeOpacity=".7" strokeWidth="1.4" strokeLinecap="round" />
        </svg>
      </div>
      <div className="leading-none">
        <div className="text-[15px] font-bold tracking-tight">Print Ready</div>
        <div className="mt-0.5 text-[11px] font-medium text-slate-400">bleed · marks · layout</div>
      </div>
    </a>
  )
}

export default function Header(props: { step: Step; setStep: (s: Step) => void; canContinue: boolean; onSettings: () => void; settings: PrintSettings }) {
  const { step, setStep, canContinue, settings } = props
  const current = STEPS.findIndex((s) => s.id === step)
  return (
    <header className="sticky top-0 z-30 border-b border-slate-200/70 bg-white/80 backdrop-blur-xl">
      <div className="mx-auto flex h-16 max-w-[1600px] items-center gap-6 px-5">
        <Logo />
        <nav className="flex flex-1 items-center justify-center" aria-label="Steps">
          {STEPS.map((s, i) => {
            const enabled = i === 0 || canContinue
            const active = i === current
            const done = i < current
            return (
              <div key={s.id} className="flex items-center">
                {i > 0 && <div className={`mx-1 h-px w-6 transition-colors sm:w-10 ${i <= current ? 'bg-brand-400' : 'bg-slate-200'}`} />}
                <button
                  disabled={!enabled}
                  onClick={() => setStep(s.id)}
                  aria-current={active ? 'step' : undefined}
                  className={`group flex items-center gap-2 rounded-full py-1.5 pr-3 pl-1.5 text-sm font-semibold transition disabled:opacity-40 ${
                    active ? 'bg-brand-50 text-brand-700' : done ? 'text-slate-700 hover:bg-slate-100' : 'text-slate-400 hover:bg-slate-100 hover:text-slate-600'
                  }`}
                >
                  <span
                    className={`grid h-6 w-6 place-items-center rounded-full text-xs transition ${
                      active ? 'bg-brand-600 text-white shadow-[0_2px_8px_rgb(91_47_245/0.4)]' : done ? 'bg-brand-100 text-brand-700' : 'bg-slate-100 text-slate-500'
                    }`}
                  >
                    {done ? <Check size={13} strokeWidth={3} /> : i + 1}
                  </span>
                  <span className="hidden md:inline">{s.label}</span>
                </button>
              </div>
            )
          })}
        </nav>
        <button onClick={props.onSettings} className="btn-secondary rounded-full py-2 pr-3 pl-3.5" title="Print settings">
          <span className="hidden text-slate-500 lg:inline">
            {settings.sheet.name} ({Math.round(settings.sheet.widthMm * 10) / 10} × {Math.round(settings.sheet.heightMm * 10) / 10} mm) · {settings.bleedMm} mm bleed
          </span>
          <SlidersHorizontal size={16} />
        </button>
      </div>
    </header>
  )
}

/** The sticky bar at the bottom with the one main action. */
export function ActionBar(props: { summary?: ReactNode; onBack?: () => void; backLabel?: string; next?: { label: string; onClick: () => void; disabled?: boolean; icon?: ReactNode } }) {
  return (
    <div className="sticky bottom-0 z-20 border-t border-slate-200/70 bg-white/85 backdrop-blur-xl">
      <div className="mx-auto flex max-w-[1600px] items-center gap-4 px-5 py-3">
        {props.onBack ? (
          <button className="btn-ghost" onClick={props.onBack}>
            <ArrowLeft size={16} />
            {props.backLabel ?? 'Back'}
          </button>
        ) : (
          <span />
        )}
        <div className="min-w-0 flex-1 truncate text-center text-sm text-slate-500">{props.summary}</div>
        {props.next && (
          <button className="btn-primary btn-lg" disabled={props.next.disabled} onClick={props.next.onClick}>
            {props.next.label}
            {props.next.icon ?? <ArrowRight size={18} />}
          </button>
        )}
      </div>
    </div>
  )
}
