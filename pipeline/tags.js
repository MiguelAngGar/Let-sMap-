/**
 * pipeline/tags.js
 * ─────────────────────────────────────────────────────────────────────────────
 * Reads the metadata the audio file already carries: ID3 / Vorbis comments /
 * MP4 atoms, plus any embedded cover art.
 *
 * The file is the primary source of truth — an online lookup only happens when
 * the file has nothing usable to offer (see meta-resolve.js).
 *
 * Uses the bundled ffmpeg binary only (no ffprobe, no extra dependency):
 *   • `-f ffmetadata -`  → clean key=value tag dump on stdout
 *   • `-i file` (no out) → banner on stderr with Duration + attached-pic streams
 * Both are metadata-only reads, so they return in a few milliseconds.
 */

const path         = require('path')
const os           = require('os')
const fs           = require('fs')
const { execFile } = require('child_process')
const ffmpegPath   = require('ffmpeg-static')
const text         = require('./text')

// Packaged builds extract ffmpeg-static to app.asar.unpacked (see converter.js)
const FFMPEG = ffmpegPath.replace('app.asar', 'app.asar.unpacked')

const TMP_DIR = path.join(os.tmpdir(), 'letsmap')
if (!fs.existsSync(TMP_DIR)) fs.mkdirSync(TMP_DIR, { recursive: true })

/** Run ffmpeg and resolve { code, stdout, stderr }. Never rejects. */
function _run(args, timeout = 15000) {
  return new Promise((resolve) => {
    execFile(FFMPEG, args, { timeout, windowsHide: true, maxBuffer: 64 * 1024 * 1024 },
      (err, stdout, stderr) => resolve({
        failed: !!err,
        stdout: stdout || '',
        stderr: stderr || (err ? String(err.message) : '')
      }))
  })
}

// ── ffmetadata parsing ───────────────────────────────────────────────────────
//
// ffmetadata escapes '=', ';', '#', '\' and newlines with a backslash, and a
// value can continue on the next line when the line ends with a backslash.

function _parseFfmetadata(text) {
  const out   = {}
  const lines = text.split(/\r?\n/)

  for (let i = 0; i < lines.length; i++) {
    let line = lines[i]
    if (!line || line.startsWith(';') || line.startsWith('#')) continue
    // [STREAM] / [CHAPTER] sections are handled from the banner instead
    if (line.startsWith('[')) {
      while (i + 1 < lines.length && !lines[i + 1].startsWith('[')) i++
      continue
    }

    // Join continuation lines (value ends with an unescaped backslash)
    while (/(^|[^\\])(\\\\)*\\$/.test(line) && i + 1 < lines.length) {
      line = line.slice(0, -1) + '\n' + lines[++i]
    }

    // Split on the first unescaped '='
    let key = '', val = null
    for (let c = 0; c < line.length; c++) {
      if (line[c] === '\\') { key += line[c + 1] ?? ''; c++; continue }
      if (line[c] === '=')  { val = line.slice(c + 1); break }
      key += line[c]
    }
    if (val === null) continue

    out[key.trim().toLowerCase()] = val.replace(/\\(.)/g, '$1').trim()
  }
  return out
}

// ── Banner parsing ───────────────────────────────────────────────────────────
//
// Vorbis comments (.ogg / .opus) live on the audio STREAM, and the ffmetadata
// muxer does not dump those — so the banner is parsed as well:
//
//   Input #0, ogg, from 'song.ogg':
//     Duration: 00:00:08.00, …
//     Stream #0:0: Audio: vorbis, 44100 Hz, mono
//       Metadata:
//         ARTIST          : Ogg Artist
//
// The attached-picture stream carries its own "title: Album cover", so only the
// container block and the AUDIO stream block are collected.

