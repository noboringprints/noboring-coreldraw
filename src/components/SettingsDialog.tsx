import { useState, type ReactNode } from 'react'
import { Crop, FileText, LayoutGrid, RotateCcw, Ruler, StickyNote } from 'lucide-react'
import { DEFAULT_SETTINGS, MM_PER_INCH, SHEETS, cloneSettings, type MarkColor, type PrintSettings } from '../config/defaults'
import { settingsProblems } from '../lib/presets'
import { Drawer, NumberField, Notice, Segmented, Switch, fmtMm } from './ui'

function Section({ icon, title, children }: { icon: ReactNode; title: string; children: ReactNode }) {
  return (
    <section className="mb-7">
      <h3 className="mb-3 flex items-center gap-2 text-sm font-bold">
        <span className="grid h-7 w-7 place-items-center rounded-lg bg-brand-50 text-brand-600">{icon}</span>
        {title}
      </h3>
      <div className="flex flex-col gap-4 rounded-2xl bg-slate-50/70 p-4 ring-1 ring-slate-900/[0.04]">{children}</div>
    </section>
  )
}

function Row({ label, hint, children }: { label: string; hint?: string; children: ReactNode }) {
  return (
    <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-2">
      <div className="min-w-0 flex-1">
        <div className="text-sm font-semibold">{label}</div>
        {hint && <div className="text-xs leading-snug text-slate-500">{hint}</div>}
      </div>
      <div className="flex shrink-0 items-center gap-2">{children}</div>
    </div>
  )
}

