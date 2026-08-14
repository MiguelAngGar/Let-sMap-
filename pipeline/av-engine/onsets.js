'use strict'
/**
 * onsets.js — complex-domain onset detection (aubio-style), pure JS.
 *
 * Port of the onset detection chain used by ArrowVortex (aubio "complex"
 * method: phase vocoder → adaptive whitening → log compression →
 * complex-domain novelty → biquad-smoothed peak picking).
 *
 * Ported with AudioSync as reference:
 *   https://github.com/Caeden117/AudioSync
 *   Copyright (c) 2023 Caeden Statia — MIT License (see THIRD-PARTY-NOTICES.md)
 *
 * Deliberate deviations from AudioSync, matching original aubio/ArrowVortex
 * behaviour instead:
 *   - The phase vocoder keeps a rolling window of the last `bufferSize`
 *     samples (true overlap), instead of zero-padding each isolated hop.
 *   - Detection runs sequentially over the whole song (no chunk threading,
 *     which loses onsets at chunk boundaries).
 *   - ArrowVortex parameters: bufferSize=1024, hopSize=256, and aubio's
 *     defaults for the "complex" method (threshold 0.15, delay 4.6·hop,
 *     whitening on, log compression λ=1, minioi 50 ms, silence −70 dB).
 */

const { rfft } = require('./fft')

const TWO_PI = Math.PI * 2

// ── Biquad filter (aubio peak-picker smoothing) ──────────────────────────────

const BIQUAD = {
  b: [0.15998789, 0.31997577, 0.15998789], // forward
  a: [1.0, 0.23484048, 0.0]                // feedback
}

/** Order-3 IIR filter, forward pass, in place. */
function forwardFilter(x) {
  let x0 = 0, x1 = 0, x2 = 0
  let y1 = 0, y2 = 0
  for (let i = 0; i < x.length; i++) {
    x2 = x1; x1 = x0; x0 = x[i]
    const y0 = BIQUAD.b[0] * x0 + BIQUAD.b[1] * x1 + BIQUAD.b[2] * x2
             - BIQUAD.a[1] * y1 - BIQUAD.a[2] * y2
    y2 = y1; y1 = y0
    x[i] = y0
  }
}

/** Zero-phase double filtering (forward + backward). */
function doubleFilter(x) {
  forwardFilter(x)
  x.reverse()
  forwardFilter(x)
  x.reverse()
}

// ── Small helpers ─────────────────────────────────────────────────────────────

function levelLinear(buf, from, to) {
  let e = 0
  for (let i = from; i < to; i++) e += buf[i] * buf[i]
  return e / Math.max(1, to - from)
}

function isSilence(buf, from, to, thresholdDb) {
  const lvl = levelLinear(buf, from, to)
  const db = Math.max(20 * Math.log10(lvl > 0 ? lvl : 1e-30), -80)
  return db < thresholdDb
}

/** Quadratic interpolation of a local peak at index 1 of a 3-buffer. */
function quadraticPeakPos(s0, s1, s2) {
  const denom = s0 - 2 * s1 + s2
  if (denom === 0) return 1
  return 1 + 0.5 * (s0 - s2) / denom
}

// ── Onset detector ────────────────────────────────────────────────────────────

class OnsetDetector {
  constructor({ bufferSize = 1024, hopSize = 256, sampleRate = 44100 } = {}) {
    this.bufferSize = bufferSize
    this.hopSize = hopSize
    this.sampleRate = sampleRate
    this.realSize = (bufferSize >> 1) + 1

    // aubio defaults for the "complex" method
    this.threshold = 0.15
    this.delay = Math.floor(4.6 * hopSize)
    this.minIOI = Math.round(0.050 * sampleRate) // 50 ms
    this.silenceDb = -70
    this.lambda = 1.0                            // log compression

    // Rolling analysis frame (true overlap, aubio pvoc behaviour)
    this.frame = new Float64Array(bufferSize)

    // Hann window
    this.window = new Float64Array(bufferSize)
    for (let i = 0; i < bufferSize; i++) {
      this.window[i] = 0.5 - 0.5 * Math.cos(TWO_PI * i / bufferSize)
    }

    // FFT work buffers
    this.windowed = new Float64Array(bufferSize)
    this.re = new Float64Array(this.realSize)
    this.im = new Float64Array(this.realSize)
    this.medianScratch = new Float64Array(7)

    // Adaptive whitening state (aubio defaults: relax 250 s, floor 1e-4)
    this.whFloor = 1e-4
    this.whDecay = Math.pow(0.001, hopSize / sampleRate / 250)
    this.whPeaks = new Float64Array(this.realSize).fill(this.whFloor)

    // Complex-domain novelty state: previous magnitude + unit phase vectors
    // of the last two frames (kept as complex units — no trig needed).
    this.oldMag = new Float64Array(this.realSize)
    this.u1re = new Float64Array(this.realSize).fill(1)
    this.u1im = new Float64Array(this.realSize)
    this.u2re = new Float64Array(this.realSize).fill(1)
    this.u2im = new Float64Array(this.realSize)

    // Peak picker state
    this.ppWindow = new Float64Array(7)  // windowPre=1, windowPost=5
    this.ppWork = new Float64Array(7)
    this.onsetPeek = new Float64Array(3)

    this.totalFrames = 0
    this.lastOnset = 0
  }

