const axios  = require('axios')
const Jimp   = require('jimp')
const path   = require('path')
const os     = require('os')
const fs     = require('fs')
const { execFile }      = require('child_process')
const { fileURLToPath } = require('url')
const text              = require('./text')
const net               = require('./net')
const ffmpegPath   = require('ffmpeg-static')

// Packaged builds extract ffmpeg-static to app.asar.unpacked (see converter.js)
const FFMPEG = ffmpegPath.replace('app.asar', 'app.asar.unpacked')

const TMP_DIR = path.join(os.tmpdir(), 'letsmap')
if (!fs.existsSync(TMP_DIR)) fs.mkdirSync(TMP_DIR, { recursive: true })

const COVER_SIZE = 512
const MAX_DOWNLOAD_BYTES = 25 * 1024 * 1024   // sane ceiling for a dropped image

function _outPath(suffix = 'cover.jpg') {
  return path.join(TMP_DIR, `${Date.now()}_${suffix}`)
}

/** Cover-crop a Jimp image to COVER_SIZE² and write as JPEG. Returns outPath. */
async function _writeSquare(img, outPath) {
  const ratio = Math.max(COVER_SIZE / img.bitmap.width, COVER_SIZE / img.bitmap.height)
  img
    .resize(Math.round(img.bitmap.width * ratio), Math.round(img.bitmap.height * ratio))
    .crop(
      Math.floor((img.bitmap.width  - COVER_SIZE) / 2),
      Math.floor((img.bitmap.height - COVER_SIZE) / 2),
      COVER_SIZE,
      COVER_SIZE
    )
    .quality(90)
  await img.writeAsync(outPath)
  return outPath
}

/** Transcode any image ffmpeg understands into a PNG Jimp can read. */
function _toPng(srcPath) {
  return new Promise((resolve, reject) => {
    const out = _outPath('decoded.png')
    execFile(FFMPEG, ['-v', 'error', '-y', '-i', srcPath, '-frames:v', '1', '-f', 'image2', out],
      { windowsHide: true }, (err) => {
        if (err || !fs.existsSync(out) || fs.statSync(out).size === 0) {
          fs.unlink(out, () => {})
          return reject(new Error('unsupported image format'))
        }
        resolve(out)
      })
  })
}

/**
 * Read an image file into Jimp. Jimp only handles PNG/JPEG/BMP/TIFF/GIF, and
 * browsers hand out WebP (and the odd AVIF) all the time — those go through
 * ffmpeg first, which is already bundled for the audio side.
 */
async function _readImage(srcPath) {
  try {
    return await Jimp.read(srcPath)
  } catch {
    return await Jimp.read(await _toPng(srcPath))
  }
}

/**
 * Does this iTunes result actually belong to the song we asked about?
 *
 * A text search always answers with the closest thing it has, so without this
 * check a map can end up with correct metadata and the artwork of a different
 * record. Both names are compared loosely, because catalogue entries carry
 * extras ours does not ("Ghost (Extended Mix)", one artist of a collab).
 */
function _artworkMatches(item, artist, title) {
  const gotTitle  = item.trackName  || item.collectionName || ''
  const gotArtist = item.artistName || ''

  const titleOk  = !title  || text.looselyMatches(gotTitle, title)
  const artistOk = !artist || text.looselyMatches(gotArtist, artist)

  // With no artist to cross-check, the title alone has to carry it, so demand
  // a real match there rather than a loose one.
  if (!artist) return !!title && text.sameText(gotTitle, title)

  return titleOk && artistOk
}

/**
 * Fetch cover art from iTunes Search API, resize to 512×512 JPEG.
 * The result is rejected unless it is the same song we asked for.
 * @returns {Promise<string|null>} path to cover image, or null if not found
 */
