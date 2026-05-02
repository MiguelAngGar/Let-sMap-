const { spawn } = require('child_process')
const path = require('path')

const SCRIPT = path.join(__dirname, '../python/analyze.py')

/**
 * Run Python audio analysis script and return parsed result.
 * @param {string} audioPath
 * @returns {Promise<{
 *   bpm: number,
 *   first_beat_time: number,
 *   silence_pad: number,
 *   final_offset: number,
 *   beat_duration: number
 * }>}
 */
function analyze(audioPath) {
  return new Promise((resolve, reject) => {
    // Try python3 first, fall back to python
    const proc = spawn('python3', [SCRIPT, audioPath], { stdio: ['ignore', 'pipe', 'pipe'] })

    let stdout = ''
    let stderr = ''

    proc.stdout.on('data', chunk => { stdout += chunk.toString() })
    proc.stderr.on('data', chunk => { stderr += chunk.toString() })

    proc.on('close', (code) => {
      if (code !== 0) {
        reject(new Error(`Python exited ${code}: ${stderr.trim()}`))
        return
      }
      try {
        const result = JSON.parse(stdout.trim())
        if (result.error) {
          reject(new Error(`Python analysis error: ${result.error}`))
        } else {
          resolve(result)
        }
      } catch {
        reject(new Error(`Could not parse Python output: ${stdout.trim()}`))
      }
    })

    proc.on('error', (err) => {
      reject(new Error(`Failed to start Python: ${err.message}. Is python3 installed?`))
    })
  })
}

module.exports = { analyze }
