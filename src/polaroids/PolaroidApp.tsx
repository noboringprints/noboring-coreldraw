import { type ReactNode, useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  AlertTriangle,
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  ChevronUp,
  Copy,
  Crop,
  Download,
  FileX2,
  ImagePlus,
  Images,
  LayoutGrid,
  Loader2,
  MousePointerClick,
  Palette,
  Pencil,
  Scissors,
  SlidersHorizontal,
  Sparkles,
  Trash2,
  Type,
  Undo2,
  UploadCloud,
  X,
} from 'lucide-react'
import { Logo } from '../components/Header'
import { Drawer, Notice, NumberField, Segmented, Stepper, ToastHost, useToast } from '../components/ui'
import DarkToggle from '../stickers/components/DarkToggle'
import { SheetCanvas } from '../stickers/components/SheetStep'
import type { ExportMode } from '../stickers/lib/exportStickers'
import { type StickerSheetLayout, layoutProblems, nest, roomOnLastSheet } from '../stickers/lib/nest'
import type { StickerVisual } from '../stickers/render'
import { buildPolaroidPdf, polaroidNestDesigns, polaroidShape } from './exportPolaroids'
import { loadCaptionFonts } from './fonts'
import {
  CROP_MARK,
  DEFAULT_POLAROID_SETTINGS,
  FORMATS,
  type Finish,
  type NewItemDefaults,
  POLAROID_SHEETS,
  type PolaroidItem,
  type PolaroidSettings,
  formatOf,
  loadNewDefaults,
  loadPolaroidSettings,
  photoDpi,
  saveNewDefaults,
  savePolaroidSettings,
  settingsProblems,
  sheetSettings,
} from './model'
import PolaroidEditor, { PolaroidThumb } from './PolaroidEditor'
import { type Photo, type PolaroidJob, renderForPrint, renderToCanvas, usePolaroidJob } from './usePolaroidJob'

const ACCEPT = 'image/jpeg,image/png,image/webp,.jpg,.jpeg,.png,.webp'
/** Sheet preview resolution of each polaroid. */
const PREVIEW_PX_PER_MM = 6
type View = 'both' | 'print' | 'cut'
type Overrides = Record<string, { x: number; y: number } | undefined>

const SEEN_KEY = 'print-ready.polaroids.seen-editor'

const plural = (n: number, w: string) => `${n} ${w}${n === 1 ? '' : 's'}`

function save(data: BlobPart, name: string, type: string) {
  const url = URL.createObjectURL(new Blob([data], { type }))
  const a = document.createElement('a')
  a.href = url
  a.download = name
  a.click()
  setTimeout(() => URL.revokeObjectURL(url), 60_000)
}

export default function PolaroidApp({ active }: { active: boolean }) {
  return (
    <ToastHost>
      <Polaroids active={active} />
    </ToastHost>
  )
}

