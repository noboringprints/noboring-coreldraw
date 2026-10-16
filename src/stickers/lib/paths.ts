/**
 * Cut-line geometry: tracing outlines from a pixel field, simplifying them, and turning them into
 * smooth Bézier curves – the kind of path a plotter cuts in one clean pass.
 * Paths are in millimetres, origin bottom-left, y up (same as PDF).
 */
import type { Rect } from '../../lib/geometry'

export type Pt = [number, number]
/** Cubic Bézier segment: control 1, control 2, end point. Starts where the previous one ended. */
export type Seg = [number, number, number, number, number, number]
/** A closed path. The last segment ends back at `start`. */
export interface BezierPath {
  start: Pt
  segs: Seg[]
}

/* ------------------------------------------------------------------ tracing */

/**
 * Marching squares: closed outlines where `field` crosses `level` (inside = field ≥ level).
 * Pixel (x, y) is sampled at its centre; returned points are in pixel units, y down.
 * The field must be below `level` along its outer border (pad the image), so every outline is closed.
 */
export function traceContours(field: Float32Array, w: number, h: number, level: number): Pt[][] {
  const at = (x: number, y: number) => field[y * w + x]
  // an edge point is identified by its grid edge: horizontal edges 2i, vertical edges 2i+1
  const point = new Map<number, Pt>()
  const edgePoint = (id: number): Pt => {
    let p = point.get(id)
    if (p) return p
    const cell = id >> 1
    const x = cell % w
    const y = (cell - x) / w
    const a = at(x, y)
    if (id & 1) {
      const b = at(x, y + 1)
      p = [x + 0.5, y + 0.5 + t(a, b)]
    } else {
      const b = at(x + 1, y)
      p = [x + 0.5 + t(a, b), y + 0.5]
    }
    point.set(id, p)
    return p
  }
  const t = (a: number, b: number) => (a === b ? 0.5 : Math.min(1, Math.max(0, (level - a) / (b - a))))

  // links: each edge point joins exactly two segments
  const links = new Map<number, number[]>()
  const link = (a: number, b: number) => {
    let la = links.get(a)
    if (!la) links.set(a, (la = []))
    la.push(b)
    let lb = links.get(b)
    if (!lb) links.set(b, (lb = []))
    lb.push(a)
  }

  for (let y = 0; y < h - 1; y++) {
    for (let x = 0; x < w - 1; x++) {
      const tl = at(x, y) >= level ? 8 : 0
      const tr = at(x + 1, y) >= level ? 4 : 0
      const br = at(x + 1, y + 1) >= level ? 2 : 0
      const bl = at(x, y + 1) >= level ? 1 : 0
      const c = tl | tr | br | bl
      if (c === 0 || c === 15) continue
      const i = y * w + x
      const T = 2 * i
      const B = 2 * (i + w)
      const L = 2 * i + 1
      const R = 2 * (i + 1) + 1
      switch (c) {
        case 1:
        case 14:
          link(L, B)
          break
        case 2:
        case 13:
          link(B, R)
          break
        case 3:
        case 12:
          link(L, R)
          break
        case 4:
        case 11:
          link(T, R)
          break
        case 6:
        case 9:
          link(T, B)
          break
        case 7:
        case 8:
          link(L, T)
          break
        case 5:
        case 10: {
          // saddle: decide by the cell centre
          const centre = (at(x, y) + at(x + 1, y) + at(x + 1, y + 1) + at(x, y + 1)) / 4 >= level
          if ((c === 5) === centre) {
            link(L, T)
            link(B, R)
          } else {
            link(L, B)
            link(T, R)
          }
          break
        }
      }
    }
  }

  const loops: Pt[][] = []
  const used = new Set<number>()
  for (const startId of links.keys()) {
    if (used.has(startId)) continue
    const loop: Pt[] = []
    let prev = -1
    let cur = startId
    while (!used.has(cur)) {
      used.add(cur)
      loop.push(edgePoint(cur))
      const next: number[] = links.get(cur)!
      const n = next[0] !== prev ? next[0] : next[1]
      if (n === undefined) break
      prev = cur
      cur = n
    }
    if (loop.length >= 3) loops.push(loop)
  }
  return loops
}

/* ------------------------------------------------------------------ polygons */

export function signedArea(p: Pt[]): number {
  let a = 0
  for (let i = 0, j = p.length - 1; i < p.length; j = i++) a += (p[j][0] - p[i][0]) * (p[j][1] + p[i][1])
  return a / 2
}

/** Light smoothing that removes pixel stair-steps but keeps sharp corners (turns of more than ~50°). */
export function smoothPolygon(p: Pt[], passes = 2): Pt[] {
  let cur = p
  for (let k = 0; k < passes; k++) {
    const n = cur.length
    const next: Pt[] = new Array(n)
    for (let i = 0; i < n; i++) {
      const a = cur[(i - 1 + n) % n]
      const b = cur[i]
      const c = cur[(i + 1) % n]
      if (turnAngle(a, b, c) > 0.9) next[i] = b
      else next[i] = [(a[0] + 2 * b[0] + c[0]) / 4, (a[1] + 2 * b[1] + c[1]) / 4]
    }
    cur = next
  }
  return cur
}

