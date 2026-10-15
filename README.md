# Print Ready

Prepares finished poster designs for printing, automatically:

1. adds **crop marks** that line up with the design edges (the design itself is printed exactly as it is – not scaled, not extended),
2. optionally adds **bleed** (off by default),
3. puts as many copies as fit on the **print sheet** (13 × 19 inch or A3),

and exports **one print-ready PDF**. No CorelDRAW needed.

Everything runs on your own computer. Files are never uploaded anywhere.

---

## How to run it

You need **Node.js** (version 20 or newer) installed once.

```bash
npm install        # first time only
npm run dev        # starts the app
```

Then open **http://localhost:5173** in Chrome or Edge.

Other commands:

| Command | What it does |
|---|---|
| `npm test` | Runs the automatic checks of all the measurements |
| `npm run samples` | Makes 3 sample PDFs in `print-reference/output/` to print and measure |
| `npm run build` | Makes a finished version in `dist/` (can be opened from any simple web server) |

---

## How to use it

**1 · Upload** – Drag your PDF, PNG or JPG files onto the page (several at once). Each file shows a small picture and its size, e.g. “216 × 303 mm (A4 + 3 mm bleed)”.

**2 · Size & copies** – For each design choose:
- the **final size** (A3, A4, A5 or Custom in mm) and Portrait / Landscape,
- the number of **copies**,
- **bleed** – one setting per design. By default the bleed is **0 mm**, so this is **None** and the design is printed exactly as it is in the file, at its own exact size. The other options only do something after you set a bleed in ⚙ Settings:
  - **Mirror edges** – the outer 3 mm of the design is mirrored *outside* the cut line.
  - **Stretch edge pixels** – the outermost row of pixels is stretched across the 3 mm.
  - **None** – no bleed; the sheet is cut exactly at the design edge.
  - **File already has bleed** – only offered when the file really is the final size + 3 mm on every side (±0.5 mm), or is a PDF whose trim box has 3 mm around it. Then the file's own bleed is used.

  The design is **never enlarged to make bleed**: 100 % of it stays inside the cut line. A yellow warning reminds you that bleed was added automatically.
  For PDFs, only the 3 mm bleed strips are made as 300 DPI images; the design itself stays vector.
  Images (PNG/JPG) only count as “has bleed” when they store a DPI value, because otherwise their real size is unknown.
- If a design's **proportions don't match** the final size, choose **Keep whole design** (white bands, nothing lost – the default) or **Fill & crop**.
- If a PDF has **text closer than 5 mm to the edge** (or running off it), you get a warning naming the text. Images can't be checked for this – look at the safe zone in the preview.
- For a **split poster**, upload one PDF with one panel per page and tick **Split poster**. Each panel is printed untouched with an 8 mm white gap around it, and short crop marks on the line of every edge (outside the panels only – nothing in the gaps). Cut on the marks and the panels butt together exactly. Labelled “Panel 1 of 3” etc.

Or click a **preset** (e.g. “A4 posters – 13×19”) to set everything at once. You can save your own presets.

Under **Copies per sheet** you can see how many fit (13 × 19: A3 = 1, A4 = 2, A5 = 4) and force fewer, e.g. 1 per sheet.

**3 · Preview** – Shows each sheet exactly as it will print, on a dark workspace with mm rulers. Use **Show** (top right) to switch the guide lines on or off.
- Mouse wheel = zoom, drag empty space = move around, **Fit** / **100%** buttons.
- Coloured lines: pink dashed = cut line (trim), blue = bleed, green dashed = **safe zone** (5 mm inside the cut – keep text inside it), orange = crop marks.
- Click a design to select it: drag it to move it, **Rotate 90°**, **Reset position**, or change its copies.
- Yellow warnings appear if something overlaps or goes off the sheet.

**4 · Download** – Click **Download print PDF**. Print it at **100 % / “Actual size”**, never “Fit to page”.

### What is in the PDF
- Each page is exactly the sheet size (13 × 19 in = 936 × 1368 pt).
- PDF designs are placed as **vectors** at exactly the trim size – quality is exactly as designed. Only automatic bleed strips (outside the cut line) are 300 DPI images.
- Photos/images keep all their original pixels. You get a warning if one would print below 200 DPI.
- Crop marks are 0.25 pt, in registration colour (prints on all plates).
- A small label in the margin: design names, trim size, “Sheet 2 of 6”, date.

---

## Settings – please confirm these with the printer

All defaults live in one file: **`src/config/defaults.ts`**. They can also be changed in the app (**⚙ Settings** button; saved in that browser).

No sample file from the printer was in `/print-reference/` yet, so these are **not measured from a real CorelDRAW file**. Please check each one:

