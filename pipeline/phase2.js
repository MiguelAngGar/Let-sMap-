/**
 * pipeline/phase2.js
 * Phase 2: takes the confirmed BPM + modifiers from the validation view,
 * recalculates silence, then fetches metadata/cover and generates the
 * final Beat Saber project folder.
 */

const path      = require('path')
const converter = require('./converter')

// ScoreSaber's hot-start rule, and the default when nothing is configured
const MIN_LEAD_DEFAULT = 1.5

// How much extra lead-in the user can ask for. The ceiling is in SECONDS, not
// beats: a cap in beats would mean a different amount of silence at every tempo,
// and doubling the BPM could clip an adjustment the user had already made.
// (Whole beats are still the step, they are the only unit that keeps beat 1 on
// the grid — this is only about how far the steps can go.)
const MAX_EXTRA_SECONDS = 12

// Fine offset (mirrors MAX_NUDGE_MS in renderer/bpm-view.js). The mapper can
// correct the detected first beat by up to a quarter of a second in either
// direction — more than any plausible detection error, and the whole-beat and
// half-beat controls cover everything larger.
const MAX_NUDGE_MS = 250

/** Whole beats that fit in MAX_EXTRA_SECONDS at this tempo (at least one). */
function maxExtraBeats(beatDur) {
  return Math.max(1, Math.floor(MAX_EXTRA_SECONDS / beatDur))
}
const metaResolve = require('./meta-resolve')
const cover       = require('./cover')
const output    = require('./output')

// ── Silence recalculation ────────────────────────────────────────────────────
//
// Re-runs the same algorithm as analyze.py but in JS, so the user's
// confirmed BPM and half-beat-shift modifier are both respected.
//
// Two things have to be true of the padded audio:
//   1. the first beat lands exactly on a beat boundary (n × beatDur), so the
//      map's grid lines up with the music, and
//   2. there is at least MIN_LEAD of silence before it (ScoreSaber hot-start).
//
// Point 2 is about the TOTAL lead-in, not about how much we add: a song that
// already opens with three seconds before its first beat needs nothing but the
// alignment nudge, and may well need nothing at all. Adding MIN_LEAD on top of
// what the file already had was a real complaint from a mapper — the intro just
// kept growing with no way to trim it.
//
// firstBeatTime : seconds into the ORIGINAL audio where the first beat is
// bpm           : confirmed BPM (possibly doubled by user)
// halfBeatShift : if true, shift the whole grid forward by half a beat
// minLead       : the lead-in the padded audio must end up with. 1.5 s is the
//                 ScoreSaber requirement and the default; Settings can change
//                 it. Grid alignment is applied on top either way.
// extraBeats    : whole beats of lead-in the mapper added (+) or removed (−)
//                 in the BPM view, relative to the minimum. Moving beat 1 by
//                 whole beats keeps it on the grid, which an arbitrary number of
//                 seconds would not. Removing is allowed down to the alignment
//                 nudge alone (pad = 0, no silence at all beyond what the grid
//                 needs); the UI warns when that leaves under 1.5 s.
//
// Returns the amount of silence to prepend (seconds, may be 0).
//
function calcSilencePad(firstBeatTime, bpm, halfBeatShift = false,
                        minLead = MIN_LEAD_DEFAULT, extraBeats = 0, nudgeMs = 0) {
  const beatDur  = 60.0 / bpm
  const MIN_LEAD = converter.clampSilence(minLead, MIN_LEAD_DEFAULT)
  const EPS      = 1e-6   // keeps float noise from costing a whole extra beat
  // Two grid lines matter: the one the minimum asks for, and the earliest one
  // that still leaves the audio intact (pad ≥ 0). The user's steps move between
  // them and up to the cap beyond (see MAX_EXTRA_SECONDS).
  const nFloor   = Math.ceil((firstBeatTime - EPS) / beatDur)
  const nDefault = Math.ceil((Math.max(firstBeatTime, MIN_LEAD) - EPS) / beatDur)

  const extra = clampExtraBeats(extraBeats, nFloor - nDefault, maxExtraBeats(beatDur))
  let n           = nDefault + extra
  let totalOffset = n * beatDur
  let silencePad  = Math.max(0, totalOffset - firstBeatTime)

  // Half-beat shift: add half a beat of extra silence so the grid
  // moves forward by half a beat relative to the first beat onset
  if (halfBeatShift) {
    silencePad  += beatDur / 2
    totalOffset += beatDur / 2
  }

  // Fine offset: milliseconds of silence on top of the aligned pad, set by hand
  // in the BPM view. It corrects a mis-detected first beat, which whole beats
  // cannot do — after it, beat 1 no longer sits exactly on n·beatDur on paper,
  // because on the real audio that is what puts the TRUE beat on the grid.
  // Clamped exactly as the UI clamps it, so what was previewed is what is built.
  const nudge = clampNudgeMs(nudgeMs, silencePad)
  silencePad  = Math.max(0, silencePad + nudge / 1000)
  totalOffset = totalOffset + nudge / 1000

  return {
    silencePad:  Math.round(silencePad  * 1e6) / 1e6,
    totalOffset: Math.round(totalOffset * 1e6) / 1e6
  }
}

