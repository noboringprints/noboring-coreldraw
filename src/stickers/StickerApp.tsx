import { Suspense, lazy, useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Check, SlidersHorizontal, UploadCloud } from 'lucide-react'
import { ActionBar, Logo } from '../components/Header'
import { ToastHost, useToast } from '../components/ui'
import type { StickerSettings } from './config'
import { type NestDesign, type StickerSheetLayout, nest } from './lib/nest'
import { fmtLen, loadStickerSettings, saveStickerSettings } from './model'
import { useStickerJob } from './useStickerJob'
import AddStep from './components/AddStep'
import CutStep from './components/CutStep'
import StickerSettingsDialog from './components/StickerSettingsDialog'

const SheetStep = lazy(() => import('./components/SheetStep'))
const ExportStep = lazy(() => import('./components/ExportStep'))

export type StickerStep = 'add' | 'cut' | 'sheet' | 'export'
const STEPS: { id: StickerStep; label: string }[] = [
  { id: 'add', label: 'Add stickers' },
  { id: 'cut', label: 'Cut line' },
  { id: 'sheet', label: 'Sheet' },
  { id: 'export', label: 'Download' },
]

export type Overrides = Record<string, { x: number; y: number } | undefined>

export default function StickerApp({ active }: { active: boolean }) {
  return (
    <ToastHost>
      <Stickers active={active} />
    </ToastHost>
  )
}