function Polaroids({ active }: { active: boolean }) {
  const toast = useToast()
  const [settings, setSettingsState] = useState<PolaroidSettings>(loadPolaroidSettings)
  const setSettings = useCallback((s: PolaroidSettings) => {
    setSettingsState(s)
    savePolaroidSettings(s)
  }, [])
  const [defaults, setDefaultsState] = useState<NewItemDefaults>(loadNewDefaults)
  const remember = useCallback((patch: Partial<NewItemDefaults>) => {
    setDefaultsState((d) => {
      const n = { ...d, ...patch }
      saveNewDefaults(n)
      return n
    })
  }, [])
  const job = usePolaroidJob(defaults)
  const { items, photos } = job
  const [selected, setSelected] = useState<string | null>(null)
  const [showSettings, setShowSettings] = useState(false)
  const [fontsReady, setFontsReady] = useState(false)
  useEffect(() => {
    void loadCaptionFonts().then(() => setFontsReady(true))
  }, [])

  // ---------- layout (only what changes the layout re-runs the nesting)
  const sheetS = useMemo(() => sheetSettings(settings), [settings])
  const layoutKey = JSON.stringify([items.map((it) => [it.id, it.formatId, it.custom, it.copies, it.rotation]), settings])
  const itemsRef = useRef(items)
  itemsRef.current = items
  const nestDesigns = useMemo(() => polaroidNestDesigns(itemsRef.current, settings), [layoutKey]) // eslint-disable-line react-hooks/exhaustive-deps
  const layout = useMemo(() => nest(nestDesigns, sheetS), [nestDesigns, sheetS])
  const [overrides, setOverrides] = useState<Overrides>({})
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
  const total = sheets.reduce((n, s) => n + s.placements.length, 0)

  // forget a selection whose polaroid is gone
  useEffect(() => {
    if (selected && !items.some((it) => it.id === selected)) setSelected(null)
  }, [items, selected])

  // ---------- drop photos anywhere (capture phase, so the hidden tools never see them)
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
      if (e.dataTransfer?.files.length) void addFiles([...e.dataTransfer.files])
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

  const input = useRef<HTMLInputElement>(null)
  const pick = () => input.current?.click()

  const fill = (it: PolaroidItem) => {
    const n = roomOnLastSheet(nestDesigns, it.id, sheetS)
    if (n > 0) {
      job.update(it.id, { copies: it.copies + n })
      toast(`Added ${n} – the last sheet is now full`)
    } else toast('The last sheet is already full')
  }

  const sel = items.find((it) => it.id === selected)
  // first-time guidance until a photo has been opened once
  const [seenEditor, setSeenEditor] = useState(() => {
    try {
      return localStorage.getItem(SEEN_KEY) === '1'
    } catch {
      return false
    }
  })
  const open = (id: string | null) => {
    setSelected(id)
    if (id && !seenEditor) {
      setSeenEditor(true)
      try {
        localStorage.setItem(SEEN_KEY, '1')
      } catch {
        /* fine */
      }
    }
  }
  // phones show one panel at a time
  const [tab, setTab] = useState<'photos' | 'sheet'>('photos')

  return (
    <div className="flex h-full flex-col">
      <input
        ref={input}
        type="file"
        multiple
        accept={ACCEPT}
        className="hidden"
        onChange={(e) => {
          void addFiles([...(e.target.files ?? [])])
          e.target.value = ''
        }}
      />
      <header className="sticky top-0 z-30 border-b border-slate-200/70 bg-white/80 backdrop-blur-xl">
        <div className="mx-auto flex h-14 max-w-[1800px] items-center gap-2 px-3 sm:h-16 sm:gap-4 sm:px-5">
          <div className="flex items-center gap-3">
            <Logo />
            <span className="hidden rounded-full bg-sky-50 px-2.5 py-0.5 text-xs font-semibold text-sky-700 ring-1 ring-sky-600/20 ring-inset sm:inline">Polaroids</span>
          </div>
          <div className="hidden min-w-0 flex-1 truncate text-center text-sm text-slate-500 md:block">
            {items.length > 0 && (
              <>
                <b className="text-slate-800">{plural(total, 'polaroid')}</b> on <b className="text-slate-800">{plural(sheets.length, 'sheet')}</b> · {settings.sheet.name}
              </>
            )}
          </div>
          <span className="flex-1 md:hidden" />
          {items.length > 0 && (
            <button
              className="btn-ghost px-2.5 sm:px-3"
              title="Start a new job (removes all photos)"
              aria-label="New job"
              onClick={() => {
                if (confirm('Start a new job? All photos will be removed.')) {
                  job.clear()
                  setSelected(null)
                }
              }}
            >
              <FileX2 size={16} /> <span className="hidden lg:inline">New job</span>
            </button>
          )}
          <button onClick={() => setShowSettings(true)} className="btn-secondary rounded-full py-2 pr-3 pl-3.5" title="Sheet settings" aria-label="Sheet settings">
            <span className="hidden text-slate-500 lg:inline">
              {settings.sheet.name} · {FINISHES.find((x) => x.value === settings.finish)?.short}
            </span>
            <span className="text-xs font-semibold text-slate-600 lg:hidden">Sheet</span>
            <SlidersHorizontal size={16} />
          </button>
        </div>
        {items.length > 0 && (
          <div className="border-t border-slate-100 px-3 py-2 lg:hidden">
            <Segmented
              full
              aria-label="Show"
              value={tab}
              onChange={setTab}
              options={[
                {
                  value: 'photos',
                  label: (
                    <>
                      <Images size={15} /> Photos <span className="text-slate-400">{items.length}</span>
                    </>
                  ),
                },
                {
                  value: 'sheet',
                  label: (
                    <>
                      <LayoutGrid size={15} /> Sheet preview <span className="text-slate-400">{sheets.length}</span>
                    </>
                  ),
                },
              ]}
            />
          </div>
        )}
      </header>

      <main className="min-h-0 flex-1">
        {items.length === 0 && job.loading === 0 ? (
          <Empty restored={job.restored} onPick={pick} errors={job.errors} />
        ) : (
          <div className="flex h-full min-h-0 flex-col lg:flex-row">
            <aside className={`${tab === 'photos' ? 'flex' : 'hidden'} min-h-0 w-full flex-1 flex-col overflow-y-auto border-r border-slate-200/70 bg-white px-3 py-3 lg:flex lg:w-[300px] lg:flex-none lg:shrink-0`}>
              {!seenEditor && <EditHint />}
              <button className="btn-secondary mb-3 w-full shrink-0 border-dashed" onClick={pick}>
                <ImagePlus size={16} /> Add photos
              </button>
              {job.loading > 0 && (
                <div className="mb-3 flex items-center gap-2 px-1 text-sm text-slate-500">
                  <Loader2 size={15} className="animate-spin" /> Reading {plural(job.loading, 'photo')}…
                </div>
              )}
              {job.errors.map((e) => (
                <div key={e} className="mb-3">
                  <Notice>{e}</Notice>
                </div>
              ))}
              <div className="flex flex-col gap-1.5">
                {items.map((it, i) => (
                  <ItemRow
                    key={it.id}
                    it={it}
                    photo={photos[it.photoId]}
                    job={job}
                    settings={settings}
                    fontsReady={fontsReady}
                    first={i === 0}
                    last={i === items.length - 1}
                    on={selected === it.id}
                    pulse={!seenEditor && i === 0}
                    onOpen={() => open(selected === it.id ? null : it.id)}
                  />
                ))}
              </div>
            </aside>
            <div className={`${tab === 'sheet' ? 'flex' : 'hidden'} min-h-0 flex-1 lg:flex`}>
              <SheetPanel
                job={job}
                settings={settings}
                sheets={sheets}
                fontsReady={fontsReady}
                showHint={!seenEditor}
                moved={Object.values(overrides).some(Boolean)}
                setOverride={(id, o) => setOverrides((m) => ({ ...m, [id]: o }))}
                resetOverrides={() => setOverrides({})}
                onSelect={(id) => id && open(id)}
              />
            </div>
            {/* the editor: a column on big screens, full screen on phones */}
            <aside
              className={`${sel ? 'fixed inset-0 z-40 flex animate-fade-up' : 'hidden'} flex-col bg-white lg:static lg:z-auto lg:flex lg:w-[400px] lg:shrink-0 lg:animate-none lg:border-l lg:border-slate-200/70`}
            >
              {sel ? (
                <PolaroidEditor
                  key={sel.id}
                  it={sel}
                  photo={photos[sel.photoId]}
                  job={job}
                  settings={settings}
                  fontsReady={fontsReady}
                  perSheet={layout.capacity[sel.id]?.perSheet}
                  onClose={() => setSelected(null)}
                  onFill={() => fill(sel)}
                  onRemember={remember}
                  onSelect={open}
                  toast={toast}
                />
              ) : (
                <div className="grid h-full place-items-center p-8 text-center">
                  <div>
                    <span className="mx-auto grid h-14 w-14 animate-pulse place-items-center rounded-2xl bg-brand-50 text-brand-600">
                      <MousePointerClick size={26} />
                    </span>
                    <div className="mt-4 text-lg font-semibold text-slate-800">Click a photo to edit it</div>
                    <p className="mt-1 text-sm text-slate-500">Pick one from the list on the left, or click a polaroid on the sheet.</p>
                    <ul className="mx-auto mt-5 max-w-[16rem] space-y-2 text-left text-sm text-slate-600">
                      {(
                        [
                          [Crop, 'Crop & position the photo'],
                          [Sparkles, 'Enhance it – clearer & brighter'],
                          [Type, 'Write a caption'],
                          [Palette, 'Pick a size and a frame theme'],
                        ] as const
                      ).map(([Icon, text]) => (
                        <li key={text} className="flex items-center gap-2.5">
                          <span className="grid h-7 w-7 shrink-0 place-items-center rounded-lg bg-slate-100 text-slate-500">
                            <Icon size={14} />
                          </span>
                          {text}
                        </li>
                      ))}
                    </ul>
                  </div>
                </div>
              )}
            </aside>
          </div>
        )}
      </main>

      {items.length > 0 && <DownloadBar job={job} settings={settings} sheets={sheets} />}

      {dragging && (
        <div className="pointer-events-none fixed inset-0 z-40 grid place-items-center bg-brand-600/10 p-6 backdrop-blur-sm">
          <div className="grid h-full w-full place-items-center rounded-[2rem] border-2 border-dashed border-brand-400 bg-white/60">
            <div className="text-center">
              <UploadCloud size={48} className="mx-auto text-brand-600" />
              <div className="mt-3 text-2xl font-bold text-brand-800">Drop photos to make polaroids</div>
            </div>
          </div>
        </div>
      )}
      {showSettings && <SettingsDrawer settings={settings} onSave={setSettings} onClose={() => setShowSettings(false)} />}
    </div>
  )
}

