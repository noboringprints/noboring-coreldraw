import { useMemo, useState } from 'react'
import { CheckCircle2, Download, FileCheck2, FileImage, Printer, RotateCcw, Scissors } from 'lucide-react'
import { Notice } from '../../components/ui'
import { apply } from '../../lib/geometry'
import type { StickerSettings } from '../config'
import { type ExportDesign, type ExportMode, buildCutSvg, buildStickerPdf } from '../lib/exportStickers'
import { type StickerSheetLayout, layoutProblems, placementMatrix } from '../lib/nest'
import { mapPath, svgPathData } from '../lib/paths'
import { artImageRect, effectiveDpi } from '../model'
import type { StickerJob } from '../useStickerJob'

const MARK_NAMES: Record<StickerSettings['marks']['style'], string> = {
  dots: '4 round corner dots',
  'l-corners': 'L-shaped corner marks',
  squares: 'square corner marks',
  silhouette: 'Silhouette-style marks (square + 3 L-corners)',
  none: 'no registration marks',
}

function save(data: BlobPart, name: string, type: string) {
  const url = URL.createObjectURL(new Blob([data], { type }))
  const a = document.createElement('a')
  a.href = url
  a.download = name
  a.click()
  setTimeout(() => URL.revokeObjectURL(url), 60_000)
}

