import { useRef } from 'react'
import { ImageMinus, Plus, Scissors, Sparkles, UploadCloud, Wand2, X } from 'lucide-react'
import { Badge, Notice } from '../../components/ui'
import type { StickerSettings } from '../config'
import { type Sticker, effectiveDpi, fmtLen, stickerSize } from '../model'
import { CHECKER } from '../render'
import type { BusyState, StickerJob } from '../useStickerJob'

const ACCEPT = '.png,.jpg,.jpeg,.webp,image/png,image/jpeg,image/webp'

export function BusyOverlay({ busy }: { busy?: BusyState }) {
  if (!busy) return null
  return (
    <div className="absolute inset-0 z-10 grid place-items-center rounded-2xl bg-white/75 backdrop-blur-[2px]">
      <div className="w-4/5 text-center">
        <span className="mx-auto block h-6 w-6 animate-spin rounded-full border-2 border-slate-300 border-t-brand-500" />
        <div className="mt-2 text-xs font-semibold text-slate-600">{busy.label}</div>
        {busy.fraction !== undefined && (
          <div className="mt-2 h-1.5 overflow-hidden rounded-full bg-slate-200">
            <div className="h-full rounded-full bg-brand-500 transition-[width]" style={{ width: `${Math.round(busy.fraction * 100)}%` }} />
          </div>
        )}
      </div>
    </div>
  )
}

export function BackgroundBadge({ s }: { s: Sticker }) {
  if (s.background === 'ai') return <Badge tone="brand" icon={<Wand2 size={12} />}>Background removed</Badge>
  if (s.background === 'plain') return <Badge tone="brand" icon={<ImageMinus size={12} />}>Background removed</Badge>
  if (s.original.info.transparent) return <Badge tone="good">Transparent</Badge>
  return <Badge tone="neutral">Has background</Badge>
}