/* ------------------------------------------------------------------ empty state */

/** A little fan of polaroids for the empty state and the launcher. */
export function PolaroidArt() {
  const card = (x: number, y: number, r: number, color: string, sky: string) => (
    <g transform={`rotate(${r} ${x + 22} ${y + 27})`}>
      <rect x={x} y={y} width="44" height="54" rx="1.5" fill={color} stroke="#e2e8f0" strokeWidth=".6" />
      <rect x={x + 3} y={y + 3} width="38" height="38" fill={sky} />
      <circle cx={x + 30} cy={y + 13} r="4" fill="#fff" opacity=".85" />
      <path d={`M${x + 3} ${y + 41}l12-14 9 9 6-5 11 10z`} fill="#000" opacity=".18" />
      <path d={`M${x + 12} ${y + 48}q4 -2 8 0t8 0`} stroke="#64748b" strokeWidth="1" fill="none" strokeLinecap="round" />
    </g>
  )
  return (
    <svg viewBox="0 0 160 120" className="h-full w-full" aria-hidden>
      {card(30, 34, -12, '#fff', '#7dd3fc')}
      {card(86, 32, 10, '#fde7ef', '#f9a8d4')}
      {card(58, 18, -1, '#fff', '#fcd34d')}
    </svg>
  )
}

