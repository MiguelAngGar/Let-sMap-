const ffmpeg      = require('fluent-ffmpeg')
const ffmpegPath  = require('ffmpeg-static')
const path        = require('path')
const os          = require('os')
const fs          = require('fs')

// When packaged by electron-builder, ffmpeg-static is extracted to app.asar.unpacked.
// The path returned by the module still points inside app.asar, so we fix it here.
const resolvedFfmpegPath = ffmpegPath.replace('app.asar', 'app.asar.unpacked')
ffmpeg.setFfmpegPath(resolvedFfmpegPath)

const TMP_DIR = path.join(os.tmpdir(), 'letsmap')
if (!fs.existsSync(TMP_DIR)) fs.mkdirSync(TMP_DIR, { recursive: true })

/**
 * Convert any audio file to .ogg (libvorbis, 44100 Hz).
 */
function toOgg(inputPath) {
  return new Promise((resolve, reject) => {
    const out = path.join(TMP_DIR, `${Date.now()}_converted.ogg`)
    ffmpeg(inputPath)
      .audioCodec('libvorbis')
      .audioQuality(6)          // vorbis quality 0–10 (6 = ~192kbps)
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
 */
function addSilence(audioPath, seconds) {
  return new Promise((resolve, reject) => {
    const out = path.join(TMP_DIR, `${Date.now()}_padded.ogg`)
    ffmpeg()
      .input(`aevalsrc=0|0:d=${seconds.toFixed(6)}:s=44100`)
      .inputOptions(['-f', 'lavfi'])
      .input(audioPath)
      .complexFilter([
        '[1:a]aresample=44100,aformat=channel_layouts=stereo[src]',
        '[0:a][src]concat=n=2:v=0:a=1[out]'
      ])
      .outputOptions(['-map', '[out]', '-c:a', 'libvorbis', '-q:a', '6'])
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
 * toOgg() → addSilence() (two vorbis encodes). Sample-accurate: silence is
 * generated at 44100 Hz and concatenated before encoding.
 */
function padToOgg(inputPath, seconds) {
  return new Promise((resolve, reject) => {
    const out = path.join(TMP_DIR, `${Date.now()}_final.ogg`)
    ffmpeg()
      .input(`aevalsrc=0|0:d=${seconds.toFixed(6)}:s=44100`)
      .inputOptions(['-f', 'lavfi'])
      .input(inputPath)
      .complexFilter([
        // Force both branches to 44100 Hz stereo so concat can't downmix
        '[1:a]aresample=44100,aformat=channel_layouts=stereo[src]',
        '[0:a][src]concat=n=2:v=0:a=1[out]'
      ])
      .outputOptions(['-map', '[out]', '-c:a', 'libvorbis', '-q:a', '6', '-ar', '44100'])
      .output(out)
      .on('end',   () => resolve(out))
      .on('error', (err) => {
        fs.unlink(out, () => {})
        reject(new Error(`FFmpeg pad+encode: ${err.message}`))
      })
      .run()
  })
}

module.exports = { toOgg, addSilence, padToOgg }
