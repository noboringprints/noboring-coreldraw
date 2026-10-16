/**
 * Transparency ("matte") helpers for background removal. Pure pixel maths on straight (non-premultiplied) RGBA.
 *
 * - Plain background (logos / clipart on white or one flat colour): flood-fill from the edges, instant, offline.
 * - AI background (photos, complex scenes): the model's low-res mask is sharpened to full resolution with a
 *   guided filter, which follows real edges in the photo, then the background colour is unmixed from soft edges.
 */

export interface RGBA {
  data: Uint8ClampedArray
  w: number
  h: number
}

/* ------------------------------------------------------------------ analysis */

/** Box around everything at least ~3 % opaque (pixels, top-left origin). Null if fully transparent. */
export function opaqueBounds(img: RGBA, minAlpha = 8): { x: number; y: number; w: number; h: number } | null {
  const { data, w, h } = img
  let x0 = w
  let y0 = h
  let x1 = -1
  let y1 = -1
  for (let y = 0; y < h; y++) {
    const row = y * w
    for (let x = 0; x < w; x++) {
      if (data[(row + x) * 4 + 3] < minAlpha) continue
      if (x < x0) x0 = x
      if (x > x1) x1 = x
      if (y < y0) y0 = y
      if (y > y1) y1 = y
    }
  }
  return x1 < 0 ? null : { x: x0, y: y0, w: x1 - x0 + 1, h: y1 - y0 + 1 }
}

/** True if a meaningful part of the image is see-through (a cut-out PNG). */
export function hasTransparency(img: RGBA): boolean {
  const { data } = img
  let clear = 0
  const n = data.length / 4
  const step = Math.max(1, Math.floor(n / 200_000))
  let seen = 0
  for (let i = 0; i < n; i += step) {
    seen++
    if (data[i * 4 + 3] < 128) clear++
  }
  return clear / seen > 0.005
}

export interface BackgroundGuess {
  color: [number, number, number]
  /** Share of edge pixels close to that colour (1 = perfectly plain background). */
  uniformity: number
}

/** Most common colour along the image's edges, and how plain the edge is. */
export function guessBackground(img: RGBA, tol = 28): BackgroundGuess {
  const { data, w, h } = img
  const samples: number[] = []
  const add = (x: number, y: number) => samples.push((y * w + x) * 4)
  const stepX = Math.max(1, Math.floor(w / 400))
  const stepY = Math.max(1, Math.floor(h / 400))
  for (let x = 0; x < w; x += stepX) {
    add(x, 0)
    add(x, h - 1)
  }
  for (let y = 0; y < h; y += stepY) {
    add(0, y)
    add(w - 1, y)
  }
  // coarse colour histogram (32 levels per channel)
  const bins = new Map<number, number>()
  for (const i of samples) {
    const key = ((data[i] >> 3) << 10) | ((data[i + 1] >> 3) << 5) | (data[i + 2] >> 3)
    bins.set(key, (bins.get(key) ?? 0) + 1)
  }
  let bestKey = 0
  let best = -1
  for (const [k, v] of bins)
    if (v > best) {
      best = v
      bestKey = k
    }
  // average the real colours in the winning bin
  let r = 0
  let g = 0
  let b = 0
  let c = 0
  for (const i of samples) {
    const key = ((data[i] >> 3) << 10) | ((data[i + 1] >> 3) << 5) | (data[i + 2] >> 3)
    if (key !== bestKey) continue
    r += data[i]
    g += data[i + 1]
    b += data[i + 2]
    c++
  }
  const color: [number, number, number] = [Math.round(r / c), Math.round(g / c), Math.round(b / c)]
  let close = 0
  for (const i of samples) if (colorDist(data[i], data[i + 1], data[i + 2], color) <= tol) close++
  return { color, uniformity: close / samples.length }
}

/** Perceptually weighted RGB distance (0…~765 scale like plain Euclidean, cheap). */
function colorDist(r: number, g: number, b: number, c: [number, number, number]): number {
  const dr = r - c[0]
  const dg = g - c[1]
  const db = b - c[2]
  const rm = (r + c[0]) / 2
  return Math.sqrt((2 + rm / 256) * dr * dr + 4 * dg * dg + (2 + (255 - rm) / 256) * db * db) / 3
}

/* ------------------------------------------------------------------ plain-colour removal */

export interface PlainRemoveOptions {
  /** Background colour; guessed from the edges when left out. */
  color?: [number, number, number]
  /** How different a pixel may be and still count as background (0–100). */
  tolerance: number
  /** Also remove the same colour where it is enclosed by the design (e.g. inside letters). */
  everywhere: boolean
}