function turnAngle(a: Pt, b: Pt, c: Pt): number {
  const ux = b[0] - a[0]
  const uy = b[1] - a[1]
  const vx = c[0] - b[0]
  const vy = c[1] - b[1]
  const lu = Math.hypot(ux, uy)
  const lv = Math.hypot(vx, vy)
  if (lu < 1e-9 || lv < 1e-9) return 0
  return Math.acos(Math.max(-1, Math.min(1, (ux * vx + uy * vy) / (lu * lv))))
}

/** Ramer–Douglas–Peucker for a closed polygon: drops points closer than `tol` to the simplified outline. */
export function simplifyClosed(p: Pt[], tol: number): Pt[] {
  if (p.length < 8) return p
  // split at the point farthest from p[0] so both halves are open polylines
  let far = 0
  let best = -1
  for (let i = 1; i < p.length; i++) {
    const d = (p[i][0] - p[0][0]) ** 2 + (p[i][1] - p[0][1]) ** 2
    if (d > best) {
      best = d
      far = i
    }
  }
  const a = simplifyOpen(p.slice(0, far + 1), tol)
  const b = simplifyOpen([...p.slice(far), p[0]], tol)
  return [...a.slice(0, -1), ...b.slice(0, -1)]
}

function simplifyOpen(p: Pt[], tol: number): Pt[] {
  const keep = new Uint8Array(p.length)
  keep[0] = keep[p.length - 1] = 1
  const stack: [number, number][] = [[0, p.length - 1]]
  const tol2 = tol * tol
  while (stack.length) {
    const [s, e] = stack.pop()!
    let idx = -1
    let max = tol2
    const [x1, y1] = p[s]
    const [x2, y2] = p[e]
    const dx = x2 - x1
    const dy = y2 - y1
    const len2 = dx * dx + dy * dy
    for (let i = s + 1; i < e; i++) {
      const [x, y] = p[i]
      let d2: number
      if (len2 < 1e-12) d2 = (x - x1) ** 2 + (y - y1) ** 2
      else {
        const t = Math.max(0, Math.min(1, ((x - x1) * dx + (y - y1) * dy) / len2))
        d2 = (x - x1 - t * dx) ** 2 + (y - y1 - t * dy) ** 2
      }
      if (d2 > max) {
        max = d2
        idx = i
      }
    }
    if (idx > 0) {
      keep[idx] = 1
      stack.push([s, idx], [idx, e])
    }
  }
  return p.filter((_, i) => keep[i])
}

/**
 * Smooth closed Bézier through the points (Catmull-Rom). Sharp corners (turn > `cornerRad`) stay sharp,
 * so a square logo keeps square corners while curves come out as clean arcs.
 */
export function bezierThrough(p: Pt[], cornerRad = 0.75): BezierPath {
  const n = p.length
  const corner = p.map((b, i) => turnAngle(p[(i - 1 + n) % n], b, p[(i + 1) % n]) > cornerRad)
  const segs: Seg[] = []
  for (let i = 0; i < n; i++) {
    const p0 = p[(i - 1 + n) % n]
    const p1 = p[i]
    const p2 = p[(i + 1) % n]
    const p3 = p[(i + 2) % n]
    // tangent length scaled to the segment, so short segments next to long ones don't overshoot
    const seg = Math.hypot(p2[0] - p1[0], p2[1] - p1[1])
    const t1 = corner[i] ? [0, 0] : tangent(p0, p2, seg)
    const t2 = corner[(i + 1) % n] ? [0, 0] : tangent(p1, p3, seg)
    segs.push([p1[0] + t1[0], p1[1] + t1[1], p2[0] - t2[0], p2[1] - t2[1], p2[0], p2[1]])
  }
  return { start: [p[0][0], p[0][1]], segs }
}

/** Tangent at a point from its neighbours `a` and `c`, sized for a segment of `segLen`. */
function tangent(a: Pt, c: Pt, segLen: number): [number, number] {
  const dx = c[0] - a[0]
  const dy = c[1] - a[1]
  const l = Math.hypot(dx, dy)
  if (l < 1e-9) return [0, 0]
  const k = segLen / 3 / l
  return [dx * k, dy * k]
}

/** Straight-line closed path through the points. */
export function polygonPath(p: Pt[]): BezierPath {
  const segs: Seg[] = p.map((a, i) => {
    const b = p[(i + 1) % p.length]
    return [a[0] + (b[0] - a[0]) / 3, a[1] + (b[1] - a[1]) / 3, a[0] + (2 * (b[0] - a[0])) / 3, a[1] + (2 * (b[1] - a[1])) / 3, b[0], b[1]]
  })
  return { start: [p[0][0], p[0][1]], segs }
}