function Empty(props: { restored: boolean; onPick: () => void; errors: string[] }) {
  if (!props.restored) return <div className="grid h-full place-items-center text-slate-400">Loading…</div>
  return (
    <div className="mx-auto h-full w-full max-w-3xl animate-fade-up overflow-y-auto px-4 py-8 sm:px-5 sm:py-12">
      <button
        onClick={props.onPick}
        className="card group flex w-full flex-col items-center border-2 border-dashed border-slate-200 px-5 py-8 text-center sm:px-6 sm:py-12 transition hover:border-brand-300 hover:bg-brand-50/30"
      >
        <span className="h-32 w-44">
          <PolaroidArt />
        </span>
        <span className="mt-4 text-2xl font-bold tracking-tight">Drop photos here</span>
        <span className="mt-2 max-w-md text-slate-500">
          Each photo becomes a polaroid. Crop and position it, add a caption and a theme, and they&rsquo;re laid out on {DEFAULT_POLAROID_SETTINGS.sheet.name} sheets ready to print and cut.
        </span>
        <span className="btn-primary mt-6">
          <ImagePlus size={16} /> Choose photos
        </span>
        <span className="mt-3 text-xs text-slate-400">JPG, PNG or WebP · many at once</span>
      </button>
      <ol className="mt-6 grid gap-3 sm:grid-cols-3">
        {(
          [
            [ImagePlus, 'Add photos', 'Each one becomes a polaroid.'],
            [Pencil, 'Tap a photo to edit', 'Crop, enhance, caption, size and theme.'],
            [Download, 'Download the PDF', 'Laid out on the sheet, ready to print and cut.'],
          ] as const
        ).map(([Icon, title, text], i) => (
          <li key={title} className="flex items-start gap-3 rounded-2xl bg-white p-4 ring-1 ring-slate-200/70">
            <span className="grid h-9 w-9 shrink-0 place-items-center rounded-xl bg-brand-50 text-brand-600">
              <Icon size={17} />
            </span>
            <span>
              <span className="block text-sm font-semibold text-slate-800">
                {i + 1}. {title}
              </span>
              <span className="block text-xs text-slate-500">{text}</span>
            </span>
          </li>
        ))}
      </ol>
      {props.errors.map((e) => (
        <div key={e} className="mt-3">
          <Notice>{e}</Notice>
        </div>
      ))}
      <div className="mt-8">
        <div className="text-center text-xs font-bold tracking-wide text-slate-400 uppercase">Standard sizes</div>
        <div className="mt-3 flex flex-wrap justify-center gap-2">
          {FORMATS.map((f) => (
            <span key={f.id} title={f.hint} className="rounded-full bg-white px-3 py-1 text-xs font-medium text-slate-600 ring-1 ring-slate-200">
              {f.name} <span className="text-slate-400">{f.hint.split(' · ')[0]}</span>
            </span>
          ))}
        </div>
      </div>
    </div>
  )
}

/* ------------------------------------------------------------------ list */

/** First-time guidance at the top of the photo list. */
function EditHint() {
  const [hidden, setHidden] = useState(false)
  if (hidden) return null
  return (
    <div className="relative mb-3 shrink-0 overflow-hidden rounded-2xl bg-gradient-to-br from-brand-600 to-brand-700 p-4 text-white shadow-[0_8px_24px_rgb(91_47_245/0.3)]">
      <button className="absolute top-2 right-2 rounded-full p-1 text-white/70 hover:bg-white/15 hover:text-white" onClick={() => setHidden(true)} aria-label="Hide tip">
        <X size={14} />
      </button>
      <div className="flex items-center gap-2 font-semibold">
        <MousePointerClick size={18} className="animate-bounce" /> <span className="lg:hidden">Tap a photo to edit it</span>
        <span className="hidden lg:inline">Click a photo to edit it</span>
      </div>
      <ol className="mt-2 space-y-1 text-sm text-white/85">
        <li>
          <b className="text-white">1.</b> Crop, enhance, add a caption & theme
        </li>
        <li>
          <b className="text-white">2.</b> Set how many copies
        </li>
        <li>
          <b className="text-white">3.</b> Download the PDF at the bottom
        </li>
      </ol>
    </div>
  )
}

