'use strict'
/**
 * analyze-core.js — full analysis over decoded mono samples.
 *
 * Produces the SAME JSON contract as python/analyze.py so the rest of the
 * pipeline (phase1/phase2/main.js/renderer) works unchanged:
 *   { bpm, tempo_candidates, beat_offset, downbeat_offset, beat_duration,
 *     first_beat_time, silence_pad, final_offset, debug{...} }
 *
 * BPM + offset come from the ArrowVortex algorithm (findtempo.js).
 * Downbeat, confidence and silence padding are Let'sMap!'s own
 * post-processing, re-expressed over onsets instead of RNN activations.
 */

const { OnsetDetector } = require('./onsets')
const { calculateBPM, calculateOffsets } = require('./findtempo')

const SAMPLE_RATE = 44100
const MIN_LEAD_IN = 1.5

// ── Silence padding (same maths as analyze.py / phase2.calcSilencePad) ───────

function calcSilencePad(anchorTime, bpm) {
  const beatDur = 60.0 / bpm
  let n = Math.ceil((anchorTime + MIN_LEAD_IN) / beatDur)
  let totalOffset = n * beatDur
  let silencePad = totalOffset - anchorTime
  if (silencePad < MIN_LEAD_IN) {
    n += 1
    totalOffset = n * beatDur
    silencePad = totalOffset - anchorTime
  }
  return {
    silencePad: Math.round(silencePad * 1e6) / 1e6,
    totalOffset: Math.round(totalOffset * 1e6) / 1e6
  }
}

// ── Downbeat: phase k ∈ [0,4) with the strongest onset support ───────────────

function detectDownbeat(onsets, beat0, period, timeSig = 4) {
  const scores = new Float64Array(timeSig)
  const tol = 0.10 * period
  for (const o of onsets) {
    const t = o.pos / SAMPLE_RATE
    const k = Math.round((t - beat0) / period)
    if (k < 0) continue
    const err = Math.abs(t - (beat0 + k * period))
    if (err <= tol) scores[k % timeSig] += o.strength
  }
  let best = 0
  for (let k = 1; k < timeSig; k++) if (scores[k] > scores[best]) best = k
  return best
}

// ── Grid coverage: fraction of onsets close to a beat or half-beat ───────────

function gridCoverage(onsets, offset, period) {
  if (!onsets.length) return 0
  const half = period / 2
  const tol = 0.15 * period
  let matched = 0
  for (const o of onsets) {
    const t = o.pos / SAMPLE_RATE
    const phase = (((t - offset) % half) + half) % half
    const err = Math.min(phase, half - phase)
    if (err <= tol) matched++
  }
  return matched / onsets.length
}

// ── Confidence heuristic (maps AV fitness + coverage → analyze.py levels) ────

function scoreConfidence(fitnessRatio, coverage) {
  if (coverage >= 0.65 && fitnessRatio >= 1.10) return 'high'
  if (coverage >= 0.45 && fitnessRatio >= 1.02) return 'medium'
  return 'low'
}

/**
 * @param {Float32Array} samples  mono PCM at 44100 Hz
 * @param {object} [opts]
 * @returns {object} analysis result (same shape as analyze.py)
 */
function analyzeSamples(samples, opts = {}) {
  const log = opts.log || (() => {})

  // 1. Onsets
  log('detecting onsets…')
  const detector = new OnsetDetector({ sampleRate: SAMPLE_RATE })
  const onsets = detector.detect(samples)
  log(`onsets detected     : ${onsets.length}`)
  if (onsets.length < 8) {
    throw new Error(`Too few onsets detected: ${onsets.length}`)
  }

  const positions = new Float64Array(onsets.length)
  const strengths = new Float64Array(onsets.length)
  for (let i = 0; i < onsets.length; i++) {
    positions[i] = onsets[i].pos
    strengths[i] = onsets[i].strength
  }

  // 2. BPM candidates (ArrowVortex)
  log('searching BPM…')
  const candidates = calculateBPM(positions, strengths, SAMPLE_RATE)
  if (!candidates.length) throw new Error('No BPM candidates found')
  calculateOffsets(candidates, positions, samples, SAMPLE_RATE)

  const winner = candidates[0]
  const bpm = winner.bpm
  const period = 60.0 / bpm
  const offset = winner.offset   // ∈ [0, period)
  log(`candidates          : ${candidates.map(c => `${c.bpm.toFixed(3)} (${c.fitness.toFixed(1)})`).join(', ')}`)

  // 3. First onset (informational; analyze.py skips anything ≤ 50 ms)
  let firstOnsetTime = 0
  for (const o of onsets) {
    const t = o.pos / SAMPLE_RATE
    if (t > 0.05) { firstOnsetTime = t; break }
  }

  // 4. First beat on the grid at (or just before) the first onset
  let k0 = Math.ceil((firstOnsetTime - 0.05 - offset) / period)
  if (k0 < 0) k0 = 0
  const beat0 = offset + k0 * period

  // 5. Downbeat phase + anchor
  const phase = detectDownbeat(onsets, beat0, period)
  const downbeatOffset = beat0 + phase * period

  // 6. Confidence
  const ratio = candidates.length >= 2 && candidates[1].fitness > 0
    ? winner.fitness / candidates[1].fitness
    : Infinity
  const coverage = gridCoverage(onsets, offset, period)
  const confidence = scoreConfidence(ratio, coverage)

  // 7. Silence pad from the downbeat anchor
  const { silencePad, totalOffset } = calcSilencePad(downbeatOffset, bpm)

  // 8. Alternative candidates for the UI (non-multiples, like analyze.py)
  const round2 = x => Math.round(x * 100) / 100
  const tempoCandidates = candidates.slice(1).map(c => round2(c.bpm))

  log(`BPM (final)         : ${bpm.toFixed(4)}  confidence=${confidence}`)
  log(`downbeat_offset     : ${downbeatOffset.toFixed(4)}s (phase ${phase}/4)`)
  log(`silence pad         : ${silencePad.toFixed(6)}s`)

  return {
    bpm: Math.round(bpm * 1e4) / 1e4,
    tempo_candidates: tempoCandidates,
    beat_offset: Math.round(beat0 * 1e6) / 1e6,
    downbeat_offset: Math.round(downbeatOffset * 1e6) / 1e6,
    beat_duration: Math.round(period * 1e6) / 1e6,
    first_beat_time: Math.round(firstOnsetTime * 1e4) / 1e4,
    silence_pad: silencePad,
    final_offset: totalOffset,
    debug: {
      engine: 'arrowvortex',
      onset_count: onsets.length,
      downbeat_phase: phase,
      coverage: Math.round(coverage * 1e4) / 1e4,
      confidence,
      fitness_ratio: Number.isFinite(ratio) ? Math.round(ratio * 1e4) / 1e4 : null,
      offset_raw: Math.round(offset * 1e6) / 1e6,
      candidates: candidates.map(c => ({
        bpm: Math.round(c.bpm * 1e4) / 1e4,
        fitness: Math.round(c.fitness * 1e3) / 1e3,
        offset: Math.round(c.offset * 1e6) / 1e6
      }))
    }
  }
}

module.exports = { analyzeSamples, calcSilencePad, SAMPLE_RATE }
