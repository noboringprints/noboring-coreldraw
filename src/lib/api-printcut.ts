/**
 * Print & Cut API Engine
 *
 * The Print & Cut tool without its screen: same product matching, design-edge detection, contour tracing,
 * nesting and PDF as the app. Runs in Node only.
 */
import { nodeRasterizer } from '../../scripts/rasterNode'
import { buildItemArtPdf, buildPrintCutPdf, buildSourcePdf } from '../printcut/exportPrintCut'
import {
  type CutShape,
  DEFAULT_PRINTCUT_SETTINGS,
  DEFAULT_PRODUCTS,
  type ItemBleed,
  type ItemBorder,
  type PrintCutItem,
  contourKey,
  contourParams,
  contourPxPerMm,
  contourRaster,
  findContent,
  itemDpi,
  itemShape,
  newItemFor,
  planItem,
  setContour,
} from '../printcut/model'
import { computeCut, cutFrame } from '../stickers/lib/cutline'
import { encodePngNode } from '../stickers/lib/imagingNode'
import { type NestDesign, layoutProblems, nest } from '../stickers/lib/nest'
import { type SheetOptions, checkAllPlaced, sheetSettings } from './api-stickers'
import { type SourceFile, newId, readSource } from './sources'

export type PrintCutApiItem = {
  name: string
  bytes: Uint8Array | Buffer
  copies?: number
  /** Finished size. Give one and the other follows the design's proportions; give neither to keep the file's size. */
  widthMm?: number
  heightMm?: number
  shape?: CutShape
  cornerMm?: number
  bleedMode?: ItemBleed
  border?: Partial<ItemBorder>
  smoothMm?: number
  rotation?: 'auto' | 0 | 90
}

export type PrintCutJobOptions = SheetOptions & { items: PrintCutApiItem[] }

/** Where the design sits in one page of a file (null = it fills the page). */
async function detectContent(src: SourceFile, pageIndex: number) {
  const g = src.pages[pageIndex].geometry
  const [img] = await nodeRasterizer.render(await buildSourcePdf(src, pageIndex), Math.min(8, 1600 / Math.max(g.widthMm, g.heightMm)))
  return findContent(img, g.widthMm, g.heightMm)
}

function applyRequest(made: PrintCutItem, req: PrintCutApiItem, bleedMm: number): PrintCutItem {
  const it = { ...made }
  const ratio = it.heightMm / it.widthMm
  if (req.widthMm !== undefined || req.heightMm !== undefined) {
    it.widthMm = req.widthMm ?? req.heightMm! / ratio
    it.heightMm = req.heightMm ?? req.widthMm! * ratio
  }
  if (req.shape) {
    it.shape = req.shape
    // as for a new item: only a rectangle can mirror its edges
    if (it.bleedMode !== 'included' && bleedMm > 0 && req.shape !== 'rect') it.bleedMode = 'grow'
  }
  if (req.cornerMm !== undefined) it.cornerMm = req.cornerMm
  if (req.bleedMode) it.bleedMode = req.bleedMode
  if (req.border) it.border = { style: 'none', mm: 3, color: '#ffffff', ...req.border }
  if (req.smoothMm !== undefined) it.smoothMm = req.smoothMm
  if (req.copies !== undefined) it.copies = req.copies
  if (req.rotation !== undefined) it.rotation = req.rotation
  return it
}

/** Traces a contour cut and puts it in the model's cache, where itemShape and the export find it. */
async function traceContour(it: PrintCutItem, src: SourceFile, bleedMm: number): Promise<string[]> {
  const [img] = await nodeRasterizer.render(await buildItemArtPdf(it, src, bleedMm), contourPxPerMm(it, bleedMm))
  const raster = contourRaster(img, it, bleedMm)
  const params = contourParams(it)
  const { bleedImage, ...geo } = computeCut(raster, cutFrame(raster.w / raster.pxPerMm, raster.h / raster.pxPerMm, params, bleedMm), params, bleedMm)
  if (!geo.cut.length) throw new Error(`"${it.name}": ${geo.warnings[0] ?? 'could not find an outline to cut around.'}`)
  setContour(contourKey(it, bleedMm), {
    ...geo,
    art: {
      png: encodePngNode({ data: raster.rgba, w: raster.w, h: raster.h }),
      rect: { x: raster.originX, y: raster.originTopY - raster.h / raster.pxPerMm, w: raster.w / raster.pxPerMm, h: raster.h / raster.pxPerMm },
    },
    ...(bleedImage ? { bleedImage: { png: encodePngNode({ data: bleedImage.rgba, w: bleedImage.w, h: bleedImage.h }), rect: bleedImage.rect } } : {}),
  })
  return geo.warnings
}

export async function runPrintCutJob(opts: PrintCutJobOptions): Promise<{
  pdfBytes: Uint8Array
  totalSheets: number
  totalPieces: number
  warnings: string[]
}> {
  if (!opts.items?.length) throw new Error('No items were sent.')
  const s = sheetSettings(DEFAULT_PRINTCUT_SETTINGS, opts)
  const warnings: string[] = []
  const sources: Record<string, SourceFile> = {}
  const items: PrintCutItem[] = []

  for (const req of opts.items) {
    const src = await readSource(req.name, new Uint8Array(req.bytes))
    sources[src.id] = src
    const base = src.name.replace(/\.(pdf|png|jpe?g)$/i, '')
    for (const p of src.pages) {
      const name = src.pages.length > 1 ? `${base} · p${p.index + 1}` : base
      const { product: _product, ...made } = newItemFor(newId('it'), name, src.id, p.index, p.geometry, DEFAULT_PRODUCTS, s.bleedMm, await detectContent(src, p.index))
      const it = applyRequest(made, req, s.bleedMm)
      if (it.shape === 'contour') for (const w of await traceContour(it, src, s.bleedMm)) warnings.push(`${name}: ${w}`)
      const plan = planItem(it, p.geometry, s.bleedMm)
      for (const w of plan.warnings) warnings.push(`${name}: ${w}`)
      const dpi = itemDpi(p.geometry, plan)
      if (dpi !== null && dpi < s.minDpi) warnings.push(`${name}: prints at ${dpi} DPI – may look soft.`)
      items.push(it)
    }
  }

  const nestDesigns: NestDesign[] = items.map((it) => ({ id: it.id, name: it.name, ...itemShape(it, s.bleedMm), copies: it.copies, rotation: it.rotation }))
  const layout = nest(nestDesigns, s)
  checkAllPlaced(nestDesigns, layout.sheets)
  warnings.push(...layout.warnings)
  const shapes = Object.fromEntries(nestDesigns.map((d) => [d.id, d]))
  for (const sh of layout.sheets) {
    const p = layoutProblems(sh, shapes, s)
    if (p.overlapping.size) warnings.push(`Sheet ${sh.index + 1}: some pieces are closer than the ${s.gapMm} mm gap.`)
    if (p.outside.size) warnings.push(`Sheet ${sh.index + 1}: a piece is outside the printable area.`)
  }

  const pdfBytes = await buildPrintCutPdf(layout.sheets, items, sources, s, { mode: opts.mode ?? 'print-cut', rasterizer: nodeRasterizer, title: opts.title })
  return { pdfBytes, totalSheets: layout.sheets.length, totalPieces: layout.sheets.reduce((n, sh) => n + sh.placements.length, 0), warnings }
}
