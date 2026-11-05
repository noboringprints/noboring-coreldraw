/**
 * "Cute" print frames: small motifs (sunflowers, bows, cherries, lips, leopard spots…) tiled over the whole frame,
 * bleed included, like printed paper – the photo is drawn on top afterwards. All sizes in mm, drawn with Canvas 2D
 * paths only (no images), so they stay sharp at any print resolution and look the same on screen and on paper.
 * Jitter comes from the polaroid's seeded random numbers, so the preview and the print are identical.
 */
import type { ThemeId } from './model'
import type { Ctx2D } from './render'

interface Box {
  x: number
  y: number
  w: number
  h: number
}

/** Calls `cb` on a staggered grid covering `area` (plus a margin, so motifs run off the edges). */
function tile(area: Box, stepX: number, stepY: number, cb: (x: number, y: number, row: number, col: number) => void) {
  let row = 0
  for (let y = area.y - stepY; y < area.y + area.h + stepY; y += stepY, row++) {
    let col = 0
    for (let x = area.x - stepX + (row % 2 ? stepX / 2 : 0); x < area.x + area.w + stepX; x += stepX, col++) cb(x, y, row, col)
  }
}

function withRotation(ctx: Ctx2D, x: number, y: number, a: number, draw: () => void) {
  ctx.save()
  ctx.translate(x, y)
  ctx.rotate(a)
  draw()
  ctx.restore()
}

function circle(ctx: Ctx2D, x: number, y: number, r: number) {
  ctx.beginPath()
  ctx.arc(x, y, r, 0, Math.PI * 2)
}

/** A petal / leaf shape pointing along +x, from 0 to `len`, `w` wide – drawn around the current origin. */
function petal(ctx: Ctx2D, len: number, w: number) {
  ctx.beginPath()
  ctx.moveTo(0, 0)
  ctx.bezierCurveTo(len * 0.3, -w, len * 0.8, -w * 0.8, len, 0)
  ctx.bezierCurveTo(len * 0.8, w * 0.8, len * 0.3, w, 0, 0)
  ctx.closePath()
}

function heartPath(ctx: Ctx2D, x: number, y: number, s: number) {
  ctx.beginPath()
  ctx.moveTo(x, y + s * 0.35)
  ctx.bezierCurveTo(x - s * 0.1, y + s * 0.2, x - s * 0.5, y + s * 0.05, x - s * 0.5, y - s * 0.2)
  ctx.bezierCurveTo(x - s * 0.5, y - s * 0.45, x - s * 0.15, y - s * 0.55, x, y - s * 0.3)
  ctx.bezierCurveTo(x + s * 0.15, y - s * 0.55, x + s * 0.5, y - s * 0.45, x + s * 0.5, y - s * 0.2)
  ctx.bezierCurveTo(x + s * 0.5, y + s * 0.05, x + s * 0.1, y + s * 0.2, x, y + s * 0.35)
  ctx.closePath()
}

/* ------------------------------------------------------------------ motifs (centred on 0, 0) */

function sunflower(ctx: Ctx2D, r: number, rand: () => number) {
  const n = 13
  // back row of petals, a shade darker, then the front row in between
  for (const [shade, off, len] of [
    ['#e9a91a', 0, 1],
    ['#f9cb35', 0.5, 0.92],
  ] as const) {
    ctx.fillStyle = shade
    for (let i = 0; i < n; i++) {
      const a = ((i + off) / n) * Math.PI * 2 + rand() * 0.08
      withRotation(ctx, 0, 0, a, () => {
        petal(ctx, r * len, r * 0.2)
        ctx.fill()
      })
    }
  }
  ctx.fillStyle = '#6b3a1c'
  circle(ctx, 0, 0, r * 0.4)
  ctx.fill()
  ctx.fillStyle = '#3f2210'
  for (let i = 0; i < 9; i++) {
    const a = rand() * Math.PI * 2
    const d = Math.sqrt(rand()) * r * 0.3
    circle(ctx, Math.cos(a) * d, Math.sin(a) * d, r * 0.045)
    ctx.fill()
  }
}

function leafPair(ctx: Ctx2D, s: number, color: string) {
  ctx.fillStyle = color
  for (const a of [-0.5, 0.5]) {
    withRotation(ctx, 0, 0, a, () => {
      petal(ctx, s, s * 0.32)
      ctx.fill()
    })
  }
}

