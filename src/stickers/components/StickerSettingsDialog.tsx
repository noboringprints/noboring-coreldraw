import { useState } from 'react'
import { Crop, FileText, LayoutGrid, RotateCcw, Scissors, StickyNote, Target } from 'lucide-react'
import { MM_PER_INCH } from '../../config/defaults'
import { Drawer, NumberField, Notice, Segmented, Switch, fmtMm } from '../../components/ui'
import { DEFAULT_STICKER_SETTINGS, type MarkStyle, STICKER_SHEETS, type StickerSettings, cloneStickerSettings, contentInsetMm, stickerSettingsProblems } from '../config'
import { Row, Section } from './CutStep'

export default function StickerSettingsDialog(props: {
  settings: StickerSettings
  onSave: (s: StickerSettings) => void
  onClose: () => void
  /** What the tool calls one piece, e.g. 'sticker'. */
  noun?: string
  paperName?: string
  defaults?: StickerSettings
}) {
  const noun = props.noun ?? 'sticker'
  const defaults = props.defaults ?? DEFAULT_STICKER_SETTINGS
  const [s, setS] = useState<StickerSettings>(() => cloneStickerSettings(props.settings))
  const set = (patch: Partial<StickerSettings>) => setS({ ...s, ...patch })
  const setMarks = (patch: Partial<StickerSettings['marks']>) => setS({ ...s, marks: { ...s.marks, ...patch } })
  const setCut = (patch: Partial<StickerSettings['cut']>) => setS({ ...s, cut: { ...s.cut, ...patch } })
  const sheetIdx = STICKER_SHEETS.findIndex((x) => x.name === s.sheet.name)
  const problems = stickerSettingsProblems(s)
  const m = s.marks.style

  return (
    <Drawer
      title="Sheet & cutter settings"
      subtitle="Saved on this computer. Check the marks once against your cutter."
      onClose={props.onClose}
      footer={
        <div className="flex items-center gap-2">
          <button className="btn-ghost" onClick={() => setS({ ...cloneStickerSettings(defaults), units: s.units })}>
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

      <Section icon={<FileText size={15} />} title={props.paperName ?? 'Sticker paper'}>
        <Segmented
          full
          aria-label="Sheet size"
          value={sheetIdx >= 0 ? String(sheetIdx) : 'custom'}
          onChange={(v) => (v === 'custom' ? set({ sheet: { ...s.sheet, name: 'Custom' } }) : set({ sheet: STICKER_SHEETS[Number(v)] }))}
          options={[...STICKER_SHEETS.map((x, i) => ({ value: String(i), label: x.name })), { value: 'custom', label: 'Custom' }]}
        />
        {sheetIdx < 0 ? (
          <Row label="Custom size" hint={`${(s.sheet.widthMm / MM_PER_INCH).toFixed(2)} × ${(s.sheet.heightMm / MM_PER_INCH).toFixed(2)} inch`}>
            <NumberField aria-label="Sheet width" value={s.sheet.widthMm} min={50} max={2000} onChange={(n) => set({ sheet: { ...s.sheet, widthMm: n } })} suffix="mm" />
            <span className="text-slate-400">×</span>
            <NumberField aria-label="Sheet height" value={s.sheet.heightMm} min={50} max={5000} onChange={(n) => set({ sheet: { ...s.sheet, heightMm: n } })} suffix="mm" />
          </Row>
        ) : (
          <div className="text-xs text-slate-500">
            {fmtMm(s.sheet.widthMm)} × {fmtMm(s.sheet.heightMm)} mm – the PDF page is exactly this size.
          </div>
        )}
        <Row label="Margin" hint="Empty edge of the sheet, outside the marks">
          <NumberField value={s.marginMm} min={0} max={60} onChange={(n) => set({ marginMm: n })} suffix="mm" />
        </Row>
      </Section>

      <Section icon={<Target size={15} />} title="Registration marks">
        <Segmented
          full
          size="sm"
          aria-label="Mark style"
          value={m}
          onChange={(v) => setMarks({ style: v as MarkStyle })}
          options={[
            { value: 'l-corners', label: 'L corners', hint: 'Graphtec ARMS type 1 style and most cutters' },
            { value: 'squares', label: 'Squares', hint: 'Filled squares in the corners' },
            { value: 'silhouette', label: 'Silhouette', hint: 'Square top-left + L corners' },
            { value: 'none', label: 'None', hint: 'Die / laser cutting, no optical sensor' },
          ]}
        />
        {(m === 'l-corners' || m === 'silhouette') && (
          <>
            <Row label="Arm length">
              <NumberField value={s.marks.lengthMm} min={3} max={50} onChange={(n) => setMarks({ lengthMm: n })} suffix="mm" />
            </Row>
            <Row label="Line thickness">
              <NumberField value={s.marks.thicknessMm} min={0.1} max={3} onChange={(n) => setMarks({ thicknessMm: n })} suffix="mm" />
            </Row>
          </>
        )}
        {(m === 'squares' || m === 'silhouette') && (
          <Row label="Square size">
            <NumberField value={s.marks.sizeMm} min={2} max={20} onChange={(n) => setMarks({ sizeMm: n })} suffix="mm" />
          </Row>
        )}
        {m !== 'none' && (
          <Row label="Clearance" hint={`Free space between marks and ${noun}s`}>
            <NumberField value={s.marks.clearanceMm} min={0} max={50} onChange={(n) => setMarks({ clearanceMm: n })} suffix="mm" />
          </Row>
        )}
        <div className="text-xs text-slate-500"><span className="capitalize">{noun}s</span> stay at least {fmtMm(contentInsetMm(s))} mm from the sheet edge.</div>
      </Section>

      <Section icon={<LayoutGrid size={15} />} title="Spacing & bleed">
        <Row label={`Gap between ${noun}s`} hint="Between neighbouring cut lines">
          <NumberField value={s.gapMm} min={0} max={30} onChange={(n) => set({ gapMm: n })} suffix="mm" />
        </Row>
        <Row label="Bleed" hint="Printed past the cut line for coloured borders and edge-to-edge designs">
          <NumberField value={s.bleedMm} min={0} max={5} onChange={(n) => set({ bleedMm: n })} suffix="mm" />
        </Row>
      </Section>

      <Section icon={<Scissors size={15} />} title="Cut line">
        <Row label="Spot colour name" hint="What your RIP / cutter software looks for">
          <input className="field w-40" value={s.cut.spotName} onChange={(e) => setCut({ spotName: e.target.value })} aria-label="Spot colour name" />
        </Row>
        <Row label="Line thickness">
          <NumberField value={s.cut.lineWidthPt} min={0.05} max={3} onChange={(n) => setCut({ lineWidthPt: n })} suffix="pt" />
        </Row>
        <Row label="Shown as" hint="Only how it looks on screen / in viewers">
          <input type="color" aria-label="Cut line display colour" className="h-9 w-14 cursor-pointer rounded-lg border-0 bg-transparent" value={s.cut.displayColor} onChange={(e) => setCut({ displayColor: e.target.value })} />
        </Row>
      </Section>

      <Section icon={<Crop size={15} />} title="Units">
        <Segmented
          full
          value={s.units}
          onChange={(v) => set({ units: v })}
          options={[
            { value: 'in', label: 'Inches' },
            { value: 'mm', label: 'Millimetres' },
          ]}
        />
      </Section>

      <Section icon={<StickyNote size={15} />} title="Extras">
        <Row label="Sheet label" hint="Sheet number, size and date in the bottom margin">
          <Switch checked={s.label} onChange={(v) => set({ label: v })} />
        </Row>
        <Row label="Low-resolution warning" hint={`Warn when a ${noun} prints below this`}>
          <NumberField value={s.minDpi} min={50} max={1200} onChange={(n) => set({ minDpi: n })} suffix="DPI" />
        </Row>
      </Section>
    </Drawer>
  )
}
