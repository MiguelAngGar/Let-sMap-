'use strict'
/**
 * fft.js — minimal iterative radix-2 complex FFT (in-place, split re/im).
 * Self-contained, no dependencies. Sizes must be powers of two.
 *
 * Twiddle factors and bit-reversal tables are cached per size.
 */

const _cache = new Map()

function _tables(n) {
  let t = _cache.get(n)
  if (t) return t
  const levels = Math.log2(n) | 0
  if (1 << levels !== n) throw new Error(`FFT size must be a power of 2 (got ${n})`)
  // bit-reversal permutation
  const rev = new Uint32Array(n)
  for (let i = 0; i < n; i++) {
    let x = i, r = 0
    for (let j = 0; j < levels; j++) { r = (r << 1) | (x & 1); x >>= 1 }
    rev[i] = r
  }
  // twiddles for forward transform: e^{-2πi k / n}, k < n/2
  const cos = new Float64Array(n / 2)
  const sin = new Float64Array(n / 2)
  for (let k = 0; k < n / 2; k++) {
    const a = -2 * Math.PI * k / n
    cos[k] = Math.cos(a)
    sin[k] = Math.sin(a)
  }
  t = { levels, rev, cos, sin }
  _cache.set(n, t)
  return t
}

/**
 * In-place complex FFT. inverse=true computes the unscaled inverse
 * (caller divides by n if needed).
 * @param {Float64Array} re
 * @param {Float64Array} im
 * @param {boolean} inverse
 */
function fftComplex(re, im, inverse = false) {
  const n = re.length
  const { rev, cos, sin } = _tables(n)
  for (let i = 0; i < n; i++) {
    const j = rev[i]
    if (j > i) {
      let tmp = re[i]; re[i] = re[j]; re[j] = tmp
      tmp = im[i]; im[i] = im[j]; im[j] = tmp
    }
  }
  const sgn = inverse ? -1 : 1
  for (let size = 2; size <= n; size <<= 1) {
    const half = size >> 1
    const step = n / size
    for (let i = 0; i < n; i += size) {
      for (let j = i, k = 0; j < i + half; j++, k += step) {
        const c = cos[k]
        const s = sgn * sin[k]
        const l = j + half
        const tre = re[l] * c - im[l] * s
        const tim = re[l] * s + im[l] * c
        re[l] = re[j] - tre
        im[l] = im[j] - tim
        re[j] += tre
        im[j] += tim
      }
    }
  }
}

// Scratch buffers for rfft, cached per size
const _rfftCache = new Map()

/**
 * Real-input FFT via complex packing (~2× faster than a padded complex FFT).
 * Computes bins 0..n/2 of the DFT of `input` (length n, power of two).
 * Results are written into outRe/outIm (length ≥ n/2+1).
 *
 * @param {Float64Array} input
 * @param {Float64Array} outRe
 * @param {Float64Array} outIm
 */
function rfft(input, outRe, outIm) {
  const n = input.length
  const half = n >> 1
  let s = _rfftCache.get(n)
  if (!s) {
    const cos = new Float64Array(half + 1)
    const sin = new Float64Array(half + 1)
    for (let k = 0; k <= half; k++) {
      const a = -2 * Math.PI * k / n
      cos[k] = Math.cos(a)
      sin[k] = Math.sin(a)
    }
    s = { re: new Float64Array(half), im: new Float64Array(half), cos, sin }
    _rfftCache.set(n, s)
  }
  const { re, im, cos, sin } = s
  for (let i = 0; i < half; i++) {
    re[i] = input[2 * i]
    im[i] = input[2 * i + 1]
  }
  fftComplex(re, im, false)

  // Untangle: X[k] = E[k] + e^{-2πik/n}·O[k]
  outRe[0] = re[0] + im[0]
  outIm[0] = 0
  outRe[half] = re[0] - im[0]
  outIm[half] = 0
  for (let k = 1; k < half; k++) {
    const j = half - k
    const er = 0.5 * (re[k] + re[j])
    const ei = 0.5 * (im[k] - im[j])
    const or_ = 0.5 * (im[k] + im[j])
    const oi = -0.5 * (re[k] - re[j])
    const c = cos[k], sn = sin[k]
    const tr = or_ * c - oi * sn
    const ti = or_ * sn + oi * c
    outRe[k] = er + tr
    outIm[k] = ei + ti
  }
}

module.exports = { fftComplex, rfft }
