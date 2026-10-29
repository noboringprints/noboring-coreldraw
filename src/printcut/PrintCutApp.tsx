import { type ReactNode, useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  AlertTriangle,
  BookmarkPlus,
  ChevronLeft,
  ChevronRight,
  Circle,
  Copy,
  Download,
  FilePlus2,
  FileX2,
  Link2,
  Link2Off,
  Loader2,
  PaintBucket,
  Package,
  RectangleHorizontal,
  RotateCw,
  Scissors,
  Shapes,
  SlidersHorizontal,
  Square,
  Trash2,
  Undo2,
  UploadCloud,
} from 'lucide-react'
import { Logo } from '../components/Header'
import { Badge, Notice, NumberField, Segmented, Stepper, ToastHost, useToast } from '../components/ui'
import { browserRasterizer } from '../lib/pdfRender'
import { round3 } from '../lib/geometry'
import { BORDER_SWATCHES, type BorderStyle, type StickerSettings } from '../stickers/config'
import { buildCutSvg } from '../stickers/lib/exportStickers'
import { pathLength } from '../stickers/lib/paths'
import { type NestDesign, type StickerSheetLayout, layoutProblems, nest, roomOnLastSheet } from '../stickers/lib/nest'
import type { ExportMode } from '../stickers/lib/exportStickers'
import { CHECKER, type StickerVisual } from '../stickers/render'
import DarkToggle from '../stickers/components/DarkToggle'
import { SheetCanvas } from '../stickers/components/SheetStep'
import StickerSettingsDialog from '../stickers/components/StickerSettingsDialog'
import { buildPrintCutPdf } from './exportPrintCut'
import {
  type CutShape,
  DEFAULT_BORDER,
  DEFAULT_PRINTCUT_SETTINGS,
  ITEM_BLEED_LABELS,
  type ItemBleed,
  type PrintCutItem,
  type Product,
  bleedOptions,
  fmtSize,
  getContour,
  itemDpi,
  itemShape,
  loadPrintCutSettings,
  loadProducts,
  matchProduct,
  planItem,
  savePrintCutSettings,
  saveProducts,
} from './model'
import { type PrintCutJob, useItemPreviews, usePrintCutJob } from './usePrintCutJob'

const ACCEPT = '.pdf,.png,.jpg,.jpeg,application/pdf,image/png,image/jpeg'
type View = 'both' | 'print' | 'cut'
type Overrides = Record<string, { x: number; y: number } | undefined>

function save(data: BlobPart, name: string, type: string) {
  const url = URL.createObjectURL(new Blob([data], { type }))
  const a = document.createElement('a')
  a.href = url
  a.download = name
  a.click()
  setTimeout(() => URL.revokeObjectURL(url), 60_000)
}

export default function PrintCutApp({ active }: { active: boolean }) {
  return (
    <ToastHost>
      <PrintCut active={active} />
    </ToastHost>
  )
}

