/** Low-level pdf-lib drawing shared by the export and the bleed-strip renderer. */
import {
  PDFDocument,
  PDFObjectCopier,
  type PDFPage,
  type PDFRef,
  clip,
  concatTransformationMatrix,
  drawObject,
  endPath,
  popGraphicsState,
  pushGraphicsState,
  rectangle,
} from 'pdf-lib'
import type { ArtPiece } from './artwork'
import type { Matrix } from './geometry'
import { type SourceFile, type SourcePageInfo, loadPdf, pdfPageToDisplayedMm } from './sources'

export const cm = (m: Matrix) => concatTransformationMatrix(m[0], m[1], m[2], m[3], m[4], m[5])

export interface Drawable {
  info: SourcePageInfo
  /** The page (Form XObject) or image (Image XObject) in the output document. */
  ref: PDFRef
  kind: 'page' | 'image'
}

/**
 * Each source page / image is embedded ONCE into a small holder document (pdf-lib decodes and
 * re-compresses page contents and PNG pixels when embedding – slow for big files). Every output
 * document then copies the finished XObject from the holder, byte for byte – same content, no re-encoding.
 */
interface Prepared {
  holder: PDFDocument
  ref: PDFRef
}
const holders = new WeakMap<Uint8Array, { doc: Promise<PDFDocument>; items: Map<number, Promise<Prepared>> }>()

function prepare(src: SourceFile, pageIndex: number): Promise<Prepared> {
  let entry = holders.get(src.bytes)
  if (!entry) {
    entry = { doc: PDFDocument.create(), items: new Map() }
    holders.set(src.bytes, entry)
  }
  const { doc, items } = entry
  const key = src.kind === 'pdf' ? pageIndex : 0
  let p = items.get(key)
  if (!p) {
    p = (async () => {
      const holder = await doc
      if (src.kind !== 'pdf') {
        const image = src.kind === 'png' ? await holder.embedPng(src.bytes) : await holder.embedJpg(src.bytes)
        await image.embed()
        return { holder, ref: image.ref }
      }
      const sd = await loadPdf(src.bytes)
      const embedded = await holder.embedPage(sd.getPage(pageIndex), src.pages[pageIndex].pdfBox)
      await embedded.embed()
      return { holder, ref: embedded.ref }
    })()
    p.catch(() => items.delete(key))
    items.set(key, p)
  }
  return p
}

/** Caches embedded pages/images per output document. */
export class SourceEmbedder {
  private refs = new Map<string, Promise<PDFRef>>()
  private copiers = new Map<PDFDocument, PDFObjectCopier>()
  constructor(private doc: PDFDocument) {}

  async get(src: SourceFile, pageIndex: number): Promise<Drawable> {
    const info = src.pages[pageIndex]
    const kind = src.kind === 'pdf' ? 'page' : 'image'
    const key = kind === 'page' ? `${src.id}:${pageIndex}` : src.id
    let ref = this.refs.get(key)
    if (!ref) {
      ref = prepare(src, pageIndex).then(({ holder, ref }) => {
        let copier = this.copiers.get(holder)
        if (!copier) {
          copier = PDFObjectCopier.for(holder.context, this.doc.context)
          this.copiers.set(holder, copier)
        }
        return copier.copy(ref)
      })
      this.refs.set(key, ref)
    }
    return { info, ref: await ref, kind }
  }
}

/**
 * Draws one piece of artwork.
 * `outer` maps local trim-space mm → page points. The piece is clipped to `piece.clip` (local mm).
 */
export function drawPiece(page: PDFPage, outer: Matrix, piece: ArtPiece, d: Drawable) {
  const c = piece.clip
  page.pushOperators(pushGraphicsState(), cm(outer), rectangle(c.x, c.y, c.w, c.h), clip(), endPath(), cm(piece.matrix))
  if (d.kind === 'page') {
    page.pushOperators(cm(pdfPageToDisplayedMm(d.info)), drawObject(page.node.newXObject('EmbeddedPdfPage', d.ref)))
  } else {
    // an image XObject fills the unit square: scale it to the image's size
    const { widthMm, heightMm } = d.info.geometry
    page.pushOperators(cm([widthMm, 0, 0, heightMm, 0, 0]), drawObject(page.node.newXObject('Image', d.ref)))
  }
  page.pushOperators(popGraphicsState())
}