/** A ribbon bow: two loops, two tails and a knot. `outline` draws line-art edges around the fill. */
function bow(ctx: Ctx2D, s: number, fill: string, outline: string | null) {
  const loop = (dir: 1 | -1) => {
    ctx.beginPath()
    ctx.moveTo(0, 0)
    ctx.bezierCurveTo(dir * s * 0.35, -s * 0.55, dir * s * 0.95, -s * 0.45, dir * s * 0.9, -s * 0.05)
    ctx.bezierCurveTo(dir * s * 0.88, s * 0.3, dir * s * 0.35, s * 0.25, 0, 0)
    ctx.closePath()
  }
  const tail = (dir: 1 | -1) => {
    ctx.beginPath()
    ctx.moveTo(dir * s * 0.05, s * 0.05)
    ctx.bezierCurveTo(dir * s * 0.2, s * 0.35, dir * s * 0.25, s * 0.6, dir * s * 0.45, s * 0.85)
    ctx.lineTo(dir * s * 0.3, s * 0.8)
    ctx.lineTo(dir * s * 0.22, s * 0.92)
    ctx.bezierCurveTo(dir * s * 0.08, s * 0.65, dir * s * 0.02, s * 0.35, -dir * s * 0.03, s * 0.08)
    ctx.closePath()
  }
  ctx.lineJoin = 'round'
  ctx.lineWidth = Math.max(0.28, s * 0.06)
  for (const shape of [() => tail(-1), () => tail(1), () => loop(-1), () => loop(1)]) {
    shape()
    ctx.fillStyle = fill
    ctx.fill()
    if (outline) {
      ctx.strokeStyle = outline
      ctx.stroke()
    }
  }
  ctx.beginPath()
  ctx.ellipse(0, 0.02 * s, s * 0.14, s * 0.17, 0, 0, Math.PI * 2)
  ctx.fillStyle = outline ?? fill
  ctx.fill()
}

function cherries(ctx: Ctx2D, s: number) {
  // stems from the top, joined, with a leaf
  ctx.strokeStyle = '#4c7a2a'
  ctx.lineWidth = s * 0.07
  ctx.lineCap = 'round'
  ctx.beginPath()
  ctx.moveTo(-s * 0.35, s * 0.35)
  ctx.quadraticCurveTo(-s * 0.2, -s * 0.2, s * 0.08, -s * 0.55)
  ctx.moveTo(s * 0.35, s * 0.3)
  ctx.quadraticCurveTo(s * 0.25, -s * 0.15, s * 0.08, -s * 0.55)
  ctx.stroke()
  ctx.fillStyle = '#5f9a32'
  withRotation(ctx, s * 0.08, -s * 0.55, -0.4, () => {
    petal(ctx, s * 0.45, s * 0.14)
    ctx.fill()
  })
  for (const [x, y] of [
    [-s * 0.35, s * 0.42],
    [s * 0.35, s * 0.37],
  ]) {
    ctx.fillStyle = '#d3203a'
    circle(ctx, x, y, s * 0.26)
    ctx.fill()
    ctx.fillStyle = 'rgba(255,255,255,0.75)'
    circle(ctx, x - s * 0.09, y - s * 0.09, s * 0.06)
    ctx.fill()
  }
}

function lips(ctx: Ctx2D, s: number) {
  const w = s / 2
  ctx.fillStyle = '#d6183a'
  // upper lip with a cupid's bow
  ctx.beginPath()
  ctx.moveTo(-w, 0)
  ctx.bezierCurveTo(-w * 0.7, -w * 0.15, -w * 0.45, -w * 0.55, -w * 0.18, -w * 0.45)
  ctx.quadraticCurveTo(0, -w * 0.38, 0, -w * 0.28)
  ctx.quadraticCurveTo(0, -w * 0.38, w * 0.18, -w * 0.45)
  ctx.bezierCurveTo(w * 0.45, -w * 0.55, w * 0.7, -w * 0.15, w, 0)
  ctx.quadraticCurveTo(0, w * 0.05, -w, 0)
  ctx.closePath()
  ctx.fill()
  // lower lip
  ctx.beginPath()
  ctx.moveTo(-w, 0.02 * w)
  ctx.quadraticCurveTo(0, w * 0.12, w, 0.02 * w)
  ctx.bezierCurveTo(w * 0.7, w * 0.45, w * 0.3, w * 0.6, 0, w * 0.6)
  ctx.bezierCurveTo(-w * 0.3, w * 0.6, -w * 0.7, w * 0.45, -w, 0.02 * w)
  ctx.closePath()
  ctx.fill()
  // a little shine
  ctx.fillStyle = 'rgba(255,255,255,0.35)'
  ctx.beginPath()
  ctx.ellipse(w * 0.25, w * 0.32, w * 0.18, w * 0.06, -0.2, 0, Math.PI * 2)
  ctx.fill()
}

