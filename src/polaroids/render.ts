/**
 * Draws one polaroid with Canvas 2D: frame (theme), photo (cropped, turned, filtered), decorations, caption.
 * The SAME function makes the editor preview, the sheet preview and the 300 DPI print, so what you see is what prints.
 * Works with browser canvases and with @napi-rs/canvas (tests / server).
 *
 * The canvas must be (w + 2·bleed) × (h + 2·bleed) mm at `pxPerMm`; the frame (pattern included) runs on into the bleed.
 */
import { enhancePixels } from './enhance'
import { type FilterId, type PolaroidItem, type ThemeInfo, fontOf, formatOf, photoWindow, placePhoto, themeOf } from './model'

export type Ctx2D = CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D

/** The photo to draw: `img` may be a smaller preview of a pxW × pxH original – it is scaled up to match. */
export interface PhotoSource {
  img: CanvasImageSource
  pxW: number
  pxH: number
}

export interface DrawOptions {
  pxPerMm: number
  bleedMm: number
  /** A grey stand-in picture is drawn when there is no photo (theme previews, still loading). */
  photo: PhotoSource | null
}

interface Box {
  x: number
  y: number
  w: number
  h: number
}

/* ------------------------------------------------------------------ helpers */

function rng(seed: string) {
  let h = 2166136261
  for (let i = 0; i < seed.length; i++) h = Math.imul(h ^ seed.charCodeAt(i), 16777619)
  let a = h >>> 0
  return () => {
    a = (a + 0x6d2b79f5) | 0
    let t = Math.imul(a ^ (a >>> 15), 1 | a)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

function roundRect(ctx: Ctx2D, x: number, y: number, w: number, h: number, r: number) {
  r = Math.max(0, Math.min(r, w / 2, h / 2))
  ctx.beginPath()
  ctx.moveTo(x + r, y)
  ctx.lineTo(x + w - r, y)
  ctx.arcTo(x + w, y, x + w, y + r, r)
  ctx.lineTo(x + w, y + h - r)
  ctx.arcTo(x + w, y + h, x + w - r, y + h, r)
  ctx.lineTo(x + r, y + h)
  ctx.arcTo(x, y + h, x, y + h - r, r)
  ctx.lineTo(x, y + r)
  ctx.arcTo(x, y, x + r, y, r)
  ctx.closePath()
}

const overlaps = (x: number, y: number, r: number, b: Box) => x + r > b.x && x - r < b.x + b.w && y + r > b.y && y - r < b.y + b.h

/** Random spots on the frame (not on the photo or behind the caption), roughly `perMm2` per square mm of the whole area. */
function scatter(rand: () => number, area: Box, avoid: Box[], perMm2: number, rMin: number, rMax: number, cb: (x: number, y: number, r: number, i: number) => void) {
  // an even density: spots that land on the photo or the caption are simply skipped (not re-tried elsewhere)
  const n = Math.round(area.w * area.h * perMm2)
  let placed = 0
  for (let i = 0; i < n; i++) {
    const r = rMin + rand() * (rMax - rMin)
    const x = area.x + rand() * area.w
    const y = area.y + rand() * area.h
    if (avoid.some((b) => overlaps(x, y, r, b))) continue
    cb(x, y, r, placed++)
  }
}

function heart(ctx: Ctx2D, x: number, y: number, s: number) {
  ctx.beginPath()
  ctx.moveTo(x, y + s * 0.35)
  ctx.bezierCurveTo(x - s * 0.1, y + s * 0.2, x - s * 0.5, y + s * 0.05, x - s * 0.5, y - s * 0.2)
  ctx.bezierCurveTo(x - s * 0.5, y - s * 0.45, x - s * 0.15, y - s * 0.55, x, y - s * 0.3)
  ctx.bezierCurveTo(x + s * 0.15, y - s * 0.55, x + s * 0.5, y - s * 0.45, x + s * 0.5, y - s * 0.2)
  ctx.bezierCurveTo(x + s * 0.5, y + s * 0.05, x + s * 0.1, y + s * 0.2, x, y + s * 0.35)
  ctx.closePath()
  ctx.fill()
}

function star(ctx: Ctx2D, x: number, y: number, r: number, rot: number) {
  ctx.beginPath()
  for (let i = 0; i < 10; i++) {
    const a = rot + (i * Math.PI) / 5 - Math.PI / 2
    const rr = i % 2 ? r * 0.45 : r
    ctx.lineTo(x + Math.cos(a) * rr, y + Math.sin(a) * rr)
  }
  ctx.closePath()
  ctx.fill()
}

function snowflake(ctx: Ctx2D, x: number, y: number, r: number, rot: number) {
  ctx.beginPath()
  for (let i = 0; i < 6; i++) {
    const a = rot + (i * Math.PI) / 3
    const ex = x + Math.cos(a) * r
    const ey = y + Math.sin(a) * r
    ctx.moveTo(x, y)
    ctx.lineTo(ex, ey)
    // little branches
    for (const s of [-1, 1]) {
      const bx = x + Math.cos(a) * r * 0.6
      const by = y + Math.sin(a) * r * 0.6
      ctx.moveTo(bx, by)
      ctx.lineTo(bx + Math.cos(a + s * 0.8) * r * 0.32, by + Math.sin(a + s * 0.8) * r * 0.32)
    }
  }
  ctx.stroke()
}

/* ------------------------------------------------------------------ frame themes */

/** Busy patterns get a soft white plate behind the caption so it stays readable. */
const PLATE: Partial<Record<ThemeInfo['id'], string>> = { dots: 'rgba(255,255,255,0.88)', stripes: 'rgba(255,255,255,0.9)', gingham: 'rgba(255,255,255,0.9)' }

function drawFrame(ctx: Ctx2D, it: PolaroidItem, t: ThemeInfo, all: Box, win: Box) {
  const rand = rng(`${it.id}|${t.id}`)
  const avoid: Box[] = [{ x: win.x - 0.6, y: win.y - 0.6, w: win.w + 1.2, h: win.h + 1.2 }]
  // keep scattered decorations out from behind the caption, so it stays readable
  if (it.caption.text.trim()) {
    const top = win.y + win.h
    const H = all.y + all.h
    avoid.push({ x: win.x + win.w * 0.12, y: top + 1, w: win.w * 0.76, h: Math.max(0, H - top - 2.5) })
  }
  const base = t.recolorable && it.frameColor ? it.frameColor : t.base
  ctx.fillStyle = base
  ctx.fillRect(all.x, all.y, all.w, all.h)

  switch (t.id) {
    case 'kraft': {
      // paper fibres: tiny light and dark specks
      scatter(rand, all, [], 0.6, 0.05, 0.22, (x, y, r) => {
        ctx.fillStyle = rand() < 0.5 ? 'rgba(90,60,30,0.22)' : 'rgba(255,240,215,0.25)'
        ctx.beginPath()
        ctx.arc(x, y, r, 0, Math.PI * 2)
        ctx.fill()
      })
      break
    }
    case 'sunset':
    case 'ocean': {
      const g = ctx.createLinearGradient(0, all.y, 0, all.y + all.h)
      const stops = t.id === 'sunset' ? ['#ffd194', '#ff9a8b', '#d97ad9'] : ['#c2e9fb', '#8fb8f8', '#5b7fe0']
      stops.forEach((c, i) => g.addColorStop(i / (stops.length - 1), c))
      ctx.fillStyle = g
      ctx.fillRect(all.x, all.y, all.w, all.h)
      break
    }
    case 'dots': {
      ctx.fillStyle = '#ffffff'
      const step = 6
      for (let row = 0, y = all.y; y < all.y + all.h + step; row++, y += step * 0.866)
        for (let x = all.x + (row % 2 ? step / 2 : 0); x < all.x + all.w + step; x += step) {
          ctx.beginPath()
          ctx.arc(x, y, 1.3, 0, Math.PI * 2)
          ctx.fill()
        }
      break
    }
    case 'stripes': {
      ctx.save()
      ctx.beginPath()
      ctx.rect(all.x, all.y, all.w, all.h)
      ctx.clip()
      ctx.fillStyle = '#ff9cbc'
      const d = all.w + all.h
      for (let s = -d; s < d * 2; s += 7) {
        ctx.beginPath()
        ctx.moveTo(all.x + s, all.y)
        ctx.lineTo(all.x + s + 3, all.y)
        ctx.lineTo(all.x + s + 3 - all.h, all.y + all.h)
        ctx.lineTo(all.x + s - all.h, all.y + all.h)
        ctx.closePath()
        ctx.fill()
      }
      ctx.restore()
      break
    }
    case 'gingham': {
      ctx.fillStyle = 'rgba(214,40,40,0.32)'
      for (let x = all.x; x < all.x + all.w; x += 6) ctx.fillRect(x, all.y, 3, all.h)
      for (let y = all.y; y < all.y + all.h; y += 6) ctx.fillRect(all.x, y, all.w, 3)
      break
    }
    case 'hearts': {
      const colors = ['#ff6b8b', '#ff8fab', '#f06292', '#ffb3c6', '#e91e63']
      scatter(rand, all, avoid, 0.05, 1.2, 2.4, (x, y, r) => {
        ctx.fillStyle = colors[Math.floor(rand() * colors.length)]
        heart(ctx, x, y, r * 2)
      })
      break
    }
    case 'stars': {
      const g = ctx.createLinearGradient(0, all.y, 0, all.y + all.h)
      g.addColorStop(0, '#141a3a')
      g.addColorStop(1, '#2d3561')
      ctx.fillStyle = g
      ctx.fillRect(all.x, all.y, all.w, all.h)
      scatter(rand, all, avoid, 0.2, 0.08, 0.25, (x, y, r) => {
        ctx.fillStyle = 'rgba(255,255,255,0.75)'
        ctx.beginPath()
        ctx.arc(x, y, r, 0, Math.PI * 2)
        ctx.fill()
      })
      scatter(rand, all, avoid, 0.03, 0.8, 1.8, (x, y, r) => {
        ctx.fillStyle = rand() < 0.6 ? '#ffe9a8' : '#ffffff'
        star(ctx, x, y, r, rand() * Math.PI)
      })
      break
    }
    case 'confetti': {
      const colors = ['#ff595e', '#ffca3a', '#8ac926', '#1982c4', '#6a4c93', '#ff7eb6', '#00c2a8']
      scatter(rand, all, avoid, 0.08, 0.5, 1.1, (x, y, r) => {
        ctx.fillStyle = colors[Math.floor(rand() * colors.length)]
        if (rand() < 0.45) {
          ctx.beginPath()
          ctx.arc(x, y, r * 0.7, 0, Math.PI * 2)
          ctx.fill()
        } else {
          ctx.save()
          ctx.translate(x, y)
          ctx.rotate(rand() * Math.PI)
          ctx.fillRect(-r * 0.4, -r, r * 0.8, r * 2)
          ctx.restore()
        }
      })
      break
    }
    case 'christmas': {
      ctx.strokeStyle = 'rgba(255,255,255,0.85)'
      ctx.lineWidth = 0.22
      ctx.lineCap = 'round'
      scatter(rand, all, avoid, 0.045, 1, 2.2, (x, y, r) => snowflake(ctx, x, y, r, rand()))
      ctx.fillStyle = 'rgba(255,255,255,0.7)'
      scatter(rand, all, avoid, 0.09, 0.15, 0.35, (x, y, r) => {
        ctx.beginPath()
        ctx.arc(x, y, r, 0, Math.PI * 2)
        ctx.fill()
      })
      break
    }
    case 'film': {
      // sprocket holes down both side borders
      const holeW = Math.min(1.6, win.x * 0.45)
      const holeH = holeW * 1.35
      ctx.fillStyle = '#e9e4d8'
      // the side borders are equal, so the right strip's centre is half a border past the window
      for (const cx of [win.x / 2, win.x + win.w + win.x / 2])
        for (let y = all.y + 1; y < all.y + all.h; y += holeH * 2.1) {
          roundRect(ctx, cx - holeW / 2, y, holeW, holeH, holeW * 0.2)
          ctx.fill()
        }
      break
    }
    default:
      break
  }
}

/** Things drawn over the photo edge (after the photo). */
function drawOverlay(ctx: Ctx2D, t: ThemeInfo, win: Box, k: number) {
  if (t.id === 'wedding') {
    ctx.strokeStyle = '#b8955a'
    ctx.lineWidth = 0.35
    ctx.strokeRect(win.x - 1.1, win.y - 1.1, win.w + 2.2, win.h + 2.2)
    ctx.lineWidth = 0.15
    ctx.strokeRect(win.x - 1.9, win.y - 1.9, win.w + 3.8, win.h + 3.8)
    // a small diamond at each corner
    ctx.fillStyle = '#b8955a'
    for (const [x, y] of [
      [win.x - 1.5, win.y - 1.5],
      [win.x + win.w + 1.5, win.y - 1.5],
      [win.x - 1.5, win.y + win.h + 1.5],
      [win.x + win.w + 1.5, win.y + win.h + 1.5],
    ]) {
      ctx.beginPath()
      ctx.moveTo(x, y - 0.8)
      ctx.lineTo(x + 0.8, y)
      ctx.lineTo(x, y + 0.8)
      ctx.lineTo(x - 0.8, y)
      ctx.closePath()
      ctx.fill()
    }
  }
  if (t.id === 'neon') {
    ctx.save()
    ctx.strokeStyle = '#ff4fd8'
    ctx.lineWidth = 0.45
    ctx.shadowColor = '#ff4fd8'
    ctx.shadowBlur = 1.6 * k // shadows are in device pixels
    roundRect(ctx, win.x - 1.1, win.y - 1.1, win.w + 2.2, win.h + 2.2, 1)
    ctx.stroke()
    ctx.strokeStyle = '#3df5ff'
    ctx.shadowColor = '#3df5ff'
    ctx.lineWidth = 0.25
    roundRect(ctx, win.x - 2, win.y - 2, win.w + 4, win.h + 4, 1.5)
    ctx.stroke()
    ctx.restore()
  }
}

/* ------------------------------------------------------------------ photo */

/** Grey picture with a sun and hills – stands in for a photo. */
function standIn(ctx: Ctx2D, win: Box) {
  const g = ctx.createLinearGradient(0, win.y, 0, win.y + win.h)
  g.addColorStop(0, '#dbe4ee')
  g.addColorStop(1, '#c3cfdc')
  ctx.fillStyle = g
  ctx.fillRect(win.x, win.y, win.w, win.h)
  const u = Math.min(win.w, win.h)
  ctx.fillStyle = '#f4f7fa'
  ctx.beginPath()
  ctx.arc(win.x + win.w * 0.7, win.y + win.h * 0.32, u * 0.11, 0, Math.PI * 2)
  ctx.fill()
  ctx.fillStyle = '#a9b8c8'
  ctx.beginPath()
  ctx.moveTo(win.x, win.y + win.h)
  ctx.lineTo(win.x, win.y + win.h * 0.75)
  ctx.lineTo(win.x + win.w * 0.35, win.y + win.h * 0.45)
  ctx.lineTo(win.x + win.w * 0.6, win.y + win.h * 0.7)
  ctx.lineTo(win.x + win.w * 0.78, win.y + win.h * 0.58)
  ctx.lineTo(win.x + win.w, win.y + win.h * 0.78)
  ctx.lineTo(win.x + win.w, win.y + win.h)
  ctx.closePath()
  ctx.fill()
}

function drawPhoto(ctx: Ctx2D, it: PolaroidItem, photo: PhotoSource, win: Box, backdrop: string) {
  const p = placePhoto(it.crop, photo.pxW, photo.pxH, win.w, win.h)
  ctx.save()
  ctx.beginPath()
  ctx.rect(win.x, win.y, win.w, win.h)
  ctx.clip()
  ctx.fillStyle = backdrop // shows only when zoomed out past the photo edge
  ctx.fillRect(win.x, win.y, win.w, win.h)
  ctx.translate(win.x, win.y)
  ctx.scale(p.scale, p.scale)
  ctx.translate(-p.ox, -p.oy) // now in display pixels
  if (it.crop.flip) {
    ctx.translate(p.rw, 0)
    ctx.scale(-1, 1)
  }
  const W = photo.pxW
  const H = photo.pxH
  // original pixel (x, y) → display pixel, for each clockwise quarter turn
  if (it.crop.turn === 1) ctx.transform(0, 1, -1, 0, H, 0)
  else if (it.crop.turn === 2) ctx.transform(-1, 0, 0, -1, W, H)
  else if (it.crop.turn === 3) ctx.transform(0, -1, 1, 0, 0, W)
  ctx.imageSmoothingEnabled = true
  ctx.imageSmoothingQuality = 'high'
  ctx.drawImage(photo.img, 0, 0, W, H)
  ctx.restore()
}

/** The part of the window the photo actually covers (all of it, unless zoomed out past the photo edge), local mm. */
function visiblePhoto(it: PolaroidItem, photo: PhotoSource, win: Box): Box {
  const p = placePhoto(it.crop, photo.pxW, photo.pxH, win.w, win.h)
  const x0 = Math.max(0, -p.ox * p.scale)
  const y0 = Math.max(0, -p.oy * p.scale)
  const x1 = Math.min(win.w, (p.rw - p.ox) * p.scale)
  const y1 = Math.min(win.h, (p.rh - p.oy) * p.scale)
  return { x: win.x + x0, y: win.y + y0, w: Math.max(0, x1 - x0), h: Math.max(0, y1 - y0) }
}

const clamp255 = (v: number) => (v < 0 ? 0 : v > 255 ? 255 : v)

/** Colour filter on a pixel rectangle (device pixels). */
export function applyFilter(data: Uint8ClampedArray | Uint8Array, filter: FilterId) {
  if (filter === 'none') return
  for (let i = 0; i < data.length; i += 4) {
    let r = data[i]
    let g = data[i + 1]
    let b = data[i + 2]
    const l = 0.299 * r + 0.587 * g + 0.114 * b
    switch (filter) {
      case 'bw':
        r = g = b = l
        break
      case 'noir': {
        const v = (l - 128) * 1.4 + 120
        r = g = b = v
        break
      }
      case 'sepia': {
        const nr = r * 0.393 + g * 0.769 + b * 0.189
        const ng = r * 0.349 + g * 0.686 + b * 0.168
        const nb = r * 0.272 + g * 0.534 + b * 0.131
        r = nr
        g = ng
        b = nb
        break
      }
      case 'vintage':
        r = r * 0.86 + l * 0.08 + 28
        g = g * 0.8 + l * 0.08 + 18
        b = b * 0.66 + l * 0.08 + 22
        break
      case 'warm':
        r = r * 1.07 + 6
        g = g * 1.01 + 2
        b = b * 0.88
        break
      case 'cool':
        r = r * 0.9
        g = g * 1.0 + 2
        b = b * 1.08 + 8
        break
      case 'fade':
        r = r * 0.78 + 42
        g = g * 0.78 + 40
        b = b * 0.78 + 44
        break
      case 'vivid': {
        const s = 1.35
        r = (l + (r - l) * s - 128) * 1.08 + 128
        g = (l + (g - l) * s - 128) * 1.08 + 128
        b = (l + (b - l) * s - 128) * 1.08 + 128
        break
      }
    }
    data[i] = clamp255(r)
    data[i + 1] = clamp255(g)
    data[i + 2] = clamp255(b)
  }
}

function vignette(ctx: Ctx2D, win: Box) {
  const cx = win.x + win.w / 2
  const cy = win.y + win.h / 2
  const r = Math.hypot(win.w, win.h) / 2
  const g = ctx.createRadialGradient(cx, cy, r * 0.45, cx, cy, r)
  g.addColorStop(0, 'rgba(60,35,10,0)')
  g.addColorStop(1, 'rgba(60,35,10,0.38)')
  ctx.fillStyle = g
  ctx.fillRect(win.x, win.y, win.w, win.h)
}

/* ------------------------------------------------------------------ caption */

/** Caption in the bottom strip, shrunk to fit. Drawn in device pixels (crisper text than a scaled font). */
function drawCaption(ctx: Ctx2D, it: PolaroidItem, t: ThemeInfo, W: number, H: number, win: Box, k: number, b: number) {
  const text = it.caption.text.replace(/\s+$/, '')
  if (!text.trim()) return
  const lines = text.split('\n').slice(0, 4)
  const f = fontOf(it.caption.font)
  const top = win.y + win.h
  const stripH = H - top
  const pad = Math.max(1.5, win.x * 0.6)
  const maxW = W - 2 * pad
  const maxH = Math.max(2, stripH - 2)
  let size = Math.max(1.5, it.caption.sizeMm)
  const font = (s: number) => `${f.weight} ${(s * k).toFixed(2)}px "${f.family}", cursive, sans-serif`
  ctx.save()
  ctx.setTransform(1, 0, 0, 1, 0, 0)
  ctx.font = font(size)
  const widest = () => Math.max(...lines.map((l) => ctx.measureText(l).width)) / k
  const lh = 1.18
  // shrink to fit the width and the strip
  const w0 = widest()
  if (w0 > maxW) size *= maxW / w0
  if (lines.length * size * lh > maxH) size = maxH / (lines.length * lh)
  ctx.font = font(size)
  const mid = top + stripH / 2
  const y0 = mid - ((lines.length - 1) * size * lh) / 2
  const align = it.caption.align
  const x = align === 'left' ? pad : align === 'right' ? W - pad : W / 2
  const plate = PLATE[t.id]
  if (plate) {
    const tw = widest()
    const px = align === 'left' ? x : align === 'right' ? x - tw : x - tw / 2
    ctx.fillStyle = plate
    ctx.save()
    ctx.setTransform(k, 0, 0, k, b * k, b * k)
    roundRect(ctx, px - 2, y0 - size * 0.65, tw + 4, (lines.length - 1) * size * lh + size * 1.3, 1.5)
    ctx.fill()
    ctx.restore()
  }
  ctx.fillStyle = it.caption.color ?? t.ink
  ctx.textAlign = align
  ctx.textBaseline = 'middle'
  lines.forEach((l, i) => ctx.fillText(l, (b + x) * k, (b + y0 + i * size * lh) * k))
  ctx.restore()
}

/* ------------------------------------------------------------------ the polaroid */

/** Canvas size in device pixels for a polaroid at this resolution, bleed included. */
export function canvasSize(it: Pick<PolaroidItem, 'formatId' | 'custom'>, pxPerMm: number, bleedMm: number) {
  const f = formatOf(it)
  return { w: Math.max(1, Math.round((f.widthMm + 2 * bleedMm) * pxPerMm)), h: Math.max(1, Math.round((f.heightMm + 2 * bleedMm) * pxPerMm)) }
}

export function drawPolaroid(ctx: Ctx2D, it: PolaroidItem, o: DrawOptions) {
  const f = formatOf(it)
  const t = themeOf(it.theme)
  const W = f.widthMm
  const H = f.heightMm
  const b = Math.max(0, o.bleedMm)
  const k = o.pxPerMm
  const win = photoWindow(f)
  const all: Box = { x: -b, y: -b, w: W + 2 * b, h: H + 2 * b }

  ctx.save()
  ctx.setTransform(k, 0, 0, k, b * k, b * k) // local mm, y down, trim corner at (0, 0)
  drawFrame(ctx, it, t, all, win)

  if (o.photo) drawPhoto(ctx, it, o.photo, win, t.recolorable && it.frameColor ? it.frameColor : t.base)
  else standIn(ctx, win)

  // enhance, then the colour look – on the photo's own pixels only (not the frame, not the backdrop when zoomed out)
  const enhance = it.enhance ?? 'off'
  if (o.photo && (it.filter !== 'none' || enhance !== 'off')) {
    const v = visiblePhoto(it, o.photo, win)
    const x0 = Math.ceil((b + v.x) * k)
    const y0 = Math.ceil((b + v.y) * k)
    const x1 = Math.floor((b + v.x + v.w) * k)
    const y1 = Math.floor((b + v.y + v.h) * k)
    if (x1 > x0 && y1 > y0) {
      const img = ctx.getImageData(x0, y0, x1 - x0, y1 - y0)
      enhancePixels(img.data, img.width, img.height, enhance, k)
      applyFilter(img.data, it.filter)
      ctx.putImageData(img, x0, y0)
    }
  }
  if (it.filter === 'vintage') vignette(ctx, win)
  // a hair of shade where the photo meets the frame, like the real film
  ctx.strokeStyle = 'rgba(0,0,0,0.08)'
  ctx.lineWidth = 0.12
  ctx.strokeRect(win.x, win.y, win.w, win.h)

  drawOverlay(ctx, t, win, k)
  drawCaption(ctx, it, t, W, H, win, k, b)
  ctx.restore()
}
