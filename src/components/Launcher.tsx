import type { ReactNode } from 'react'
import { ArrowRight, Lock } from 'lucide-react'
import { Logo } from './Header'

export type Mode = 'posters' | 'stickers'

/** Little drawing of a poster sheet: two A4s with crop marks. */
function PosterArt() {
  return (
    <svg viewBox="0 0 160 120" className="h-full w-full" aria-hidden>
      <rect x="38" y="6" width="84" height="108" rx="3" fill="#fff" stroke="#e2e8f0" />
      {[
        [48, 16],
        [48, 62],
      ].map(([x, y], i) => (
        <g key={i}>
          <rect x={x} y={y} width="64" height="42" rx="1.5" fill={i ? '#22b8a7' : '#7c5cff'} opacity=".9" />
          <rect x={x + 6} y={y + 7} width="30" height="5" rx="1" fill="#fff" opacity=".8" />
          <rect x={x + 6} y={y + 15} width="20" height="3" rx="1" fill="#fff" opacity=".55" />
        </g>
      ))}
      <path d="M48 10v4M112 10v4M42 16h4M114 16h4M48 106v4M112 106v4M42 104h4M114 104h4" stroke="#f97316" strokeWidth="1.2" />
    </svg>
  )
}

/** Little drawing of a sticker sheet: die-cut shapes with magenta cut lines and corner marks. */
function StickerArt() {
  return (
    <svg viewBox="0 0 160 120" className="h-full w-full" aria-hidden>
      <rect x="38" y="6" width="84" height="108" rx="3" fill="#fff" stroke="#e2e8f0" />
      <path d="M43 11h7M43 11v7M117 11h-7M117 11v7M43 109h7M43 109v-7M117 109h-7M117 109v-7" stroke="#111" strokeWidth="1.6" />
      <circle cx="62" cy="34" r="13" fill="#f59e0b" />
      <circle cx="62" cy="34" r="16" fill="none" stroke="#ec008c" strokeWidth="1" strokeDasharray="2.5 1.8" />
      <path d="M98 20l5 10 11 1.6-8 7.8 2 11-10-5.3-10 5.3 2-11-8-7.8 11-1.6z" fill="#ef5da8" />
      <path d="M98 14.5l6.8 13.2 14.5 2.2-10.6 10.2 2.6 14.6-13.3-7-13.3 7 2.6-14.6-10.6-10.2 14.5-2.2z" fill="none" stroke="#ec008c" strokeWidth="1" strokeLinejoin="round" strokeDasharray="2.5 1.8" />
      <rect x="50" y="64" width="60" height="32" rx="8" fill="#3b82f6" />
      <rect x="57" y="73" width="30" height="5" rx="1" fill="#fff" opacity=".85" />
      <rect x="57" y="82" width="20" height="3" rx="1" fill="#fff" opacity=".6" />
      <rect x="46.5" y="60.5" width="67" height="39" rx="11" fill="none" stroke="#ec008c" strokeWidth="1" strokeDasharray="2.5 1.8" />
    </svg>
  )
}

function Choice(props: { title: string; tagline: string; points: string[]; art: ReactNode; last: boolean; onClick: () => void; accent: string }) {
  return (
    <button
      onClick={props.onClick}
      className="group card relative flex flex-col overflow-hidden text-left transition duration-200 hover:-translate-y-0.5 hover:shadow-lift focus-visible:ring-4 focus-visible:ring-brand-200 focus-visible:outline-none"
    >
      {props.last && <span className="absolute top-4 right-4 z-10 rounded-full bg-white/90 px-2.5 py-0.5 text-xs font-semibold text-slate-500 ring-1 ring-slate-900/5">Last used</span>}
      <div className={`h-44 px-6 pt-6 ${props.accent}`}>{props.art}</div>
      <div className="flex flex-1 flex-col p-6">
        <div className="text-xl font-bold tracking-tight">{props.title}</div>
        <div className="mt-1 text-slate-500">{props.tagline}</div>
        <ul className="mt-4 space-y-1.5 text-sm text-slate-600">
          {props.points.map((p) => (
            <li key={p} className="flex gap-2">
              <span className="mt-[7px] h-1.5 w-1.5 shrink-0 rounded-full bg-brand-400" />
              {p}
            </li>
          ))}
        </ul>
        <span className="mt-6 inline-flex items-center gap-1.5 text-sm font-semibold text-brand-700">
          Open <ArrowRight size={16} className="transition group-hover:translate-x-0.5" />
        </span>
      </div>
    </button>
  )
}

export default function Launcher(props: { last: Mode | null; onPick: (m: Mode) => void }) {
  return (
    <div className="flex min-h-full flex-col">
      <header className="border-b border-slate-200/70 bg-white/80 backdrop-blur-xl">
        <div className="mx-auto flex h-16 max-w-[1600px] items-center px-5">
          <Logo />
        </div>
      </header>
      <main className="mx-auto w-full max-w-4xl flex-1 animate-fade-up px-5 py-12">
        <div className="text-center">
          <h1 className="text-3xl font-bold tracking-tight text-balance sm:text-4xl">What are we printing today?</h1>
          <p className="mt-3 text-lg text-slate-500">Pick a job – everything is set up for production automatically.</p>
        </div>
        <div className="mt-10 grid gap-5 sm:grid-cols-2">
          <Choice
            title="Posters"
            tagline="A3 · A4 · A5 on 13×19 or A3 sheets"
            points={['3 mm bleed and crop marks added', 'Most copies per sheet, laid out for you', 'PDFs stay sharp vector']}
            art={<PosterArt />}
            accent="bg-gradient-to-br from-brand-50 to-slate-50"
            last={props.last === 'posters'}
            onClick={() => props.onPick('posters')}
          />
          <Choice
            title="Stickers"
            tagline="Die-cut & kiss-cut sticker sheets"
            points={['Cut line around the design, like CorelDRAW Contour', 'Background removal built in', 'Fills A4 / A3 sheets, ready for the plotter']}
            art={<StickerArt />}
            accent="bg-gradient-to-br from-pink-50 to-amber-50"
            last={props.last === 'stickers'}
            onClick={() => props.onPick('stickers')}
          />
        </div>
        <p className="mt-10 flex items-center justify-center gap-2 text-sm text-slate-400">
          <Lock size={14} /> Files never leave this computer.
        </p>
      </main>
    </div>
  )
}
