const { spawn } = require('child_process')
const path = require('path')
const fs   = require('fs')

// ── Engine selection ──────────────────────────────────────────────────────────
// 'arrowvortex' → pure-JS engine (pipeline/av-engine): ArrowVortex algorithm,
//                 no Python needed, ~2-4 s per song.
// 'madmom'      → legacy Python sidecar (python/analyze.py / analyze.exe).
// Switch here in code, or without touching code via env var:
//   LETSMAP_ENGINE=madmom npm start
const ENGINE = process.env.LETSMAP_ENGINE || 'arrowvortex'

// Resolve bundled ffmpeg — same fix as converter.js
const ffmpegStatic = require('ffmpeg-static')
const FFMPEG_PATH  = ffmpegStatic.replace('app.asar', 'app.asar.unpacked')

// When packaged, resources are extracted to app.asar.unpacked
const PROJECT_ROOT = path.join(__dirname, '..').replace('app.asar', 'app.asar.unpacked')
const SCRIPT       = path.join(PROJECT_ROOT, 'python', 'analyze.py')

/**
 * Resolve how to invoke the analyzer.
 * Priority:
 *   1. PyInstaller standalone binary (python/dist/analyze[.exe]) — used in packaged builds
 *   2. .venv Python + analyze.py — used in dev
 *   3. System python3/python + analyze.py — last resort
 *
 * Returns { bin, args } where the full command is: bin [...args, audioPath]
 */
const ANALYZE_TIMEOUT_MS = 120_000  // 2 min — safety net for hangs

function getAnalyzeCommand() {
  const binName = process.platform === 'win32' ? 'analyze.exe' : 'analyze'
  // --onedir layout: python/dist/analyze/analyze[.exe]
  const binPath = path.join(PROJECT_ROOT, 'python', 'dist', 'analyze', binName)
  if (fs.existsSync(binPath)) {
    return { bin: binPath, args: [] }
  }

  // Dev fallback: use venv or system Python with the script
  const venvUnix = path.join(PROJECT_ROOT, '.venv', 'bin',     'python3')
  const venvWin  = path.join(PROJECT_ROOT, '.venv', 'Scripts', 'python.exe')
  let pythonBin
  if      (fs.existsSync(venvUnix)) pythonBin = venvUnix
  else if (fs.existsSync(venvWin))  pythonBin = venvWin
  else                               pythonBin = process.platform === 'win32' ? 'python' : 'python3'

  return { bin: pythonBin, args: [SCRIPT] }
}

/**
 * Legacy engine: run the Python/madmom analysis in a child process.
 * @param {string} audioPath
 * @returns {Promise<{bpm, first_beat_time, silence_pad, final_offset, beat_duration, ...}>}
 */
function analyzeMadmom(audioPath) {
  return new Promise((resolve, reject) => {
    const { bin, args } = getAnalyzeCommand()
    const proc = spawn(bin, [...args, audioPath], {
      stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env, FFMPEG_PATH: FFMPEG_PATH }
    })

    let stdout = ''
    let stderr = ''
    let timedOut = false

    const timer = setTimeout(() => {
      timedOut = true
      proc.kill()
      reject(new Error(`Analyzer timed out after ${ANALYZE_TIMEOUT_MS / 1000}s`))
    }, ANALYZE_TIMEOUT_MS)

    proc.stdout.on('data', chunk => { stdout += chunk.toString() })
    proc.stderr.on('data', chunk => { stderr += chunk.toString() })

    proc.on('close', (code) => {
      clearTimeout(timer)
      if (timedOut) return   // already rejected

      if (code !== 0) {
        reject(new Error(`Analyzer exited ${code}: ${stderr.trim()}`))
        return
      }
      try {
        const result = JSON.parse(stdout.trim())
        if (result.error) {
          reject(new Error(`Analysis error: ${result.error}`))
        } else {
          resolve(result)
        }
      } catch {
        reject(new Error(`Could not parse analyzer output: ${stdout.trim()}`))
      }
    })

    proc.on('error', (err) => {
      clearTimeout(timer)
      reject(new Error(`Failed to start analyzer (${bin}): ${err.message}`))
    })
  })
}

/**
 * Run audio analysis with the selected engine and return the parsed result.
 * Both engines return the same JSON contract.
 * @param {string} audioPath
 * @returns {Promise<{bpm, first_beat_time, silence_pad, final_offset, beat_duration, ...}>}
 */
function analyze(audioPath) {
  if (ENGINE === 'arrowvortex') {
    return require('./av-engine').analyze(audioPath)
  }
  return analyzeMadmom(audioPath)
}

module.exports = { analyze, ENGINE }