export default function ExportStep(props: { job: StickerJob; settings: StickerSettings; sheets: StickerSheetLayout[] }) {
  const { job, settings, sheets } = props
  const [busy, setBusy] = useState<ExportMode | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [done, setDone] = useState<{ name: string; size: string } | null>(null)

  const designs = useMemo(() => {
    const out: Record<string, ExportDesign> = {}
    for (const s of job.stickers) {
      const r = job.cuts[s.id]?.result
      if (!r?.cut.length) continue
      out[s.id] = {
        id: s.id,
        name: s.name,
        cut: r.cut,
        bleed: r.bleed,
        bounds: r.bounds,
        border: s.params.border,
        borderColor: s.params.borderColor,
        art: { bytes: s.art.bytes, kind: s.art.kind, rect: artImageRect(s, settings.bleedMm) },
        bleedImage: r.bleedImage,
      }
    }
    return out
  }, [job.stickers, job.cuts, settings.bleedMm])

  const stickersTotal = sheets.reduce((n, s) => n + s.placements.length, 0)
  const problems = useMemo(() => {
    const out: string[] = []
    for (const s of job.stickers) {
      for (const w of job.cuts[s.id]?.result?.warnings ?? []) out.push(`${s.name}: ${w}`)
      const dpi = effectiveDpi(s)
      if (dpi < settings.minDpi) out.push(`${s.name}: prints at ${Math.round(dpi)} DPI – may look soft.`)
    }
    for (const sh of sheets) {
      const p = layoutProblems(sh, designs, settings)
      if (p.overlapping.size) out.push(`Sheet ${sh.index + 1}: some stickers are closer than the ${settings.gapMm} mm gap.`)
      if (p.outside.size) out.push(`Sheet ${sh.index + 1}: a sticker is outside the printable area.`)
    }
    return out
  }, [job.stickers, job.cuts, sheets, designs, settings])

  const date = new Date().toISOString().slice(0, 10)
  const base = `stickers_${date}_${settings.sheet.name.replace(/[^\w]+/g, '')}_${sheets.length}-sheet${sheets.length === 1 ? '' : 's'}`

  const download = async (mode: ExportMode) => {
    setBusy(mode)
    setError(null)
    try {
      const suffix = mode === 'print-cut' ? 'print-and-cut' : mode === 'print' ? 'print-only' : 'cut-lines'
      const name = `${base}_${suffix}.pdf`
      const bytes = await buildStickerPdf(sheets, designs, settings, { mode, title: name })
      save(bytes as BlobPart, name, 'application/pdf')
      setDone({ name, size: `${(bytes.length / 1024 / 1024).toFixed(1)} MB` })
    } catch (e) {
      setError((e as Error).message)
    } finally {
      setBusy(null)
    }
  }

  const stats = [
    { label: 'Sheets', value: sheets.length },
    { label: 'Stickers', value: stickersTotal },
    { label: 'Designs', value: Object.keys(designs).length },
    { label: 'Sheet', value: settings.sheet.name },
  ]

  return (
    <div className="mx-auto w-full max-w-5xl px-5 py-10">
      <div className="card animate-fade-up overflow-hidden">
        <div className="relative px-6 py-10 text-center sm:px-10">
          <div className="pointer-events-none absolute inset-0 bg-[radial-gradient(60%_80%_at_50%_0%,var(--color-brand-100),transparent)]" />
          <div className="relative">
            <span
              className={`mx-auto grid h-16 w-16 place-items-center rounded-3xl text-white shadow-[0_10px_30px_rgb(91_47_245/0.35)] ${done ? 'bg-gradient-to-br from-emerald-400 to-emerald-600' : 'bg-gradient-to-br from-brand-500 to-brand-700'}`}
            >
              {done ? <CheckCircle2 size={30} /> : <FileCheck2 size={30} />}
            </span>
            <h1 className="mt-5 text-3xl font-bold tracking-tight">{done ? 'Downloaded!' : 'Ready to print & cut'}</h1>
            <p className="mt-2 text-slate-500">
              {done ? (
                <>
                  Saved <b className="text-slate-700">{done.name}</b> ({done.size}).
                </>
              ) : (
                <>
                  One PDF: artwork on the <b>Print</b> layer, cut lines on the <b>{settings.cut.spotName}</b> layer.
                </>
              )}
            </p>

            <div className="mx-auto mt-7 grid max-w-xl grid-cols-2 gap-3 sm:grid-cols-4">
              {stats.map((s) => (
                <div key={s.label} className="rounded-2xl bg-slate-50 px-3 py-3 ring-1 ring-slate-900/[0.04]">
                  <div className="text-xl font-bold tabular-nums">{s.value}</div>
                  <div className="text-xs font-medium text-slate-500">{s.label}</div>
                </div>
              ))}
            </div>

            <div className="mt-8 flex flex-wrap items-center justify-center gap-3">
              <button className="btn-primary btn-lg px-8 py-4 text-lg" disabled={!!busy || !sheets.length} onClick={() => download('print-cut')}>
                {busy === 'print-cut' ? (
                  <>
                    <span className="h-5 w-5 animate-spin rounded-full border-2 border-white/40 border-t-white" /> Making PDF…
                  </>
                ) : done ? (
                  <>
                    <RotateCcw size={20} /> Download again
                  </>
                ) : (
                  <>
                    <Download size={20} /> Download print & cut PDF
                  </>
                )}
              </button>
            </div>
            <div className="mt-4 flex flex-wrap items-center justify-center gap-2 text-sm">
              <span className="text-slate-400">Separate files:</span>
              <button className="btn-secondary px-3 py-1.5" disabled={!!busy || !sheets.length} onClick={() => download('print')}>
                <Printer size={15} /> {busy === 'print' ? 'Making…' : 'Print only (PDF)'}
              </button>
              <button className="btn-secondary px-3 py-1.5" disabled={!!busy || !sheets.length} onClick={() => download('cut')}>
                <Scissors size={15} /> {busy === 'cut' ? 'Making…' : 'Cut lines only (PDF)'}
              </button>
              {sheets.map((sh) => (
                <button
                  key={sh.index}
                  className="btn-secondary px-3 py-1.5"
                  onClick={() => save(buildCutSvg(sh, designs, settings), `${base}_sheet-${sh.index + 1}_cut.svg`, 'image/svg+xml')}
                  title="Cut lines and marks of this sheet as SVG (mm)"
                >
                  <FileImage size={15} /> {sheets.length > 1 ? `Sheet ${sh.index + 1} ` : ''}cut SVG
                </button>
              ))}
            </div>
            {error && (
              <div className="mx-auto mt-4 max-w-lg text-left">
                <Notice>Could not make the PDF: {error}</Notice>
              </div>
            )}
          </div>
        </div>

        <div className="grid gap-6 border-t border-slate-100 bg-slate-50/50 px-6 py-6 sm:px-10 md:grid-cols-2">
          <div>
            <div className="mb-3 flex items-center gap-2 text-sm font-semibold">
              <Printer size={16} className="text-brand-600" /> In production
            </div>
            <ol className="space-y-2 text-sm text-slate-600">
              {[
                <>
                  Print at <b>100 % / “Actual size”</b> on {settings.sheet.name} sticker paper. The {settings.cut.spotName} line is a spot colour and is normally not printed – if your printer does print it, use the <b>Print only</b> file.
                </>,
                <>Load the printed sheet into the cutter. This file has {MARK_NAMES[settings.marks.style]} – set the cutter's mark type to match.</>,
                <>
                  Open the same PDF (or the <b>Cut lines</b> file / SVG) in the cutter software. The cut path is the <b>{settings.cut.spotName}</b> spot colour.
                </>,
                <>Kiss-cut: cut through the vinyl only, so stickers stay on the sheet. Die-cut: cut through the backing too.</>,
              ].map((t, i) => (
                <li key={i} className="flex gap-2.5">
                  <span className="grid h-5 w-5 shrink-0 place-items-center rounded-full bg-brand-100 text-[11px] font-bold text-brand-700">{i + 1}</span>
                  <span>{t}</span>
                </li>
              ))}
            </ol>
          </div>
          <div>
            <div className="mb-3 text-sm font-semibold">{problems.length ? `Worth a look (${problems.length})` : 'Checks'}</div>
            {problems.length ? (
              <div className="flex max-h-56 flex-col gap-2 overflow-y-auto">
                {problems.map((w) => (
                  <Notice key={w}>{w}</Notice>
                ))}
              </div>
            ) : (
              <Notice tone="good">No problems found.</Notice>
            )}
          </div>
        </div>
      </div>

      <h2 className="mt-10 mb-4 text-sm font-semibold text-slate-500">What's in the file</h2>
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-4">
        {sheets.map((sh) => (
          <div key={sh.index} className="card flex items-center gap-3 p-3">
            <SheetThumb sheet={sh} designs={designs} settings={settings} />
            <div className="min-w-0">
              <div className="text-sm font-semibold">Sheet {sh.index + 1}</div>
              <div className="text-xs text-slate-500">{sh.placements.length} stickers</div>
              <div className="truncate text-[11px] text-slate-400">{[...new Set(sh.placements.map((p) => designs[p.designId]?.name))].join(', ')}</div>
            </div>
          </div>
        ))}
      </div>
    </div>
  )
}

/** Small picture of a sheet: its cut lines. */
function SheetThumb(props: { sheet: StickerSheetLayout; designs: Record<string, ExportDesign>; settings: StickerSettings }) {
  const { settings } = props
  const W = settings.sheet.widthMm
  const H = settings.sheet.heightMm
  const d = useMemo(
    () =>
      props.sheet.placements
        .map((p) => {
          const des = props.designs[p.designId]
          if (!des) return ''
          const M = placementMatrix(p, des.bounds, settings)
          return des.cut.map((c) => svgPathData(mapPath(c, (x, y) => apply(M, x, y)), (x, y) => [x, H - y], 1)).join('')
        })
        .join(''),
    [props.sheet, props.designs, settings, H],
  )
  return (
    <svg viewBox={`0 0 ${W} ${H}`} style={{ height: 72, width: (72 * W) / H }} className="shrink-0">
      <rect width={W} height={H} rx={W * 0.02} fill="#fff" stroke="#e2e8f0" strokeWidth={W * 0.006} />
      <path d={d} fill="#f3f1ff" stroke={settings.cut.displayColor} strokeWidth={W * 0.004} />
    </svg>
  )
}
