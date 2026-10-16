import { Suspense, lazy, useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { PrintSettings } from './config/defaults'
import { detectBleed, planArtwork, sizeMatches, suggestTrim } from './lib/artwork'
import { buildItems, checkDesign, type Design, type DesignCheck } from './lib/job'
import { groupKey, layoutJob, type PlacementOverride } from './lib/layout'
import { edgeTextWarning, textNearEdge } from './lib/textCheck'
import { type Preset, loadSettings, loadUserPresets, saveSettings, saveUserPresets } from './lib/presets'
import { type SourceFile, newId, readSource } from './lib/sources'
import Header, { ActionBar, type Step } from './components/Header'
import { ToastHost } from './components/ui'
import UploadStep from './components/UploadStep'
import SizeStep from './components/SizeStep'
import SettingsDialog from './components/SettingsDialog'

// pdf.js and the preview / download screens are loaded on demand, so the app opens faster
const pdfRender = () => import('./lib/pdfRender')
const loadPreview = () => import('./components/PreviewStep')
const loadDownload = () => import('./components/DownloadStep')
const PreviewStep = lazy(loadPreview)
const DownloadStep = lazy(loadDownload)

/**
 * Re-runs automatic bleed detection for a design.
 * A hand-picked mode is kept – except 'File already has bleed', which is only allowed while the file really has it.
 */
function redetect(d: Design, src: SourceFile | undefined, s: PrintSettings): Design {
  if (!src) return d
  const pages = d.split ? src.pages : [src.pages[d.pageIndex] ?? src.pages[0]]
  const dets = pages.map((p) => detectBleed(p.geometry, d.trimW, d.trimH, s.bleedMm))
  const hasBleed = dets.every((x) => x.hasBleed)
  const fallback = s.bleedMm > 0 ? 'mirror' : 'none'
  if (d.bleedAuto) return { ...d, bleedMode: hasBleed ? 'included' : fallback }
  if (d.bleedMode === 'included' && !hasBleed) return { ...d, bleedMode: fallback, bleedAuto: true }
  return d
}

export default function App() {
  const [step, setStep] = useState<Step>('upload')
  const [settings, setSettingsState] = useState<PrintSettings>(loadSettings)
  const [sources, setSources] = useState<Record<string, SourceFile>>({})
  const [thumbs, setThumbs] = useState<Record<string, string>>({})
  const [designs, setDesigns] = useState<Design[]>([])
  const [maxPerSheet, setMaxPerSheet] = useState<Record<string, number | undefined>>({})
  const [overrides, setOverrides] = useState<Record<string, PlacementOverride | undefined>>({})
  const [userPresets, setUserPresets] = useState<Preset[]>(loadUserPresets)
  const [showSettings, setShowSettings] = useState(false)
  const [errors, setErrors] = useState<string[]>([])
  const [loading, setLoading] = useState(0)

  const setSettings = useCallback(
    (s: PrintSettings) => {
      setSettingsState(s)
      saveSettings(s)
      setDesigns((ds) => ds.map((d) => redetect(d, sources[d.sourceId], s)))
    },
    [sources],
  )

  // ---------- derived ----------
  const items = useMemo(() => buildItems(designs, sources), [designs, sources])
  const sheets = useMemo(() => layoutJob(items, settings, { maxPerSheet, overrides }), [items, settings, maxPerSheet, overrides])
  // text close to the cut line (PDFs only; runs in the background with pdf.js)
  const [edgeText, setEdgeText] = useState<Record<string, string | null>>({})
  const edgeKey = JSON.stringify(designs.map((d) => [d.id, d.sourceId, d.split, d.pageIndex, d.trimW, d.trimH, d.bleedMode, d.fit]).concat([[settings.bleedMm, settings.safeZoneMm]]))
  useEffect(() => {
    let cancelled = false
    ;(async () => {
      const out: Record<string, string | null> = {}
      for (const d of designs) {
        const src = sources[d.sourceId]
        if (!src || src.kind !== 'pdf') continue
        const found = []
        for (const p of d.split ? src.pages : [src.pages[d.pageIndex] ?? src.pages[0]]) {
          try {
            const plan = planArtwork(p.geometry, d.trimW, d.trimH, settings.bleedMm, d.bleedMode, d.fit)
            found.push(...textNearEdge(await (await pdfRender()).pdfTextItems(src.bytes, p.index), p, plan, d.trimW, d.trimH, settings.safeZoneMm))
          } catch {
            /* unreadable text layer – skip the check */
          }
        }
        out[d.id] = edgeTextWarning(found.sort((a, b) => a.distanceMm - b.distanceMm), settings.safeZoneMm)
      }
      if (!cancelled) setEdgeText(out)
    })()
    return () => {
      cancelled = true
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [edgeKey, sources])

  const checks = useMemo(() => {
    const out: Record<string, DesignCheck> = {}
    for (const d of designs) {
      if (!sources[d.sourceId]) continue
      const c = checkDesign(d, sources[d.sourceId], settings)
      const t = edgeText[d.id]
      if (t) c.warnings.push(t)
      else if (sources[d.sourceId].kind !== 'pdf') c.notes = ['Images can’t be checked for text near the edge – look at the safe zone in the preview.']
      out[d.id] = c
    }
    return out
  }, [designs, sources, settings, edgeText])
  const trimNames = useMemo(() => {
    const out: Record<string, string> = {}
    for (const d of designs) if (d.trimName !== 'Custom') out[groupKey(d.trimW, d.trimH)] = d.trimName
    return out
  }, [designs])

  // Manual moves belong to a particular layout; when the layout inputs change, start fresh.
  const layoutInputs = JSON.stringify([items.map((i) => [i.id, i.trimW, i.trimH]), settings, maxPerSheet])
  const lastInputs = useRef(layoutInputs)
  useEffect(() => {
    if (lastInputs.current !== layoutInputs) {
      lastInputs.current = layoutInputs
      setOverrides({})
    }
  }, [layoutInputs])

  // ---------- actions ----------
  /**
   * Adds uploaded files as designs. Multi-page PDFs whose pages are all the same size become split posters.
   * `trim` (optional) forces the size, e.g. when filling an empty space on a sheet of that size.
   */
  const addFiles = useCallback(
    async (files: File[], trim?: { name: string; w: number; h: number }) => {
      setErrors([])
      setLoading((n) => n + files.length)
      for (const f of files) {
        try {
          const bytes = new Uint8Array(await f.arrayBuffer())
          const src = await readSource(f.name, bytes)
          const g = src.pages[0].geometry
          let t = suggestTrim(g, settings.bleedMm, f.name)
          if (trim) {
            // same size as the space being filled, in the file's own orientation
            const short = Math.min(trim.w, trim.h)
            const long = Math.max(trim.w, trim.h)
            const land = g.widthMm > g.heightMm
            t = { name: trim.name, w: land ? long : short, h: land ? short : long }
          }
          const det = detectBleed(g, t.w, t.h, settings.bleedMm)
          const samePages = src.pages.every((p) => Math.abs(p.geometry.widthMm - g.widthMm) < 1 && Math.abs(p.geometry.heightMm - g.heightMm) < 1)
          const design: Design = {
            id: newId('d'),
            sourceId: src.id,
            name: f.name.replace(/\.(pdf|png|jpe?g)$/i, ''),
            trimName: t.name,
            trimW: t.w,
            trimH: t.h,
            copies: 1,
            bleedMode: det.mode,
            fit: 'fit',
            bleedAuto: true,
            split: src.pages.length > 1 && samePages,
            pageIndex: 0,
          }
          setSources((s) => ({ ...s, [src.id]: src }))
          setDesigns((ds) => [...ds, design])
          pdfRender()
            .then((m) => m.thumbnail(src.kind, src.bytes))
            .then((url) => setThumbs((t) => ({ ...t, [src.id]: url })))
            .catch(() => {})
        } catch (e) {
          setErrors((er) => [...er, (e as Error).message])
        } finally {
          setLoading((n) => n - 1)
        }
      }
    },
    [settings.bleedMm],
  )

  const updateDesign = useCallback(
    (id: string, patch: Partial<Design>) =>
      setDesigns((ds) =>
        ds.map((d) => {
          if (d.id !== id) return d
          const next = { ...d, ...patch }
          if ('bleedMode' in patch) next.bleedAuto = false
          return redetect(next, sources[d.sourceId], settings)
        }),
      ),
    [sources, settings],
  )

  /** Prints one more copy of a design (or of one panel of a split poster), e.g. to fill an empty space. */
  const repeatPanel = useCallback((designId: string, pageIndex: number) => {
    setDesigns((ds) => {
      const d = ds.find((x) => x.id === designId)
      if (!d) return ds
      const extra: Design = {
        ...d,
        id: newId('d'),
        name: d.split ? `${d.name} – panel ${pageIndex + 1}` : d.name,
        copies: 1,
        split: false,
        pageIndex,
      }
      return [...ds, extra]
    })
  }, [])

  const removeDesign = useCallback((id: string) => setDesigns((ds) => ds.filter((d) => d.id !== id)), [])

  const applyPreset = useCallback(
    (p: Preset) => {
      const s = JSON.parse(JSON.stringify(p.settings)) as PrintSettings
      setSettingsState(s)
      saveSettings(s)
      setDesigns((ds) =>
        ds.map((d) => {
          let next = { ...d }
          const src = sources[d.sourceId]
          if (p.split !== undefined && src && src.pages.length > 1) next.split = p.split
          // a design that already is the preset's size keeps its own exact size (printed 1:1, not rescaled)
          if (p.trim && !sizeMatches(d.trimW, d.trimH, p.trim.w, p.trim.h)) {
            const landscape = d.trimW > d.trimH
            const short = Math.min(p.trim.w, p.trim.h)
            const long = Math.max(p.trim.w, p.trim.h)
            next = { ...next, trimName: p.trim.name, trimW: landscape ? long : short, trimH: landscape ? short : long }
          }
          return redetect(next, src, s)
        }),
      )
      if (p.trim) setMaxPerSheet((m) => ({ ...m, [groupKey(p.trim!.w, p.trim!.h)]: p.maxPerSheet }))
    },
    [sources],
  )

  const savePreset = useCallback(
    (name: string) => {
      const first = designs[0]
      const key = first ? groupKey(first.trimW, first.trimH) : ''
      const p: Preset = {
        id: newId('p'),
        name,
        settings: JSON.parse(JSON.stringify(settings)),
        trim: first ? { name: first.trimName, w: Math.min(first.trimW, first.trimH), h: Math.max(first.trimW, first.trimH) } : null,
        maxPerSheet: key ? maxPerSheet[key] : undefined,
        split: first ? first.split : undefined,
      }
      const list = [...userPresets, p]
      setUserPresets(list)
      saveUserPresets(list)
    },
    [designs, settings, maxPerSheet, userPresets],
  )

  const deletePreset = useCallback(
    (id: string) => {
      const list = userPresets.filter((p) => p.id !== id)
      setUserPresets(list)
      saveUserPresets(list)
    },
    [userPresets],
  )

  const hasDesigns = designs.length > 0
  // fetch the next screens in the background once there is something to show
  useEffect(() => {
    if (hasDesigns) void Promise.all([loadPreview(), loadDownload()]).catch(() => {})
  }, [hasDesigns])
  const prints = sheets.reduce((n, s) => n + s.placements.length, 0)
  const toCheck = designs.reduce((n, d) => n + (checks[d.id]?.warnings.filter((w) => !w.startsWith('Bleed was added')).length ?? 0), 0)
  const plural = (n: number, w: string) => `${n} ${w}${n === 1 ? '' : 's'}`

  const bar: Record<Step, Parameters<typeof ActionBar>[0]> = {
    upload: {
      summary: hasDesigns ? `${plural(designs.length, 'design')} ready` : 'Add your PDF, PNG or JPG files to start',
      next: { label: 'Continue', onClick: () => setStep('size'), disabled: !hasDesigns },
    },
    size: {
      onBack: () => setStep('upload'),
      summary: (
        <>
          <b className="text-slate-800">{plural(prints, 'print')}</b> on <b className="text-slate-800">{plural(sheets.length, 'sheet')}</b>
          {toCheck > 0 && <span className="text-amber-700"> · {plural(toCheck, 'thing')} to check</span>}
        </>
      ),
      next: { label: 'Preview', onClick: () => setStep('preview'), disabled: !hasDesigns },
    },
    preview: {
      onBack: () => setStep('size'),
      summary: `${plural(sheets.length, 'sheet')} · exactly as they will print`,
      next: { label: 'Looks good', onClick: () => setStep('download') },
    },
    download: { onBack: () => setStep('preview'), backLabel: 'Back to preview', summary: 'Print at 100 % – actual size' },
  }

  return (
    <ToastHost>
      <div className="flex h-full flex-col">
        <Header step={step} setStep={setStep} canContinue={hasDesigns} onSettings={() => setShowSettings(true)} settings={settings} />
        <main className={`min-h-0 flex-1 ${step === 'preview' ? '' : 'overflow-y-auto'}`}>
        {step === 'upload' && (
          <UploadStep
            designs={designs}
            sources={sources}
            thumbs={thumbs}
            checks={checks}
            settings={settings}
            loading={loading > 0}
            errors={errors}
            onFiles={addFiles}
            onRemove={removeDesign}
          />
        )}
        {step === 'size' && (
          <SizeStep
            designs={designs}
            sources={sources}
            thumbs={thumbs}
            settings={settings}
            checks={checks}
            sheets={sheets}
            maxPerSheet={maxPerSheet}
            setMaxPerSheet={(k, v) => setMaxPerSheet((m) => ({ ...m, [k]: v }))}
            presets={[...userPresets]}
            onApplyPreset={applyPreset}
            onSavePreset={savePreset}
            onDeletePreset={deletePreset}
            onUpdate={updateDesign}
            onRemove={removeDesign}
            onAddFiles={addFiles}
            onRepeat={repeatPanel}
          />
        )}
        <Suspense fallback={<div className="grid h-full place-items-center text-slate-400">Loading…</div>}>
        {step === 'preview' && (
          <PreviewStep
            sheets={sheets}
            sources={sources}
            settings={settings}
            designs={designs}
            checks={checks}
            trimNames={trimNames}
            overrides={overrides}
            setOverride={(id, o) => setOverrides((m) => ({ ...m, [id]: o }))}
            onUpdateDesign={updateDesign}
            thumbs={thumbs}
            onAddFiles={addFiles}
            onRepeat={repeatPanel}
          />
        )}
        {step === 'download' && <DownloadStep sheets={sheets} sources={sources} settings={settings} designs={designs} checks={checks} trimNames={trimNames} />}
        </Suspense>
        </main>
        <ActionBar {...bar[step]} />
        {showSettings && <SettingsDialog settings={settings} onSave={setSettings} onClose={() => setShowSettings(false)} />}
      </div>
    </ToastHost>
  )
}