function ItemRow(props: {
  it: PolaroidItem
  photo?: Photo
  job: PolaroidJob
  settings: PolaroidSettings
  fontsReady: boolean
  first: boolean
  last: boolean
  on: boolean
  /** Draw attention to this row (first-time guidance). */
  pulse?: boolean
  onOpen: () => void
}) {
  const { it, photo, job } = props
  const f = formatOf(it)
  const dpi = photo ? photoDpi(it, photo.pxW, photo.pxH) : null
  const ref = useRef<HTMLDivElement>(null)
  useEffect(() => {
    if (props.on) ref.current?.scrollIntoView({ block: 'nearest', behavior: 'smooth' })
  }, [props.on])
  const tags = [f.name, it.enhance && it.enhance !== 'off' ? 'enhanced' : null, it.caption.text ? `“${it.caption.text.split('\n')[0]}”` : null].filter(Boolean)
  return (
    <div
      ref={ref}
      role="button"
      tabIndex={0}
      aria-label={`Edit ${it.name}`}
      onClick={props.onOpen}
      onKeyDown={(e) => {
        if (e.target === e.currentTarget && (e.key === 'Enter' || e.key === ' ')) {
          e.preventDefault()
          props.onOpen()
        }
      }}
      className={`group relative flex cursor-pointer items-center gap-3 rounded-2xl p-2 transition outline-none focus-visible:ring-4 focus-visible:ring-brand-200 ${
        props.on ? 'bg-brand-50 ring-2 ring-brand-500' : props.pulse ? 'bg-brand-50/60 ring-2 ring-brand-400 ring-offset-2' : 'hover:bg-slate-50'
      }`}
    >
      <div className="relative grid w-14 shrink-0 place-items-center">
        <PolaroidThumb it={it} photo={photo} width={Math.min(52, (64 * f.widthMm) / f.heightMm)} fontsReady={props.fontsReady} />
        {/* on hover the picture itself says it can be edited */}
        <span className="pointer-events-none absolute inset-0 hidden place-items-center rounded-sm bg-brand-700/45 text-white opacity-0 transition group-hover:opacity-100 lg:grid">
          <Pencil size={16} />
        </span>
      </div>
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2">
          <div className="min-w-0 flex-1 truncate text-sm font-semibold text-slate-800">{it.name}</div>
          <span
            className={`inline-flex shrink-0 items-center gap-1 rounded-full px-2 py-0.5 text-[11px] font-semibold transition ${
              props.on ? 'bg-brand-600 text-white' : 'bg-brand-50 text-brand-700 ring-1 ring-brand-200 group-hover:bg-brand-600 group-hover:text-white'
            }`}
          >
            <Pencil size={11} /> {props.on ? 'Editing' : 'Edit'}
            {props.pulse && !props.on && (
              <span className="relative -mr-0.5 ml-0.5 flex h-2 w-2">
                <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-brand-500 opacity-75" />
                <span className="relative inline-flex h-2 w-2 rounded-full bg-brand-600" />
              </span>
            )}
          </span>
        </div>
        <div className="truncate text-xs text-slate-500">{tags.join(' · ')}</div>
        <div className="mt-1.5 flex items-center gap-1.5" onClick={(e) => e.stopPropagation()}>
          <Stepper size="sm" value={it.copies} min={0} onChange={(copies) => job.update(it.id, { copies })} label="Copies" />
          <span className="text-[11px] text-slate-400">{it.copies === 1 ? 'copy' : 'copies'}</span>
          {dpi !== null && dpi < props.settings.minDpi && (
            <span title={`Prints at about ${dpi} DPI – may look soft`} className="text-amber-500">
              <AlertTriangle size={15} />
            </span>
          )}
          <span className="flex-1" />
          {/* always visible on touch screens; on hover with a mouse */}
          <span className="flex transition lg:opacity-0 lg:group-hover:opacity-100 lg:focus-within:opacity-100">
            <button className="btn-icon hidden h-8 w-8 text-slate-400 hover:bg-white hover:text-slate-700 sm:grid" disabled={props.first} onClick={() => job.move(it.id, -1)} aria-label="Move up">
              <ChevronUp size={14} />
            </button>
            <button className="btn-icon hidden h-8 w-8 text-slate-400 hover:bg-white hover:text-slate-700 sm:grid" disabled={props.last} onClick={() => job.move(it.id, 1)} aria-label="Move down">
              <ChevronDown size={14} />
            </button>
            <button className="btn-icon h-8 w-8 text-slate-400 hover:bg-white hover:text-slate-700" onClick={() => job.duplicate(it.id)} aria-label="Another polaroid of this photo" title="Another polaroid of this photo">
              <Copy size={14} />
            </button>
            <button className="btn-icon h-8 w-8 text-slate-400 hover:bg-white hover:text-red-600" onClick={() => job.remove(it.id)} aria-label="Remove" title="Remove">
              <Trash2 size={14} />
            </button>
          </span>
        </div>
      </div>
    </div>
  )
}

/* ------------------------------------------------------------------ sheet */