export default function AddStep(props: { job: StickerJob; settings: StickerSettings; onOpen: (id: string) => void }) {
  const { job, settings } = props
  const input = useRef<HTMLInputElement>(null)
  const pick = () => input.current?.click()
  const empty = job.stickers.length === 0

  return (
    <div className="mx-auto w-full max-w-6xl px-5 py-8">
      <input
        ref={input}
        type="file"
        multiple
        accept={ACCEPT}
        className="hidden"
        onChange={(e) => {
          void job.addFiles([...(e.target.files ?? [])])
          e.target.value = ''
        }}
      />

      {empty ? (
        <div className="animate-fade-up">
          <div className="mx-auto max-w-2xl text-center">
            <h1 className="text-3xl font-bold tracking-tight text-balance sm:text-4xl">Make die-cut stickers in minutes</h1>
            <p className="mt-3 text-lg text-slate-500">Cut line around every design, background removal and a full sheet – ready for the plotter.</p>
          </div>

          <button
            onClick={pick}
            className="group mt-10 flex w-full flex-col items-center rounded-[2rem] border-2 border-dashed border-slate-300 bg-white px-6 py-16 text-center transition hover:border-brand-400 hover:bg-brand-50/40"
          >
            <span className="grid h-20 w-20 place-items-center rounded-3xl bg-gradient-to-br from-brand-500 to-brand-700 text-white shadow-[0_10px_30px_rgb(91_47_245/0.35)] transition group-hover:scale-105">
              <UploadCloud size={36} />
            </span>
            <span className="mt-6 text-xl font-bold">Drop your sticker designs here</span>
            <span className="mt-1 text-slate-500">PNG (best with a transparent background), JPG or WebP · as many as you like</span>
            <span className="btn-primary btn-lg mt-6">
              <Plus size={18} /> Choose images
            </span>
          </button>

          <div className="mt-8 grid gap-3 sm:grid-cols-3">
            {[
              { icon: <Scissors size={18} />, title: 'Cut line done for you', text: 'Follows the design with a border – like CorelDRAW’s Contour.' },
              { icon: <Wand2 size={18} />, title: 'Background removal', text: 'Plain backgrounds go automatically; photos with one click.' },
              { icon: <Sparkles size={18} />, title: 'Full sheets', text: 'Stickers nest into each other’s gaps on A4 / A3.' },
            ].map((f) => (
              <div key={f.title} className="flex items-start gap-3 rounded-2xl bg-white/60 p-4 ring-1 ring-slate-900/[0.04]">
                <span className="grid h-9 w-9 shrink-0 place-items-center rounded-xl bg-brand-50 text-brand-600">{f.icon}</span>
                <div>
                  <div className="text-sm font-semibold">{f.title}</div>
                  <div className="text-sm text-slate-500">{f.text}</div>
                </div>
              </div>
            ))}
          </div>
        </div>
      ) : (
        <div className="animate-fade-up">
          <div className="mb-6 flex flex-wrap items-end justify-between gap-3">
            <div>
              <h1 className="text-2xl font-bold tracking-tight">Your stickers</h1>
              <p className="mt-1 text-slate-500">Click a sticker to set its size and cut line, or continue.</p>
            </div>
            <button className="btn-secondary" onClick={pick}>
              <Plus size={16} /> Add images
            </button>
          </div>

          <div className="grid grid-cols-2 gap-4 sm:grid-cols-3 lg:grid-cols-4">
            {job.stickers.map((s, i) => {
              const size = stickerSize(s)
              const dpi = effectiveDpi(s)
              return (
                <div key={s.id} className="group card relative animate-fade-up p-3" style={{ animationDelay: `${i * 40}ms` }}>
                  <button onClick={() => props.onOpen(s.id)} className="relative block h-40 w-full overflow-hidden rounded-2xl" style={CHECKER} aria-label={`Edit ${s.name}`}>
                    <img src={s.art.url} alt="" className="h-full w-full object-contain p-3" />
                    <BusyOverlay busy={job.busy[s.id]} />
                  </button>
                  <button
                    onClick={() => job.remove(s.id)}
                    aria-label={`Remove ${s.name}`}
                    className="absolute top-5 right-5 z-20 grid h-8 w-8 place-items-center rounded-full bg-white/90 text-slate-500 opacity-0 shadow-sm ring-1 ring-slate-900/5 transition group-hover:opacity-100 hover:text-red-600 focus:opacity-100"
                  >
                    <X size={16} />
                  </button>
                  <div className="px-1 pt-3 pb-1">
                    <div className="truncate font-semibold" title={s.name}>
                      {s.name}
                    </div>
                    <div className="mt-0.5 truncate text-xs text-slate-500">
                      {s.art.info.pxW} × {s.art.info.pxH} px · {fmtLen(size.w, settings.units)} × {fmtLen(size.h, settings.units)}
                    </div>
                    <div className="mt-2.5 flex flex-wrap gap-1.5">
                      <BackgroundBadge s={s} />
                      {dpi < settings.minDpi && <Badge tone="warn">{Math.round(dpi)} DPI</Badge>}
                    </div>
                  </div>
                </div>
              )
            })}
            <button
              onClick={pick}
              className="flex min-h-[15rem] flex-col items-center justify-center gap-2 rounded-3xl border-2 border-dashed border-slate-300 text-slate-500 transition hover:border-brand-400 hover:bg-brand-50/40 hover:text-brand-700"
            >
              <span className="grid h-11 w-11 place-items-center rounded-2xl bg-slate-100">
                <Plus size={20} />
              </span>
              <span className="text-sm font-semibold">Add more</span>
            </button>
          </div>
        </div>
      )}

      <div className="mt-6 flex flex-col gap-2">
        {job.loading && (
          <div className="flex items-center gap-2 text-sm text-slate-500">
            <span className="h-4 w-4 animate-spin rounded-full border-2 border-slate-300 border-t-brand-500" /> Reading images…
          </div>
        )}
        {job.errors.map((e) => (
          <Notice key={e}>{e}</Notice>
        ))}
      </div>

      {!empty && (
        <p className="mt-8 text-center text-xs text-slate-400">
          Tip: the sharpest stickers come from PNGs with a transparent background, about 300 DPI at the printed size.
        </p>
      )}
    </div>
  )
}