function _parseBanner(stderr) {
  const format = {}, audio = {}
  let target = format      // whose metadata the current block belongs to
  let inMeta = false

  for (const line of stderr.split(/\r?\n/)) {
    if (/^\s*Input #/.test(line))            { target = format; inMeta = false; continue }
    if (/^\s*Stream #\S+:\s*Audio:/.test(line)) { target = audio;  inMeta = false; continue }
    if (/^\s*Stream #/.test(line))           { target = null;   inMeta = false; continue }
    if (/^\s*Metadata:\s*$/.test(line))      { inMeta = true;  continue }
    if (/^\s*(Duration:|Output #|At least|Chapter #)/.test(line)) { inMeta = false; continue }

    if (!inMeta || !target) continue

    const m = /^\s{2,}([^:]+?)\s*:\s?(.*)$/.exec(line)
    if (!m) { inMeta = false; continue }

    const key = m[1].trim().toLowerCase()
    const val = m[2].trim()
    if (key && val && !(key in target)) target[key] = val
  }
  return { format, audio }
}

/** "Duration: 00:03:41.52" → 221.52 (seconds), or 0 when absent. */
function _parseDuration(stderr) {
  const m = /Duration:\s*(\d+):(\d{2}):(\d{2}(?:\.\d+)?)/.exec(stderr)
  if (!m) return 0
  return (+m[1]) * 3600 + (+m[2]) * 60 + parseFloat(m[3])
}

/** True when the container carries an attached picture (cover art). */
function _hasAttachedPic(stderr) {
  return /Stream #\d+:\d+.*: Video:/.test(stderr) &&
         (/attached pic/.test(stderr) || /Video: (mjpeg|png|bmp|gif|webp)/.test(stderr))
}

// ── Placeholder tags ───────────────────────────────────────────────────────
//
// Rippers and converters fill the fields with something rather than nothing:
// "unknow", "Various Artists", "Track 03", the name of the site that made the
// file. Treating those as real metadata means trusting a value that says
// "I don't know" — so they count as an empty field instead, and the song falls
// through to the filename and the online lookup like any untagged file.

const JUNK_EXACT = new Set([
  'unknown', 'unknow', 'unkown', 'unknown artist', 'unknown album',
  'unknown title', 'desconocido', 'desconocida', 'various', 'various artists',
  'varios artistas', 'va', 'none', 'null', 'undefined', 'nan', 'n a', 'na',
  'untitled', 'sin titulo', 'no title', 'notitle', 'title', 'artist', 'album',
  'audio', 'audiotrack', 'sound', 'song', 'track', 'pista', 'music', 'musica',
  'youtube', 'youtube audio library', 'soundcloud', 'bandcamp', 'spotify',
  'tmp', 'temp', 'output', 'new recording'
])

// Anything of the shape "track 04", "pista 2", "audio 12", or a bare number,
// plus the calling cards download sites leave behind.
const JUNK_PATTERN = /^(track|pista|titulo|title|song|audio|file|mix)?\s*\d{1,3}$|^(mp3|m4a|wav|flac|ogg)\s*\d*$|(mp3juices|y2mate|savefrom|ytmp3|converto|320kbps|128kbps|downloaded\s*(from|with)|converted\s*(by|with)|free\s*download|ripped\s*by)/

/** True when a tag value carries no information about the song. */
function _isPlaceholder(value) {
  const norm = text.normalize(value)
  if (!norm) return true
  if (JUNK_EXACT.has(norm)) return true
  return JUNK_PATTERN.test(norm)
}

// ── Multi-value tags ────────────────────────────────────────────────────────
//
// Taggers store several values in one field separated by ';', and some write
// the same value twice: a real file arrived tagged "Dimrain47;Dimrain47" /
// "Infernoplex;Infernoplex" and produced a map folder named after both copies.
//
// A repeated value always collapses to one. Genuinely different values are only
// re-joined as a ", " list for artist fields, where ';' is the well-known
// separator — a title is left exactly as tagged, because "Wake Up; Get Up" is a
// song name, not two of them.
//
// Collapsing a repeat rewrites what the file said, so the field is reported back
// as `duplicated`: the caller then verifies it online instead of trusting it
// blindly (a band could genuinely be called "Duran Duran;Duran Duran"…).

function _collapse(value, joinDistinct = false) {
  const raw = String(value ?? '').trim()
  const parts = raw.split(/\s*[;\u0000]\s*/).map(s => s.trim()).filter(Boolean)
  if (parts.length < 2) return { value: raw, duplicated: false }

  const unique = new Map()                       // lowercase key → first spelling
  for (const part of parts) {
    const key = part.toLowerCase()
    if (!unique.has(key)) unique.set(key, part)
  }
  const values = Array.from(unique.values())
  const duplicated = values.length < parts.length

  // "Dimrain47;Dimrain47" → one value. "SAIKO;Feid" → a list, but only where a
  // list makes sense; anywhere else the raw string is kept untouched.
  const value_ = values.length === 1 ? values[0]
               : joinDistinct        ? values.join(', ')
               : raw

  return { value: value_, duplicated }
}

/** Empty tag result — shape stays stable so callers never branch on undefined. */
function _empty() {
  return {
    title: '', artist: '', album: '', albumArtist: '',
    durationSec: 0, hasCover: false, duplicated: [], placeholder: [], raw: {}
  }
}

/**
 * Read embedded tags + duration + cover-art presence.
 * Never throws: an unreadable file yields empty strings.
 *
 * @param {string} filePath
 * @returns {Promise<{ title, artist, album, albumArtist, durationSec, hasCover,
 *                     duplicated: string[], placeholder: string[], raw }>}
 */
async function read(filePath) {
  if (!filePath || !fs.existsSync(filePath)) return _empty()

  const [meta, probe] = await Promise.all([
    _run(['-v', 'error', '-i', filePath, '-f', 'ffmetadata', '-']),
    // No output file → ffmpeg prints the stream banner and exits non-zero.
    _run(['-hide_banner', '-i', filePath])
  ])

  const dump   = _parseFfmetadata(meta.stdout)
  const banner = _parseBanner(probe.stderr)

  // Container tags win over stream tags; the ffmetadata dump is the cleanest
  // source (no truncation, proper unescaping) so it is consulted first.
  const sources = [dump, banner.format, banner.audio]
  // Fields whose tag held the same value twice — see _collapse above
  const duplicated = []
  // Fields whose tag said nothing ("unknow", "Track 03") and were dropped
  const placeholder = []

  // opts.list = the field is a list of people, where ';' separates entries
  const pick = (field, keys, opts = {}) => {
    for (const src of sources) {
      for (const k of keys) {
        const v = src[k]
        if (typeof v !== 'string' || !v.trim()) continue

        const res = _collapse(v, opts.list === true)

        if (_isPlaceholder(res.value)) {
          // Keep looking: another source may hold something real
          if (!placeholder.includes(field)) {
            placeholder.push(field)
            console.log(`[tags] ignoring placeholder ${field}: "${res.value}"`)
          }
          continue
        }

        if (res.duplicated) duplicated.push(field)
        return res.value
      }
    }
    return ''
  }

  return {
    title:       pick('title',       ['title', 'tit2', 'inam']),
    artist:      pick('artist',      ['artist', 'tpe1', 'iart', 'author'], { list: true }),
    album:       pick('album',       ['album', 'talb', 'iprd']),
    albumArtist: pick('albumArtist', ['album_artist', 'albumartist', 'tpe2'], { list: true }),
    durationSec: _parseDuration(probe.stderr),
    hasCover:    _hasAttachedPic(probe.stderr),
    duplicated,
    placeholder,
    raw:         { ...banner.audio, ...banner.format, ...dump }
  }
}

/**
 * Extract the first embedded picture to a temp PNG.
 * @returns {Promise<string|null>} path to the raw image, or null when none
 */
async function extractCover(filePath) {
  if (!filePath || !fs.existsSync(filePath)) return null

  const out = path.join(TMP_DIR, `${Date.now()}_embedded.png`)
  const res = await _run([
    '-v', 'error', '-y', '-i', filePath,
    '-map', '0:v:0', '-frames:v', '1', '-f', 'image2', out
  ])

  if (res.failed || !fs.existsSync(out) || fs.statSync(out).size === 0) {
    fs.unlink(out, () => {})
    return null
  }
  return out
}

module.exports = { read, extractCover, isPlaceholder: _isPlaceholder }
