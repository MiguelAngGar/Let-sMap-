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

// Bitrate window used when following a lossy source (kbps).
// The floor is 96 rather than the source's own bitrate because libvorbis treats
// -b:a as a loose average and lands roughly 30% under the target: asking for
// 64k on a poor YouTube rip produced ~45 kbps of actual audio, which is audible
// in the map. Above ~500 kbps there is nothing left to gain.
const MIN_MATCH_KBPS = 96
const MAX_MATCH_KBPS = 500

// Nominal bitrate of each libvorbis quality step, q0 … q10 (kbps). Used to put
// the chosen quality and the source's bitrate on the same scale.
const VORBIS_KBPS = [64, 80, 96, 112, 128, 160, 192, 224, 256, 320, 500]

// Codecs that are already lossy: matching their bitrate keeps size/quality
// roughly identical. Anything not listed here (flac, alac, pcm_*, wavpack,
// truehd…) is treated as lossless, where "match bitrate" is meaningless.
const LOSSY_CODECS = new Set([
  'mp3', 'aac', 'vorbis', 'opus', 'wmav1', 'wmav2', 'ac3', 'eac3',
  'mp2', 'mp1', 'cook', 'atrac3', 'atrac3p', 'dts'
])

/**
 * Parse ffmpeg's banner for the first audio stream's codec, sample rate and
 * bitrate. Exported for testing.
 *
 *   Input #0, mp3, from 'song.mp3':
 *     Duration: 00:03:41.52, start: 0.025056, bitrate: 321 kb/s
 *     Stream #0:0: Audio: mp3, 44100 Hz, stereo, fltp, 320 kb/s
 *
 * The stream bitrate is preferred; the container one (which includes tag and
 * container overhead) is the fallback, matching the old ffprobe logic.
 */
