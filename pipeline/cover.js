const axios = require('axios')
const Jimp   = require('jimp')
const path   = require('path')
const os     = require('os')
const fs     = require('fs')

const TMP_DIR = path.join(os.tmpdir(), 'letsmap')
if (!fs.existsSync(TMP_DIR)) fs.mkdirSync(TMP_DIR, { recursive: true })

const COVER_SIZE = 512

/**
 * Fetch cover art from iTunes Search API, resize to 512×512 JPEG.
 * Generates a solid-color placeholder on failure — never throws.
 * @returns {Promise<string>} path to cover image
 */
async function fetch(artist, title) {
  const outPath = path.join(TMP_DIR, `${Date.now()}_cover.jpg`)

  try {
    const query   = encodeURIComponent(`${artist} ${title}`.trim() || title)
    const res     = await axios.get(
      `https://itunes.apple.com/search?term=${query}&media=music&limit=1`,
      { timeout: 7000 }
    )

    const item = res.data?.results?.[0]
    if (item?.artworkUrl100) {
      // Upgrade 100×100 thumbnail to highest available resolution
      const imageUrl = item.artworkUrl100
        .replace('100x100bb', '600x600bb')
        .replace('100x100',   '600x600')

      const imgRes = await axios.get(imageUrl, {
        responseType: 'arraybuffer',
        timeout: 10000
      })

      const img = await Jimp.read(Buffer.from(imgRes.data))
      // Cover crop: scale so both dimensions fill COVER_SIZE, then crop centre
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
  } catch (err) {
    console.warn('[cover] fetch failed:', err.message)
  }

  // Fallback: dark grey placeholder
  const placeholder = new Jimp(COVER_SIZE, COVER_SIZE, 0x1c1c20ff)
  placeholder.quality(80)
  await placeholder.writeAsync(outPath)

  return outPath
}

module.exports = { fetch }
