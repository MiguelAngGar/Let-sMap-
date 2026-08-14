'use strict'
/**
 * findtempo.js — BPM + offset estimation, port of ArrowVortex's FindTempo.cpp
 * (Bram van de Wetering, "Non-causal Beat Tracking for Rhythm Games").
 *
 * Faithful to the original in every behavioural decision:
 *   - Interval sweep at sample resolution, coarse (every 10 samples,
 *     histogram downsampled ×8) → cubic-polynomial fitness normalisation →
 *     full refinement around promising peaks.
 *   - Gap confidence: Hamming-windowed support of the wrapped-onset
 *     histogram, plus 0.5× the offbeat position.
 *   - Conservative integer rounding (snap only within 0.05 BPM and only if
 *     the rounded fitness ≥ 99% of the unrounded one).
 *   - Duplicate/octave removal, second-opinion pass when the top two
 *     candidates are within 5%, top-3 results.
 *   - Offset from the best gap position, disambiguated against the offbeat
 *     using waveform slopes.
 *
 * Implementation note: the original evaluates gap confidence only at onset
 * positions; we evaluate it at every histogram position via FFT circular
 * correlation, which contains the original's search space (positions without
 * onset support cannot win) and is much faster in JS.
 */

const { fftComplex } = require('./fft')

const MIN_BPM = 89.0
const MAX_BPM = 205.0
const INTERVAL_DELTA = 10
const INTERVAL_DOWNSAMPLE = 3
const GAP_WINDOW = 2048

// ── FFT-correlation gap confidence ───────────────────────────────────────────

function nextPow2(n) { let p = 1; while (p < n) p <<= 1; return p }

const _winFFTCache = new Map()

/** FFT of a Hamming window of length ws, zero-padded to `pad` (conjugated). */
function windowFFT(ws, pad) {
  const key = ws + ':' + pad
  let w = _winFFTCache.get(key)
  if (w) return w
  const re = new Float64Array(pad)
  const im = new Float64Array(pad)
  const t = TWO_PI_HAMMING / (ws - 1)
  for (let i = 0; i < ws; i++) re[i] = 0.54 - 0.46 * Math.cos(i * t)
  fftComplex(re, im, false)
  // conjugate for cross-correlation
  for (let i = 0; i < pad; i++) im[i] = -im[i]
  w = { re, im }
  _winFFTCache.set(key, w)
  return w
}
const TWO_PI_HAMMING = 6.2831853071795864

/**
 * Windowed circular support of a wrapped histogram, evaluated everywhere.
 * scores[p] = Σ_j hist[(p−ws/2+j) mod red] · hamming[j]
 *
 * @param {Float64Array} hist  wrapped histogram, length red
 * @param {number} ws          window size
 * @returns {Float64Array} scores, length red
 */
function circularSupport(hist, ws) {
  const red = hist.length
  if (ws > red) ws = red
  const pad = nextPow2(red + ws)
  const re = new Float64Array(pad)
  const im = new Float64Array(pad)
  // extended histogram (wrap the first ws samples) → linear correlation
  re.set(hist)
  for (let i = 0; i < ws; i++) re[red + i] = hist[i]
  fftComplex(re, im, false)
  const w = windowFFT(ws, pad)
  for (let i = 0; i < pad; i++) {
    const a = re[i], b = im[i]
    re[i] = a * w.re[i] - b * w.im[i]
    im[i] = a * w.im[i] + b * w.re[i]
  }
  fftComplex(re, im, true)
  const inv = 1 / pad
  const half = ws >> 1
  const scores = new Float64Array(red)
  // corr[k] = Σ_j ext[k+j]·win[j]; window centered → shift by ws/2
  for (let p = 0; p < red; p++) {
    let k = p - half
    if (k < 0) k += red
    scores[p] = re[k] * inv
  }
  return scores
}

/** Best gap score for a histogram: max over p of score[p] + 0.5·score[offbeat]. */
function bestGap(hist, ws) {
  const red = hist.length
  const scores = circularSupport(hist, ws)
  const half = red >> 1
  let best = 0, bestPos = 0
  for (let p = 0; p < red; p++) {
    let ob = p + half
    if (ob >= red) ob -= red
    const v = scores[p] + 0.5 * scores[ob]
    if (v > best) { best = v; bestPos = p }
  }
  return { confidence: best, pos: bestPos }
}

// ── Histograms ────────────────────────────────────────────────────────────────

/** Integer-interval histogram of onset strengths, downsampled positions. */
function histForInterval(positions, strengths, interval, downsample) {
  const red = interval >> downsample
  const hist = new Float64Array(red)
  for (let i = 0; i < positions.length; i++) {
    let p = (positions[i] % interval) >> downsample
    if (p >= red) p = red - 1
    hist[p] += strengths[i]
  }
  return hist
}

/** Float-interval histogram (for exact-BPM confidence checks). */
function histForBPM(positions, strengths, sampleRate, bpm) {
  const intervalf = sampleRate * 60.0 / bpm
  const red = Math.round(intervalf)
  const hist = new Float64Array(red)
  for (let i = 0; i < positions.length; i++) {
    let p = Math.floor(positions[i] % intervalf)
    if (p >= red) p = red - 1
    hist[p] += strengths[i]
  }
  return hist
}