function SheetPanel(props: {
  job: PolaroidJob
  settings: PolaroidSettings
  sheets: StickerSheetLayout[]
  fontsReady: boolean
  /** Show the "click a polaroid to edit" tip on the sheet. */
  showHint?: boolean
  moved: boolean
  setOverride: (id: string, o: { x: number; y: number } | undefined) => void
  resetOverrides: () => void
  onSelect: (designId: string | null) => void
}) {
  const { job, settings, sheets } = props
  const sheetS = useMemo(() => sheetSettings(settings), [settings])
  const [sheetIdx, setSheetIdx] = useState(0)
  const views: { value: View; label: ReactNode }[] =
    settings.finish === 'printcut'
      ? [
          { value: 'both', label: 'Print + cut' },
          { value: 'print', label: 'Print' },
          { value: 'cut', label: <><Scissors size={12} /> Cut lines</> },
        ]
      : [
          { value: 'print', label: 'Print' },
          { value: 'both', label: 'Show trim lines' },
        ]
  const [viewState, setView] = useState<View>('print')
  const view = views.some((v) => v.value === viewState) ? viewState : views[0].value
  const idx = Math.min(sheetIdx, Math.max(0, sheets.length - 1))
  const sheet = sheets[idx]
  const b = Math.max(0, settings.bleedMm)

  // one preview picture per polaroid, redrawn only when that polaroid changes
  const cache = useRef(new Map<string, { key: string; canvas: HTMLCanvasElement }>())
  const visuals = useMemo(() => {
    const out: Record<string, StickerVisual> = {}
    const live = new Set<string>()
    for (const it of job.items) {
      live.add(it.id)
      const photo = job.photos[it.photoId]
      const { copies: _c, rotation: _r, name: _n, ...look } = it
      const key = JSON.stringify([look, !!photo?.preview, b, props.fontsReady])
      let hit = cache.current.get(it.id)
      if (!hit || hit.key !== key) {
        hit = { key, canvas: renderToCanvas(it, photo, PREVIEW_PX_PER_MM, b, hit?.canvas) }
        cache.current.set(it.id, hit)
      }
      const f = formatOf(it)
      const { cut, bleed } = polaroidShape(it, settings)
      out[it.id] = { cut, bleed, border: 'none', borderColor: '#000', art: hit.canvas, artRect: { x: -b, y: -b, w: f.widthMm + 2 * b, h: f.heightMm + 2 * b } }
    }
    for (const id of [...cache.current.keys()]) if (!live.has(id)) cache.current.delete(id)
    return out
  }, [job.items, job.photos, b, settings, props.fontsReady])
  const shapes = useMemo(() => Object.fromEntries(job.items.map((it) => [it.id, polaroidShape(it, settings)])), [job.items, settings])
  const problems = useMemo(() => (sheet ? layoutProblems(sheet, shapes, sheetS) : { overlapping: new Set<string>(), outside: new Set<string>() }), [sheet, shapes, sheetS])

  return (
    <section className="relative flex min-h-[60vh] flex-1 flex-col bg-canvas lg:min-h-[420px]">
      <div className="z-10 flex flex-wrap items-center gap-2 border-b border-white/5 px-3 py-2 text-white/80">
        <div className="flex items-center gap-1">
          <button className="btn-icon text-white/70 hover:bg-white/10" disabled={idx === 0} onClick={() => setSheetIdx(idx - 1)} aria-label="Previous sheet">
            <ChevronLeft size={18} />
          </button>
          <span className="min-w-[6.5rem] text-center text-sm font-semibold tabular-nums">{sheets.length ? `Sheet ${idx + 1} of ${sheets.length}` : 'No sheets'}</span>
          <button className="btn-icon text-white/70 hover:bg-white/10" disabled={idx >= sheets.length - 1} onClick={() => setSheetIdx(idx + 1)} aria-label="Next sheet">
            <ChevronRight size={18} />
          </button>
        </div>
        {views.length > 1 && <DarkToggle aria-label="Show" value={view} onChange={setView} options={views} />}
        <span className="flex-1" />
        {props.moved && (
          <button className="btn rounded-lg px-2.5 py-1.5 text-xs text-white/80 hover:bg-white/10" onClick={props.resetOverrides}>
            <Undo2 size={14} /> <span className="hidden sm:inline">Re-arrange automatically</span><span className="sm:hidden">Re-arrange</span>
          </button>
        )}
        <span className="hidden text-xs text-white/50 2xl:inline">Drag to move · wheel to zoom</span>
      </div>
      <div className="relative flex min-h-0 flex-1 flex-col">
      {sheet ? (
        <SheetCanvas
          sheet={sheet}
          settings={sheetS}
          visuals={visuals}
          shapes={shapes}
          view={view}
          problems={problems}
          onMove={(id, x, y) => props.setOverride(id, { x, y })}
          onSelect={props.onSelect}
          noun="polaroid"
        />
      ) : (
        <div className="grid flex-1 place-items-center text-white/50">Nothing to place yet – set copies above 0.</div>
      )}
      {sheet && (
        <div
          className={`pointer-events-none absolute top-3 left-1/2 flex -translate-x-1/2 items-center gap-2 rounded-full px-3.5 py-1.5 text-xs font-semibold whitespace-nowrap shadow-lift transition sm:text-sm ${
            props.showHint ? 'animate-bounce bg-white text-brand-700 [animation-duration:2s]' : 'bg-black/40 text-white/80 backdrop-blur'
          }`}
        >
          <MousePointerClick size={15} />
          <span className="lg:hidden">{props.showHint ? 'Tap any polaroid to edit it' : 'Tap a polaroid to edit · drag to move it'}</span>
          <span className="hidden lg:inline">{props.showHint ? 'Click any polaroid to edit it' : 'Click a polaroid to edit · drag to move it'}</span>
        </div>
      )}
      </div>
      {(problems.overlapping.size > 0 || problems.outside.size > 0) && (
        <div className="absolute bottom-3 left-1/2 flex -translate-x-1/2 items-center gap-2 rounded-full bg-amber-500 px-4 py-2 text-sm font-semibold text-amber-950 shadow-lift">
          <AlertTriangle size={16} />
          {problems.overlapping.size > 0 ? 'Some polaroids are too close together.' : 'A polaroid is outside the printable area.'}
        </div>
      )}
    </section>
  )
}

