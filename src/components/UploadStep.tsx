import { useEffect, useRef, useState } from 'react'
import { FileStack, Layers, Lock, Plus, Scissors, Sparkles, UploadCloud, X } from 'lucide-react'
import type { PrintSettings } from '../config/defaults'
import type { Design, DesignCheck } from '../lib/job'
import type { SourceFile } from '../lib/sources'
import { Badge, Notice, Thumb, detectedSizeText } from './ui'

const ACCEPT = '.pdf,.png,.jpg,.jpeg,application/pdf,image/png,image/jpeg'

export default function UploadStep(props: {
  designs: Design[]
  sources: Record<string, SourceFile>
  thumbs: Record<string, string>
  checks: Record<string, DesignCheck>
  settings: PrintSettings
  loading: boolean
  errors: string[]
  onFiles: (files: File[]) => void
  onRemove: (id: string) => void
}) {
  const input = useRef<HTMLInputElement>(null)
  const [dragging, setDragging] = useState(false)
  const pick = () => input.current?.click()

  // drop files anywhere on the page
  useEffect(() => {
    let depth = 0
    const enter = (e: DragEvent) => {
      if (!e.dataTransfer?.types.includes('Files')) return
      depth++
      setDragging(true)
    }
    const leave = () => {
      depth = Math.max(0, depth - 1)
      if (!depth) setDragging(false)
    }
    const over = (e: DragEvent) => e.preventDefault()
    const drop = (e: DragEvent) => {
      e.preventDefault()
      depth = 0
      setDragging(false)
      if (e.dataTransfer?.files.length) props.onFiles([...e.dataTransfer.files])
    }
    window.addEventListener('dragenter', enter)
    window.addEventListener('dragleave', leave)
    window.addEventListener('dragover', over)
    window.addEventListener('drop', drop)
    return () => {
      window.removeEventListener('dragenter', enter)
      window.removeEventListener('dragleave', leave)
      window.removeEventListener('dragover', over)
      window.removeEventListener('drop', drop)
    }
  }, [props])

  const fileInput = (
    <input
      ref={input}
      type="file"
      multiple
      accept={ACCEPT}
      className="hidden"
      onChange={(e) => {
        props.onFiles([...(e.target.files ?? [])])
        e.target.value = ''
      }}
    />
  )

  const empty = props.designs.length === 0

  return (
    <div className="mx-auto w-full max-w-6xl px-5 py-8">
      {fileInput}

      {dragging && (
        <div className="pointer-events-none fixed inset-0 z-40 grid place-items-center bg-brand-600/10 p-6 backdrop-blur-sm">
          <div className="grid h-full w-full place-items-center rounded-[2rem] border-2 border-dashed border-brand-400 bg-white/60">
            <div className="text-center">
              <UploadCloud size={48} className="mx-auto text-brand-600" />
              <div className="mt-3 text-2xl font-bold text-brand-800">Drop to add</div>
            </div>
          </div>
        </div>
      )}

      {empty ? (
        <div className="animate-fade-up">
          <div className="mx-auto max-w-2xl text-center">
            <h1 className="text-3xl font-bold tracking-tight text-balance sm:text-4xl">Make your posters print‑ready</h1>
            <p className="mt-3 text-lg text-slate-500">Bleed, crop marks and the best layout on the sheet – done for you in seconds.</p>
          </div>

          <button
            onClick={pick}
            className="group mt-10 flex w-full flex-col items-center rounded-[2rem] border-2 border-dashed border-slate-300 bg-white px-6 py-16 text-center transition hover:border-brand-400 hover:bg-brand-50/40"
          >
            <span className="grid h-20 w-20 place-items-center rounded-3xl bg-gradient-to-br from-brand-500 to-brand-700 text-white shadow-[0_10px_30px_rgb(91_47_245/0.35)] transition group-hover:scale-105">
              <UploadCloud size={36} />
            </span>
            <span className="mt-6 text-xl font-bold">Drop your designs here</span>
            <span className="mt-1 text-slate-500">PDF, PNG or JPG · as many as you like</span>
            <span className="btn-primary btn-lg mt-6">
              <Plus size={18} /> Choose files
            </span>
          </button>

          <div className="mt-8 grid gap-3 sm:grid-cols-3">
            {[
              { icon: <Lock size={18} />, title: 'Private', text: 'Files never leave this computer.' },
              { icon: <Sparkles size={18} />, title: 'Sharp', text: 'PDFs stay vector – no quality loss.' },
              { icon: <Scissors size={18} />, title: 'Ready to cut', text: 'Bleed and crop marks added for you.' },
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
              <h1 className="text-2xl font-bold tracking-tight">Your designs</h1>
              <p className="mt-1 text-slate-500">
                {props.designs.length} file{props.designs.length === 1 ? '' : 's'} added. Add more, or continue to choose sizes.
              </p>
            </div>
            <button className="btn-secondary" onClick={pick}>
              <Plus size={16} /> Add files
            </button>
          </div>

          <div className="grid grid-cols-2 gap-4 sm:grid-cols-3 lg:grid-cols-4">
            {props.designs.map((d, i) => {
              const src = props.sources[d.sourceId]
              if (!src) return null
              const c = props.checks[d.id]
              return (
                <div key={d.id} className="group card relative animate-fade-up p-3" style={{ animationDelay: `${i * 40}ms` }}>
                  <Thumb url={props.thumbs[src.id]} alt={d.name} size="lg" />
                  <button
                    onClick={() => props.onRemove(d.id)}
                    aria-label={`Remove ${d.name}`}
                    className="absolute top-5 right-5 grid h-8 w-8 place-items-center rounded-full bg-white/90 text-slate-500 opacity-0 shadow-sm ring-1 ring-slate-900/5 transition group-hover:opacity-100 hover:text-red-600 focus:opacity-100"
                  >
                    <X size={16} />
                  </button>
                  <div className="px-1 pt-3 pb-1">
                    <div className="truncate font-semibold" title={src.name}>
                      {d.name}
                    </div>
                    <div className="mt-0.5 truncate text-xs text-slate-500">{detectedSizeText(src, 0, props.settings.bleedMm)}</div>
                    <div className="mt-2.5 flex flex-wrap gap-1.5">
                      {src.pages.length > 1 && (
                        <Badge tone="neutral" icon={<FileStack size={12} />}>
                          {src.pages.length} pages
                        </Badge>
                      )}
                      {c?.hasBleed ? <Badge tone="good">Has bleed</Badge> : <Badge tone="brand">Bleed added for you</Badge>}
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
        {props.loading && (
          <div className="flex items-center gap-2 text-sm text-slate-500">
            <span className="h-4 w-4 animate-spin rounded-full border-2 border-slate-300 border-t-brand-500" /> Reading files…
          </div>
        )}
        {props.errors.map((e) => (
          <Notice key={e}>{e}</Notice>
        ))}
      </div>

      {!empty && (
        <p className="mt-8 flex items-center justify-center gap-2 text-xs text-slate-400">
          <Layers size={14} /> Tip: for a split poster, upload one PDF with one panel per page.
        </p>
      )}
    </div>
  )
}
