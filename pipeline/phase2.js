/**
 * pipeline/phase2.js
 * Phase 2: takes the confirmed BPM + modifiers from the validation view,
 * recalculates silence, then fetches metadata/cover and generates the
 * final Beat Saber project folder.
 */

const path      = require('path')
const converter = require('./converter')
const metadata  = require('./metadata')
const cover     = require('./cover')
const output    = require('./output')

// ── Silence recalculation ────────────────────────────────────────────────────
//
// Re-runs the same algorithm as analyze.py but in JS, so the user's
// confirmed BPM and half-beat-shift modifier are both respected.
//
// firstBeatTime : seconds into the ORIGINAL audio where the first beat is
// bpm           : confirmed BPM (possibly doubled by user)
// halfBeatShift : if true, shift the whole grid forward by half a beat
//
// Returns the amount of silence to prepend (seconds).
//
function calcSilencePad(firstBeatTime, bpm, halfBeatShift = false) {
  const beatDur   = 60.0 / bpm
  const MIN_LEAD  = 1.5   // seconds of mandatory lead-in

  // Find smallest N such that N × beatDur - firstBeatTime ≥ MIN_LEAD
  // i.e. the beat lands on-grid AND at least 1.5s into the padded audio
  let n           = Math.ceil((firstBeatTime + MIN_LEAD) / beatDur)
  let totalOffset = n * beatDur
  let silencePad  = totalOffset - firstBeatTime

  // Safety clamp (edge case: tiny firstBeatTime with very long beat_dur)
  if (silencePad < MIN_LEAD) {
    n++
    totalOffset = n * beatDur
    silencePad  = totalOffset - firstBeatTime
  }

  // Half-beat shift: add half a beat of extra silence so the grid
  // moves forward by half a beat relative to the first beat onset
  if (halfBeatShift) {
    silencePad  += beatDur / 2
    totalOffset += beatDur / 2
  }

  return {
    silencePad:  Math.round(silencePad  * 1e6) / 1e6,
    totalOffset: Math.round(totalOffset * 1e6) / 1e6
  }
}

/**
 * @param {object} opts
 * @param {string}  opts.oggPath       Temp .ogg from phase1 (unconverted original)
 * @param {object}  opts.analysis      Raw analysis from Python (first_beat_time etc.)
 * @param {number}  opts.confirmedBpm  BPM chosen by user (may be doubled)
 * @param {boolean} opts.halfBeatShift Whether to shift the grid +½ beat
 * @param {string}  opts.originalName  Song filename without extension (for metadata)
 * @param {string}  opts.exportDir     Output root directory
 * @param {string}  opts.mapperName    Written into Info.dat
 * @param {Function} opts.send         Progress callback (step, message)
 * @returns {Promise<{ outputDir: string }>}
 */
async function run({
  oggPath,
  analysis,
  confirmedBpm,
  halfBeatShift,
  originalName,
  exportDir,
  mapperName,
  send = () => {}
}) {
  // 1. Recalculate silence with user-confirmed BPM + modifiers.
  // Anchor to downbeat_offset (musical beat 1) so the bar grid aligns correctly.
  // Falls back to first_beat_time for older analysis objects that lack downbeat_offset.
  const anchorTime = analysis.downbeat_offset ?? analysis.first_beat_time
  const { silencePad } = calcSilencePad(anchorTime, confirmedBpm, halfBeatShift)
  send('silence', `Adding ${silencePad.toFixed(3)}s silence…`)
  const paddedPath = await converter.addSilence(oggPath, silencePad)

  // 2. Metadata
  send('metadata', 'Fetching song metadata…')
  const meta = await metadata.fetch(originalName)

  // 3. Cover
  send('cover', 'Fetching cover image…')
  const coverPath = await cover.fetch(meta.artist, meta.title)

  // 4. Output
  send('output', 'Generating Beat Saber folder…')
  const result = await output.generate({
    audioPath: paddedPath,
    coverPath,
    meta,
    analysis: { ...analysis, bpm: confirmedBpm, silence_pad: silencePad },
    exportDir,
    mapperName
  })

  return result
}

module.exports = { run, calcSilencePad }