  /**
   * Compute the complex-domain novelty for the current rolling frame.
   * @returns {number}
   */
  _novelty() {
    const n = this.bufferSize
    const half = n >> 1
    const { re, im, frame, window, windowed } = this

    // Windowed + fftshifted copy (swap halves, aubio pvoc behaviour)
    for (let i = 0; i < half; i++) {
      windowed[i] = frame[i + half] * window[i + half]
      windowed[i + half] = frame[i] * window[i]
    }
    rfft(windowed, re, im)

    let onset = 0
    const R = this.realSize
    for (let i = 0; i < R; i++) {
      let mag = Math.sqrt(re[i] * re[i] + im[i] * im[i])

      // unit phase vector of the current bin
      let ure = 1, uim = 0
      if (mag > 1e-30) { ure = re[i] / mag; uim = im[i] / mag }

      // adaptive whitening (magnitude only)
      const newPeak = Math.max(this.whDecay * this.whPeaks[i], this.whFloor)
      this.whPeaks[i] = Math.max(mag, newPeak)
      mag /= this.whPeaks[i]

      // log compression
      mag = Math.log(this.lambda * mag + 1)

      // predicted phase e^{i(2φ1−φ2)} = u1·u1·conj(u2)
      const are = this.u1re[i], aim = this.u1im[i]
      const sre = are * are - aim * aim        // u1²
      const sim = 2 * are * aim
      const pre = sre * this.u2re[i] + sim * this.u2im[i]   // ·conj(u2)
      const pim = sim * this.u2re[i] - sre * this.u2im[i]

      // cos(θpred − φ) = Re(pred · conj(u))
      const cosD = pre * ure + pim * uim

      const om = this.oldMag[i]
      let d2 = om * om + mag * mag - 2 * om * mag * cosD
      if (d2 < 0) d2 = -d2
      onset += Math.sqrt(d2)

      // push back state
      this.u2re[i] = this.u1re[i]; this.u2im[i] = this.u1im[i]
      this.u1re[i] = ure; this.u1im[i] = uim
      this.oldMag[i] = mag
    }
    return onset
  }

  /**
   * Feed the novelty into the aubio peak picker.
   * @returns {number} fractional onset position (in hops) if a peak fired, else 0
   */
  _pickPeak(novelty) {
    const w = this.ppWindow
    // push (shift left, append)
    for (let i = 0; i < 6; i++) w[i] = w[i + 1]
    w[6] = novelty

    this.ppWork.set(w)
    doubleFilter(this.ppWork)

    let mean = 0
    for (let i = 0; i < 7; i++) mean += this.ppWork[i]
    mean /= 7
    // median of 7 without allocations (insertion sort on a scratch buffer)
    const ms = this.medianScratch
    ms.set(this.ppWork)
    for (let i = 1; i < 7; i++) {
      const v = ms[i]
      let j = i - 1
      while (j >= 0 && ms[j] > v) { ms[j + 1] = ms[j]; j-- }
      ms[j + 1] = v
    }
    const median = ms[3]

    const thresholded = this.ppWork[5] - median - mean * this.threshold

    const pk = this.onsetPeek
    pk[0] = pk[1]; pk[1] = pk[2]; pk[2] = thresholded

    if (pk[1] > pk[0] && pk[1] > pk[2] && pk[1] > 0) {
      return quadraticPeakPos(pk[0], pk[1], pk[2])
    }
    return 0
  }

  /**
   * Detect onsets over a whole mono signal, sequentially.
   * @param {Float32Array|Float64Array} samples
   * @returns {{pos: number, strength: number}[]} onset sample positions + strengths
   */
  detect(samples) {
    const hop = this.hopSize
    const buf = this.bufferSize
    const onsets = []

    for (let start = 0; start + hop <= samples.length; start += hop) {
      // roll the analysis frame
      this.frame.copyWithin(0, hop)
      for (let i = 0; i < hop; i++) this.frame[buf - hop + i] = samples[start + i]

      const novelty = this._novelty()
      const frac = this._pickPeak(novelty)

      if (frac > 0) {
        if (!isSilence(samples, start, start + hop, this.silenceDb)) {
          const newOnset = this.totalFrames + Math.round(frac * hop)
          const blocked = (this.lastOnset + this.minIOI >= newOnset) ||
                          (this.lastOnset > 0 && this.delay > newOnset)
          if (!blocked) {
            this.lastOnset = Math.max(this.delay, newOnset)
            onsets.push(this.lastOnset - this.delay)
          }
        }
      } else if (this.totalFrames <= this.delay &&
                 !isSilence(samples, start, start + hop, this.silenceDb)) {
        // non-silent start of file counts as an onset (aubio behaviour)
        if (this.totalFrames === 0 || this.lastOnset + this.minIOI < this.totalFrames) {
          this.lastOnset = this.totalFrames + this.delay
          onsets.push(this.lastOnset - this.delay)
        }
      }

      this.totalFrames += hop
    }

    // Onset strengths: mean |amplitude| in ±100 samples around each onset.
    // (Computed for ALL onsets — fixes an ArrowVortex quirk that only
    // filled the first 100.)
    return onsets.map(pos => {
      const a = Math.max(0, pos - 100)
      const b = Math.min(samples.length, pos + 100)
      let v = 0
      for (let i = a; i < b; i++) v += Math.abs(samples[i])
      return { pos, strength: v / Math.max(1, b - a) }
    })
  }
}

module.exports = { OnsetDetector }
