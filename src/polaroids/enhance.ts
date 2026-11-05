/**
 * "Enhance": makes a photo clearer, at draw time only – the uploaded file is never changed, and switching it off
 * gives the original back. Classic photo-lab steps, in this order:
 *   1. auto levels   – stretches the darkest / brightest 0.5 % to black / white (limited, so noise isn't blown up),
 *                      per channel a little, which takes out a mild colour cast but keeps warm / cool light
 *   2. exposure      – a gentle gamma, only for photos that are clearly too dark or too bright,
 *                      then a soft S-curve for a little more punch
 *   3. vibrance      – lifts dull colours more than already-strong ones (skin stays natural)
 *   4. clarity       – a little local contrast (a large, soft unsharp mask on brightness)
 *   5. sharpen       – a fine unsharp mask on brightness only (no colour fringes), skipping tiny noise
 * Sizes are in mm (converted with px/mm), so the screen preview and the 300 DPI print get the same look.
 */
export type EnhanceLevel = 'off' | 'auto' | 'strong'

export const ENHANCE_LEVELS: { id: EnhanceLevel; name: string; hint: string }[] = [
  { id: 'off', name: 'Off', hint: 'The photo as it is' },
  { id: 'auto', name: 'Auto', hint: 'Balanced brightness, colour and sharpness' },
  { id: 'strong', name: 'Strong', hint: 'For dull, dark or soft photos' },
]

const PARAMS = {
  auto: { levels: 0.8, cast: 0.2, maxStretch: 1.5, gamma: 0.45, curve: 0.3, vibrance: 0.2, clarity: 0.14, sharpen: 0.55 },
  strong: { levels: 1, cast: 0.4, maxStretch: 1.9, gamma: 0.7, curve: 0.5, vibrance: 0.35, clarity: 0.26, sharpen: 0.9 },
}

/** Fast box blur of one channel (sliding window), radius in px. Two passes ≈ a soft gaussian. */
function boxBlur(src: Float32Array, w: number, h: number, r: number): Float32Array {
  if (r < 1) return src.slice()
  const tmp = new Float32Array(src.length)
  const out = new Float32Array(src.length)
  const d = 2 * r + 1
  for (let y = 0; y < h; y++) {
    const row = y * w
    let acc = 0
    for (let x = -r; x <= r; x++) acc += src[row + Math.min(w - 1, Math.max(0, x))]
    for (let x = 0; x < w; x++) {
      tmp[row + x] = acc / d
      acc += src[row + Math.min(w - 1, x + r + 1)] - src[row + Math.max(0, x - r)]
    }
  }
  for (let x = 0; x < w; x++) {
    let acc = 0
    for (let y = -r; y <= r; y++) acc += tmp[Math.min(h - 1, Math.max(0, y)) * w + x]
    for (let y = 0; y < h; y++) {
      out[y * w + x] = acc / d
      acc += tmp[Math.min(h - 1, y + r + 1) * w + x] - tmp[Math.max(0, y - r) * w + x]
    }
  }
  return out
}

const blur2 = (src: Float32Array, w: number, h: number, r: number) => boxBlur(boxBlur(src, w, h, r), w, h, r)

/** Value below which `p` of the pixels fall, from a 256-bin histogram. */
function percentile(hist: Uint32Array, total: number, p: number): number {
  const target = total * p
  let acc = 0
  for (let i = 0; i < 256; i++) {
    acc += hist[i]
    if (acc >= target) return i
  }
  return 255
}

const clamp = (v: number) => (v < 0 ? 0 : v > 255 ? 255 : v)

