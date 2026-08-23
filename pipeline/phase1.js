/**
 * pipeline/phase1.js
 * Phase 1: convert input audio → .ogg, then run Python analysis.
 * Returns everything the BPM validation view needs.
 * Does NOT touch metadata, cover, or output folders yet.
 */

const path      = require('path')
const converter = require('./converter')
const analyzer  = require('./analyzer')

/**
 * @param {string} inputPath  Absolute path to the dropped audio file
 * @returns {Promise<{
 *   oggPath:          string,
 *   analysis:         { bpm, first_beat_time, silence_pad, final_offset, beat_duration },
 *   originalName:     string,
 *   trailingSilence:  number   Seconds of silence the file already ends with
 * }>}
 */
async function run(inputPath) {
  const oggPath    = await converter.toOgg(inputPath)
  const analysis   = await analyzer.analyze(oggPath)
  const originalName = path.basename(inputPath, path.extname(inputPath))

  // How much silence the song already ends with. Measured here, not just at
  // export time, so the BPM view can tell the user what their outro will be
  // before they commit to it. Costs one metadata-only decode (~0.2 s).
  const trailingSilence = await converter.measureTrailingSilence(inputPath)

  // originalPath kept so phase2 can pad+encode from the source in ONE pass
  // (avoids a second lossy vorbis generation)
  return { oggPath, originalPath: inputPath, analysis, originalName, trailingSilence }
}

module.exports = { run }
