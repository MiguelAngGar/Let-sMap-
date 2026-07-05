const axios = require('axios')
const Jimp   = require('jimp')
const path   = require('path')
const os     = require('os')
const fs     = require('fs')

const TMP_DIR = path.join(os.tmpdir(), 'letsmap')
if (!fs.existsSync(TMP_DIR)) fs.mkdirSync(TMP_DIR, { recursive: true })

const COVER_SIZE = 512

function _outPath() {
  return path.join(TMP_DIR, `${Date.now()}_cover.jpg`)
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

/**
 * Fetch cover art from iTunes Search API, resize to 512×512 JPEG.
 * @returns {Promise<string|null>} path to cover image, or null if not found
 */
async function fetchRemote(artist, title) {
  try {
    const query = encodeURIComponent(`${artist} ${title}`.trim() || title)
    if (!query) return null

    const res = await axios.get(
      `https://itunes.apple.com/search?term=${query}&media=music&limit=1`,
      { timeout: 7000 }
    )

    const item = res.data?.results?.[0]
    if (!item?.artworkUrl100) return null

    // Upgrade 100×100 thumbnail to highest available resolution
    const imageUrl = item.artworkUrl100
      .replace('100x100bb', '600x600bb')
      .replace('100x100',   '600x600')

    const imgRes = await axios.get(imageUrl, {
      responseType: 'arraybuffer',
      timeout: 10000
    })

    const img = await Jimp.read(Buffer.from(imgRes.data))
    return await _writeSquare(img, _outPath())
  } catch (err) {
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
  const img = await Jimp.read(srcPath)
  return _writeSquare(img, _outPath())
}

/**
 * Legacy behaviour: remote fetch with placeholder fallback — never throws.
 * @returns {Promise<string>} path to cover image
 */
async function fetch(artist, title) {
  return (await fetchRemote(artist, title)) || placeholder()
}

module.exports = { fetch, fetchRemote, placeholder, fromFile }
