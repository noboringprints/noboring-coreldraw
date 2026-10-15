import { useState } from 'react'
import { Bookmark, BookmarkPlus, ChevronDown, FileStack, Plus, RectangleHorizontal, RectangleVertical, Trash2, X, Zap } from 'lucide-react'
import { TRIM_SIZES, type PrintSettings } from '../config/defaults'
import type { BleedMode } from '../lib/artwork'
import type { Design, DesignCheck } from '../lib/job'
import { bestGrid, groupKey, type Sheet } from '../lib/layout'
import { BUILT_IN_PRESETS, type Preset } from '../lib/presets'
import type { SourceFile } from '../lib/sources'
import FillSpace from './FillSpace'
import { Badge, DESIGN_COLORS, NumberField, Notice, Segmented, SheetDiagram, Stepper, Switch, Thumb, detectedSizeText, fmtMm, useToast } from './ui'

/** Warnings that are just information (the app did something for you), not problems. */
const isInfo = (w: string) => w.startsWith('Bleed was added automatically')

export default function SizeStep(props: {
  designs: Design[]
  sources: Record<string, SourceFile>
  thumbs: Record<string, string>
  settings: PrintSettings
  checks: Record<string, DesignCheck>
  sheets: Sheet[]
  maxPerSheet: Record<string, number | undefined>
  setMaxPerSheet: (key: string, v: number | undefined) => void
  presets: Preset[]
  onApplyPreset: (p: Preset) => void
  onSavePreset: (name: string) => void
  onDeletePreset: (id: string) => void
  onUpdate: (id: string, patch: Partial<Design>) => void
  onRemove: (id: string) => void
  onAddFiles: (files: File[], trim: { name: string; w: number; h: number }) => void
  onRepeat: (designId: string, pageIndex: number) => void
}) {
  const { settings } = props
  const toast = useToast()
  const colorOf = (designId: string) => DESIGN_COLORS[Math.max(0, props.designs.findIndex((d) => d.id === designId)) % DESIGN_COLORS.length]

  return (
    <div className="mx-auto grid w-full max-w-[1400px] gap-6 px-5 py-8 lg:grid-cols-[1fr_360px]">
      <div className="min-w-0">
        <div className="mb-5">
          <h1 className="text-2xl font-bold tracking-tight">Size & copies</h1>
          <p className="mt-1 text-slate-500">Pick the final size and how many you need. Everything else is automatic.</p>
        </div>

        <QuickSetups
          presets={props.presets}
          onApply={(p) => {
            props.onApplyPreset(p)
            toast(`“${p.name}” applied`)
          }}
          onSave={(n) => {
            props.onSavePreset(n)
            toast(`Saved “${n}”`)
          }}
          onDelete={props.onDeletePreset}
        />

        <div className="mt-5 flex flex-col gap-4">
          {props.designs.map((d, i) => {
            const src = props.sources[d.sourceId]
            if (!src) return null
            return (
              <DesignCard
                key={d.id}
                index={i}
                d={d}
                src={src}
                thumb={props.thumbs[src.id]}
                check={props.checks[d.id]}
                settings={settings}
                color={colorOf(d.id)}
                onUpdate={(patch) => props.onUpdate(d.id, patch)}
                onRemove={() => props.onRemove(d.id)}
              />
            )
          })}
        </div>
      </div>

      <PrintPlan {...props} colorOf={colorOf} />
    </div>
  )
}

/* ---------------------------------------------------------------- quick setups */