| Setting | Default | Question for the printer |
|---|---|---|
| Sheet | 13 × 19 in (330.2 × 482.6 mm), portrait | Exact sheet size? Any other sheets (SRA3 = 320 × 450 mm)? |
| Bleed | 0 mm (design printed exactly as it is) | Set e.g. 3 mm if the printer wants bleed. |
| Crop mark length | 4 mm (as the CorelDRAW reference) | OK? |
| Crop mark offset | 1 mm from the cut corner (as the CorelDRAW reference) | OK? (Must be ≥ bleed, otherwise marks would sit on the artwork.) |
| Crop mark thickness | 0.25 pt | OK? |
| Crop mark colour | Registration (C+M+Y+K) | Or 100 % black only? |
| Sheet margin | 10 mm to the artwork (incl. bleed) | **Important** – see below |
| Keep away from edge | 3 mm (marks and label) | What is the printer's non-printable edge (gripper)? |
| Gap between copies | 8 mm (white) | OK? |
| Safe zone | 5 mm inside the cut | OK? |
| Automatic bleed for PDFs | 300 DPI image strips (or vector copies) | Is a 300 DPI RGB strip fine in the bleed? |

**About the margin:** with a 10 mm margin, there is *not* enough room on a 13 × 19 sheet for A4 2-up or A5 4-up if the crop marks must *also* stay inside the 10 mm. So the app keeps the **artwork + bleed** at least 10 mm from the edge, and lets crop marks and the label go into that margin (but never closer than 3 mm to the edge). For A5 4-up the side crop marks end about 6 mm from the sheet edge. Please check that the printer can print that close to the edge.

**About crop marks between copies:** a mark pointing into the gap between two copies is left out unless the gap is big enough for both copies' marks without touching (2 × (offset + length) − bleed + 0.5 mm; 10.5 mm with the defaults). Every cut line still has marks on the outside of the block – this is the usual way ganged sheets are cut.

**About A3 sheets:** an A3 design with bleed (303 × 426 mm) is bigger than an A3 sheet, so it can't be printed on A3 – the app shows a warning. On an A3 sheet you get A4 = 1 and A5 = 2 per sheet.

---

## Checking the output with a ruler

`npm run samples` writes three PDFs into `print-reference/output/`:
`A3-single_13x19.pdf`, `A4-2up_13x19.pdf`, `A5-4up_13x19.pdf`, and **`MEASUREMENTS.md`** with the exact positions (in mm) to measure. The test designs have **no bleed in the file**, so they test the automatic (mirrored) bleed. Each has a **2 mm coloured border just inside the cut line** (left red, right green, bottom blue, top orange). After cutting, the full 2 mm border must be visible on every side, with no white edge.

When the printer's CorelDRAW sample arrives, put it in `/print-reference/` and compare it with these, then adjust `src/config/defaults.ts`.

---

## For developers

```
src/config/defaults.ts   all print settings (one place)
src/lib/layout.ts        ups, positions, crop marks, label (pure maths, mm, origin bottom-left)
src/lib/artwork.ts       bleed detection, fitting, mirror/stretch bleed
src/lib/exportPdf.ts     builds the PDF with pdf-lib (vectors, registration colour)
src/lib/sources.ts       reads PDFs (boxes, page rotation) and image sizes
src/components/          the 4 screens + settings dialog
tests/                   vitest: layout maths and the exported PDF
scripts/generate-samples.ts
```

1 mm = 72 / 25.4 pt = 2.834645… pt. All maths is done in mm and converted once when writing the PDF.

### Licences of the libraries used

| Library | Licence | Used for |
|---|---|---|
| pdf-lib 1.17 | MIT | Building the PDF, embedding PDF pages as vectors |
| (pdf-lib's own deps: pako, @pdf-lib/standard-fonts, @pdf-lib/upng, tslib) | MIT / Zlib / 0BSD | – |
| pdfjs-dist 6.4 (pdf.js) | Apache-2.0 | On-screen previews and thumbnails only |
| React 19, react-dom | MIT | User interface |
| Tailwind CSS 4 | MIT | Styling |
| lucide-react | ISC | Icons |
| Inter (@fontsource-variable/inter) | SIL OFL 1.1 | Typeface (bundled, works offline) |
| Vite 8, @vitejs/plugin-react | MIT | Dev server / build (dev only) |
| Vitest 5, tsx | MIT | Tests and sample script (dev only) |
| TypeScript 7 | Apache-2.0 | Type checking (dev only) |
| @napi-rs/canvas | MIT | Renders the 300 DPI bleed strips in tests and the sample script (dev only; the app uses the browser) |

All are free, open-source licences that allow commercial use.