/** Enhances RGBA pixels in place. `pxPerMm` = the resolution they will be shown / printed at. */
export function enhancePixels(data: Uint8ClampedArray | Uint8Array, w: number, h: number, level: EnhanceLevel, pxPerMm: number) {
  if (level === 'off' || w < 2 || h < 2) return
  const P = PARAMS[level]
  const n = w * h

  // ---------- 1. levels (from histograms, ignoring the extreme 0.5 %)
  const hist = [new Uint32Array(256), new Uint32Array(256), new Uint32Array(256), new Uint32Array(256)]
  for (let i = 0; i < n; i++) {
    const r = data[i * 4]
    const g = data[i * 4 + 1]
    const b = data[i * 4 + 2]
    hist[0][r]++
    hist[1][g]++
    hist[2][b]++
    hist[3][(r * 77 + g * 151 + b * 28) >> 8]++
  }
  const lumLo = percentile(hist[3], n, 0.005)
  const lumHi = percentile(hist[3], n, 0.995)
  const lut: Uint8Array[] = []
  for (let c = 0; c < 3; c++) {
    // mostly the brightness range (keeps the light's colour), a little of the channel's own (takes out a cast)
    const lo = lumLo + (percentile(hist[c], n, 0.005) - lumLo) * P.cast
    const hi = lumHi + (percentile(hist[c], n, 0.995) - lumHi) * P.cast
    const range = Math.max(1, hi - lo)
    const k = Math.min(P.maxStretch, 255 / range)
    // keep the middle of the range in place when the stretch is limited
    const mid = (lo + hi) / 2
    const t = new Uint8Array(256)
    for (let v = 0; v < 256; v++) {
      const s = 255 / range >= P.maxStretch ? (v - mid) * k + 127.5 : (v - lo) * k
      t[v] = clamp(v + (s - v) * P.levels)
    }
    lut.push(t)
  }

  // ---------- 2. exposure: only when the photo is clearly too dark (< 0.36) or too bright (> 0.62), then an S-curve
  let sum = 0
  for (let i = 0; i < n; i++) sum += lut[0][data[i * 4]] * 0.3 + lut[1][data[i * 4 + 1]] * 0.59 + lut[2][data[i * 4 + 2]] * 0.11
  const mean = Math.min(0.95, Math.max(0.05, sum / n / 255))
  const target = mean < 0.36 ? 0.4 : mean > 0.62 ? 0.56 : mean
  const gamma = 1 + (Math.min(1.35, Math.max(0.75, Math.log(target) / Math.log(mean))) - 1) * P.gamma
  const gl = new Uint8Array(256)
  for (let v = 0; v < 256; v++) {
    const x = Math.pow(v / 255, gamma)
    // darks a touch darker, lights a touch lighter; the ends stay put and it never folds over (curve ≤ 1)
    gl[v] = clamp(255 * (x + (P.curve * Math.sin(2 * Math.PI * (x - 0.5))) / (2 * Math.PI)))
  }
  for (let c = 0; c < 3; c++) for (let v = 0; v < 256; v++) lut[c][v] = gl[lut[c][v]]

  // ---------- 3. vibrance, and brightness for the detail passes
  const L = new Float32Array(n)
  for (let i = 0; i < n; i++) {
    let r = lut[0][data[i * 4]]
    let g = lut[1][data[i * 4 + 1]]
    let b = lut[2][data[i * 4 + 2]]
    const mx = Math.max(r, g, b)
    const mn = Math.min(r, g, b)
    const sat = mx ? (mx - mn) / mx : 0
    const l = r * 0.3 + g * 0.59 + b * 0.11
    const boost = 1 + P.vibrance * (1 - sat) * (1 - sat)
    r = l + (r - l) * boost
    g = l + (g - l) * boost
    b = l + (b - l) * boost
    data[i * 4] = clamp(r)
    data[i * 4 + 1] = clamp(g)
    data[i * 4 + 2] = clamp(b)
    L[i] = data[i * 4] * 0.3 + data[i * 4 + 1] * 0.59 + data[i * 4 + 2] * 0.11
  }

  // ---------- 4 + 5. clarity (≈ 1.5 mm) and sharpen (≈ 0.1 mm), on brightness
  const rClarity = Math.max(2, Math.round(1.5 * pxPerMm / 2))
  const rSharp = Math.max(1, Math.round(0.1 * pxPerMm))
  const big = blur2(L, w, h, rClarity)
  const fine = boxBlur(L, w, h, rSharp)
  for (let i = 0; i < n; i++) {
    const local = (L[i] - big[i]) * P.clarity
    let edge = L[i] - fine[i]
    // leave flat areas alone, so grain and JPEG noise aren't sharpened
    edge = Math.abs(edge) < 2 ? 0 : edge * P.sharpen
    const d = local + edge
    if (!d) continue
    data[i * 4] = clamp(data[i * 4] + d)
    data[i * 4 + 1] = clamp(data[i * 4 + 1] + d)
    data[i * 4 + 2] = clamp(data[i * 4 + 2] + d)
  }
}
