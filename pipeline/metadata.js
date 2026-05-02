const axios = require('axios')

const MB_URL    = 'https://musicbrainz.org/ws/2/recording/'
const USER_AGENT = 'LetsMap/0.1 (miguelangel.garrido02@gmail.com)'

/**
 * Fetch song title + artist from MusicBrainz using the filename as query.
 * Returns partial data on failure — never throws.
 */
async function fetch(query) {
  const defaults = { title: query, artist: '', album: '' }

  try {
    const res = await axios.get(MB_URL, {
      params: { query, limit: 1, fmt: 'json' },
      headers: { 'User-Agent': USER_AGENT },
      timeout: 6000
    })

    const rec = res.data?.recordings?.[0]
    if (!rec) return defaults

    return {
      title:  rec.title || defaults.title,
      artist: rec['artist-credit']?.[0]?.artist?.name || defaults.artist,
      album:  rec.releases?.[0]?.title || defaults.album
    }
  } catch (err) {
    console.warn('[metadata] fetch failed:', err.message)
    return defaults
  }
}

module.exports = { fetch }