function QuickSetups(props: { presets: Preset[]; onApply: (p: Preset) => void; onSave: (name: string) => void; onDelete: (id: string) => void }) {
  const [saving, setSaving] = useState(false)
  const [name, setName] = useState('')
  const [active, setActive] = useState<string | null>(null)
  return (
    <div className="card p-4">
      <div className="mb-3 flex items-center gap-2">
        <Zap size={16} className="text-brand-600" />
        <span className="text-sm font-semibold">Quick setups</span>
        <span className="text-sm text-slate-400">– one click sets the size for every design</span>
      </div>
      <div className="flex flex-wrap gap-2">
        {[...BUILT_IN_PRESETS, ...props.presets].map((p) => (
          <span key={p.id} className="group relative">
            <button
              onClick={() => {
                props.onApply(p)
                setActive(p.id)
              }}
              className={`btn rounded-full px-3.5 py-2 ${active === p.id ? 'bg-brand-600 text-white shadow-sm' : 'bg-slate-100 text-slate-700 hover:bg-brand-50 hover:text-brand-700'} ${p.builtIn ? '' : 'pr-8'}`}
            >
              {!p.builtIn && <Bookmark size={14} />}
              {p.name}
            </button>
            {!p.builtIn && (
              <button
                title="Delete"
                aria-label={`Delete ${p.name}`}
                className="absolute top-1/2 right-1.5 grid h-6 w-6 -translate-y-1/2 place-items-center rounded-full text-slate-400 hover:bg-white hover:text-red-600"
                onClick={() => confirm(`Delete “${p.name}”?`) && props.onDelete(p.id)}
              >
                <X size={13} />
              </button>
            )}
          </span>
        ))}
        {saving ? (
          <form
            className="flex items-center gap-1.5"
            onSubmit={(e) => {
              e.preventDefault()
              if (!name.trim()) return
              props.onSave(name.trim())
              setName('')
              setSaving(false)
            }}
          >
            <input autoFocus className="field w-56 rounded-full py-1.5" placeholder="Name, e.g. A4 posters – A3" value={name} onChange={(e) => setName(e.target.value)} />
            <button className="btn-primary rounded-full px-3.5 py-2" disabled={!name.trim()}>
              Save
            </button>
            <button type="button" className="btn-icon btn-ghost rounded-full" onClick={() => setSaving(false)} aria-label="Cancel">
              <X size={16} />
            </button>
          </form>
        ) : (
          <button className="btn rounded-full border border-dashed border-slate-300 px-3.5 py-2 text-slate-500 hover:border-brand-400 hover:text-brand-700" onClick={() => setSaving(true)}>
            <BookmarkPlus size={15} /> Save current
          </button>
        )}
      </div>
    </div>
  )
}

/* ---------------------------------------------------------------- one design */

function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="grid items-center gap-2 sm:grid-cols-[96px_1fr]">
      <div className="label-xs">{label}</div>
      <div className="flex flex-wrap items-center gap-2">{children}</div>
    </div>
  )
}

