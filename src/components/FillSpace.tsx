/** "Fill the empty space" panel: add another file of the same size, or print one more of a panel/design already in the job. */
import { useRef } from 'react'
import { Copy, Plus, Upload, X } from 'lucide-react'
import { designPages, type Design } from '../lib/job'
import { groupKey } from '../lib/layout'
import type { SourceFile } from '../lib/sources'
import { fmtMm } from './ui'

export interface FillTarget {
  /** Size group of the sheet with the empty space. */
  groupKey: string
  trimName: string
  trimW: number
  trimH: number
  /** How many spaces are empty. */
  free: number
}

export default function FillSpace(props: {
  target: FillTarget
  designs: Design[]
  sources: Record<string, SourceFile>
  thumbs?: Record<string, string>
  onAddFiles: (files: File[], trim: { name: string; w: number; h: number }) => void
  onRepeat: (designId: string, pageIndex: number) => void
  onClose?: () => void
  /** Fill the parent's width (embedded in a card) instead of a floating popover. */
  wide?: boolean
}) {
  const { target } = props
  const input = useRef<HTMLInputElement>(null)
  const size = `${target.trimName !== 'Custom' ? target.trimName + ' · ' : ''}${fmtMm(Math.max(target.trimW, target.trimH))} × ${fmtMm(Math.min(target.trimW, target.trimH))} mm`
  // designs of the same size, main ones first (repeats are listed under their original)
  const same = props.designs.filter((d) => groupKey(d.trimW, d.trimH) === target.groupKey && props.sources[d.sourceId])
  const seen = new Set<string>()
  const originals = same.filter((d) => {
    if (!d.split && same.some((o) => o.split && o.sourceId === d.sourceId)) return false
    const k = `${d.sourceId}:${d.split ? 'all' : d.pageIndex}`
    if (seen.has(k)) return false
    seen.add(k)
    return true
  })

  return (
    <div className={`${props.wide ? 'w-full ring-1 ring-slate-200' : 'w-[340px] max-w-[calc(100vw-32px)] shadow-lift'} rounded-2xl bg-white p-4 text-slate-800`}>
      <div className="flex items-start gap-2">
        <div className="min-w-0 flex-1">
          <div className="text-sm font-semibold">
            Fill {target.free === 1 ? 'the empty space' : `${target.free} empty spaces`}
          </div>
          <div className="text-xs text-slate-500">{size}</div>
        </div>
        {props.onClose && (
          <button className="btn-icon btn-ghost -mt-1 -mr-1 h-8 w-8 rounded-full" onClick={props.onClose} aria-label="Close">
            <X size={16} />
          </button>
        )}
      </div>

      <button className="btn-primary mt-3 w-full justify-center rounded-xl py-2.5" onClick={() => input.current?.click()}>
        <Upload size={16} /> Add another file ({target.trimName !== 'Custom' ? target.trimName : 'same size'})
      </button>
      <input
        ref={input}
        type="file"
        multiple
        accept=".pdf,.png,.jpg,.jpeg,application/pdf,image/png,image/jpeg"
        className="hidden"
        onChange={(e) => {
          const files = [...(e.target.files ?? [])]
          e.target.value = ''
          if (files.length) {
            props.onAddFiles(files, { name: target.trimName, w: target.trimW, h: target.trimH })
            props.onClose?.()
          }
        }}
      />
      <p className="mt-1.5 text-[11px] leading-snug text-slate-400">A split poster PDF (one panel per page) is split automatically and its panels fill the free spaces first.</p>

      {originals.length > 0 && (
        <>
          <div className="mt-4 mb-2 flex items-center gap-2 text-[11px] font-semibold tracking-wider text-slate-400 uppercase">
            <Copy size={12} /> Or print one more of
          </div>
          <div className="flex max-h-56 flex-col gap-2 overflow-y-auto">
            {originals.map((d) => {
              const src = props.sources[d.sourceId]
              const pages = designPages(d, src).map((p) => p.index)
              return (
                <div key={d.id} className="flex items-center gap-2.5 rounded-xl bg-slate-50 p-2">
                  {props.thumbs?.[src.id] ? (
                    <img src={props.thumbs[src.id]} alt="" className="h-9 w-9 shrink-0 rounded-md bg-white object-contain" />
                  ) : (
                    <span className="h-9 w-9 shrink-0 rounded-md bg-slate-200" />
                  )}
                  <div className="min-w-0 flex-1">
                    <div className="truncate text-xs font-semibold">{d.name}</div>
                    <div className="mt-1 flex flex-wrap gap-1">
                      {pages.map((pi) => (
                        <button
                          key={pi}
                          className="btn rounded-full bg-white px-2 py-0.5 text-[11px] text-slate-700 ring-1 ring-slate-200 hover:bg-brand-50 hover:text-brand-700 hover:ring-brand-300"
                          title={d.split ? `Print panel ${pi + 1} once more` : 'Print one more copy'}
                          onClick={() => {
                            props.onRepeat(d.id, pi)
                            if (target.free <= 1) props.onClose?.()
                          }}
                        >
                          <Plus size={11} /> {d.split ? `Panel ${pi + 1}` : '1 copy'}
                        </button>
                      ))}
                    </div>
                  </div>
                </div>
              )
            })}
          </div>
        </>
      )}
    </div>
  )
}