function PrintCut({ active }: { active: boolean }) {
  const toast = useToast()
  const [settings, setSettingsState] = useState<StickerSettings>(loadPrintCutSettings)
  const setSettings = useCallback((s: StickerSettings) => {
    setSettingsState(s)
    savePrintCutSettings(s)
  }, [])
  const [products, setProductsState] = useState<Product[]>(loadProducts)
  const setProducts = (p: Product[]) => {
    setProductsState(p)
    saveProducts(p)
  }
  const [showSettings, setShowSettings] = useState(false)
  const [selected, setSelected] = useState<string | null>(null)
  const job = usePrintCutJob(settings, products, toast)
  const { items } = job

  // ---------- layout
  const nestDesigns = useMemo<NestDesign[]>(
    () => items.map((it) => ({ id: it.id, name: it.name, ...itemShape(it, settings.bleedMm), copies: it.copies, rotation: it.rotation })),
    // a newly traced contour changes itemShape
    [items, settings.bleedMm, job.contours.version],
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

  // ---------- drop files anywhere (capture phase, so the hidden tools never see them)
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
  const fileInput = (
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
  )

  // keep the clicked piece's card in view
  const cards = useRef<Record<string, HTMLDivElement | null>>({})
  useEffect(() => {
    if (selected) cards.current[selected]?.scrollIntoView({ block: 'nearest', behavior: 'smooth' })
  }, [selected])

  const fill = (it: PrintCutItem) => {
    const n = roomOnLastSheet(nestDesigns, it.id, settings)
    if (n > 0) {
      job.update(it.id, { copies: it.copies + n })
      toast(`Added ${n} – the last sheet is now full`)
    } else toast('The last sheet is already full')
  }

  const total = sheets.reduce((n, s) => n + s.placements.length, 0)
  const plural = (n: number, w: string) => `${n} ${w}${n === 1 ? '' : 's'}`

  return (
    <div className="flex h-full flex-col">
      {fileInput}
      <header className="sticky top-0 z-30 border-b border-slate-200/70 bg-white/80 backdrop-blur-xl">
        <div className="mx-auto flex h-16 max-w-[1600px] items-center gap-4 px-5">
          <div className="flex items-center gap-3">
            <Logo />
            <span className="hidden rounded-full bg-amber-50 px-2.5 py-0.5 text-xs font-semibold text-amber-700 ring-1 ring-amber-600/20 ring-inset sm:inline">Print & Cut</span>
          </div>
          <div className="min-w-0 flex-1 truncate text-center text-sm text-slate-500">
            {items.length > 0 && (
              <>
                <b className="text-slate-800">{plural(total, 'piece')}</b> on <b className="text-slate-800">{plural(sheets.length, 'sheet')}</b> · {settings.sheet.name}
              </>
            )}
          </div>
          {items.length > 0 && (
            <button
              className="btn-ghost px-3"
              title="Start a new job (removes all pieces)"
              onClick={() => {
                if (confirm('Start a new job? All pieces on the sheet will be removed.')) job.clear()
              }}
            >
              <FileX2 size={16} /> <span className="hidden lg:inline">New job</span>
            </button>
          )}
          <button onClick={() => setShowSettings(true)} className="btn-secondary rounded-full py-2 pr-3 pl-3.5" title="Sheet & cutter settings">
            <span className="hidden text-slate-500 lg:inline">
              {settings.sheet.name} · gap {settings.gapMm} mm · bleed {settings.bleedMm} mm
            </span>
            <SlidersHorizontal size={16} />
          </button>
        </div>
      </header>

      <main className="min-h-0 flex-1">
        {items.length === 0 && job.loading === 0 ? (
          <Empty restored={job.restored} onPick={pick} errors={job.errors} products={products} />
        ) : (
          <div className="flex h-full min-h-0 flex-col lg:flex-row">
            <aside className="w-full shrink-0 overflow-y-auto border-r border-slate-200/70 bg-white px-4 py-4 lg:w-[400px]">
              <button className="btn-secondary mb-3 w-full border-dashed" onClick={pick}>
                <FilePlus2 size={16} /> Add designs (PDF, PNG, JPG)
              </button>
              {job.loading > 0 && (
                <div className="mb-3 flex items-center gap-2 text-sm text-slate-500">
                  <Loader2 size={15} className="animate-spin" /> Reading {plural(job.loading, 'file')}…
                </div>
              )}
              {job.errors.map((e) => (
                <div key={e} className="mb-3">
                  <Notice>{e}</Notice>
                </div>
              ))}
              <div className="flex flex-col gap-2.5">
                {items.map((it) => (
                  <div key={it.id} ref={(el) => void (cards.current[it.id] = el)}>
                    <ItemCard
                      it={it}
                      job={job}
                      settings={settings}
                      products={products}
                      setProducts={setProducts}
                      perSheet={layout.capacity[it.id]?.perSheet}
                      open={selected === it.id}
                      onOpen={() => setSelected(selected === it.id ? null : it.id)}
                      onFill={() => fill(it)}
                    />
                  </div>
                ))}
              </div>
              <ProductList products={products} setProducts={setProducts} />
            </aside>
            <SheetPanel
              job={job}
              settings={settings}
              sheets={sheets}
              nestDesigns={nestDesigns}
              moved={Object.values(overrides).some(Boolean)}
              setOverride={(id, o) => setOverrides((m) => ({ ...m, [id]: o }))}
              resetOverrides={() => setOverrides({})}
              onSelect={(id) => id && setSelected(id)}
            />
          </div>
        )}
      </main>

      {items.length > 0 && <DownloadBar job={job} settings={settings} sheets={sheets} nestDesigns={nestDesigns} />}

      {dragging && (
        <div className="pointer-events-none fixed inset-0 z-40 grid place-items-center bg-brand-600/10 p-6 backdrop-blur-sm">
          <div className="grid h-full w-full place-items-center rounded-[2rem] border-2 border-dashed border-brand-400 bg-white/60">
            <div className="text-center">
              <UploadCloud size={48} className="mx-auto text-brand-600" />
              <div className="mt-3 text-2xl font-bold text-brand-800">Drop to add to the sheet</div>
            </div>
          </div>
        </div>
      )}
      {showSettings && (
        <StickerSettingsDialog
          settings={settings}
          onSave={setSettings}
          onClose={() => setShowSettings(false)}
          noun="piece"
          paperName="Sheet"
          defaults={DEFAULT_PRINTCUT_SETTINGS}
        />
      )}
    </div>
  )
}

/* ------------------------------------------------------------------ empty state */

function Empty(props: { restored: boolean; onPick: () => void; errors: string[]; products: Product[] }) {
  if (!props.restored) return <div className="grid h-full place-items-center text-slate-400">Loading…</div>
  return (
    <div className="mx-auto w-full max-w-3xl animate-fade-up px-5 py-12">
      <button
        onClick={props.onPick}
        className="card group flex w-full flex-col items-center border-2 border-dashed border-slate-200 px-6 py-14 text-center transition hover:border-brand-300 hover:bg-brand-50/30"
      >
        <span className="grid h-16 w-16 place-items-center rounded-3xl bg-gradient-to-br from-brand-500 to-brand-700 text-white shadow-[0_10px_30px_rgb(91_47_245/0.35)]">
          <UploadCloud size={30} />
        </span>
        <span className="mt-5 text-2xl font-bold tracking-tight">Drop your finished designs here</span>
        <span className="mt-2 max-w-md text-slate-500">
          Any sizes and shapes – coasters, mug wraps, labels, tags. Each is placed at its exact size, gets bleed and a cut line, and they&rsquo;re packed onto the sheet together.
        </span>
        <span className="btn-primary mt-6">Choose files</span>
      </button>
      {props.errors.map((e) => (
        <div key={e} className="mt-3">
          <Notice>{e}</Notice>
        </div>
      ))}
      {props.products.length > 0 && (
        <p className="mt-6 text-center text-sm text-slate-500">
          Recognised automatically: {props.products.map((p) => `${p.name} (${p.shape === 'circle' ? 'round' : p.shape === 'rounded' ? 'rounded' : p.shape === 'contour' ? 'contour' : 'rectangle'})`).join(' · ')}
        </p>
      )}
    </div>
  )
}

/* ------------------------------------------------------------------ one design */

const SHAPES: { value: CutShape; label: ReactNode; hint: string }[] = [
  { value: 'contour', label: <><Shapes size={12} /> Contour</>, hint: 'Follows the outline of the design, with a border around it' },
  { value: 'rect', label: <><Square size={12} /> Rectangle</>, hint: 'Cut on the edge of the design' },
  { value: 'rounded', label: <><RectangleHorizontal size={12} /> Rounded</>, hint: 'Rectangle with rounded corners' },
  { value: 'circle', label: <><Circle size={12} /> Circle</>, hint: 'Circle (or oval, if width ≠ height)' },
]

const BORDERS: { value: BorderStyle; label: string; hint: string }[] = [
  { value: 'white', label: 'White', hint: 'Plain paper between the design and the cut line' },
  { value: 'color', label: 'Colour', hint: 'A printed border in any colour' },
  { value: 'none', label: 'None', hint: 'Cut right on the design edge (its edge colours are printed a little past the cut)' },
]

function ItemCard(props: {
  it: PrintCutItem
  job: PrintCutJob
  settings: StickerSettings
  products: Product[]
  setProducts: (p: Product[]) => void
  perSheet: number | undefined
  open: boolean
  onOpen: () => void
  onFill: () => void
}) {
  const { it, job, settings, open } = props
  const src = job.sources[it.sourceId]
  const g = src?.pages[it.pageIndex]?.geometry
  const [locked, setLocked] = useState(true)
  const [naming, setNaming] = useState<string | null>(null)
  const set = (patch: Partial<PrintCutItem>) => job.update(it.id, patch)
  if (!g) return null

  const plan = planItem(it, g, settings.bleedMm)
  const content = job.contentOf(it)
  const dpi = itemDpi(g, plan)
  const ratio = it.heightMm / it.widthMm
  const product = matchProduct({ kind: 'pdf', physicalSize: true, widthMm: it.widthMm, heightMm: it.heightMm }, props.products, 0)?.product
  const sameAsProduct = product && product.shape === it.shape
  const warnings = plan.warnings.filter((w) => !w.startsWith('Bleed was added automatically') && !w.startsWith('Bleed is made from'))
  const contour = it.shape === 'contour'
  const border = it.border ?? DEFAULT_BORDER
  const setBorder = (patch: Partial<typeof border>) => set({ border: { ...border, ...patch } })
  const traced = contour ? getContour(it, settings.bleedMm) : undefined
  if (traced) warnings.push(...traced.warnings.map((w) => w.replace('one sticker', 'one piece')))
  const traceError = contour ? job.contours.error(it) : undefined
  if (traceError) warnings.push(traceError)
  if (dpi !== null && dpi < settings.minDpi) warnings.push(`Prints at ${dpi} DPI at this size – may look soft.`)
  if (g.kind === 'image' && g.physicalSize === false && !product) warnings.push('This image has no size stored in it – check the width and height.')
  if (props.perSheet === 0) warnings.push('Bigger than the usable area of the sheet.')
  const proportionsDiffer = plan.plan.warnings.some((w) => w.startsWith("Design proportions don't match"))

  return (
    <div className={`rounded-2xl bg-white ring-1 transition ${open ? 'ring-brand-300 shadow-soft' : 'ring-slate-900/5 hover:ring-slate-900/10'}`}>
      <div className="flex items-center gap-2.5 p-2.5">
        <button className="flex min-w-0 flex-1 items-center gap-2.5 text-left" onClick={props.onOpen} aria-expanded={open}>
          <span className="grid h-12 w-12 shrink-0 place-items-center overflow-hidden rounded-lg" style={CHECKER}>
            {job.thumbOf(it) ? <img src={job.thumbOf(it)} alt="" className="max-h-full max-w-full object-contain p-0.5" /> : <Loader2 size={16} className="animate-spin text-slate-300" />}
          </span>
          <span className="min-w-0 flex-1">
            <span className="block truncate text-sm font-semibold">{it.name}</span>
            <span className="flex items-center gap-1.5 truncate text-xs text-slate-500">
              {it.shape === 'circle' ? <Circle size={11} /> : contour ? <Shapes size={11} /> : <Square size={11} />}
              {fmtSize(it.widthMm, it.heightMm)}
              {props.perSheet ? ` · ${props.perSheet}/sheet` : ''}
              {warnings.length > 0 && <AlertTriangle size={12} className="text-amber-500" />}
            </span>
          </span>
        </button>
        <Stepper size="sm" value={it.copies} label={`Copies of ${it.name}`} onChange={(n) => set({ copies: n })} />
      </div>

      {open && (
        <div className="flex flex-col gap-3 border-t border-slate-100 px-3 pt-3 pb-3">
          {sameAsProduct && (
            <div>
              <Badge tone="brand" icon={<Package size={11} />}>
                {product.name}
              </Badge>
            </div>
          )}
          <div className="flex flex-wrap items-center gap-1.5">
            <span className="w-11 text-xs font-semibold text-slate-500">Size</span>
            <NumberField
              aria-label="Width"
              value={round3(it.widthMm)}
              min={5}
              max={2000}
              suffix="mm"
              onChange={(w) => set(locked ? { widthMm: w, heightMm: round3(w * ratio) } : { widthMm: w })}
            />
            <span className="text-slate-400">×</span>
            <NumberField
              aria-label="Height"
              value={round3(it.heightMm)}
              min={5}
              max={2000}
              suffix="mm"
              onChange={(h) => set(locked ? { heightMm: h, widthMm: round3(h / ratio) } : { heightMm: h })}
            />
            <button className="btn-icon h-8 w-8 text-slate-500 hover:bg-slate-100" onClick={() => setLocked(!locked)} title={locked ? 'Proportions locked' : 'Proportions free'} aria-pressed={locked}>
              {locked ? <Link2 size={15} /> : <Link2Off size={15} />}
            </button>
          </div>

          {content && (
            <div className="flex flex-wrap items-center gap-1.5">
              <span className="w-11 text-xs font-semibold text-slate-500">Cut at</span>
              <Segmented
                size="sm"
                aria-label="Cut at"
                value={it.crop ? 'design' : 'file'}
                onChange={(v) => {
                  // keep the current print scale, swap which part of the file is the piece
                  const k = it.widthMm / (it.crop?.w ?? g.widthMm)
                  if (v === 'file') return set({ crop: undefined, widthMm: round3(g.widthMm * k), heightMm: round3(g.heightMm * k) })
                  const shape = content.ellipse && it.shape === 'rect' ? 'circle' : it.shape
                  set({
                    crop: content.rect,
                    widthMm: round3(content.rect.w * k),
                    heightMm: round3(content.rect.h * k),
                    shape,
                    ...(it.bleedMode === 'included' || (shape !== 'rect' && it.bleedMode === 'mirror') ? { bleedMode: shape === 'rect' ? 'mirror' : 'grow' } : {}),
                  })
                }}
                options={[
                  { value: 'design', label: 'Design edge', hint: 'Cut around the artwork itself, skipping the empty space in the file' },
                  { value: 'file', label: 'File edge', hint: 'Cut around the whole file / page' },
                ]}
              />
            </div>
          )}
          <div className="flex flex-wrap items-center gap-1.5">
            <span className="w-11 text-xs font-semibold text-slate-500">Cut</span>
            <Segmented size="sm" aria-label="Cut shape" value={it.shape} onChange={(shape) => set({ shape, ...(shape === 'circle' && it.bleedMode === 'mirror' ? { bleedMode: 'grow' as const } : {}) })} options={SHAPES} />
            {it.shape === 'rounded' && <NumberField aria-label="Corner radius" value={it.cornerMm} min={0} max={Math.min(it.widthMm, it.heightMm) / 2} suffix="mm" onChange={(cornerMm) => set({ cornerMm })} />}
          </div>

          {contour && (
            <>
              <div className="flex flex-wrap items-center gap-1.5">
                <span className="w-11 text-xs font-semibold text-slate-500">Border</span>
                <Segmented size="sm" aria-label="Border" value={border.style} onChange={(style) => setBorder({ style })} options={BORDERS} />
                {border.style !== 'none' && <NumberField aria-label="Border width" value={border.mm} min={0.5} max={20} suffix="mm" onChange={(mm) => setBorder({ mm })} />}
              </div>
              {border.style === 'color' && (
                <div className="flex flex-wrap items-center gap-1.5">
                  <span className="w-11 text-xs font-semibold text-slate-500">Colour</span>
                  {BORDER_SWATCHES.map((c) => (
                    <button
                      key={c}
                      className={`h-6 w-6 rounded-full ring-1 ring-slate-900/15 ${border.color.toLowerCase() === c ? 'outline-2 outline-offset-2 outline-brand-500' : ''}`}
                      style={{ background: c }}
                      onClick={() => setBorder({ color: c })}
                      aria-label={`Border colour ${c}`}
                      aria-pressed={border.color.toLowerCase() === c}
                    />
                  ))}
                  <input type="color" aria-label="Border colour" className="h-7 w-9 cursor-pointer rounded-md border-0 bg-transparent" value={border.color} onChange={(e) => setBorder({ color: e.target.value })} />
                </div>
              )}
              <div>
                <div className="flex flex-wrap items-center gap-1.5">
                  <span className="w-11 text-xs font-semibold text-slate-500" title="Fills small gaps and notches so the blade cuts one clean line">Smooth</span>
                  <input
                    type="range"
                    aria-label="Smoothing slider"
                    className="min-w-0 flex-1 accent-brand-600"
                    min={0}
                    max={10}
                    step={0.5}
                    value={Math.min(10, it.smoothMm ?? 0)}
                    onChange={(e) => set({ smoothMm: Number(e.target.value) })}
                  />
                  <NumberField aria-label="Smoothing" value={it.smoothMm ?? 0} min={0} max={30} suffix="mm" onChange={(smoothMm) => set({ smoothMm })} />
                </div>
                <p className="mt-1 pl-[3.125rem] text-xs text-slate-500">Fills small gaps and notches so the blade cuts one clean line</p>
              </div>
              <div className="flex flex-wrap gap-x-4 gap-y-1 text-xs text-slate-500">
                {traced ? (
                  <>
                    <span>
                      {traced.pieces} piece{traced.pieces === 1 ? '' : 's'}
                    </span>
                    <span>cut {fmtSize(traced.bounds.w, traced.bounds.h)}</span>
                    <span>cut length {round3(traced.cut.reduce((n, c) => n + pathLength(c), 0) / 25.4 * 10) / 10}″</span>
                    <span>{traced.cut.reduce((n, c) => n + c.segs.length, 0)} nodes</span>
                  </>
                ) : traceError ? null : (
                  <span className="inline-flex items-center gap-1.5"><Loader2 size={12} className="animate-spin" /> Tracing the outline…</span>
                )}
              </div>
            </>
          )}

          {!contour && <div className="flex flex-wrap items-center gap-1.5">
            <span className="w-11 text-xs font-semibold text-slate-500">Bleed</span>
            <select className="field flex-1 py-1.5 text-sm" aria-label="Bleed" value={it.bleedMode} onChange={(e) => set({ bleedMode: e.target.value as ItemBleed })}>
              {bleedOptions(it, g, settings.bleedMm).map((b) => (
                <option key={b} value={b}>
                  {ITEM_BLEED_LABELS[b]}
                </option>
              ))}
            </select>
          </div>}

          {proportionsDiffer && (
            <div className="flex flex-wrap items-center gap-1.5">
              <span className="w-11 text-xs font-semibold text-slate-500">Fit</span>
              <Segmented
                size="sm"
                aria-label="Fit"
                value={it.fit}
                onChange={(fit) => set({ fit })}
                options={[
                  { value: 'fit', label: 'Keep whole design' },
                  { value: 'fill', label: 'Fill & crop' },
                ]}
              />
            </div>
          )}

          <div className="flex flex-wrap items-center gap-1.5">
            <span className="w-11 text-xs font-semibold text-slate-500">Turn</span>
            <Segmented
              size="sm"
              aria-label="Rotation"
              value={String(it.rotation)}
              onChange={(v) => set({ rotation: v === 'auto' ? 'auto' : (Number(v) as 0 | 90) })}
              options={[
                { value: 'auto', label: 'Auto', hint: 'Turn it whichever way fits more' },
                { value: '0', label: 'Upright' },
                { value: '90', label: <><RotateCw size={12} /> 90°</> },
              ]}
            />
          </div>

          {warnings.map((w) => (
            <Notice key={w}>{w}</Notice>
          ))}

          {naming !== null ? (
            <form
              className="flex items-center gap-2"
              onSubmit={(e) => {
                e.preventDefault()
                const name = naming.trim() || fmtSize(it.widthMm, it.heightMm)
                const rest = props.products.filter((p) => !(Math.abs(p.widthMm - it.widthMm) < 0.01 && Math.abs(p.heightMm - it.heightMm) < 0.01))
                props.setProducts([...rest, { id: `p${Date.now().toString(36)}`, name, widthMm: it.widthMm, heightMm: it.heightMm, shape: it.shape, cornerMm: it.cornerMm }])
                setNaming(null)
              }}
            >
              <input autoFocus className="field flex-1 py-1.5 text-sm" placeholder="Product name, e.g. Coaster 82" value={naming} onChange={(e) => setNaming(e.target.value)} aria-label="Product name" />
              <button className="btn-primary px-3 py-1.5 text-xs" type="submit">
                Save
              </button>
              <button className="btn-ghost px-2 py-1.5 text-xs" type="button" onClick={() => setNaming(null)}>
                Cancel
              </button>
            </form>
          ) : (
            <div className="flex flex-wrap items-center gap-1.5">
              <button className="btn-secondary px-2.5 py-1.5 text-xs" onClick={props.onFill} disabled={!props.perSheet} title="Add copies until the last sheet is full">
                <PaintBucket size={13} /> Fill sheet
              </button>
              {!sameAsProduct && (
                <button className="btn-secondary px-2.5 py-1.5 text-xs" onClick={() => setNaming(it.name)} title="Files of this size get this cut shape automatically next time">
                  <BookmarkPlus size={13} /> Remember size
                </button>
              )}
              <span className="flex-1" />
              <button className="btn-icon h-8 w-8 text-slate-500 hover:bg-slate-100" onClick={() => job.duplicate(it.id)} title="Duplicate (e.g. same design at another size)" aria-label="Duplicate">
                <Copy size={15} />
              </button>
              <button className="btn-icon h-8 w-8 text-slate-500 hover:bg-red-50 hover:text-red-600" onClick={() => job.remove(it.id)} title="Remove" aria-label="Remove">
                <Trash2 size={15} />
              </button>
            </div>
          )}
        </div>
      )}
    </div>
  )
}

function ProductList(props: { products: Product[]; setProducts: (p: Product[]) => void }) {
  if (!props.products.length) return null
  return (
    <details className="mt-5 rounded-2xl bg-slate-50/70 px-3 py-2.5 ring-1 ring-slate-900/[0.04]">
      <summary className="cursor-pointer text-sm font-semibold text-slate-700">
        <Package size={14} className="mr-1.5 inline" /> Remembered sizes ({props.products.length})
      </summary>
      <p className="mt-1.5 text-xs text-slate-500">Files of these sizes (± 1 mm, with or without bleed) get the name and cut shape automatically.</p>
      <ul className="mt-2 flex flex-col gap-1">
        {props.products.map((p) => (
          <li key={p.id} className="flex items-center gap-2 text-sm">
            {p.shape === 'circle' ? <Circle size={13} className="text-slate-400" /> : <Square size={13} className="text-slate-400" />}
            <span className="min-w-0 flex-1 truncate">{p.name}</span>
            <span className="text-xs text-slate-500 tabular-nums">{fmtSize(p.widthMm, p.heightMm)}</span>
            <button className="btn-icon h-7 w-7 text-slate-400 hover:bg-red-50 hover:text-red-600" aria-label={`Forget ${p.name}`} onClick={() => props.setProducts(props.products.filter((q) => q.id !== p.id))}>
              <Trash2 size={13} />
            </button>
          </li>
        ))}
      </ul>
    </details>
  )
}

/* ------------------------------------------------------------------ sheet */

function SheetPanel(props: {
  job: PrintCutJob
  settings: StickerSettings
  sheets: StickerSheetLayout[]
  nestDesigns: NestDesign[]
  moved: boolean
  setOverride: (id: string, o: { x: number; y: number } | undefined) => void
  resetOverrides: () => void
  onSelect: (designId: string | null) => void
}) {
  const { job, settings, sheets } = props
  const [sheetIdx, setSheetIdx] = useState(0)
  const [view, setView] = useState<View>('both')
  const idx = Math.min(sheetIdx, Math.max(0, sheets.length - 1))
  const sheet = sheets[idx]
  const previews = useItemPreviews(job.items, job.sources, settings.bleedMm)
  const shapes = useMemo(() => Object.fromEntries(props.nestDesigns.map((d) => [d.id, { cut: d.cut, bounds: d.bounds }])), [props.nestDesigns])
  const visuals = useMemo(() => {
    const b = settings.bleedMm
    const out: Record<string, StickerVisual> = {}
    for (const it of job.items) {
      const { cut, bleed } = itemShape(it, b)
      const traced = it.shape === 'contour' ? getContour(it, b) : undefined
      if (traced) {
        const pics = job.contours.pictures(it)
        const border = it.border ?? DEFAULT_BORDER
        out[it.id] = { cut, bleed, border: border.style, borderColor: border.color, art: pics?.art ?? null, artRect: traced.art.rect, bleedImg: pics?.bleed ?? null, bleedRect: traced.bleedImage?.rect }
        continue
      }
      out[it.id] = { cut, bleed, border: 'none', borderColor: '#000', art: previews[it.id] ?? null, artRect: { x: -b, y: -b, w: it.widthMm + 2 * b, h: it.heightMm + 2 * b } }
    }
    return out
  }, [job.items, previews, settings.bleedMm, job.contours.version]) // version: a newly traced contour changes what is drawn
  const problems = useMemo(() => (sheet ? layoutProblems(sheet, shapes, settings) : { overlapping: new Set<string>(), outside: new Set<string>() }), [sheet, shapes, settings])

  return (
    <section className="relative flex min-h-[420px] flex-1 flex-col bg-canvas">
      <div className="z-10 flex flex-wrap items-center gap-2 border-b border-white/5 px-3 py-2 text-white/80">
        <div className="flex items-center gap-1">
          <button className="btn-icon text-white/70 hover:bg-white/10" disabled={idx === 0} onClick={() => setSheetIdx(idx - 1)} aria-label="Previous sheet">
            <ChevronLeft size={18} />
          </button>
          <span className="min-w-[7.5rem] text-center text-sm font-semibold tabular-nums">{sheets.length ? `Sheet ${idx + 1} of ${sheets.length}` : 'No sheets'}</span>
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
        {props.moved && (
          <button className="btn rounded-lg px-2.5 py-1.5 text-xs text-white/80 hover:bg-white/10" onClick={props.resetOverrides}>
            <Undo2 size={14} /> Re-arrange automatically
          </button>
        )}
        <span className="hidden text-xs text-white/50 xl:inline">Click a piece to edit it · drag to move · wheel to zoom</span>
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
          onSelect={props.onSelect}
          noun="piece"
        />
      ) : (
        <div className="grid flex-1 place-items-center text-white/50">Nothing to place yet.</div>
      )}
      {(problems.overlapping.size > 0 || problems.outside.size > 0) && (
        <div className="absolute bottom-3 left-1/2 flex -translate-x-1/2 items-center gap-2 rounded-full bg-amber-500 px-4 py-2 text-sm font-semibold text-amber-950 shadow-lift">
          <AlertTriangle size={16} />
          {problems.overlapping.size > 0 ? 'Some pieces are too close – their cut lines would touch.' : 'A piece is outside the printable area.'}
        </div>
      )}
    </section>
  )
}

