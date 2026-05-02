const axios = require('axios')
const sharp  = require('sharp')
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

      await sharp(Buffer.from(imgRes.data))
        .resize(COVER_SIZE, COVER_SIZE, { fit: 'cover', position: 'centre' })
        .jpeg({ quality: 90 })
        .toFile(outPath)

      return outPath
    }
  } catch (err) {
    console.warn('[cover] fetch failed:', err.message)
  }

  // Fallback: dark grey placeholder
  await sharp({
    create: {
      width: COVER_SIZE,
      height: COVER_SIZE,
      channels: 3,
      background: { r: 28, g: 28, b: 32 }
    }
  })
    .jpeg({ quality: 80 })
    .toFile(outPath)

  return outPath
}

module.exports = { fetch }