function DesignCard(props: {
  index: number
  d: Design
  src: SourceFile
  thumb?: string
  check?: DesignCheck
  settings: PrintSettings
  color: string
  onUpdate: (p: Partial<Design>) => void
  onRemove: () => void
}) {
  const { d, src, check, settings, onUpdate } = props
  const landscape = d.trimW > d.trimH
  const multi = src.pages.length > 1
  const problems = (check?.warnings ?? []).filter((w) => !isInfo(w))
  const infos = (check?.warnings ?? []).filter(isInfo)
  const [open, setOpen] = useState(true)

  const setSize = (name: string) => {
    if (name === 'Custom') return onUpdate({ trimName: 'Custom' })
    const t = TRIM_SIZES.find((x) => x.name === name)!
    const s = Math.min(t.widthMm, t.heightMm)
    const l = Math.max(t.widthMm, t.heightMm)
    onUpdate({ trimName: name, trimW: landscape ? l : s, trimH: landscape ? s : l })
  }

  const bleedOptions: { value: BleedMode; label: string; hint: string }[] = [
    ...(check?.hasBleed ? [{ value: 'included' as BleedMode, label: 'From file', hint: `The file already includes ${settings.bleedMm} mm bleed` }] : []),
    { value: 'mirror', label: 'Mirror', hint: `Mirror the outer ${settings.bleedMm} mm outside the cut line` },
    { value: 'stretch', label: 'Stretch', hint: 'Stretch the edge pixels outward' },
    { value: 'none', label: 'None', hint: 'No bleed – design printed exactly as it is, cut at its edge' },
  ]

  return (
    <div className="card animate-fade-up overflow-hidden" style={{ animationDelay: `${props.index * 50}ms` }}>
      <div className="flex gap-4 p-4 sm:p-5">
        <div className="relative">
          <Thumb url={props.thumb} alt={d.name} />
          <span className="absolute -top-1 -left-1 h-3.5 w-3.5 rounded-full ring-2 ring-white" style={{ background: props.color }} />
        </div>
        <div className="min-w-0 flex-1">
          <div className="flex items-start gap-3">
            <div className="min-w-0 flex-1">
              <input
                className="-mx-2 w-full rounded-lg px-2 py-0.5 text-lg font-semibold tracking-tight outline-none hover:bg-slate-50 focus:bg-white focus:ring-2 focus:ring-brand-500"
                value={d.name}
                onChange={(e) => onUpdate({ name: e.target.value })}
                aria-label="Design name"
              />
              <div className="mt-0.5 flex flex-wrap items-center gap-2 text-xs text-slate-500">
                <span>{detectedSizeText(src, d.split ? 0 : d.pageIndex, settings.bleedMm)}</span>
                {multi && (
                  <Badge tone="neutral" icon={<FileStack size={12} />}>
                    {src.pages.length} pages
                  </Badge>
                )}
                {check?.dpi != null && <Badge tone={check.dpi >= settings.minDpi ? 'good' : 'warn'}>{check.dpi} DPI</Badge>}
              </div>
            </div>
            <div className="flex flex-col items-end gap-1">
              <Stepper value={d.copies} onChange={(n) => onUpdate({ copies: n })} label="Copies" />
              <span className="text-[11px] font-medium text-slate-400">{d.split ? 'full sets' : d.copies === 1 ? 'copy' : 'copies'}</span>
            </div>
            <button className="btn-icon btn-ghost -mt-1 -mr-2 text-slate-400 hover:text-red-600" onClick={props.onRemove} aria-label={`Remove ${d.name}`} title="Remove">
              <Trash2 size={17} />
            </button>
          </div>

          <div className="mt-4 flex flex-col gap-3">
            <Row label={d.split ? 'Panel size' : 'Size'}>
              <Segmented aria-label="Trim size" value={d.trimName} onChange={setSize} options={[...TRIM_SIZES.map((t) => ({ value: t.name, label: t.name })), { value: 'Custom', label: 'Custom' }]} />
              <Segmented
                aria-label="Orientation"
                value={landscape ? 'l' : 'p'}
                onChange={(v) => (v === 'l') !== landscape && onUpdate({ trimW: d.trimH, trimH: d.trimW })}
                options={[
                  { value: 'p', label: <RectangleVertical size={16} />, hint: 'Portrait' },
                  { value: 'l', label: <RectangleHorizontal size={16} />, hint: 'Landscape' },
                ]}
              />
              {d.trimName === 'Custom' ? (
                <span className="flex items-center gap-1.5">
                  <NumberField aria-label="Width" value={d.trimW} min={10} max={2000} onChange={(n) => onUpdate({ trimW: n })} suffix="mm" />
                  <span className="text-slate-400">×</span>
                  <NumberField aria-label="Height" value={d.trimH} min={10} max={2000} onChange={(n) => onUpdate({ trimH: n })} suffix="mm" />
                </span>
              ) : (
                <span className="text-sm text-slate-500 tabular-nums">
                  {fmtMm(d.trimW)} × {fmtMm(d.trimH)} mm
                </span>
              )}
            </Row>

            <Row label="Bleed">
              <Segmented aria-label="Bleed" value={d.bleedMode} onChange={(v) => onUpdate({ bleedMode: v })} options={bleedOptions} />
              <span className="text-xs text-slate-400">{bleedOptions.find((o) => o.value === d.bleedMode)?.hint}</span>
            </Row>

            {multi && (
              <Row label="Pages">
                <Switch checked={d.split} onChange={(v) => onUpdate({ split: v })} label={`Split poster – ${src.pages.length} panels`} />
                {!d.split && (
                  <span className="flex items-center gap-2 text-sm text-slate-500">
                    or print page
                    <select className="field py-1.5" value={d.pageIndex} onChange={(e) => onUpdate({ pageIndex: Number(e.target.value) })}>
                      {src.pages.map((p) => (
                        <option key={p.index} value={p.index}>
                          {p.index + 1}
                        </option>
                      ))}
                    </select>
                  </span>
                )}
              </Row>
            )}

            {check?.aspectMismatch && (
              <Row label="Fit">
                <Segmented
                  aria-label="Fit"
                  value={d.fit}
                  onChange={(v) => onUpdate({ fit: v })}
                  options={[
                    { value: 'fit', label: 'Keep whole design', hint: 'Nothing is cut off; white bands fill the gap' },
                    { value: 'fill', label: 'Fill & crop', hint: 'Fills the size; some of the design is cut off' },
                  ]}
                />
              </Row>
            )}
          </div>
        </div>
      </div>

      {(problems.length > 0 || infos.length > 0 || (check?.notes?.length ?? 0) > 0) && (
        <div className="border-t border-slate-100 bg-slate-50/60 px-4 py-3 sm:px-5">
          {problems.length > 0 ? (
            <>
              <button className="flex w-full items-center gap-2 text-left text-sm font-semibold text-amber-800" onClick={() => setOpen(!open)}>
                <span className="grid h-5 w-5 place-items-center rounded-full bg-amber-400 text-[11px] text-white">{problems.length}</span>
                {problems.length === 1 ? 'Something to check' : 'Things to check'}
                <ChevronDown size={16} className={`ml-auto transition-transform ${open ? 'rotate-180' : ''}`} />
              </button>
              {open && (
                <div className="mt-2.5 flex flex-col gap-2">
                  {problems.map((w) => (
                    <Notice key={w}>{w}</Notice>
                  ))}
                </div>
              )}
            </>
          ) : (
            <div className="flex items-center gap-2 text-sm font-medium text-emerald-700">
              <span className="grid h-5 w-5 place-items-center rounded-full bg-emerald-500 text-white">✓</span>
              Looks good
            </div>
          )}
          {[...infos, ...(check?.notes ?? [])].map((n) => (
            <p key={n} className="mt-1.5 text-xs text-slate-500">
              {n}
            </p>
          ))}
        </div>
      )}
    </div>
  )
}