/* ------------------------------------------------------------------ download */

function DownloadBar(props: { job: PrintCutJob; settings: StickerSettings; sheets: StickerSheetLayout[]; nestDesigns: NestDesign[] }) {
  const { job, settings, sheets } = props
  const [busy, setBusy] = useState<ExportMode | 'svg' | null>(null)
  const [error, setError] = useState<string | null>(null)
  const date = new Date().toISOString().slice(0, 10)
  const base = `print-cut_${date}_${settings.sheet.name.replace(/[^\w]+/g, '')}_${sheets.length}-sheet${sheets.length === 1 ? '' : 's'}`
  const shapes = useMemo(() => Object.fromEntries(props.nestDesigns.map((d) => [d.id, d])), [props.nestDesigns])
  const tracing = job.contours.waiting > 0
  const clash = sheets.some((sh) => {
    const p = layoutProblems(sh, shapes, settings)
    return p.overlapping.size > 0 || p.outside.size > 0
  })

  const pdf = async (mode: ExportMode) => {
    setBusy(mode)
    setError(null)
    try {
      const suffix = mode === 'print-cut' ? 'print-and-cut' : mode === 'print' ? 'print-only' : 'cut-lines'
      const name = `${base}_${suffix}.pdf`
      const bytes = await buildPrintCutPdf(sheets, job.items, job.sources, settings, { mode, rasterizer: browserRasterizer, title: name })
      save(bytes as BlobPart, name, 'application/pdf')
    } catch (e) {
      setError((e as Error).message)
    } finally {
      setBusy(null)
    }
  }
  const svg = () => {
    setBusy('svg')
    try {
      for (const sh of sheets) save(buildCutSvg(sh, shapes, settings), `${base}_cut_sheet-${sh.index + 1}.svg`, 'image/svg+xml')
    } finally {
      setBusy(null)
    }
  }

  return (
    <div className="sticky bottom-0 z-20 border-t border-slate-200/70 bg-white/85 backdrop-blur-xl">
      <div className="mx-auto flex max-w-[1600px] flex-wrap items-center gap-2 px-5 py-3">
        <div className="min-w-0 flex-1 truncate text-sm text-slate-500">
          {error ? (
            <span className="text-red-600">Could not make the PDF: {error}</span>
          ) : tracing ? (
            <span className="inline-flex items-center gap-1.5"><Loader2 size={14} className="animate-spin" /> Tracing contour cut lines…</span>
          ) : clash ? (
            <span className="text-amber-700">Some pieces overlap or leave the sheet – fix them before printing.</span>
          ) : (
            <>Print at 100 % – then cut on the {settings.cut.spotName} line</>
          )}
        </div>
        <button className="btn-ghost px-3 text-xs" disabled={!!busy || tracing || !sheets.length} onClick={() => void pdf('print')} title="Artwork and registration marks only">
          Print only
        </button>
        <button className="btn-ghost px-3 text-xs" disabled={!!busy || tracing || !sheets.length} onClick={() => void pdf('cut')} title="Cut lines and registration marks only">
          Cut only
        </button>
        <button className="btn-ghost px-3 text-xs" disabled={!!busy || tracing || !sheets.length} onClick={svg} title="Cut lines as SVG, one file per sheet">
          Cut SVG
        </button>
        <button className="btn-primary btn-lg" disabled={!!busy || tracing || !sheets.length} onClick={() => void pdf('print-cut')}>
          {busy === 'print-cut' ? <Loader2 size={18} className="animate-spin" /> : <Download size={18} />}
          {busy === 'print-cut' ? 'Making PDF…' : 'Download print & cut PDF'}
        </button>
      </div>
    </div>
  )
}