/**
 * Fine offset within the allowed window.
 * Never removes more silence than there is (so no audio is ever cut), and never
 * moves more than MAX_NUDGE_MS in either direction.
 * @param {number} value  requested correction in milliseconds
 * @param {number} pad    silence available to take from (seconds)
 */
function clampNudgeMs(value, pad = 0) {
  const ms = Number(value)
  if (!Number.isFinite(ms)) return 0
  const min = -Math.min(MAX_NUDGE_MS, Math.max(0, pad) * 1000)
  return Math.min(MAX_NUDGE_MS, Math.max(min, ms))
}

/**
 * Whole beats within the allowed window.
 * @param {number} value
 * @param {number} [min=0]   Most negative step allowed (never removes audio)
 * @param {number} [max]     Most positive step allowed (defaults to the cap at
 *                           120 BPM, only used when no tempo is known)
 */
function clampExtraBeats(value, min = 0, max = maxExtraBeats(0.5)) {
  const n = Math.round(Number(value))
  if (!Number.isFinite(n)) return 0
  return Math.min(max, Math.max(Math.min(0, min), n))
}

/**
 * @param {object} opts
 * @param {string}  opts.oggPath       Temp .ogg from phase1 (unconverted original)
 * @param {object}  opts.analysis      Raw analysis from Python (first_beat_time etc.)
 * @param {number}  opts.confirmedBpm  BPM chosen by user (may be doubled)
 * @param {boolean} opts.halfBeatShift Whether to shift the grid +½ beat
 * @param {string}  opts.originalName  Song filename without extension (for metadata)
 * @param {object}  [opts.meta]        User-confirmed { title, artist } — skips auto-fetch
 * @param {?string} [opts.coverPath]   With opts.meta: cover image path, or null = no cover
 * @param {string}  opts.exportDir     Output root directory
 * @param {string}  opts.mapperName    Written into Info.dat
 * @param {Function} opts.send         Progress callback (step, message)
 * @returns {Promise<{ outputDir: string }>}
 */
async function run({
  oggPath,
  originalPath,
  analysis,
  confirmedBpm,
  halfBeatShift,
  originalName,
  meta: metaOverride,
  coverPath: coverOverride,
  exportDir,
  mapperName,
  oggQuality = 10,
  leadIn  = MIN_LEAD_DEFAULT,
  coldEnd = converter.COLD_END_SECONDS,
  extraBeats = 0,
  offsetNudgeMs = 0,
  send = () => {}
}) {
  // 1. Recalculate silence with user-confirmed BPM + modifiers.
  // Anchor to downbeat_offset (musical beat 1) so the bar grid aligns correctly.
  // Falls back to first_beat_time for older analysis objects that lack downbeat_offset.
  const anchorTime = analysis.downbeat_offset ?? analysis.first_beat_time
  const { silencePad } = calcSilencePad(anchorTime, confirmedBpm, halfBeatShift, leadIn,
                                        extraBeats, offsetNudgeMs)
  send('silence', `Adding ${silencePad.toFixed(3)}s silence…`)
  // Prefer single-pass pad+encode from the ORIGINAL file (one lossy generation).
  // Fall back to padding the phase-1 ogg for older callers.
  const fs = require('fs')
  const encOpts = { quality: oggQuality, coldEnd }
  const paddedPath = (originalPath && fs.existsSync(originalPath))
    ? await converter.padToOgg(originalPath, silencePad, encOpts)
    : await converter.addSilence(oggPath, silencePad, encOpts)

  // 2 + 3. Metadata + cover
  // If the renderer already resolved them (confidence flow), respect its
  // values — coverPath null explicitly means "no cover". Otherwise fetch.
  let meta, coverPath
  if (metaOverride) {
    meta      = metaOverride
    coverPath = coverOverride ?? null
  } else {
    // Same resolution order as the UI flow: the file's own tags first, the
    // online lookup only when the file has nothing usable.
    const resolved = await metaResolve.resolve({
      filePath: originalPath,
      originalName,
      send
    })
    meta      = resolved.meta
    // No confirmation screen on this path, so never end up with no artwork.
    coverPath = resolved.coverPath || await cover.placeholder()
  }

  // 4. Output
  send('output', 'Generating Beat Saber folder…')
  const result = await output.generate({
    audioPath: paddedPath,
    coverPath,
    meta,
    analysis: { ...analysis, bpm: confirmedBpm, silence_pad: silencePad },
    exportDir,
    mapperName,
    fallbackName: originalName
  })

  return result
}

module.exports = {
  run, calcSilencePad, clampExtraBeats, maxExtraBeats, clampNudgeMs,
  MIN_LEAD_DEFAULT, MAX_EXTRA_SECONDS, MAX_NUDGE_MS
}