/**
 * Removes a flat background. Pixels connected to the image edge (or all, with `everywhere`) and close to the
 * background colour become transparent; edge pixels get a soft alpha and have the background colour unmixed,
 * so no white halo is left on a coloured border.
 */
export function removePlainBackground(img: RGBA, opts: PlainRemoveOptions): RGBA {
  const { data, w, h } = img
  const n = w * h
  const bg = opts.color ?? guessBackground(img).color
  const tol = 4 + (opts.tolerance / 100) * 90
  const soft = tol * 1.6 // up to here pixels are a mix of art and background
  const dist = new Float32Array(n)
  for (let i = 0; i < n; i++) dist[i] = data[i * 4 + 3] < 8 ? 0 : colorDist(data[i * 4], data[i * 4 + 1], data[i * 4 + 2], bg)

  // which pixels are background
  const isBg = new Uint8Array(n)
  if (opts.everywhere) {
    for (let i = 0; i < n; i++) isBg[i] = dist[i] <= tol ? 1 : 0
  } else {
    const stack = new Int32Array(n)
    let sp = 0
    const push = (i: number) => {
      if (!isBg[i] && dist[i] <= tol) {
        isBg[i] = 1
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
      if (i < n - w) push(i + w)
    }
  }

  const out = new Uint8ClampedArray(data)
  for (let i = 0; i < n; i++) {
    if (isBg[i]) {
      out[i * 4 + 3] = 0
      continue
    }
    // soft edge: only pixels touching the removed background
    const x = i % w
    const touches = (x > 0 && isBg[i - 1]) || (x < w - 1 && isBg[i + 1]) || (i >= w && isBg[i - w]) || (i < n - w && isBg[i + w])
    if (!touches || dist[i] >= soft) continue
    const a = Math.max(0, Math.min(1, (dist[i] - tol) / (soft - tol)))
    setUnmixed(out, i, a * (data[i * 4 + 3] / 255), bg)
  }
  return { data: out, w, h }
}

/** Sets alpha `a` (0–1) on pixel i and removes the background colour mixed into it: C = (I − (1−a)·B) / a. */
function setUnmixed(out: Uint8ClampedArray, i: number, a: number, bg: [number, number, number]) {
  const o = i * 4
  if (a <= 0.004) {
    out[o + 3] = 0
    return
  }
  if (a < 0.999)
    for (let c = 0; c < 3; c++) out[o + c] = Math.max(0, Math.min(255, Math.round((out[o + c] - (1 - a) * bg[c]) / a)))
  out[o + 3] = Math.round(a * 255)
}

/* ------------------------------------------------------------------ AI mask refinement */

/** Running box mean with radius r (separable, O(n) whatever the radius). */
function boxMean(src: Float32Array, w: number, h: number, r: number): Float32Array {
  const tmp = new Float32Array(w * h)
  const out = new Float32Array(w * h)
  for (let y = 0; y < h; y++) {
    const row = y * w
    let acc = 0
    for (let x = -r; x <= r; x++) acc += src[row + Math.min(w - 1, Math.max(0, x))]
    for (let x = 0; x < w; x++) {
      tmp[row + x] = acc / (2 * r + 1)
      acc += src[row + Math.min(w - 1, x + r + 1)] - src[row + Math.max(0, x - r)]
    }
  }
  for (let x = 0; x < w; x++) {
    let acc = 0
    for (let y = -r; y <= r; y++) acc += tmp[Math.min(h - 1, Math.max(0, y)) * w + x]
    for (let y = 0; y < h; y++) {
      out[y * w + x] = acc / (2 * r + 1)
      acc += tmp[Math.min(h - 1, y + r + 1) * w + x] - tmp[Math.max(0, y - r) * w + x]
    }
  }
  return out
}

/**
 * Guided filter (He, Sun & Tang): makes a blurry/low-res mask `p` follow the real edges of the guide image.
 * guide and p are 0–1, same size. Returns the refined mask (0–1).
 */
export function guidedFilter(guide: Float32Array, p: Float32Array, w: number, h: number, r: number, eps: number): Float32Array {
  const n = w * h
  const Ip = new Float32Array(n)
  const II = new Float32Array(n)
  for (let i = 0; i < n; i++) {
    Ip[i] = guide[i] * p[i]
    II[i] = guide[i] * guide[i]
  }
  const mI = boxMean(guide, w, h, r)
  const mp = boxMean(p, w, h, r)
  const mIp = boxMean(Ip, w, h, r)
  const mII = boxMean(II, w, h, r)
  const a = Ip // reuse buffers
  const b = II
  for (let i = 0; i < n; i++) {
    const cov = mIp[i] - mI[i] * mp[i]
    const varI = mII[i] - mI[i] * mI[i]
    a[i] = cov / (varI + eps)
    b[i] = mp[i] - a[i] * mI[i]
  }
  const ma = boxMean(a, w, h, r)
  const mb = boxMean(b, w, h, r)
  const q = mI // reuse
  for (let i = 0; i < n; i++) q[i] = Math.max(0, Math.min(1, ma[i] * guide[i] + mb[i]))
  return q
}

/** Bilinear resize of a single-channel 0–255 mask to w × h, as 0–1 floats. */
export function resizeMask(mask: Uint8Array | Uint8ClampedArray, mw: number, mh: number, w: number, h: number): Float32Array {
  const out = new Float32Array(w * h)
  const sx = mw / w
  const sy = mh / h
  for (let y = 0; y < h; y++) {
    const fy = Math.max(0, Math.min(mh - 1, (y + 0.5) * sy - 0.5))
    const y0 = Math.floor(fy)
    const y1 = Math.min(mh - 1, y0 + 1)
    const ty = fy - y0
    for (let x = 0; x < w; x++) {
      const fx = Math.max(0, Math.min(mw - 1, (x + 0.5) * sx - 0.5))
      const x0 = Math.floor(fx)
      const x1 = Math.min(mw - 1, x0 + 1)
      const tx = fx - x0
      const top = mask[y0 * mw + x0] * (1 - tx) + mask[y0 * mw + x1] * tx
      const bot = mask[y1 * mw + x0] * (1 - tx) + mask[y1 * mw + x1] * tx
      out[y * w + x] = (top * (1 - ty) + bot * ty) / 255
    }
  }
  return out
}

/**
 * Applies an AI mask to the image at full resolution:
 * upscales the mask, sharpens it along real edges (guided filter), tightens the soft edge a little
 * (stickers need a crisp outline), and unmixes the local background colour from edge pixels.
 * `img` should be at most a few megapixels (the caller scales big photos down for this step).
 */
export function applyAiMask(img: RGBA, mask: Uint8Array | Uint8ClampedArray, mw: number, mh: number): RGBA {
  const { data, w, h } = img
  const n = w * h
  const coarse = resizeMask(mask, mw, mh, w, h)
  const guide = new Float32Array(n)
  for (let i = 0; i < n; i++) guide[i] = (0.299 * data[i * 4] + 0.587 * data[i * 4 + 1] + 0.114 * data[i * 4 + 2]) / 255
  const scale = Math.max(w / mw, h / mh)
  const r = Math.max(2, Math.round(scale * 2))
  const fine = guidedFilter(guide, coarse, w, h, r, 1e-3)

  // local background colour = average colour where the mask says "background", for unmixing edges
  const bgW = new Float32Array(n)
  const bgR = new Float32Array(n)
  const bgG = new Float32Array(n)
  const bgB = new Float32Array(n)
  for (let i = 0; i < n; i++) {
    const wgt = coarse[i] < 0.1 ? 1 : 0
    bgW[i] = wgt
    bgR[i] = wgt * data[i * 4]
    bgG[i] = wgt * data[i * 4 + 1]
    bgB[i] = wgt * data[i * 4 + 2]
  }
  const rr = r * 4
  const mW = boxMean(bgW, w, h, rr)
  const mR = boxMean(bgR, w, h, rr)
  const mG = boxMean(bgG, w, h, rr)
  const mB = boxMean(bgB, w, h, rr)

  const out = new Uint8ClampedArray(data)
  for (let i = 0; i < n; i++) {
    // gentle contrast on the matte: crisper edges, fewer faint ghosts
    let a = Math.max(0, Math.min(1, (fine[i] - 0.08) / 0.84))
    a = a * a * (3 - 2 * a)
    a *= data[i * 4 + 3] / 255
    if (a > 0.004 && a < 0.996 && mW[i] > 0.01) {
      const bg: [number, number, number] = [mR[i] / mW[i], mG[i] / mW[i], mB[i] / mW[i]]
      setUnmixed(out, i, a, bg)
    } else out[i * 4 + 3] = Math.round(a * 255)
  }
  return { data: out, w, h }
}

/** Copies a region out of an image. */
export function cropImage(img: RGBA, x: number, y: number, w: number, h: number): RGBA {
  const out = new Uint8ClampedArray(w * h * 4)
  for (let row = 0; row < h; row++) out.set(img.data.subarray(((y + row) * img.w + x) * 4, ((y + row) * img.w + x + w) * 4), row * w * 4)
  return { data: out, w, h }
}
