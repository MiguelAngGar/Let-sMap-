const ffmpeg      = require('fluent-ffmpeg')
const ffmpegPath  = require('ffmpeg-static')
const path        = require('path')
const os          = require('os')
const fs          = require('fs')
const { execFile } = require('child_process')

// When packaged by electron-builder, ffmpeg-static is extracted to app.asar.unpacked.
// The path returned by the module still points inside app.asar, so we fix it here.
const resolvedFfmpegPath = ffmpegPath.replace('app.asar', 'app.asar.unpacked')
ffmpeg.setFfmpegPath(resolvedFfmpegPath)

const TMP_DIR = path.join(os.tmpdir(), 'letsmap')
if (!fs.existsSync(TMP_DIR)) fs.mkdirSync(TMP_DIR, { recursive: true })

/** Clamp Vorbis quality to a valid integer 0–10. Falls back to 10 (max). */
function clampQuality(q) {
  const n = Math.round(Number(q))
  if (!Number.isFinite(n)) return 10
  return Math.min(10, Math.max(0, n))
}

// Codecs that are already lossy: matching their bitrate keeps size/quality
// roughly identical. Anything not listed here (flac, alac, pcm_*, wavpack,
// truehd…) is treated as lossless, where "match bitrate" is meaningless.
const LOSSY_CODECS = new Set([
  'mp3', 'aac', 'vorbis', 'opus', 'wmav1', 'wmav2', 'ac3', 'eac3',
  'mp2', 'mp1', 'cook', 'atrac3', 'atrac3p', 'dts'
])

/**
 * Probe a file's audio stream. Returns sample rate, codec and bitrate (bps).
 * Bitrate prefers the stream value, falling back to the container/format value.
 * All fields fall back to safe defaults if probing fails.
 */
function probeAudio(inputPath) {
  return new Promise((resolve) => {
    ffmpeg.ffprobe(inputPath, (err, data) => {
      if (err || !data) return resolve({ sampleRate: 44100, codec: null, bitRate: 0 })
      const stream = (data.streams || []).find(s => s.codec_type === 'audio') || {}
      const sr = parseInt(stream.sample_rate, 10)
      const streamBr = parseInt(stream.bit_rate, 10)
      const fmtBr = data.format && parseInt(data.format.bit_rate, 10)
      const bitRate = Number.isFinite(streamBr) && streamBr > 0 ? streamBr
                    : Number.isFinite(fmtBr)    && fmtBr    > 0 ? fmtBr
                    : 0
      resolve({
        sampleRate: Number.isFinite(sr) && sr > 0 ? sr : 44100,
        codec:      stream.codec_name || null,
        bitRate
      })
    })
  })
}

// ── Cold end (ScoreSaber outro rule) ─────────────────────────────────────────
// "A map must have an outro period of more than 2 seconds" — if the source
// audio ends abruptly, the mapper cannot satisfy it. Exports therefore
// guarantee ≥ COLD_END_SECONDS of trailing silence, adding only the missing
// difference (never "excessive silence").
const COLD_END_SECONDS = 2.0

/**
 * Measure how much trailing silence the file already has (seconds).
 * Decodes the last ~12 s to mono PCM and scans 20 ms RMS windows against a
 * −45 dBFS threshold. Resolves 0 on any decode problem (⇒ full pad, safe).
 */
function measureTrailingSilence(inputPath, lookback = 12) {
  return new Promise((resolve) => {
    execFile(resolvedFfmpegPath, [
      '-v', 'error', '-sseof', String(-lookback), '-i', inputPath,
      '-f', 'f32le', '-ac', '1', '-ar', '22050', 'pipe:1'
    ], { encoding: 'buffer', maxBuffer: 32 * 1024 * 1024, windowsHide: true },
    (err, stdout) => {
      if (err || !stdout || stdout.length < 8) return resolve(0)
      const n = Math.floor(stdout.length / 4)
      const ab = new ArrayBuffer(n * 4)
      new Uint8Array(ab).set(stdout.subarray(0, n * 4))
      const x = new Float32Array(ab)
      const sr = 22050
      const win = 441                              // 20 ms
      const thr = Math.pow(10, -45 / 20)           // −45 dBFS RMS
      let lastLoudEnd = 0
      for (let i0 = 0; i0 + win <= n; i0 += win) {
        let e = 0
        for (let i = i0; i < i0 + win; i++) e += x[i] * x[i]
        if (Math.sqrt(e / win) > thr) lastLoudEnd = i0 + win
      }
      resolve((n - lastLoudEnd) / sr)
    })
  })
}

/** Seconds of silence to append so the export ends with ≥ COLD_END_SECONDS. */
async function coldEndPad(inputPath) {
  const trailing = await measureTrailingSilence(inputPath)
  const pad = Math.max(0, COLD_END_SECONDS - trailing)
  return pad > 0.01 ? pad : 0
}

/**
 * Convert any audio file to .ogg (libvorbis, 44100 Hz).
 * NOTE: only used to feed the Python BPM analyser — quality here does not
 * affect the exported song.ogg (that comes from padToOgg on the original).
 */