/* ---------------------------------------------------------------- print plan */

function PrintPlan(props: Parameters<typeof SizeStep>[0] & { colorOf: (id: string) => string }) {
  const { settings } = props
  const groups = new Map<string, { w: number; h: number; names: string[]; trimName: string }>()
  for (const d of props.designs) {
    const k = groupKey(d.trimW, d.trimH)
    if (!groups.has(k)) groups.set(k, { w: Math.min(d.trimW, d.trimH), h: Math.max(d.trimW, d.trimH), names: [], trimName: d.trimName })
    groups.get(k)!.names.push(d.name)
  }
  const total = props.sheets.length
  const [fillKey, setFillKey] = useState<string | null>(null)
  return (
    <aside className="lg:sticky lg:top-6 lg:self-start">
      <div className="card overflow-hidden">
        <div className="bg-gradient-to-br from-brand-600 to-brand-800 px-5 py-5 text-white">
          <div className="text-xs font-semibold tracking-wider text-brand-100 uppercase">Print plan</div>
          <div className="mt-1 flex items-baseline gap-2">
            <span className="text-4xl font-bold tabular-nums">{total}</span>
            <span className="text-brand-100">sheet{total === 1 ? '' : 's'} of {settings.sheet.name}</span>
          </div>
          <div className="mt-1 text-xs text-brand-100 tabular-nums">
            Sheet size {fmtMm(settings.sheet.widthMm)} × {fmtMm(settings.sheet.heightMm)} mm
          </div>
        </div>
        <div className="flex flex-col divide-y divide-slate-100">
          {[...groups].map(([k, g]) => {
            const auto = bestGrid(settings.sheet, g.w, g.h, settings).count
            const gs = props.sheets.filter((s) => s.groupKey === k)
            const first = gs[0]
            const opts = Array.from({ length: Math.max(0, auto) }, (_, i) => auto - i)
            const free = gs.reduce((n, s) => n + s.freeSlots.length, 0)
            return (
              <div key={k} className="p-4">
              <div className="flex gap-4">
                {first && (
                  <SheetDiagram
                    sheetW={settings.sheet.widthMm}
                    sheetH={settings.sheet.heightMm}
                    bleed={settings.bleedMm}
                    height={92}
                    trims={first.placements.map((p) => ({ rect: p.trim, color: props.colorOf(p.item.designId) }))}
                  />
                )}
                <div className="min-w-0 flex-1">
                  <div className="font-semibold">
                    {g.trimName !== 'Custom' && <span className="text-brand-700">{g.trimName} · </span>}
                    {fmtMm(g.w)} × {fmtMm(g.h)} mm
                  </div>
                  <div className="truncate text-xs text-slate-500">{[...new Set(g.names)].join(', ')}</div>
                  {auto === 0 ? (
                    <div className="mt-2">
                      <Notice>Too big for this sheet. Pick a bigger sheet in Settings.</Notice>
                    </div>
                  ) : (
                    <>
                      <div className="mt-2 text-sm">
                        <b>{first?.placements.length ?? 0}</b> per sheet · <b>{gs.length}</b> sheet{gs.length === 1 ? '' : 's'}
                      </div>
                      <label className="mt-2 flex items-center gap-2 text-xs text-slate-500">
                        Per sheet
                        <select
                          className="field py-1 text-xs"
                          value={props.maxPerSheet[k] ?? ''}
                          onChange={(e) => props.setMaxPerSheet(k, e.target.value ? Number(e.target.value) : undefined)}
                        >
                          <option value="">Fit most ({auto})</option>
                          {opts.slice(1).map((n) => (
                            <option key={n} value={n}>
                              {n}
                            </option>
                          ))}
                        </select>
                      </label>
                      {free > 0 && (
                        <div className="mt-3">
                          <button
                            className="btn w-full justify-center rounded-xl bg-amber-100 px-3 py-2 text-sm font-semibold text-amber-900 hover:bg-amber-200"
                            onClick={() => setFillKey(fillKey === k ? null : k)}
                            aria-expanded={fillKey === k}
                          >
                            <Plus size={15} /> {free === 1 ? '1 empty space' : `${free} empty spaces`} – fill
                          </button>
                        </div>
                      )}
                    </>
                  )}
                </div>
              </div>
              {fillKey === k && (
                <div className="mt-3">
                  <FillSpace
                    wide
                    target={{ groupKey: k, trimName: g.trimName, trimW: first?.trimW ?? g.w, trimH: first?.trimH ?? g.h, free: gs.reduce((n, s) => n + s.freeSlots.length, 0) }}
                    designs={props.designs}
                    sources={props.sources}
                    thumbs={props.thumbs}
                    onAddFiles={props.onAddFiles}
                    onRepeat={props.onRepeat}
                    onClose={() => setFillKey(null)}
                  />
                </div>
              )}
              </div>
            )
          })}
        </div>
        <div className="border-t border-slate-100 px-5 py-3 text-xs text-slate-400">Same sizes share a sheet. Different sizes print on separate sheets.</div>
      </div>
    </aside>
  )
}