export default function SettingsDialog(props: { settings: PrintSettings; onSave: (s: PrintSettings) => void; onClose: () => void }) {
  const [s, setS] = useState<PrintSettings>(() => cloneSettings(props.settings))
  const set = (patch: Partial<PrintSettings>) => setS({ ...s, ...patch })
  const setMarks = (patch: Partial<PrintSettings['marks']>) => setS({ ...s, marks: { ...s.marks, ...patch } })
  const sheetIdx = SHEETS.findIndex((x) => x.name === s.sheet.name)
  const problems = settingsProblems(s)

  return (
    <Drawer
      title="Print settings"
      subtitle="Saved on this computer. Check these with your printer once."
      onClose={props.onClose}
      footer={
        <div className="flex items-center gap-2">
          <button className="btn-ghost" onClick={() => setS(cloneSettings(DEFAULT_SETTINGS))}>
            <RotateCcw size={15} /> Defaults
          </button>
          <span className="flex-1" />
          <button className="btn-secondary" onClick={props.onClose}>
            Cancel
          </button>
          <button
            className="btn-primary"
            onClick={() => {
              props.onSave(s)
              props.onClose()
            }}
          >
            Save
          </button>
        </div>
      }
    >
      {problems.length > 0 && (
        <div className="mb-5 flex flex-col gap-2">
          {problems.map((p) => (
            <Notice key={p}>{p}</Notice>
          ))}
        </div>
      )}

      <Section icon={<FileText size={15} />} title="Paper">
        <Segmented
          full
          aria-label="Sheet size"
          value={sheetIdx >= 0 ? String(sheetIdx) : 'custom'}
          onChange={(v) => (v === 'custom' ? set({ sheet: { ...s.sheet, name: 'Custom' } }) : set({ sheet: SHEETS[Number(v)] }))}
          options={[...SHEETS.map((x, i) => ({ value: String(i), label: x.name })), { value: 'custom', label: 'Custom' }]}
        />
        {sheetIdx < 0 ? (
          <Row label="Custom size" hint={`${(s.sheet.widthMm / MM_PER_INCH).toFixed(2)} × ${(s.sheet.heightMm / MM_PER_INCH).toFixed(2)} inch`}>
            <NumberField aria-label="Sheet width" value={s.sheet.widthMm} min={50} max={3000} onChange={(n) => set({ sheet: { ...s.sheet, widthMm: n } })} suffix="mm" />
            <span className="text-slate-400">×</span>
            <NumberField aria-label="Sheet height" value={s.sheet.heightMm} min={50} max={3000} onChange={(n) => set({ sheet: { ...s.sheet, heightMm: n } })} suffix="mm" />
          </Row>
        ) : (
          <div className="text-xs text-slate-500">
            {fmtMm(s.sheet.widthMm)} × {fmtMm(s.sheet.heightMm)} mm – the PDF page is exactly this size.
          </div>
        )}
      </Section>

      <Section icon={<Crop size={15} />} title="Bleed & safe zone">
        <Row label="Bleed" hint="How far the design runs past the cut line">
          <NumberField value={s.bleedMm} min={0} max={20} onChange={(n) => set({ bleedMm: n })} suffix="mm" />
        </Row>
        <Row label="Safe zone" hint="Keep text this far inside the cut line">
          <NumberField value={s.safeZoneMm} min={0} max={30} onChange={(n) => set({ safeZoneMm: n })} suffix="mm" />
        </Row>
        <Row label="Automatic bleed for PDFs" hint="The design always stays sharp vector">
          <Segmented
            size="sm"
            value={s.bleedStrips}
            onChange={(v) => set({ bleedStrips: v })}
            options={[
              { value: 'image', label: 'Image strips', hint: 'Only the bleed strips are images (recommended)' },
              { value: 'vector', label: 'Vector', hint: 'Bleed made from vector copies' },
            ]}
          />
        </Row>
        {s.bleedStrips === 'image' && (
          <Row label="Strip resolution">
            <NumberField aria-label="Bleed strip resolution" value={s.bleedStripDpi} min={150} max={1200} onChange={(n) => set({ bleedStripDpi: n })} suffix="DPI" />
          </Row>
        )}
      </Section>

      <Section icon={<Ruler size={15} />} title="Crop marks">
        <Row label="Length">
          <NumberField value={s.marks.lengthMm} min={1} max={30} onChange={(n) => setMarks({ lengthMm: n })} suffix="mm" />
        </Row>
        <Row label="Gap from the cut corner" hint="Must be at least the bleed">
          <NumberField value={s.marks.offsetMm} min={0} max={30} onChange={(n) => setMarks({ offsetMm: n })} suffix="mm" />
        </Row>
        <Row label="Thickness" hint={`${((s.marks.lineWidthPt * MM_PER_INCH) / 72).toFixed(3)} mm`}>
          <NumberField value={s.marks.lineWidthPt} min={0.05} max={3} onChange={(n) => setMarks({ lineWidthPt: n })} suffix="pt" />
        </Row>
        <Row label="Colour">
          <Segmented
            size="sm"
            value={s.marks.color}
            onChange={(v) => setMarks({ color: v as MarkColor })}
            options={[
              { value: 'registration', label: 'Registration', hint: 'Prints on every plate (C+M+Y+K)' },
              { value: 'black', label: 'Black', hint: '100% K only' },
            ]}
          />
        </Row>
      </Section>

      <Section icon={<LayoutGrid size={15} />} title="Layout">
        <Row label="Sheet margin" hint="Empty space between the sheet edge and the artwork">
          <NumberField value={s.marginMm} min={0} max={100} onChange={(n) => set({ marginMm: n })} suffix="mm" />
        </Row>
        <Row label="Keep marks off the edge" hint="Marks and label never closer than this">
          <NumberField value={s.minEdgeMm} min={0} max={50} onChange={(n) => set({ minEdgeMm: n })} suffix="mm" />
        </Row>
        <Row label="Gap between copies" hint="0 = bleeds touch (fits the most)">
          <NumberField value={s.gutterMm} min={0} max={100} onChange={(n) => set({ gutterMm: n })} suffix="mm" />
        </Row>
      </Section>

      <Section icon={<StickyNote size={15} />} title="Extras">
        <Row label="Sheet label" hint="Names, size, sheet number and date in the margin">
          <Switch checked={s.label.enabled} onChange={(v) => set({ label: { ...s.label, enabled: v } })} />
          {s.label.enabled && <NumberField value={s.label.fontSizePt} min={4} max={14} onChange={(n) => set({ label: { ...s.label, fontSizePt: n } })} suffix="pt" />}
        </Row>
        <Row label="Low-resolution warning" hint="Warn when a photo prints below this">
          <NumberField value={s.minDpi} min={50} max={1200} onChange={(n) => set({ minDpi: n })} suffix="DPI" />
        </Row>
      </Section>
    </Drawer>
  )
}
