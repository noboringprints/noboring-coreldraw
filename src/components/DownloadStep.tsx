import { useState } from 'react'
import { CheckCircle2, Download, FileCheck2, Printer, RotateCcw } from 'lucide-react'
import type { PrintSettings } from '../config/defaults'
import { buildPrintPdf } from '../lib/exportPdf'
import type { ArtRef, Design, DesignCheck } from '../lib/job'
import type { Sheet } from '../lib/layout'
import { browserRasterizer } from '../lib/pdfRender'
import type { SourceFile } from '../lib/sources'
import { DESIGN_COLORS, Notice, SheetDiagram, fmtMm } from './ui'

export default function DownloadStep(props: {
  sheets: Sheet<ArtRef>[]
  sources: Record<string, SourceFile>
  settings: PrintSettings
  designs: Design[]
  checks: Record<string, DesignCheck>
  trimNames: Record<string, string>
}) {
  const { sheets, settings } = props
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [done, setDone] = useState<{ name: string; size: string } | null>(null)
  const colorOf = (id: string) => DESIGN_COLORS[Math.max(0, props.designs.findIndex((d) => d.id === id)) % DESIGN_COLORS.length]

  const problems = [
    ...props.designs.flatMap((d) => (props.checks[d.id]?.warnings ?? []).filter((w) => !w.startsWith('Bleed was added')).map((w) => `${d.name}: ${w}`)),
    ...sheets.flatMap((s) => s.warnings.map((w) => `Sheet ${s.index + 1}: ${w}`)),
  ]
  const pieces = sheets.reduce((n, s) => n + s.placements.length, 0)

  const download = async () => {
    setBusy(true)
    setError(null)
    try {
      const date = new Date()
      const fileName = `print-ready_${date.toISOString().slice(0, 10)}_${sheets.length}-sheets.pdf`
      const bytes = await buildPrintPdf(sheets, props.sources, settings, { date, trimNames: props.trimNames, title: fileName, rasterizer: browserRasterizer })
      const url = URL.createObjectURL(new Blob([bytes as BlobPart], { type: 'application/pdf' }))
      const a = document.createElement('a')
      a.href = url
      a.download = fileName
      a.click()
      setTimeout(() => URL.revokeObjectURL(url), 60_000)
      setDone({ name: fileName, size: `${(bytes.length / 1024 / 1024).toFixed(1)} MB` })
    } catch (e) {
      setError((e as Error).message)
    } finally {
      setBusy(false)
    }
  }

  const stats = [
    { label: 'Sheets', value: sheets.length },
    { label: 'Prints', value: pieces },
    { label: 'Designs', value: props.designs.length },
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
            <h1 className="mt-5 text-3xl font-bold tracking-tight">{done ? 'Downloaded!' : 'Ready to print'}</h1>
            <p className="mt-2 text-slate-500">
              {done ? (
                <>
                  Saved <b className="text-slate-700">{done.name}</b> ({done.size}). Send it straight to the printer.
                </>
              ) : (
                'One PDF with bleed, crop marks and every sheet laid out.'
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
              <button className="btn-primary btn-lg px-8 py-4 text-lg" disabled={busy || !sheets.length} onClick={download}>
                {busy ? (
                  <>
                    <span className="h-5 w-5 animate-spin rounded-full border-2 border-white/40 border-t-white" /> Making PDF…
                  </>
                ) : done ? (
                  <>
                    <RotateCcw size={20} /> Download again
                  </>
                ) : (
                  <>
                    <Download size={20} /> Download PDF
                  </>
                )}
              </button>
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
              <Printer size={16} className="text-brand-600" /> Before you print
            </div>
            <ul className="space-y-2 text-sm text-slate-600">
              {[
                <>
                  Print at <b>100 % / “Actual size”</b> – never “Fit to page”.
                </>,
                <>
                  Load <b>{settings.sheet.name}</b> paper ({fmtMm(settings.sheet.widthMm)} × {fmtMm(settings.sheet.heightMm)} mm).
                </>,
                <>Cut on the crop marks – the bleed is cut away.</>,
              ].map((t, i) => (
                <li key={i} className="flex gap-2.5">
                  <CheckCircle2 size={17} className="mt-0.5 shrink-0 text-emerald-500" />
                  <span>{t}</span>
                </li>
              ))}
            </ul>
          </div>
          <div>
            <div className="mb-3 text-sm font-semibold">{problems.length ? `Worth a look (${problems.length})` : 'Checks'}</div>
            {problems.length ? (
              <div className="flex max-h-48 flex-col gap-2 overflow-y-auto">
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
        {sheets.map((s) => (
          <div key={s.id} className="card flex items-center gap-3 p-3">
            <SheetDiagram sheetW={settings.sheet.widthMm} sheetH={settings.sheet.heightMm} bleed={settings.bleedMm} height={64} trims={s.placements.map((p) => ({ rect: p.trim, color: colorOf(p.item.designId) }))} />
            <div className="min-w-0">
              <div className="text-sm font-semibold">Sheet {s.index + 1}</div>
              <div className="text-xs text-slate-500">
                {props.trimNames[s.groupKey] ?? `${fmtMm(s.trimW)}×${fmtMm(s.trimH)}`} · {s.placements.length} up
              </div>
              <div className="truncate text-[11px] text-slate-400">{[...new Set(s.placements.map((p) => p.item.name))].join(', ')}</div>
            </div>
          </div>
        ))}
      </div>
    </div>
  )
}
