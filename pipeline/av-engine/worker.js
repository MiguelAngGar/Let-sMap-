'use strict'
/**
 * worker.js — worker-thread entry point for the ArrowVortex engine.
 *
 * Decodes the audio with the bundled ffmpeg (f32le mono 44.1 kHz — the same
 * decode analyze.py used) and runs the analysis, keeping the Electron main
 * process responsive.
 */

const { parentPort, workerData } = require('worker_threads')
const { spawn } = require('child_process')
const { analyzeSamples, SAMPLE_RATE } = require('./analyze-core')

function decode(audioPath, ffmpegPath) {
  return new Promise((resolve, reject) => {
    const proc = spawn(ffmpegPath, [
      '-v', 'error',
      '-i', audioPath,
      '-f', 'f32le', '-ar', String(SAMPLE_RATE), '-ac', '1',
      'pipe:1'
    ], { stdio: ['ignore', 'pipe', 'pipe'] })

    const chunks = []
    let stderr = ''
    proc.stdout.on('data', c => chunks.push(c))
    proc.stderr.on('data', c => { stderr += c.toString() })
    proc.on('error', err => reject(new Error(`ffmpeg spawn failed: ${err.message}`)))
    proc.on('close', code => {
      if (code !== 0) {
        reject(new Error(`ffmpeg decode failed: ${stderr.trim()}`))
        return
      }
      const buf = Buffer.concat(chunks)
      if (buf.length < 4) {
        reject(new Error('ffmpeg produced no audio data'))
        return
      }
      // Align to a fresh ArrayBuffer (Buffer pools are not 4-byte aligned)
      const aligned = new ArrayBuffer(buf.length - (buf.length % 4))
      new Uint8Array(aligned).set(buf.subarray(0, aligned.byteLength))
      resolve(new Float32Array(aligned))
    })
  })
}

async function main() {
  const { audioPath, ffmpegPath } = workerData
  const t0 = Date.now()
  const samples = await decode(audioPath, ffmpegPath)
  const tDecode = Date.now()

  const result = analyzeSamples(samples, {
    log: msg => console.error(`[av-engine] ${msg}`)
  })

  result.debug.timings_ms = {
    decode: tDecode - t0,
    analysis: Date.now() - tDecode,
    total: Date.now() - t0
  }
  parentPort.postMessage({ ok: true, result })
}

main().catch(err => {
  parentPort.postMessage({ ok: false, error: err.message || String(err) })
})
