const ffmpeg      = require('fluent-ffmpeg')
const ffmpegPath  = require('ffmpeg-static')
const path        = require('path')
const os          = require('os')
const fs          = require('fs')

// Use the bundled ffmpeg binary (compiled with libvorbis + all common codecs)
ffmpeg.setFfmpegPath(ffmpegPath)

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
      .on('error', (err) => reject(new Error(`FFmpeg convert: ${err.message}`)))
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
      .input(`aevalsrc=0:d=${seconds.toFixed(6)}`)
      .inputOptions(['-f', 'lavfi'])
      .input(audioPath)
      .complexFilter(['[0:a][1:a]concat=n=2:v=0:a=1[out]'])
      .outputOptions(['-map', '[out]', '-c:a', 'libvorbis', '-q:a', '6'])
      .output(out)
      .on('end',   () => resolve(out))
      .on('error', (err) => reject(new Error(`FFmpeg silence: ${err.message}`)))
      .run()
  })
}

module.exports = { toOgg, addSilence }
