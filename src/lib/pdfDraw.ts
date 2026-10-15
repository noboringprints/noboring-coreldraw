/** Low-level pdf-lib drawing shared by the export and the bleed-strip renderer. */
import {
  PDFDocument,
  type PDFEmbeddedPage,
  type PDFImage,
  type PDFPage,
  clip,
  concatTransformationMatrix,
  endPath,
  popGraphicsState,
  pushGraphicsState,
  rectangle,
} from 'pdf-lib'
import type { ArtPiece } from './artwork'
import type { Matrix } from './geometry'
import { type SourceFile, type SourcePageInfo, pdfPageToDisplayedMm } from './sources'

export const cm = (m: Matrix) => concatTransformationMatrix(m[0], m[1], m[2], m[3], m[4], m[5])

export interface Drawable {
  info: SourcePageInfo
  embedded?: PDFEmbeddedPage
  image?: PDFImage
}

/** Caches embedded pages/images per output document. */
export class SourceEmbedder {
  private docs = new Map<string, PDFDocument>()
  private pages = new Map<string, PDFEmbeddedPage>()
  private images = new Map<string, PDFImage>()
  constructor(private doc: PDFDocument) {}

  async get(src: SourceFile, pageIndex: number): Promise<Drawable> {
    const info = src.pages[pageIndex]
    if (src.kind !== 'pdf') {
      let image = this.images.get(src.id)
      if (!image) {
        image = src.kind === 'png' ? await this.doc.embedPng(src.bytes) : await this.doc.embedJpg(src.bytes)
        this.images.set(src.id, image)
      }
      return { info, image }
    }
    const key = `${src.id}:${pageIndex}`
    let embedded = this.pages.get(key)
    if (!embedded) {
      let sd = this.docs.get(src.id)
      if (!sd) {
        sd = await PDFDocument.load(src.bytes, { ignoreEncryption: true, updateMetadata: false })
        this.docs.set(src.id, sd)
      }
      embedded = await this.doc.embedPage(sd.getPage(pageIndex), info.pdfBox)
      this.pages.set(key, embedded)
    }
    return { info, embedded }
  }
}

/**
 * Draws one piece of artwork.
 * `outer` maps local trim-space mm → page points. The piece is clipped to `piece.clip` (local mm).
 */
export function drawPiece(page: PDFPage, outer: Matrix, piece: ArtPiece, d: Drawable) {
  const c = piece.clip
  page.pushOperators(pushGraphicsState(), cm(outer), rectangle(c.x, c.y, c.w, c.h), clip(), endPath(), cm(piece.matrix))
  if (d.embedded) {
    page.pushOperators(cm(pdfPageToDisplayedMm(d.info)))
    page.drawPage(d.embedded, { x: 0, y: 0 })
  } else if (d.image) {
    page.drawImage(d.image, { x: 0, y: 0, width: d.info.geometry.widthMm, height: d.info.geometry.heightMm })
  }
  page.pushOperators(popGraphicsState())
}
