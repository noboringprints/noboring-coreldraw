/**
 * Generates sample print-ready PDFs into /print-reference/output/ so they can be
 * printed and measured with a ruler. Run with:  npm run samples
 *
 * The sample designs have NO bleed in the file (exactly trim size) and a 2 mm coloured
 * border inside the cut line, so the print shows that:
 *   - nothing of the design is cut off (the full 2 mm border is visible on every side), and
 *   - the bleed was added outside the cut line by mirroring.
 */
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { DEFAULT_SETTINGS, SHEETS, cloneSettings } from '../src/config/defaults'
import { expand } from '../src/lib/geometry'
import { buildItems, checkDesign, type Design } from '../src/lib/job'
import { layoutJob } from '../src/lib/layout'
import { buildPrintPdf } from '../src/lib/exportPdf'
import { readSource } from '../src/lib/sources'
import { makeTestPoster } from '../src/lib/testDesign'
import { nodeRasterizer } from './rasterNode'

const outDir = join(import.meta.dirname, '..', 'print-reference', 'output')
mkdirSync(outDir, { recursive: true })

const samples = [
  { file: 'A3-single_13x19.pdf', name: 'A3 sample', trimName: 'A3', w: 297, h: 420, copies: 1, color: [0.12, 0.42, 0.72] },
  { file: 'A4-2up_13x19.pdf', name: 'A4 sample', trimName: 'A4', w: 210, h: 297, copies: 2, color: [0.1, 0.55, 0.4] },
  { file: 'A5-4up_13x19.pdf', name: 'A5 sample', trimName: 'A5', w: 148, h: 210, copies: 4, color: [0.5, 0.3, 0.65] },
] as const

const f = (n: number) => n.toFixed(1)
const date = new Date()
const s = cloneSettings(DEFAULT_SETTINGS)
s.sheet = SHEETS[0]

let md = `# Sample output – how to measure

Generated ${date.toISOString().slice(0, 10)} with the default settings:
sheet ${s.sheet.name} (${s.sheet.widthMm} × ${s.sheet.heightMm} mm), bleed ${s.bleedMm} mm (designs printed exactly as they are),
crop marks ${s.marks.lengthMm} mm long, ${s.marks.offsetMm} mm from the trim corner, ${s.marks.lineWidthPt} pt, ${s.marks.color},
minimum margin ${s.marginMm} mm (to the artwork), white gap between copies ${s.gutterMm} mm.

**Print at 100 % / "Actual size" – never "Fit to page".**

## What the test designs look like

The sample designs have **no bleed in the file** – they are exactly the trim size – and are printed 1:1,
untouched. Each has a **2 mm coloured border just inside the cut line**:
left = red, right = green, bottom = blue, top = orange (as the design is read; A4 copies are turned 90° on the sheet).

After cutting on the crop marks you should see:

1. The **full 2 mm border on all four sides** (measure it: 2 mm). If any border is thinner or missing, artwork was lost.
2. Before cutting: nothing is printed outside the design edge – only the white gap and the crop marks,
   which line up exactly with the design edges.

There is also a pale-yellow frame 5 mm inside the cut line = the safe zone, and white ticks every 10 mm.

All positions below are measured from the **bottom-left corner of the sheet** (portrait, as it comes out of the PDF).
`

for (const smp of samples) {
  const bytes = await makeTestPoster({ trimW: smp.w, trimH: smp.h, bleed: 0, border: true, title: smp.name, color: [...smp.color] as [number, number, number] })
  const src = await readSource(`${smp.name}.pdf`, bytes, 'src')
  const design: Design = {
    id: 'd', sourceId: 'src', name: smp.name, trimName: smp.trimName, trimW: smp.w, trimH: smp.h, copies: smp.copies,
    bleedMode: 'none', fit: 'fit', bleedAuto: true, split: false, pageIndex: 0,
  }
  const check = checkDesign(design, src, s)
  if (check.hasBleed) throw new Error('sample design should have no bleed')
  const sheets = layoutJob(buildItems([design], { src }), s)
  if (sheets.some((x) => x.warnings.length)) throw new Error(sheets.flatMap((x) => x.warnings).join('\n'))
  const pdf = await buildPrintPdf(sheets, { src }, s, { date, trimNames: { [sheets[0].groupKey]: smp.trimName }, title: smp.file, rasterizer: nodeRasterizer })
  writeFileSync(join(outDir, smp.file), pdf)

  md += `\n## ${smp.file}\n\n${sheets[0].placements.length} × ${smp.trimName} (${smp.w} × ${smp.h} mm) per sheet.\n\n`
  md += `| Copy | Rotated | Cut line left → right (mm) | Cut line bottom → top (mm) | Bleed edge left → right | Bleed edge bottom → top |\n|---|---|---|---|---|---|\n`
  sheets[0].placements.forEach((p, i) => {
    const t = p.trim
    const b = expand(t, s.bleedMm)
    md += `| ${i + 1} | ${p.rotation ? p.rotation + '°' : 'no'} | ${f(t.x)} → ${f(t.x + t.w)} | ${f(t.y)} → ${f(t.y + t.h)} | ${f(b.x)} → ${f(b.x + b.w)} | ${f(b.y)} → ${f(b.y + b.h)} |\n`
  })
  const sideMarks = sheets[0].marks.filter((m) => m.y1 === m.y2)
  const leftMark = sideMarks.find((m) => m.x2 < m.x1)!
  md += `\nCrop marks: ${sheets[0].marks.length} lines. Example: the left-side marks run from x = ${f(leftMark.x1)} to ${f(leftMark.x2)} mm `
  md += `(that is ${s.marks.offsetMm} mm to ${s.marks.offsetMm + s.marks.lengthMm} mm left of the cut line).\n`
  md += `Marks that would point into the gap between copies are left out – the marks on the outside of the block mark those cut lines.\n`
  if (sheets[0].label) md += `Label: bottom margin, ${s.label.fontSizePt} pt text.\n`
  console.log(`wrote ${smp.file}  (${sheets[0].placements.length}-up, ${sheets[0].marks.length} marks, no bleed)`)
}

writeFileSync(join(outDir, 'MEASUREMENTS.md'), md)
console.log(`wrote MEASUREMENTS.md → ${outDir}`)