function Stickers({ active }: { active: boolean }) {
  const toast = useToast()
  const [step, setStep] = useState<StickerStep>('add')
  const [settings, setSettingsState] = useState<StickerSettings>(loadStickerSettings)
  const setSettings = useCallback((s: StickerSettings) => {
    setSettingsState(s)
    saveStickerSettings(s)
  }, [])
  const [showSettings, setShowSettings] = useState(false)
  const [selected, setSelected] = useState<string | null>(null)
  const job = useStickerJob(settings, toast)
  const { stickers, cuts } = job

  // keep a sticker selected
  useEffect(() => {
    if (!stickers.length) setSelected(null)
    else if (!selected || !stickers.some((s) => s.id === selected)) setSelected(stickers[0].id)
  }, [stickers, selected])

  // ---------- layout
  const nestDesigns = useMemo<NestDesign[]>(
    () =>
      stickers.flatMap((s) => {
        const r = cuts[s.id]?.result
        return r?.cut.length ? [{ id: s.id, name: s.name, cut: r.cut, bounds: r.bounds, copies: s.copies, rotation: s.rotation }] : []
      }),
    [stickers, cuts],
  )
  const layout = useMemo(() => nest(nestDesigns, settings), [nestDesigns, settings])
  const [overrides, setOverrides] = useState<Overrides>({})
  // hand-made moves belong to one layout: start fresh when what's being laid out changes
  const layoutKey = JSON.stringify([nestDesigns.map((d) => [d.id, d.bounds, d.copies, d.rotation]), settings])
  const lastKey = useRef(layoutKey)
  useEffect(() => {
    if (lastKey.current !== layoutKey) {
      lastKey.current = layoutKey
      setOverrides({})
    }
  }, [layoutKey])
  const sheets = useMemo<StickerSheetLayout[]>(
    () => layout.sheets.map((sh) => ({ ...sh, placements: sh.placements.map((p) => (overrides[p.id] ? { ...p, ...overrides[p.id] } : p)) })),
    [layout, overrides],
  )

  // ---------- drop files anywhere (capture phase, so a hidden poster screen never sees them)
  const [dragging, setDragging] = useState(false)
  const addFiles = job.addFiles
  useEffect(() => {
    if (!active) return
    let depth = 0
    const files = (e: DragEvent) => !!e.dataTransfer?.types.includes('Files')
    const enter = (e: DragEvent) => {
      if (!files(e)) return
      e.stopPropagation()
      depth++
      setDragging(true)
    }
    const leave = (e: DragEvent) => {
      if (!files(e)) return
      e.stopPropagation()
      depth = Math.max(0, depth - 1)
      if (!depth) setDragging(false)
    }
    const over = (e: DragEvent) => {
      if (!files(e)) return
      e.stopPropagation()
      e.preventDefault()
    }
    const drop = (e: DragEvent) => {
      if (!files(e)) return
      e.stopPropagation()
      e.preventDefault()
      depth = 0
      setDragging(false)
      if (e.dataTransfer?.files.length) {
        void addFiles([...e.dataTransfer.files])
        setStep((s) => (s === 'export' ? 'sheet' : s))
      }
    }
    window.addEventListener('dragenter', enter, true)
    window.addEventListener('dragleave', leave, true)
    window.addEventListener('dragover', over, true)
    window.addEventListener('drop', drop, true)
    return () => {
      window.removeEventListener('dragenter', enter, true)
      window.removeEventListener('dragleave', leave, true)
      window.removeEventListener('dragover', over, true)
      window.removeEventListener('drop', drop, true)
    }
  }, [active, addFiles])

  // ---------- footer
  const has = stickers.length > 0
  const ready = has && job.pending === 0
  const total = sheets.reduce((n, s) => n + s.placements.length, 0)
  const plural = (n: number, w: string) => `${n} ${w}${n === 1 ? '' : 's'}`
  const toCheck = stickers.filter((s) => cuts[s.id]?.result?.warnings.length || cuts[s.id]?.error).length
  const bar: Record<StickerStep, Parameters<typeof ActionBar>[0]> = {
    add: {
      summary: has ? `${plural(stickers.length, 'sticker')} added` : 'Add PNG, JPG or WebP images to start',
      next: { label: 'Continue', onClick: () => setStep('cut'), disabled: !has },
    },
    cut: {
      onBack: () => setStep('add'),
      summary:
        job.pending > 0 ? (
          'Making cut lines…'
        ) : (
          <>
            {plural(stickers.length, 'sticker')} · cut lines ready
            {toCheck > 0 && <span className="text-amber-700"> · {plural(toCheck, 'thing')} to check</span>}
          </>
        ),
      next: { label: job.pending > 0 ? 'Working…' : 'Arrange on sheet', onClick: () => setStep('sheet'), disabled: !ready },
    },
    sheet: {
      onBack: () => setStep('cut'),
      summary: (
        <>
          <b className="text-slate-800">{plural(total, 'sticker')}</b> on <b className="text-slate-800">{plural(sheets.length, 'sheet')}</b> ({settings.sheet.name})
        </>
      ),
      next: { label: 'Looks good', onClick: () => setStep('export'), disabled: !sheets.length },
    },
    export: { onBack: () => setStep('sheet'), backLabel: 'Back to sheet', summary: 'Print at 100 % – then cut on the CutContour line' },
  }

  const current = STEPS.findIndex((s) => s.id === step)
  const canGo = (id: StickerStep) => id === 'add' || (id === 'cut' ? has : ready && (id === 'sheet' || sheets.length > 0))

  return (
    <div className="flex h-full flex-col">
      <header className="sticky top-0 z-30 border-b border-slate-200/70 bg-white/80 backdrop-blur-xl">
        <div className="mx-auto flex h-16 max-w-[1600px] items-center gap-6 px-5">
          <div className="flex items-center gap-3">
            <Logo />
            <span className="hidden rounded-full bg-pink-50 px-2.5 py-0.5 text-xs font-semibold text-pink-700 ring-1 ring-pink-600/15 ring-inset sm:inline">Stickers</span>
          </div>
          <nav className="flex flex-1 items-center justify-center" aria-label="Steps">
            {STEPS.map((s, i) => {
              const on = i === current
              const done = i < current
              return (
                <div key={s.id} className="flex items-center">
                  {i > 0 && <div className={`mx-1 h-px w-6 transition-colors sm:w-10 ${i <= current ? 'bg-brand-400' : 'bg-slate-200'}`} />}
                  <button
                    disabled={!canGo(s.id)}
                    onClick={() => setStep(s.id)}
                    aria-current={on ? 'step' : undefined}
                    className={`flex items-center gap-2 rounded-full py-1.5 pr-3 pl-1.5 text-sm font-semibold transition disabled:opacity-40 ${
                      on ? 'bg-brand-50 text-brand-700' : done ? 'text-slate-700 hover:bg-slate-100' : 'text-slate-400 hover:bg-slate-100 hover:text-slate-600'
                    }`}
                  >
                    <span
                      className={`grid h-6 w-6 place-items-center rounded-full text-xs transition ${
                        on ? 'bg-brand-600 text-white shadow-[0_2px_8px_rgb(91_47_245/0.4)]' : done ? 'bg-brand-100 text-brand-700' : 'bg-slate-100 text-slate-500'
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
          <button onClick={() => setShowSettings(true)} className="btn-secondary rounded-full py-2 pr-3 pl-3.5" title="Sheet & cutter settings">
            <span className="hidden text-slate-500 lg:inline">
              {settings.sheet.name} · gap {fmtLen(settings.gapMm, 'mm')} · bleed {fmtLen(settings.bleedMm, 'mm')}
            </span>
            <SlidersHorizontal size={16} />
          </button>
        </div>
      </header>

      <main className={`min-h-0 flex-1 ${step === 'sheet' || step === 'cut' ? '' : 'overflow-y-auto'}`}>
        {step === 'add' && <AddStep job={job} settings={settings} onOpen={(id) => (setSelected(id), setStep('cut'))} />}
        {step === 'cut' && <CutStep job={job} settings={settings} setSettings={setSettings} selected={selected} setSelected={setSelected} />}
        <Suspense fallback={<div className="grid h-full place-items-center text-slate-400">Loading…</div>}>
          {step === 'sheet' && (
            <SheetStep
              job={job}
              settings={settings}
              setSettings={setSettings}
              sheets={sheets}
              layout={layout}
              nestDesigns={nestDesigns}
              overrides={overrides}
              setOverride={(id, o) => setOverrides((m) => ({ ...m, [id]: o }))}
              resetOverrides={() => setOverrides({})}
            />
          )}
          {step === 'export' && <ExportStep job={job} settings={settings} sheets={sheets} />}
        </Suspense>
      </main>

      <ActionBar {...bar[step]} />

      {dragging && (
        <div className="pointer-events-none fixed inset-0 z-40 grid place-items-center bg-brand-600/10 p-6 backdrop-blur-sm">
          <div className="grid h-full w-full place-items-center rounded-[2rem] border-2 border-dashed border-brand-400 bg-white/60">
            <div className="text-center">
              <UploadCloud size={48} className="mx-auto text-brand-600" />
              <div className="mt-3 text-2xl font-bold text-brand-800">Drop to add stickers</div>
            </div>
          </div>
        </div>
      )}
      {showSettings && <StickerSettingsDialog settings={settings} onSave={setSettings} onClose={() => setShowSettings(false)} />}
    </div>
  )
}
