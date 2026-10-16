/**
 * Exact Euclidean distance transform (Felzenszwalb & Huttenlocher, linear time).
 * For every pixel: the squared distance (in pixels) to the nearest "feature" pixel, and optionally which one it is.
 * This is what turns an artwork outline into an offset outline (CorelDRAW's "Contour").
 */

const INF = 1e20

/** Lower envelope of parabolas for one row/column. `arg` gets the index of the nearest site. */
function dt1d(f: Float64Array, n: number, d: Float64Array, arg: Int32Array, v: Int32Array, z: Float64Array) {
  let k = 0
  v[0] = 0
  z[0] = -INF
  z[1] = INF
  for (let q = 1; q < n; q++) {
    let s = (f[q] + q * q - (f[v[k]] + v[k] * v[k])) / (2 * q - 2 * v[k])
    while (s <= z[k]) {
      k--
      s = (f[q] + q * q - (f[v[k]] + v[k] * v[k])) / (2 * q - 2 * v[k])
    }
    k++
    v[k] = q
    z[k] = s
    z[k + 1] = INF
  }
  k = 0
  for (let q = 0; q < n; q++) {
    while (z[k + 1] < q) k++
    const dq = q - v[k]
    d[q] = dq * dq + f[v[k]]
    arg[q] = v[k]
  }
}

export interface DistanceField {
  /** Squared distance in pixels to the nearest feature pixel (≥ 1e19 when there is none). */
  d2: Float32Array
  /** Index (y·w + x) of the nearest feature pixel, when asked for. */
  nearest?: Int32Array
}

/** `feature[i]` truthy = distance 0 there. */
export function distanceTransform(feature: Uint8Array, w: number, h: number, withNearest = false): DistanceField {
  const n = Math.max(w, h)
  const f = new Float64Array(n)
  const d = new Float64Array(n)
  const arg = new Int32Array(n)
  const v = new Int32Array(n)
  const z = new Float64Array(n + 1)
  const colD = new Float64Array(w * h)
  const colArg = withNearest ? new Int32Array(w * h) : null

  // pass 1: down each column
  for (let x = 0; x < w; x++) {
    for (let y = 0; y < h; y++) f[y] = feature[y * w + x] ? 0 : INF
    dt1d(f, h, d, arg, v, z)
    for (let y = 0; y < h; y++) {
      colD[y * w + x] = d[y]
      if (colArg) colArg[y * w + x] = arg[y]
    }
  }

  // pass 2: along each row
  const d2 = new Float32Array(w * h)
  const nearest = withNearest ? new Int32Array(w * h) : undefined
  for (let y = 0; y < h; y++) {
    const row = y * w
    for (let x = 0; x < w; x++) f[x] = colD[row + x]
    dt1d(f, w, d, arg, v, z)
    for (let x = 0; x < w; x++) {
      d2[row + x] = d[x]
      if (nearest) {
        const nx = arg[x]
        nearest[row + x] = colArg![row + nx] * w + nx
      }
    }
  }
  return { d2, nearest }
}

/** Distance (pixels) from every pixel to the nearest pixel where `mask` is set. */
export function distanceTo(mask: Uint8Array, w: number, h: number): Float32Array {
  const { d2 } = distanceTransform(mask, w, h)
  for (let i = 0; i < d2.length; i++) d2[i] = Math.sqrt(d2[i])
  return d2
}

/** Distance (pixels) from every pixel INSIDE `mask` to the nearest pixel outside it (0 outside). */
export function distanceInside(mask: Uint8Array, w: number, h: number): Float32Array {
  const outside = new Uint8Array(mask.length)
  for (let i = 0; i < mask.length; i++) outside[i] = mask[i] ? 0 : 1
  return distanceTo(outside, w, h)
}

/** Sets every pixel that can't be reached from the image border without crossing `mask` (closes holes). */
export function fillHoles(mask: Uint8Array, w: number, h: number): Uint8Array {
  const outside = new Uint8Array(mask.length)
  const stack = new Int32Array(mask.length)
  let sp = 0
  const push = (i: number) => {
    if (!mask[i] && !outside[i]) {
      outside[i] = 1
      stack[sp++] = i
    }
  }
  for (let x = 0; x < w; x++) {
    push(x)
    push((h - 1) * w + x)
  }
  for (let y = 0; y < h; y++) {
    push(y * w)
    push(y * w + w - 1)
  }
  while (sp) {
    const i = stack[--sp]
    const x = i % w
    if (x > 0) push(i - 1)
    if (x < w - 1) push(i + 1)
    if (i >= w) push(i - w)
    if (i < w * (h - 1)) push(i + w)
  }
  const out = new Uint8Array(mask.length)
  for (let i = 0; i < mask.length; i++) out[i] = outside[i] ? 0 : 1
  return out
}

/** Connected groups of set pixels (8-neighbour). Returns a label per pixel (0 = background) and each group's size. */
export function components(mask: Uint8Array, w: number, h: number): { labels: Int32Array; sizes: number[] } {
  const labels = new Int32Array(mask.length)
  const sizes = [0]
  const stack = new Int32Array(mask.length)
  for (let start = 0; start < mask.length; start++) {
    if (!mask[start] || labels[start]) continue
    const id = sizes.length
    let count = 0
    let sp = 0
    stack[sp++] = start
    labels[start] = id
    while (sp) {
      const i = stack[--sp]
      count++
      const x = i % w
      const y = (i - x) / w
      for (let dy = -1; dy <= 1; dy++) {
        const yy = y + dy
        if (yy < 0 || yy >= h) continue
        for (let dx = -1; dx <= 1; dx++) {
          const xx = x + dx
          if (xx < 0 || xx >= w) continue
          const j = yy * w + xx
          if (mask[j] && !labels[j]) {
            labels[j] = id
            stack[sp++] = j
          }
        }
      }
    }
    sizes.push(count)
  }
  return { labels, sizes }
}