function orange(ctx: Ctx2D, s: number, slice: boolean) {
  const r = s / 2
  if (slice) {
    ctx.fillStyle = '#f7a440'
    circle(ctx, 0, 0, r)
    ctx.fill()
    ctx.fillStyle = '#fff1d6'
    circle(ctx, 0, 0, r * 0.86)
    ctx.fill()
    ctx.fillStyle = '#fbb45a'
    for (let i = 0; i < 8; i++)
      withRotation(ctx, 0, 0, (i / 8) * Math.PI * 2, () => {
        ctx.beginPath()
        ctx.moveTo(r * 0.1, 0)
        ctx.arc(0, 0, r * 0.76, -0.3, 0.3)
        ctx.closePath()
        ctx.fill()
      })
    return
  }
  ctx.fillStyle = '#f58a1f'
  circle(ctx, 0, 0, r)
  ctx.fill()
  ctx.fillStyle = 'rgba(255,255,255,0.35)'
  circle(ctx, -r * 0.35, -r * 0.35, r * 0.18)
  ctx.fill()
  ctx.fillStyle = '#4f8f2f'
  withRotation(ctx, r * 0.1, -r * 0.9, -0.6, () => {
    petal(ctx, r * 0.9, r * 0.28)
    ctx.fill()
  })
}

function daisy(ctx: Ctx2D, s: number, rand: () => number) {
  const r = s / 2
  ctx.fillStyle = '#ffffff'
  const turn = rand() * Math.PI
  for (let i = 0; i < 9; i++)
    withRotation(ctx, 0, 0, turn + (i / 9) * Math.PI * 2, () => {
      petal(ctx, r, r * 0.26)
      ctx.fill()
    })
  ctx.fillStyle = '#f6c437'
  circle(ctx, 0, 0, r * 0.3)
  ctx.fill()
}

function leopardSpot(ctx: Ctx2D, s: number, rand: () => number) {
  // a tan centre ringed by broken dark blobs
  ctx.fillStyle = '#a8713c'
  ctx.beginPath()
  ctx.ellipse(0, 0, s * 0.32, s * 0.24, rand() * Math.PI, 0, Math.PI * 2)
  ctx.fill()
  ctx.strokeStyle = '#2b1a0f'
  ctx.lineCap = 'round'
  const parts = 2 + Math.floor(rand() * 3)
  const start = rand() * Math.PI * 2
  for (let i = 0; i < parts; i++) {
    const a0 = start + (i / parts) * Math.PI * 2
    const a1 = a0 + ((Math.PI * 2) / parts) * (0.45 + rand() * 0.35)
    ctx.lineWidth = s * (0.12 + rand() * 0.08)
    ctx.beginPath()
    ctx.ellipse(0, 0, s * 0.42, s * 0.34, 0, a0, a1)
    ctx.stroke()
  }
}

/* ------------------------------------------------------------------ frames */

const GINGHAM: Partial<Record<ThemeId, string>> = { gingham: '214,40,40', 'gingham-lilac': '150,118,206', 'gingham-blue': '84,140,214', 'gingham-peach': '240,150,90' }