/* ------------------------------------------------------------------ settings */

const FINISHES: { value: Finish; label: string; short: string; hint: string }[] = [
  { value: 'crop', label: 'Crop marks', short: 'crop marks', hint: 'Short lines at every corner – cut on a guillotine or with a trimmer.' },
  { value: 'printcut', label: 'Print & cut', short: 'print & cut', hint: 'CutContour line + registration marks for the plotter (same marks as the Print & Cut tool). Allows rounded corners.' },
  { value: 'none', label: 'No marks', short: 'no marks', hint: 'Just the polaroids with a gap between them.' },
]

function SettingsDrawer(props: { settings: PolaroidSettings; onSave: (s: PolaroidSettings) => void; onClose: () => void }) {
  const s = props.settings
  const set = (patch: Partial<PolaroidSettings>) => props.onSave({ ...s, ...patch })
  const row = (label: string, control: ReactNode, hint?: string) => (
    <div className="flex items-center justify-between gap-4 py-2.5">
      <div>
        <div className="text-sm font-medium text-slate-700">{label}</div>
        {hint && <div className="text-xs text-slate-400">{hint}</div>}
      </div>
      {control}
    </div>
  )
  return (
    <Drawer
      title="Sheet settings"
      subtitle="Saved in this browser"
      onClose={props.onClose}
      footer={
        <div className="flex justify-between">
          <button className="btn-ghost" onClick={() => props.onSave({ ...DEFAULT_POLAROID_SETTINGS })}>
            Reset to defaults
          </button>
          <button className="btn-primary" onClick={props.onClose}>
            Done
          </button>
        </div>
      }
    >
      <div className="label-xs mb-2">Sheet</div>
      <Segmented
        full
        value={s.sheet.name}
        onChange={(name) => set({ sheet: POLAROID_SHEETS.find((x) => x.name === name)! })}
        options={POLAROID_SHEETS.map((x) => ({ value: x.name, label: x.name }))}
      />
      <div className="label-xs mt-6 mb-2">Finishing</div>
      <div className="flex flex-col gap-2">
        {FINISHES.map((f) => (
          <button
            key={f.value}
            onClick={() => set({ finish: f.value })}
            className={`rounded-2xl px-4 py-3 text-left ring-1 transition ${s.finish === f.value ? 'bg-brand-50 ring-2 ring-brand-500' : 'ring-slate-200 hover:ring-slate-300'}`}
          >
            <div className="text-sm font-semibold text-slate-800">{f.label}</div>
            <div className="text-xs text-slate-500">{f.hint}</div>
          </button>
        ))}
      </div>
      <div className="label-xs mt-6 mb-1">Spacing</div>
      <div className="divide-y divide-slate-100">
        {row('Gap between polaroids', <NumberField value={s.gapMm} min={0} max={50} suffix="mm" onChange={(gapMm) => set({ gapMm })} />, s.finish === 'crop' ? `Room for crop marks – ${CROP_MARK.lengthMm} mm long` : undefined)}
        {row('Bleed', <NumberField value={s.bleedMm} min={0} max={5} suffix="mm" onChange={(bleedMm) => set({ bleedMm })} />, 'Frame printed past the cut, so a slightly-off cut never shows white')}
        {s.finish !== 'printcut' && row('Sheet margin', <NumberField value={s.marginMm} min={0} max={50} suffix="mm" onChange={(marginMm) => set({ marginMm })} />, 'Unprinted strip along the sheet edge')}
        {s.finish === 'printcut' && row('Rounded corners', <NumberField value={s.cornerMm} min={0} max={10} suffix="mm" onChange={(cornerMm) => set({ cornerMm })} />, 'Instant film has about 3 mm')}
        {row('Warn below', <NumberField value={s.minDpi} min={50} max={600} suffix="DPI" onChange={(minDpi) => set({ minDpi })} />, 'Photos printing softer than this get a warning')}
      </div>
      {settingsProblems(s).map((p) => (
        <div key={p} className="mt-3">
          <Notice>{p}</Notice>
        </div>
      ))}
      {s.finish === 'printcut' && (
        <p className="mt-4 text-xs text-slate-500">Registration marks, sheet margin and the cut colour name come from the Print & Cut tool&rsquo;s settings, so both tools match your cutter.</p>
      )}
    </Drawer>
  )
}