// ── Confidence functions (mirror the originals) ──────────────────────────────

function confidenceForInterval(positions, strengths, interval, downsample) {
  const hist = histForInterval(positions, strengths, interval, downsample)
  const ws = Math.min(GAP_WINDOW >> downsample, hist.length)
  return bestGap(hist, ws).confidence
}

function confidenceForBPM(positions, strengths, sampleRate, bpm, poly) {
  const hist = histForBPM(positions, strengths, sampleRate, bpm)
  const ws = Math.min(GAP_WINDOW, hist.length)
  const conf = bestGap(hist, ws).confidence
  return conf - evalPoly(poly, sampleRate * 60.0 / bpm)
}

// ── Cubic polynomial fit (fitness normalisation) ─────────────────────────────

/**
 * Least-squares cubic fit y ≈ c0 + c1·x + c2·x² + c3·x³.
 * x is normalised internally for conditioning.
 */
function polyfit3(xs, ys) {
  const n = xs.length
  const xmax = Math.max(...xs)
  const S = new Float64Array(7)   // Σ x^k, k=0..6
  const T = new Float64Array(4)   // Σ y·x^k, k=0..3
  for (let i = 0; i < n; i++) {
    const x = xs[i] / xmax
    let xp = 1
    for (let k = 0; k <= 6; k++) { S[k] += xp; xp *= x }
    xp = 1
    for (let k = 0; k <= 3; k++) { T[k] += ys[i] * xp; xp *= x }
  }
  // 4×4 normal equations, Gaussian elimination
  const A = [
    [S[0], S[1], S[2], S[3], T[0]],
    [S[1], S[2], S[3], S[4], T[1]],
    [S[2], S[3], S[4], S[5], T[2]],
    [S[3], S[4], S[5], S[6], T[3]]
  ]
  for (let col = 0; col < 4; col++) {
    let piv = col
    for (let r = col + 1; r < 4; r++) if (Math.abs(A[r][col]) > Math.abs(A[piv][col])) piv = r
    const tmp = A[col]; A[col] = A[piv]; A[piv] = tmp
    const d = A[col][col] || 1e-30
    for (let r = 0; r < 4; r++) {
      if (r === col) continue
      const f = A[r][col] / d
      for (let c = col; c <= 4; c++) A[r][c] -= f * A[col][c]
    }
  }
  const c = [A[0][4] / (A[0][0] || 1e-30), A[1][4] / (A[1][1] || 1e-30),
             A[2][4] / (A[2][2] || 1e-30), A[3][4] / (A[3][3] || 1e-30)]
  return { c, xmax }
}

function evalPoly(poly, x) {
  const t = x / poly.xmax
  return poly.c[0] + t * (poly.c[1] + t * (poly.c[2] + t * poly.c[3]))
}

// ── BPM candidate search (CalculateBPM) ──────────────────────────────────────

/**
 * @param {Float64Array} positions  onset sample positions
 * @param {Float64Array} strengths  onset strengths
 * @param {number} sampleRate
 * @returns {{bpm:number, fitness:number, offset:number}[]} top candidates (desc fitness)
 */
function calculateBPM(positions, strengths, sampleRate) {
  if (positions.length < 2) return []

  const minInterval = Math.round(sampleRate * 60.0 / MAX_BPM)
  const maxInterval = Math.round(sampleRate * 60.0 / MIN_BPM)
  const numIntervals = maxInterval - minInterval
  const intervalToBPM = i => (sampleRate * 60.0) / (i + minInterval)

  const fitness = new Float64Array(numIntervals)

  // 1. Coarse scan (every INTERVAL_DELTA samples, downsampled histogram)
  const coarseX = []
  const coarseY = []
  for (let i = 0; i < numIntervals; i += INTERVAL_DELTA) {
    const f = Math.max(0.001,
      confidenceForInterval(positions, strengths, minInterval + i, INTERVAL_DOWNSAMPLE))
    fitness[i] = f
    coarseX.push(minInterval + i)
    coarseY.push(f)
  }

  // 2. Normalise the fitness trend with a cubic fit
  const poly = polyfit3(coarseX, coarseY)
  let maxFitness = 0.001
  for (let i = 0; i < numIntervals; i += INTERVAL_DELTA) {
    fitness[i] -= evalPoly(poly, minInterval + i)
    if (fitness[i] > maxFitness) maxFitness = fitness[i]
  }

  // 3. Refine around promising coarse intervals
  const results = []
  const threshold = maxFitness * 0.4
  for (let i = 0; i < numIntervals; i += INTERVAL_DELTA) {
    if (fitness[i] <= threshold) continue
    const begin = Math.max(0, i - INTERVAL_DELTA)
    const end = Math.min(numIntervals, i + INTERVAL_DELTA)
    for (let j = begin; j < end; j++) {
      if (fitness[j] === 0) {
        let f = confidenceForInterval(positions, strengths, minInterval + j, INTERVAL_DOWNSAMPLE)
        f -= evalPoly(poly, minInterval + j)
        fitness[j] = Math.max(f, 0.1)
      }
    }
    let best = begin
    for (let j = begin; j < end; j++) if (fitness[j] > fitness[best]) best = j
    results.push({ bpm: intervalToBPM(best), fitness: fitness[best], offset: 0 })
  }

  // 4. Full-precision passes: sort, dedupe, conservative integer rounding
  results.sort((a, b) => b.fitness - a.fitness)
  removeDuplicates(results)
  roundBPMValues(results, positions, strengths, sampleRate, poly)

  // 5. Second opinion when the top two are very close
  if (results.length >= 2 && results[0].fitness / results[1].fitness < 1.05) {
    for (const r of results) {
      r.fitness = confidenceForBPM(positions, strengths, sampleRate, r.bpm, poly)
    }
    results.sort((a, b) => b.fitness - a.fitness)
  }

  return results.slice(0, 3)
}