function parseProbe(text) {
  const out = { sampleRate: 44100, codec: null, bitRate: 0 }
  if (!text) return out

  const line = (/Stream #\d+:\d+[^\n]*: Audio: [^\n]*/.exec(text) || [''])[0]
  if (line) {
    const codec = /: Audio: ([A-Za-z0-9_.\-]+)/.exec(line)
    if (codec) out.codec = codec[1].toLowerCase()

    const sr = /(\d+(?:\.\d+)?)\s*(k)?Hz/.exec(line)
    if (sr) {
      const hz = Math.round(parseFloat(sr[1]) * (sr[2] ? 1000 : 1))
      if (hz > 0) out.sampleRate = hz
    }

    const br = /(\d+(?:\.\d+)?)\s*kb\/s/.exec(line)
    if (br) out.bitRate = Math.round(parseFloat(br[1]) * 1000)
  }

  if (!out.bitRate) {
    const fb = /Duration:[^\n]*?bitrate:\s*(\d+(?:\.\d+)?)\s*kb\/s/.exec(text)
    if (fb) out.bitRate = Math.round(parseFloat(fb[1]) * 1000)
  }

  return out
}

/**
 * Probe a file's audio stream. Returns sample rate, codec and bitrate (bps).
 *
 * Read from ffmpeg's own banner instead of ffprobe: only the ffmpeg binary is
 * bundled (ffmpeg-static), so `ffprobe` was missing on most machines, failed
 * silently and returned the defaults below — which quietly disabled "keep
 * original file quality" and exported everything at q10. ffmpeg with no output
 * file prints the stream info and exits non-zero; that is the whole probe.
 *
 * All fields fall back to safe defaults if the banner cannot be parsed.
 */
function probeAudio(inputPath) {
  return new Promise((resolve) => {
    execFile(resolvedFfmpegPath, ['-hide_banner', '-i', inputPath],
      { encoding: 'utf8', maxBuffer: 8 * 1024 * 1024, windowsHide: true },
      (_err, _stdout, stderr) => {
        const info = parseProbe(stderr || '')
        if (!info.codec) console.warn('[converter] probe found no audio stream in', inputPath)
        resolve(info)
      })
  })
}

// ── Cold end (ScoreSaber outro rule) ─────────────────────────────────────────
// "A map must have an outro period of more than 2 seconds" — if the source
// audio ends abruptly, the mapper cannot satisfy it. Exports therefore
// guarantee at least this much trailing silence, adding only the missing
// difference (never "excessive silence"). The default matches the criteria;
// Settings can raise or lower it, and the UI warns when it goes below.
const COLD_END_SECONDS = 2.0
const MAX_SILENCE_SECONDS = 15.0   // the criteria cap the outro at 15 s

/** Keep a configured silence target inside sane bounds. */
function clampSilence(value, fallback) {
  const n = Number(value)
  if (!Number.isFinite(n) || n < 0) return fallback
  return Math.min(MAX_SILENCE_SECONDS, Math.round(n * 1000) / 1000)
}

/**
 * Measure how much trailing silence the file already has (seconds).
 * Decodes the last `lookback` seconds to mono PCM and scans 20 ms RMS windows
 * against a −45 dBFS threshold. Resolves 0 on any decode problem (⇒ full pad).
 *
 * The window has to be wider than the criteria's outro ceiling (15 s), or a
 * song that ends with 20 s of silence would look like it ends with 12 and we
 * could never tell the user their outro is too long to be ranked.
 */
function measureTrailingSilence(inputPath, lookback = 20) {
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

/**
 * Seconds of silence to append so the export ends with at least `target`.
 * Silence the file already has counts towards it, so a song that fades out
 * gets nothing added.
 */
async function coldEndPad(inputPath, target = COLD_END_SECONDS) {
  const wanted = clampSilence(target, COLD_END_SECONDS)
  const trailing = await measureTrailingSilence(inputPath)
  const pad = Math.max(0, wanted - trailing)
  return pad > 0.01 ? pad : 0
}

/**
 * How much silence to append, from either of the two ways a caller can ask.
 *
 * `coldEndAdd` says it outright: append exactly this much, and 0 means leave the
 * end of the audio exactly as it is. That is what the BPM view sends, because
 * its ± moves that number directly and the export has to deliver what the
 * readout promised — not re-derive it from a target and land somewhere else.
 *
 * `coldEnd` is the older way: a TARGET for the total, from which the missing
 * amount is worked out by measuring the file. Kept for pipeline/index.js and
 * any caller that only knows the setting.
 *
 * Explicit wins, and asking for exactly 0 has to mean 0 — so the target is only
 * consulted when no explicit amount was given at all.
 */
async function resolveTailPad(inputPath, opts = {}) {
  if (Number.isFinite(opts.coldEndAdd)) {
    const add = clampSilence(Math.max(0, opts.coldEndAdd), 0)
    return add > 0.01 ? add : 0
  }
  return coldEndPad(inputPath, opts.coldEnd)
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
  // original source to follow here, so just honour the quality target.
  const q = clampQuality(opts.quality ?? 10)
  const pad = Number(seconds) > 0.001 ? Number(seconds) : 0
  const tailPad = await resolveTailPad(audioPath, opts)
  return new Promise((resolve, reject) => {
    const out = path.join(TMP_DIR, `${Date.now()}_padded.ogg`)
    const cmd = ffmpeg()
    const filters = []

    if (pad > 0) {
      cmd.input(`aevalsrc=0|0:d=${pad.toFixed(6)}:s=44100`).inputOptions(['-f', 'lavfi'])
      cmd.input(audioPath)
      filters.push('[1:a]aresample=44100,aformat=channel_layouts=stereo[src]')
      filters.push('[0:a][src]concat=n=2:v=0:a=1[out]')
    } else {
      cmd.input(audioPath)
      filters.push('[0:a]aresample=44100,aformat=channel_layouts=stereo[out]')
    }

    let outLabel = '[out]'
    if (tailPad > 0) {
      filters.push(`[out]apad=pad_dur=${tailPad.toFixed(3)}[fin]`)
      outLabel = '[fin]'
    }
    cmd
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
 * Choose the encoder settings for the exported song.ogg.
 *
 * The quality picked in Settings is a CEILING, not a target:
 *
 *   • A lossless source (WAV/FLAC/PCM) has no bitrate worth following, so it is
 *     encoded at that quality.
 *   • A lossy source better than the chosen quality is encoded at that quality
 *     too — there is no point storing more than the user asked for.
 *   • A lossy source ALREADY WORSE than the chosen quality keeps its own
 *     bitrate. Re-encoding a 96 kbps rip at q8 cannot invent the detail that
 *     was thrown away; it only triples the file size.
 *
 * @returns {{ encodeOpts: string[], reason: string }}
 */
function encoderArgs({ quality, codec, bitRate, sampleRate }) {
  const q      = clampQuality(quality)
  const target = VORBIS_KBPS[q]
  const source = bitRate > 0 ? Math.round(bitRate / 1000) : 0
  const rate   = ['-ar', String(sampleRate)]

  if (LOSSY_CODECS.has(codec) && source > 0 && source < target) {
    // Never below the floor, never above the ceiling the user chose
    let kbps = Math.max(MIN_MATCH_KBPS, source)
    kbps = Math.min(kbps, target, MAX_MATCH_KBPS)
    return {
      encodeOpts: ['-c:a', 'libvorbis', '-b:a', `${kbps}k`, ...rate],
      reason: `source ${source}kbps is under q${q} (~${target}kbps), following the source`
    }
  }

  return {
    encodeOpts: ['-c:a', 'libvorbis', '-q:a', String(q), ...rate],
    reason: source > 0
      ? `source ${source}kbps is at or above q${q} (~${target}kbps), capping at q${q}`
      : `no bitrate to follow, using q${q}`
  }
}

/**
 * Prepend `seconds` of silence to the ORIGINAL (lossless/source) file and
 * encode to .ogg in a single pass. Avoids the double-lossy generation of
 * toOgg() → addSilence() (two vorbis encodes).
 *
 * `seconds` may legitimately be 0: a song that already opens with enough
 * silence before its first beat needs none added (see phase2.calcSilencePad),
 * and in that case the silence branch is left out of the filter graph entirely.
 *
 * @param {string} inputPath
 * @param {number} seconds            Silence to prepend (0 = none).
 * @param {object} [opts]
 * @param {number} [opts.quality=10]  Vorbis quality CEILING 0–10. A source
 *        already poorer than this keeps its own bitrate instead of being
 *        re-encoded larger for nothing — see encoderArgs above.
 * @param {number} [opts.coldEndAdd]  Silence to append, exactly (seconds).
 *        0 leaves the end of the audio untouched. Takes precedence over coldEnd.
 * @param {number} [opts.coldEnd=2]   Fallback when coldEndAdd is absent: a
 *        TARGET for the total trailing silence, of which only the missing
 *        amount is appended.
 *
 * The native sample rate is always probed and preserved (a 48 kHz upload is not
 * downsampled to 44100), and any prepended silence is generated at that same
 * rate so the concat stays sample-accurate.
 */
async function padToOgg(inputPath, seconds, opts = {}) {
  const q = clampQuality(opts.quality ?? 10)
  const pad = Number(seconds) > 0.001 ? Number(seconds) : 0
  const tailPad = await resolveTailPad(inputPath, opts)

  return new Promise((resolve, reject) => {
    probeAudio(inputPath).then(({ sampleRate: sr, codec, bitRate }) => {
      const out = path.join(TMP_DIR, `${Date.now()}_final.ogg`)

      const { encodeOpts, reason } = encoderArgs({ quality: q, codec, bitRate, sampleRate: sr })

      console.log(`[converter] source ${codec || '?'} ${Math.round(bitRate / 1000)}kbps ${sr}Hz → ` +
                  `${encodeOpts.join(' ')}  (${reason})`)
      console.log(`[converter] lead-in ${pad.toFixed(3)}s, cold end +${tailPad.toFixed(3)}s`)

      const cmd = ffmpeg()
      const filters = []
      let label

      if (pad > 0) {
        cmd.input(`aevalsrc=0|0:d=${pad.toFixed(6)}:s=${sr}`).inputOptions(['-f', 'lavfi'])
        cmd.input(inputPath)
        // Match the silence branch to the source rate/layout so concat cannot
        // resample or downmix
        filters.push(`[1:a]aresample=${sr},aformat=channel_layouts=stereo[src]`)
        filters.push('[0:a][src]concat=n=2:v=0:a=1[out]')
      } else {
        cmd.input(inputPath)
        // Nothing to prepend: still route the audio through the graph so the
        // output is audio-only (a source can carry embedded cover art)
        filters.push(`[0:a]aresample=${sr},aformat=channel_layouts=stereo[out]`)
      }
      label = '[out]'

      if (tailPad > 0) {
        // Cold end: top the outro up to ≥2 s of silence (ScoreSaber outro rule)
        filters.push(`${label}apad=pad_dur=${tailPad.toFixed(3)}[fin]`)
        label = '[fin]'
      }

      cmd.complexFilter(filters)
        .outputOptions(['-map', label, ...encodeOpts])
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

module.exports = {
  toOgg, addSilence, padToOgg, probeAudio, parseProbe, encoderArgs,
  coldEndPad, resolveTailPad, clampSilence, measureTrailingSilence,
  COLD_END_SECONDS, MAX_SILENCE_SECONDS
}
