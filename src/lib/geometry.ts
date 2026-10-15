import { PT_PER_MM } from '../config/defaults'

/** Rectangle in millimetres. Origin is the BOTTOM-LEFT of the sheet (same as PDF). */
export interface Rect {
  x: number
  y: number
  w: number
  h: number
}

/** A straight line in millimetres. */
export interface Segment {
  x1: number
  y1: number
  x2: number
  y2: number
}

/**
 * 2D affine matrix, PDF order: [a, b, c, d, e, f]
 *   x' = a·x + c·y + e
 *   y' = b·x + d·y + f
 */
export type Matrix = [number, number, number, number, number, number]

export const IDENTITY: Matrix = [1, 0, 0, 1, 0, 0]
export const EPS = 1e-6

export const mmToPt = (mm: number) => mm * PT_PER_MM
export const ptToMm = (pt: number) => pt / PT_PER_MM

/** Rounds away floating-point noise (to 1/1000 mm), for display and comparisons. */
export const round3 = (n: number) => Math.round(n * 1000) / 1000

export function expand(r: Rect, by: number): Rect {
  return { x: r.x - by, y: r.y - by, w: r.w + 2 * by, h: r.h + 2 * by }
}

/** True if two rectangles share some area (touching edges do NOT count). */
export function rectsOverlap(a: Rect, b: Rect, eps = 0.01): boolean {
  return a.x < b.x + b.w - eps && b.x < a.x + a.w - eps && a.y < b.y + b.h - eps && b.y < a.y + a.h - eps
}

/** True if `inner` lies completely inside `outer`. */
export function rectInside(inner: Rect, outer: Rect, eps = 0.01): boolean {
  return (
    inner.x >= outer.x - eps &&
    inner.y >= outer.y - eps &&
    inner.x + inner.w <= outer.x + outer.w + eps &&
    inner.y + inner.h <= outer.y + outer.h + eps
  )
}

export function segmentBounds(s: Segment): Rect {
  const x = Math.min(s.x1, s.x2)
  const y = Math.min(s.y1, s.y2)
  return { x, y, w: Math.abs(s.x2 - s.x1), h: Math.abs(s.y2 - s.y1) }
}

/** Does an axis-aligned segment pass through the inside of a rectangle? (Running along its edge doesn't count.) */
export function segmentHitsRect(s: Segment, r: Rect, eps = 0.01): boolean {
  const b = segmentBounds(s)
  if (b.h < EPS) {
    // horizontal
    return b.y > r.y + eps && b.y < r.y + r.h - eps && b.x < r.x + r.w - eps && b.x + b.w > r.x + eps
  }
  // vertical
  return b.x > r.x + eps && b.x < r.x + r.w - eps && b.y < r.y + r.h - eps && b.y + b.h > r.y + eps
}

/** m1 · m2 — the result applies m2 first, then m1. */
export function multiply(m1: Matrix, m2: Matrix): Matrix {
  const [a1, b1, c1, d1, e1, f1] = m1
  const [a2, b2, c2, d2, e2, f2] = m2
  return [
    a1 * a2 + c1 * b2,
    b1 * a2 + d1 * b2,
    a1 * c2 + c1 * d2,
    b1 * c2 + d1 * d2,
    a1 * e2 + c1 * f2 + e1,
    b1 * e2 + d1 * f2 + f1,
  ]
}

export function apply(m: Matrix, x: number, y: number): [number, number] {
  return [m[0] * x + m[2] * y + m[4], m[1] * x + m[3] * y + m[5]]
}

export const translate = (tx: number, ty: number): Matrix => [1, 0, 0, 1, tx, ty]
export const scale = (sx: number, sy = sx): Matrix => [sx, 0, 0, sy, 0, 0]
