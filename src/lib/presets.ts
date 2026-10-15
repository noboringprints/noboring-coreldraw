/** Named setups that can be applied in one click. Built-in ones + ones the operator saves (kept in this browser). */
import { DEFAULT_SETTINGS, SHEETS, TRIM_SIZES, cloneSettings, type PrintSettings } from '../config/defaults'

export interface Preset {
  id: string
  name: string
  builtIn?: boolean
  settings: PrintSettings
  /** Trim size applied to every design (portrait; designs keep their own orientation). */
  trim: { name: string; w: number; h: number } | null
  /** Force at most this many copies per sheet (undefined = as many as fit). */
  maxPerSheet?: number
  /** Turn multi-page PDFs into split posters. */
  split?: boolean
}

const onSheet = (sheetIndex: number): PrintSettings => {
  const s = cloneSettings(DEFAULT_SETTINGS)
  s.sheet = SHEETS[sheetIndex]
  return s
}
const trim = (name: string) => {
  const t = TRIM_SIZES.find((x) => x.name === name)!
  return { name: t.name, w: t.widthMm, h: t.heightMm }
}

export const BUILT_IN_PRESETS: Preset[] = [
  { id: 'bi-a4', name: 'A4 posters – 13×19', builtIn: true, settings: onSheet(0), trim: trim('A4') },
  { id: 'bi-a3', name: 'A3 single – 13×19', builtIn: true, settings: onSheet(0), trim: trim('A3'), maxPerSheet: 1 },
  { id: 'bi-a5', name: 'A5 pack – 13×19', builtIn: true, settings: onSheet(0), trim: trim('A5') },
  { id: 'bi-split', name: 'Split poster (A4 panels) – 13×19', builtIn: true, settings: onSheet(0), trim: trim('A4'), split: true },
]

const KEY_PRESETS = 'print-ready.presets.v1'
// v2: defaults changed to no bleed + 8 mm gap; settings saved under v1 are not reused
const KEY_SETTINGS = 'print-ready.settings.v2'

function read<T>(key: string, fallback: T): T {
  try {
    const raw = localStorage.getItem(key)
    return raw ? (JSON.parse(raw) as T) : fallback
  } catch {
    return fallback
  }
}
function write(key: string, value: unknown) {
  try {
    localStorage.setItem(key, JSON.stringify(value))
  } catch {
    /* storage unavailable – settings just won't be remembered */
  }
}

export const loadUserPresets = (): Preset[] => read<Preset[]>(KEY_PRESETS, [])
export const saveUserPresets = (p: Preset[]) => write(KEY_PRESETS, p)

/** Saved settings, merged over the defaults so new setting fields always have a value. */
export function loadSettings(): PrintSettings {
  const saved = read<Partial<PrintSettings> | null>(KEY_SETTINGS, null)
  const d = cloneSettings(DEFAULT_SETTINGS)
  if (!saved) return d
  return { ...d, ...saved, marks: { ...d.marks, ...saved.marks }, label: { ...d.label, ...saved.label }, sheet: saved.sheet ?? d.sheet }
}
export const saveSettings = (s: PrintSettings) => write(KEY_SETTINGS, s)

/** Problems with a settings combination, in plain English. */
export function settingsProblems(s: PrintSettings): string[] {
  const out: string[] = []
  if (s.marks.offsetMm < s.bleedMm)
    out.push(`Crop mark offset (${s.marks.offsetMm} mm) is smaller than the bleed (${s.bleedMm} mm), so marks would sit on the artwork. They will be left out.`)
  if (s.minEdgeMm > s.marginMm) out.push('"Keep away from sheet edge" is larger than the margin.')
  if (s.sheet.widthMm <= 0 || s.sheet.heightMm <= 0) out.push('Sheet size must be larger than 0.')
  if (s.marks.lineWidthPt <= 0) out.push('Crop mark thickness must be larger than 0.')
  return out
}