/* ------------------------------------------------------------------ download */

function DownloadBar(props: { job: PolaroidJob; settings: PolaroidSettings; sheets: StickerSheetLayout[] }) {
  const { job, settings, sheets } = props
  const sheetS = useMemo(() => sheetSettings(settings), [settings])
  const [busy, setBusy] = useState<ExportMode | null>(null)
  const [progress, setProgress] = useState<[number, number] | null>(null)
  const [error, setError] = useState<string | null>(null)
  const date = new Date().toISOString().slice(0, 10)
  const base = `polaroids_${date}_${settings.sheet.name.replace(/[^\w]+/g, '')}_${sheets.length}-sheet${sheets.length === 1 ? '' : 's'}`
  const shapes = useMemo(() => Object.fromEntries(job.items.map((it) => [it.id, polaroidShape(it, settings)])), [job.items, settings])
  const clash = sheets.some((sh) => {
    const p = layoutProblems(sh, shapes, sheetS)
    return p.overlapping.size > 0 || p.outside.size > 0
  })
  const pc = settings.finish === 'printcut'

  const pdf = async (mode: ExportMode) => {
    setBusy(mode)
    setError(null)
    const cache = new Map<string, ImageBitmap>()
    try {
      await loadCaptionFonts()
      const suffix = !pc ? (settings.finish === 'crop' ? 'crop-marks' : 'print') : mode === 'print-cut' ? 'print-and-cut' : mode === 'print' ? 'print-only' : 'cut-lines'
      const name = `${base}_${suffix}.pdf`
      const bytes = await buildPolaroidPdf(sheets, job.items, settings, sheetS, (it, bleed) => renderForPrint(it, job.photos[it.photoId], bleed, cache), {
        mode,
        title: name,
        onProgress: (d, t) => setProgress([d, t]),
      })
      save(bytes as BlobPart, name, 'application/pdf')
    } catch (e) {
      setError((e as Error).message)
    } finally {
      for (const b of cache.values()) b.close()
      setBusy(null)
      setProgress(null)
    }
  }
  const disabled = !!busy || !sheets.length

  return (
    <div className="sticky bottom-0 z-20 border-t border-slate-200/70 bg-white/85 backdrop-blur-xl">
      <div className="mx-auto flex max-w-[1800px] flex-wrap items-center gap-x-2 gap-y-1.5 px-3 py-2.5 pb-[max(0.625rem,env(safe-area-inset-bottom))] sm:px-5 sm:py-3">
        <div className="w-full min-w-0 truncate text-xs text-slate-500 sm:w-auto sm:flex-1 sm:text-sm">
          {error ? (
            <span className="text-red-600">Could not make the PDF: {error}</span>
          ) : progress ? (
            <span className="inline-flex items-center gap-1.5">
              <Loader2 size={14} className="animate-spin" /> Rendering polaroids at 300 DPI… {Math.min(progress[0] + 1, progress[1])} of {progress[1]}
            </span>
          ) : clash ? (
            <span className="text-amber-700">Some polaroids overlap or leave the sheet – fix them before printing.</span>
          ) : pc ? (
            <>Print at 100 % – then cut on the {sheetS.cut.spotName} line</>
          ) : settings.finish === 'crop' ? (
            <>Print at 100 % – crop marks at every corner</>
          ) : (
            <>Print at 100 %</>
          )}
        </div>
        {pc && (
          <>
            <button className="btn-ghost px-3 text-xs" disabled={disabled} onClick={() => void pdf('print')} title="Artwork and registration marks only">
              Print only
            </button>
            <button className="btn-ghost px-3 text-xs" disabled={disabled} onClick={() => void pdf('cut')} title="Cut lines and registration marks only">
              Cut only
            </button>
          </>
        )}
        <button className="btn-primary btn-lg ml-auto flex-1 sm:flex-none" disabled={disabled} onClick={() => void pdf(pc ? 'print-cut' : 'print')}>
          {busy ? <Loader2 size={18} className="animate-spin" /> : <Download size={18} />}
          {busy ? 'Making PDF…' : pc ? 'Download print & cut PDF' : 'Download PDF'}
        </button>
      </div>
    </div>
  )
}