/** Remove near-duplicates and ×2 / ×0.5 multiples of better candidates. */
function removeDuplicates(results) {
  for (let i = 0; i < results.length; i++) {
    const bpm = results[i].bpm
    for (let j = results.length - 1; j > i; j--) {
      const v = results[j].bpm
      const d = Math.min(Math.abs(v - bpm), Math.abs(v - bpm * 2), Math.abs(v - bpm * 0.5))
      if (d < 0.1) results.splice(j, 1)
    }
  }
}

/** ArrowVortex integer rounding: <0.01 always, <0.05 only if ≥99% fitness. */
function roundBPMValues(results, positions, strengths, sampleRate, poly) {
  for (const r of results) {
    const rounded = Math.round(r.bpm)
    const diff = Math.abs(r.bpm - rounded)
    if (diff < 0.01) {
      r.bpm = rounded
    } else if (diff < 0.05) {
      const cur = confidenceForBPM(positions, strengths, sampleRate, r.bpm, poly)
      const rnd = confidenceForBPM(positions, strengths, sampleRate, rounded, poly)
      if (rnd > cur * 0.99) r.bpm = rounded
    }
  }
}

// ── Offset (CalculateOffset) ─────────────────────────────────────────────────

/**
 * Base offset for a BPM: gap position with the highest support of a
 * count histogram (weights = 1.0, window 1024, full resolution — as the
 * original).
 */
function baseOffset(positions, sampleRate, bpm) {
  const intervalf = sampleRate * 60.0 / bpm
  const red = Math.round(intervalf)
  const hist = new Float64Array(red)
  for (let i = 0; i < positions.length; i++) {
    let p = Math.floor(positions[i] % intervalf)
    if (p >= red) p = red - 1
    hist[p] += 1.0
  }
  const ws = Math.min(GAP_WINDOW >> 1, red)
  return bestGap(hist, ws).pos / sampleRate
}

/** Sliding-window amplitude slopes of the waveform (original ComputeSlopes). */
function computeSlopes(samples, sampleRate) {
  const n = samples.length
  const out = new Float64Array(n)
  const wh = Math.floor(sampleRate / 20)
  if (n < wh * 2) return out
  let sumL = 0, sumR = 0
  for (let i = 0, j = wh; i < wh; i++, j++) {
    sumL += Math.abs(samples[i])
    sumR += Math.abs(samples[j])
  }
  const scalar = 1.0 / wh
  for (let i = wh, end = n - wh; i < end; i++) {
    out[i] = Math.max(0, (sumR - sumL) * scalar)
    const cur = Math.abs(samples[i])
    sumL -= Math.abs(samples[i - wh]); sumL += cur
    sumR -= cur; sumR += Math.abs(samples[i + wh])
  }
  return out
}

/** Pick offset vs its offbeat by comparing waveform-slope support. */
function adjustForOffbeats(slopes, sampleRate, offset, bpm) {
  const secondsPerBeat = 60.0 / bpm
  let offbeat = offset + secondsPerBeat * 0.5
  if (offbeat > secondsPerBeat) offbeat -= secondsPerBeat
  const interval = secondsPerBeat * sampleRate
  let posA = offset * sampleRate, sumA = 0
  let posB = offbeat * sampleRate, sumB = 0
  const end = slopes.length
  while (posA < end && posB < end) {
    sumA += slopes[Math.floor(posA)]
    sumB += slopes[Math.floor(posB)]
    posA += interval
    posB += interval
  }
  return sumA >= sumB ? offset : offbeat
}

/**
 * Fill in offsets for every candidate.
 * (Slopes are computed once and reused — the original recomputed them per
 * candidate with identical results.)
 */
function calculateOffsets(results, positions, samples, sampleRate) {
  if (!results.length) return
  const slopes = computeSlopes(samples, sampleRate)
  for (const r of results) {
    const base = baseOffset(positions, sampleRate, r.bpm)
    r.offset = adjustForOffbeats(slopes, sampleRate, base, r.bpm)
  }
}

module.exports = {
  MIN_BPM, MAX_BPM,
  calculateBPM, calculateOffsets,
  confidenceForBPM, polyfit3, evalPoly
}
