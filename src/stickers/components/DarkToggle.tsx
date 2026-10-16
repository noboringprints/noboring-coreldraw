import type { ReactNode } from 'react'

/** Segmented control for the dark canvas toolbars. */
export default function DarkToggle<T extends string>(props: { value: T; onChange: (v: T) => void; options: { value: T; label: ReactNode; hint?: string }[]; 'aria-label'?: string }) {
  return (
    <div role="radiogroup" aria-label={props['aria-label']} className="inline-flex rounded-xl bg-white/10 p-0.5 backdrop-blur">
      {props.options.map((o) => {
        const on = o.value === props.value
        return (
          <button
            key={o.value}
            role="radio"
            aria-checked={on}
            title={o.hint}
            onClick={() => props.onChange(o.value)}
            className={`flex items-center gap-1.5 rounded-lg px-2.5 py-1 text-xs font-semibold whitespace-nowrap transition ${on ? 'bg-white text-slate-900 shadow-sm' : 'text-white/70 hover:text-white'}`}
          >
            {o.label}
          </button>
        )
      })}
    </div>
  )
}