/* ------------------------------------------------------------------ shapes */

/** 4·(√2−1)/3: control-point distance for a quarter circle. */
const KAPPA = 0.5522847498

/** Rectangle with rounded corners (radius 0 = sharp), counter-clockwise from the bottom edge. */
export function roundedRectPath(x: number, y: number, w: number, h: number, radius: number): BezierPath {
  const r = Math.max(0, Math.min(radius, w / 2, h / 2))
  if (r < 1e-6) return polygonPath([[x, y], [x + w, y], [x + w, y + h], [x, y + h]])
  const k = r * KAPPA
  const line = (ax: number, ay: number, bx: number, by: number): Seg => [ax + (bx - ax) / 3, ay + (by - ay) / 3, ax + (2 * (bx - ax)) / 3, ay + (2 * (by - ay)) / 3, bx, by]
  const x0 = x
  const x1 = x + w
  const y0 = y
  const y1 = y + h
  return {
    start: [x0 + r, y0],
    segs: [
      line(x0 + r, y0, x1 - r, y0),
      [x1 - r + k, y0, x1, y0 + r - k, x1, y0 + r],
      line(x1, y0 + r, x1, y1 - r),
      [x1, y1 - r + k, x1 - r + k, y1, x1 - r, y1],
      line(x1 - r, y1, x0 + r, y1),
      [x0 + r - k, y1, x0, y1 - r + k, x0, y1 - r],
      line(x0, y1 - r, x0, y0 + r),
      [x0, y0 + r - k, x0 + r - k, y0, x0 + r, y0],
    ],
  }
}

export function ellipsePath(cx: number, cy: number, rx: number, ry: number): BezierPath {
  const kx = rx * KAPPA
  const ky = ry * KAPPA
  return {
    start: [cx + rx, cy],
    segs: [
      [cx + rx, cy + ky, cx + kx, cy + ry, cx, cy + ry],
      [cx - kx, cy + ry, cx - rx, cy + ky, cx - rx, cy],
      [cx - rx, cy - ky, cx - kx, cy - ry, cx, cy - ry],
      [cx + kx, cy - ry, cx + rx, cy - ky, cx + rx, cy],
    ],
  }
}

/* ------------------------------------------------------------------ utilities */

/** Points along the path (each curve split into `steps` lines). */
export function flatten(path: BezierPath, steps = 8): Pt[] {
  const out: Pt[] = []
  let [x0, y0] = path.start
  for (const [c1x, c1y, c2x, c2y, x, y] of path.segs) {
    for (let i = 0; i < steps; i++) {
      const t = i / steps
      const u = 1 - t
      out.push([
        u * u * u * x0 + 3 * u * u * t * c1x + 3 * u * t * t * c2x + t * t * t * x,
        u * u * u * y0 + 3 * u * u * t * c1y + 3 * u * t * t * c2y + t * t * t * y,
      ])
    }
    x0 = x
    y0 = y
  }
  return out
}

/** Bounding box of the paths (from the curves themselves, not just the control points). */
export function pathsBounds(paths: BezierPath[]): Rect {
  let x0 = Infinity
  let y0 = Infinity
  let x1 = -Infinity
  let y1 = -Infinity
  for (const p of paths)
    for (const [x, y] of flatten(p, 16)) {
      if (x < x0) x0 = x
      if (y < y0) y0 = y
      if (x > x1) x1 = x
      if (y > y1) y1 = y
    }
  if (!Number.isFinite(x0)) return { x: 0, y: 0, w: 0, h: 0 }
  return { x: x0, y: y0, w: x1 - x0, h: y1 - y0 }
}

export function mapPath(path: BezierPath, f: (x: number, y: number) => Pt): BezierPath {
  return {
    start: f(path.start[0], path.start[1]),
    segs: path.segs.map(([a, b, c, d, e, g]) => {
      const p1 = f(a, b)
      const p2 = f(c, d)
      const p3 = f(e, g)
      return [p1[0], p1[1], p2[0], p2[1], p3[0], p3[1]] as Seg
    }),
  }
}

export function pathLength(path: BezierPath): number {
  const pts = flatten(path, 12)
  let l = 0
  for (let i = 0; i < pts.length; i++) {
    const a = pts[i]
    const b = pts[(i + 1) % pts.length]
    l += Math.hypot(b[0] - a[0], b[1] - a[1])
  }
  return l
}

/** SVG path data. `f` maps path coordinates to SVG coordinates. */
export function svgPathData(path: BezierPath, f: (x: number, y: number) => Pt = (x, y) => [x, y], digits = 3): string {
  const r = (n: number) => String(Math.round(n * 10 ** digits) / 10 ** digits)
  const m = mapPath(path, f)
  let d = `M${r(m.start[0])} ${r(m.start[1])}`
  for (const s of m.segs) d += `C${r(s[0])} ${r(s[1])} ${r(s[2])} ${r(s[3])} ${r(s[4])} ${r(s[5])}`
  return d + 'Z'
}
