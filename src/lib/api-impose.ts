/**
 * CorelDraw Imposition API Engine
 *
 * Exposes a headless programmatic endpoint to run the exact same
 * 13x19 imposition, bleed addition, and crop-mark generation
 * that the CorelDraw / Print Ready frontend uses.
 */
import { cloneSettings, DEFAULT_SETTINGS, SHEETS, TRIM_SIZES } from '../config/defaults'
import { buildItems, type Design } from './job'
import { layoutJob } from './layout'
import { buildPrintPdf } from './exportPdf'
import { readSource, type SourceFile } from './sources'

export type ImposeItem = {
  name: string
  bytes: Uint8Array | Buffer
  copies?: number
}

export type ImposeJobOptions = {
  size: 'A3' | 'A4' | 'A5'
  sheet?: '13x19' | 'A3'
  title?: string
  bleedMm?: number
  items: ImposeItem[]
}

export async function runCorelDrawImposition(opts: ImposeJobOptions): Promise<{
  pdfBytes: Uint8Array
  totalSheets: number
  totalPosters: number
}> {
  const trim = TRIM_SIZES.find((t) => t.name.toUpperCase() === opts.size.toUpperCase()) ?? {
    name: opts.size,
    widthMm: opts.size === 'A5' ? 148 : 210,
    heightMm: opts.size === 'A5' ? 210 : 297,
  }

  const s = cloneSettings(DEFAULT_SETTINGS)
  if (opts.sheet === 'A3') {
    s.sheet = SHEETS[1]
  } else {
    s.sheet = SHEETS[0] // 13 × 19 in (330.2 × 482.6 mm)
  }

  if (typeof opts.bleedMm === 'number') {
    s.bleedMm = opts.bleedMm
  }

  const sources: Record<string, SourceFile> = {}
  const designs: Design[] = []

  for (let i = 0; i < opts.items.length; i++) {
    const it = opts.items[i]
    const srcId = `src_${i}`
    const fileName = it.name.endsWith('.jpg') || it.name.endsWith('.png') ? it.name : `${it.name}.jpg`
    const srcBytes = it.bytes instanceof Uint8Array ? it.bytes : new Uint8Array(it.bytes)

    const src = await readSource(fileName, srcBytes, srcId)
    sources[srcId] = src

    designs.push({
      id: `design_${i}`,
      sourceId: srcId,
      name: it.name,
      trimName: trim.name,
      trimW: trim.widthMm,
      trimH: trim.heightMm,
      copies: it.copies ?? 1,
      bleedMode: 'included', // files processed with bleed or exact trim
      fit: 'fill',
      bleedAuto: false,
      split: false,
      pageIndex: 0,
    })
  }

  const layoutItems = buildItems(designs, sources)
  const sheets = layoutJob(layoutItems, s)

  const groupKey = sheets[0]?.groupKey ?? `${trim.widthMm}x${trim.heightMm}`
  const pdfBytes = await buildPrintPdf(sheets, sources, s, {
    date: new Date(),
    title: opts.title ?? `print-ready_${opts.size}_${sheets.length}-sheets.pdf`,
    trimNames: { [groupKey]: trim.name },
  })

  return {
    pdfBytes,
    totalSheets: sheets.length,
    totalPosters: layoutItems.length,
  }
}

