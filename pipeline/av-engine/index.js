'use strict'
/**
 * av-engine — BPM + offset detection engine for Let'sMap!
 * ─────────────────────────────────────────────────────────────────────────────
 * Pure-JS implementation of the ArrowVortex tempo detection algorithm
 * (Bram van de Wetering, "Non-causal Beat Tracking for Rhythm Games"),
 * replacing the Python/madmom sidecar. No native dependencies.
 *
 * Onset detection ported using AudioSync (© 2023 Caeden Statia, MIT) as
 * reference — see THIRD-PARTY-NOTICES.md.
 *
 * Public API (same contract as pipeline/analyzer.js expects):
 *   analyze(audioPath) → Promise<result JSON like python/analyze.py>
 *
 * Runs in a worker thread so the Electron main process never blocks.
 */

const path = require('path')
const { Worker } = require('worker_threads')

// Resolve bundled ffmpeg — same fix as converter.js / analyzer.js
const ffmpegStatic = require('ffmpeg-static')
const FFMPEG_PATH = ffmpegStatic.replace('app.asar', 'app.asar.unpacked')

const ANALYZE_TIMEOUT_MS = 120_000

// Worker threads need a real file on disk — in packaged builds the engine is
// unpacked from the asar (see "asarUnpack" in package.json), same as ffmpeg.
const WORKER_PATH = path.join(__dirname, 'worker.js').replace('app.asar', 'app.asar.unpacked')

/**
 * @param {string} audioPath
 * @returns {Promise<object>} analysis result (same shape as analyze.py)
 */
function analyze(audioPath) {
  return new Promise((resolve, reject) => {
    const worker = new Worker(WORKER_PATH, {
      workerData: { audioPath, ffmpegPath: FFMPEG_PATH }
    })

    let settled = false
    const settle = (fn, arg) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      worker.terminate().catch(() => {})
      fn(arg)
    }

    const timer = setTimeout(() => {
      settle(reject, new Error(`Analyzer timed out after ${ANALYZE_TIMEOUT_MS / 1000}s`))
    }, ANALYZE_TIMEOUT_MS)

    worker.on('message', msg => {
      if (msg.ok) settle(resolve, msg.result)
      else settle(reject, new Error(`Analysis error: ${msg.error}`))
    })
    worker.on('error', err => settle(reject, err))
    worker.on('exit', code => {
      if (code !== 0) settle(reject, new Error(`Analyzer worker exited with code ${code}`))
    })
  })
}

module.exports = { analyze }
