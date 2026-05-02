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
 *   oggPath:      string,
 *   analysis:     { bpm, first_beat_time, silence_pad, final_offset, beat_duration },
 *   originalName: string
 * }>}
 */
async function run(inputPath) {
  const oggPath    = await converter.toOgg(inputPath)
  const analysis   = await analyzer.analyze(oggPath)
  const originalName = path.basename(inputPath, path.extname(inputPath))
  return { oggPath, analysis, originalName }
}

module.exports = { run }