function toOgg(inputPath) {
  return new Promise((resolve, reject) => {
    const out = path.join(TMP_DIR, `${Date.now()}_converted.ogg`)
    ffmpeg(inputPath)
      .audioCodec('libvorbis')
      .audioQuality(6)          // vorbis quality 0–10 (6 = ~192kbps) — analysis only
      .audioFrequency(44100)
      .output(out)
      .on('end',   () => resolve(out))
      .on('error', (err) => {
        fs.unlink(out, () => {})   // clean up partial file
        reject(new Error(`FFmpeg convert: ${err.message}`))
      })
      .run()
  })
}

/**
 * Prepend `seconds` of silence to an .ogg file.
 * Uses FFmpeg's lavfi aevalsrc null source + concat filter.
 * Fallback path (phase-1 ogg is already 44100 Hz). Encodes at q10 to avoid
 * adding further loss on top of the phase-1 encode.
 */
async function addSilence(audioPath, seconds, opts = {}) {
  // Fallback path: input is the phase-1 ogg (already 44100 Hz). There is no
  // original source to match here, so just honour the quality target.
  const q = clampQuality(opts.quality ?? 10)
  const tailPad = await coldEndPad(audioPath)
  return new Promise((resolve, reject) => {
    const out = path.join(TMP_DIR, `${Date.now()}_padded.ogg`)
    const filters = [
      '[1:a]aresample=44100,aformat=channel_layouts=stereo[src]',
      '[0:a][src]concat=n=2:v=0:a=1[out]'
    ]
    let outLabel = '[out]'
    if (tailPad > 0) {
      filters.push(`[out]apad=pad_dur=${tailPad.toFixed(3)}[fin]`)
      outLabel = '[fin]'
    }
    ffmpeg()
      .input(`aevalsrc=0|0:d=${seconds.toFixed(6)}:s=44100`)
      .inputOptions(['-f', 'lavfi'])
      .input(audioPath)
      .complexFilter(filters)
      .outputOptions(['-map', outLabel, '-c:a', 'libvorbis', '-q:a', String(q)])
      .output(out)
      .on('end',   () => resolve(out))
      .on('error', (err) => {
        fs.unlink(out, () => {})   // clean up partial file
        reject(new Error(`FFmpeg silence: ${err.message}`))
      })
      .run()
  })
}

/**
 * Prepend `seconds` of silence to the ORIGINAL (lossless/source) file and
 * encode to .ogg in a single pass. Avoids the double-lossy generation of
 * toOgg() → addSilence() (two vorbis encodes).
 *
 * @param {string} inputPath
 * @param {number} seconds                Silence to prepend.
 * @param {object} [opts]
 * @param {number}  [opts.quality=10]     Vorbis VBR quality 0–10 (used when NOT matching).
 * @param {boolean} [opts.matchSource=true]
 *        When true and the source is a LOSSY file with a known bitrate, the
 *        output is encoded at ~that same bitrate (constant-bitrate ABR), so the
 *        exported song.ogg stays about the same size/quality as the upload
 *        instead of ballooning at q10. For lossless sources (WAV/FLAC/PCM) or an
 *        unknown bitrate there is nothing to match, so it uses `quality`.
 *
 * The native sample rate is always probed and preserved (a 48 kHz upload is not
 * downsampled to 44100), and the prepended silence is generated at that same
 * rate so the concat stays sample-accurate.
 */
async function padToOgg(inputPath, seconds, opts = {}) {
  const { quality = 10, matchSource = true } = opts
  const q = clampQuality(quality)
  const tailPad = await coldEndPad(inputPath)
  return new Promise((resolve, reject) => {
    probeAudio(inputPath).then(({ sampleRate: sr, codec, bitRate }) => {
      const out = path.join(TMP_DIR, `${Date.now()}_final.ogg`)

      // Decide the encoder args: match the source bitrate, or use a quality target.
      let encodeOpts
      if (matchSource && LOSSY_CODECS.has(codec) && bitRate > 0) {
        // Clamp to a sane Vorbis range (kbps): below ~64 sounds bad, above ~500
        // is pointless. Round to nearest kbps.
        const kbps = Math.min(500, Math.max(64, Math.round(bitRate / 1000)))
        encodeOpts = ['-c:a', 'libvorbis', '-b:a', `${kbps}k`, '-ar', String(sr)]
      } else {
        encodeOpts = ['-c:a', 'libvorbis', '-q:a', String(q), '-ar', String(sr)]
      }

      const filters = [
        // Match silence branch to the source rate/layout so concat can't resample or downmix
        `[1:a]aresample=${sr},aformat=channel_layouts=stereo[src]`,
        '[0:a][src]concat=n=2:v=0:a=1[out]'
      ]
      let outLabel = '[out]'
      if (tailPad > 0) {
        // Cold end: top the outro up to ≥2 s of silence (ScoreSaber outro rule)
        filters.push(`[out]apad=pad_dur=${tailPad.toFixed(3)}[fin]`)
        outLabel = '[fin]'
      }

      ffmpeg()
        .input(`aevalsrc=0|0:d=${seconds.toFixed(6)}:s=${sr}`)
        .inputOptions(['-f', 'lavfi'])
        .input(inputPath)
        .complexFilter(filters)
        .outputOptions(['-map', outLabel, ...encodeOpts])
        .output(out)
        .on('end',   () => resolve(out))
        .on('error', (err) => {
          fs.unlink(out, () => {})
          reject(new Error(`FFmpeg pad+encode: ${err.message}`))
        })
        .run()
    })
  })
}

module.exports = { toOgg, addSilence, padToOgg }