/** Scalloped line around the photo, with little bows on it (drawn after the photo, so the bows sit over its corners). */
export function scallop(ctx: Ctx2D, win: Box, color: string) {
  const off = 1.8
  const r = 1.4
  const x0 = win.x - off
  const y0 = win.y - off
  const x1 = win.x + win.w + off
  const y1 = win.y + win.h + off
  ctx.strokeStyle = color
  ctx.lineWidth = 0.4
  ctx.beginPath()
  const edge = (ax: number, ay: number, bx: number, by: number) => {
    const len = Math.hypot(bx - ax, by - ay)
    const n = Math.max(1, Math.round(len / (2 * r)))
    const ux = (bx - ax) / len
    const uy = (by - ay) / len
    const seg = len / n
    for (let i = 0; i < n; i++) {
      const cx = ax + ux * seg * (i + 0.5)
      const cy = ay + uy * seg * (i + 0.5)
      const a = Math.atan2(uy, ux)
      // half circles bulging outward (to the left of the clockwise direction)
      ctx.moveTo(cx - (ux * seg) / 2, cy - (uy * seg) / 2)
      ctx.arc(cx, cy, seg / 2, a + Math.PI, a, false)
    }
  }
  edge(x0, y0, x1, y0)
  edge(x1, y0, x1, y1)
  edge(x1, y1, x0, y1)
  edge(x0, y1, x0, y0)
  ctx.stroke()
  const s = Math.min(5, Math.max(3, win.x * 1.05))
  for (const [x, y] of [
    [x0, y0],
    [x1, y0],
    [x0, y1],
    [x1, y1],
    [(x0 + x1) / 2, y0],
  ]) {
    ctx.save()
    ctx.translate(x, y)
    bow(ctx, s, color, null)
    ctx.restore()
  }
}

/** Draws a "cute print" frame. Returns false for themes that aren't drawn here. */
export function drawPrintTheme(ctx: Ctx2D, id: ThemeId, all: Box, rand: () => number): boolean {
  const g = GINGHAM[id]
  if (g) {
    ctx.fillStyle = `rgba(${g},0.33)`
    for (let x = all.x; x < all.x + all.w; x += 6) ctx.fillRect(x, all.y, 3, all.h)
    for (let y = all.y; y < all.y + all.h; y += 6) ctx.fillRect(all.x, y, all.w, 3)
    return true
  }
  const jitter = (n: number) => (rand() - 0.5) * n
  ctx.save()
  ctx.beginPath()
  ctx.rect(all.x, all.y, all.w, all.h)
  ctx.clip()
  switch (id) {
    case 'sunflowers':
      tile(all, 11, 9.5, (x, y) => {
        withRotation(ctx, x + jitter(2), y + jitter(2), rand() * Math.PI, () => {
          ctx.save()
          ctx.translate(0, 3.2)
          leafPair(ctx, 3.4, '#6f9a3c')
          ctx.restore()
          sunflower(ctx, 3.3 + rand() * 0.8, rand)
        })
      })
      break
    case 'bows':
      tile(all, 12, 10, (x, y) => withRotation(ctx, x + jitter(1.5), y + jitter(1.5), jitter(0.5), () => bow(ctx, 5.6, '#fde9ef', '#9e2f4e')))
      break
    case 'cherries':
      tile(all, 8.5, 8, (x, y) => withRotation(ctx, x + jitter(1.5), y + jitter(1.5), jitter(0.9), () => cherries(ctx, 4.2)))
      break
    case 'kisses':
      tile(all, 9, 8, (x, y) => withRotation(ctx, x + jitter(2), y + jitter(2), jitter(1.2), () => lips(ctx, 5 + rand())))
      break
    case 'tiny-hearts':
      ctx.fillStyle = '#e0283f'
      tile(all, 4.6, 4.2, (x, y) =>
        withRotation(ctx, x, y, jitter(0.5), () => {
          heartPath(ctx, 0, 0, 2)
          ctx.fill()
        }),
      )
      break
    case 'oranges':
      tile(all, 9, 8.5, (x, y, row, col) => withRotation(ctx, x + jitter(1.5), y + jitter(1.5), jitter(1), () => orange(ctx, 4.6, (row + col) % 3 === 0)))
      break
    case 'daisies':
      tile(all, 6.5, 6, (x, y) => {
        const s = 3.4 + rand() * 1.4
        withRotation(ctx, x + jitter(2), y + jitter(2), 0, () => {
          ctx.save()
          ctx.translate(s * 0.35, s * 0.45)
          ctx.rotate(0.6)
          ctx.fillStyle = '#86b36a'
          petal(ctx, s * 0.55, s * 0.16)
          ctx.fill()
          ctx.restore()
          daisy(ctx, s, rand)
        })
      })
      break
    case 'leopard':
      tile(all, 6.2, 5.6, (x, y) => withRotation(ctx, x + jitter(2.2), y + jitter(2.2), rand() * Math.PI, () => leopardSpot(ctx, 3.6 + rand() * 1.4, rand)))
      break
    case 'scallop-bows':
      // plain cream – the scalloped line and bows go on after the photo (drawOverlay)
      ctx.restore()
      return true
    default:
      ctx.restore()
      return false
  }
  ctx.restore()
  return true
}