async function fetchRemote(artist, title) {
  try {
    const query = encodeURIComponent(`${artist} ${title}`.trim() || title)
    if (!query) return null
    if (net.offline()) return null

    // A few results, so a slightly-off first hit does not lose a good match
    const res = await axios.get(
      `https://itunes.apple.com/search?term=${query}&media=music&limit=5`,
      { timeout: 7000 }
    )

    net.noteSuccess()

    const results = res.data?.results || []
    const item = results.find(r => r?.artworkUrl100 && _artworkMatches(r, artist, title))

    if (!item) {
      if (results.length) {
        const first = results[0]
        console.log(`[cover] discarded artwork for "${first.artistName} - ${first.trackName}" ` +
                    `(asked for "${artist} - ${title}")`)
      }
      return null
    }

    // Upgrade 100×100 thumbnail to highest available resolution
    const imageUrl = item.artworkUrl100
      .replace('100x100bb', '600x600bb')
      .replace('100x100',   '600x600')

    const imgRes = await axios.get(imageUrl, {
      responseType: 'arraybuffer',
      timeout: 10000
    })

    // Through fromBuffer so downloaded artwork gets the same format fallback
    // as a dropped file (Jimp alone cannot read WebP)
    return await fromBuffer(Buffer.from(imgRes.data))
  } catch (err) {
    net.noteFailure(err)
    console.warn('[cover] fetch failed:', err.message)
    return null
  }
}

/** Dark grey placeholder cover. Never throws. */
async function placeholder() {
  const outPath = _outPath()
  const img = new Jimp(COVER_SIZE, COVER_SIZE, 0x1c1c20ff)
  img.quality(80)
  await img.writeAsync(outPath)
  return outPath
}

/**
 * Process a user-picked local image into the 512×512 JPEG cover format.
 * @returns {Promise<string>} path to processed cover — throws on unreadable file
 */
async function fromFile(srcPath) {
  return _writeSquare(await _readImage(srcPath), _outPath())
}

/**
 * Same, from raw bytes (a dropped data: URL, a download). The bytes hit a temp
 * file first so the ffmpeg fallback in _readImage can reach them.
 * @returns {Promise<string>} path to processed cover — throws on unreadable data
 */
async function fromBuffer(buf) {
  if (!buf || !buf.length) throw new Error('empty image data')
  if (buf.length > MAX_DOWNLOAD_BYTES) throw new Error('image too large')

  const tmp = _outPath('dropped.img')
  fs.writeFileSync(tmp, buf)
  try {
    return await fromFile(tmp)
  } finally {
    fs.unlink(tmp, () => {})
  }
}

/**
 * Same, from an http(s) URL — an image dragged straight out of a browser.
 * @returns {Promise<string>} path to processed cover — throws on failure
 */
async function fromUrl(url) {
  try {
    const res = await axios.get(url, {
      responseType:   'arraybuffer',
      timeout:        12000,
      maxContentLength: MAX_DOWNLOAD_BYTES,
      maxBodyLength:    MAX_DOWNLOAD_BYTES
    })
    net.noteSuccess()
    return fromBuffer(Buffer.from(res.data))
  } catch (err) {
    net.noteFailure(err)
    throw err
  }
}

/**
 * Process whatever a drag & drop handed over: a local path, a file:// URL from
 * a file manager, an http(s) URL or a data: URL dragged out of a browser.
 * @returns {Promise<string|null>} processed cover path, or null if unusable
 */
async function fromDrop(src) {
  const s = typeof src === 'string' ? src.trim() : ''
  if (!s) return null

  try {
    if (/^https?:\/\//i.test(s)) return await fromUrl(s)

    if (/^data:image\//i.test(s)) {
      const comma = s.indexOf(',')
      if (comma < 0 || !/;base64/i.test(s.slice(0, comma))) return null
      return await fromBuffer(Buffer.from(s.slice(comma + 1), 'base64'))
    }

    return await fromFile(/^file:\/\//i.test(s) ? fileURLToPath(s) : s)
  } catch (err) {
    console.warn('[cover] dropped image rejected:', err.message)
    return null
  }
}

/**
 * Legacy behaviour: remote fetch with placeholder fallback — never throws.
 * @returns {Promise<string>} path to cover image
 */
async function fetch(artist, title) {
  return (await fetchRemote(artist, title)) || placeholder()
}

module.exports = { fetch, fetchRemote, placeholder, fromFile, fromBuffer, fromUrl, fromDrop }
