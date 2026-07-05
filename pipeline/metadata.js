const axios = require('axios')

const MB_URL    = 'https://musicbrainz.org/ws/2/recording/'
const USER_AGENT = 'LetsMap/0.1 (https://github.com/MiguelAngGar/Let-sMap-)'

// ── Confidence heuristics ────────────────────────────────────────────────────
//
// A match is "confident" only if:
//   1. MusicBrainz relevance score ≥ MIN_SCORE, AND
//   2. every token of the matched TITLE appears in the filename query, AND
//   3. an artist was found AND every token of the ARTIST appears in the query.
//
// Conservative on purpose: false "confident" silently writes wrong metadata,
// false "unsure" merely shows the confirmation screen.

const MIN_SCORE = 90

/** lowercase, strip diacritics, keep alphanumerics only */
function _norm(s) {
  return (s || '')
    .toLowerCase()
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim()
}

/** true if every token of `needle` appears as a token of `hay` */
function _contains(hay, needle) {
  const hayTokens = new Set(_norm(hay).split(' '))
  const tokens    = _norm(needle).split(' ').filter(Boolean)
  if (!tokens.length) return false
  return tokens.every(t => hayTokens.has(t))
}

/**
 * Fetch song title + artist from MusicBrainz using the filename as query.
 * Returns partial data on failure — never throws.
 * @returns {Promise<{ title, artist, album, found, confident }>}
 */
async function fetch(query) {
  const defaults = { title: query, artist: '', album: '', found: false, confident: false }

  try {
    const res = await axios.get(MB_URL, {
      params: { query, limit: 1, fmt: 'json' },
      headers: { 'User-Agent': USER_AGENT },
      timeout: 6000
    })

    const rec = res.data?.recordings?.[0]
    if (!rec) return defaults

    const title  = rec.title || defaults.title
    const artist = rec['artist-credit']?.[0]?.artist?.name || ''
    const score  = typeof rec.score === 'number' ? rec.score : 0

    const confident =
      score >= MIN_SCORE &&
      _contains(query, title) &&
      !!artist &&
      _contains(query, artist)

    return {
      title,
      artist,
      album: rec.releases?.[0]?.title || defaults.album,
      found: true,
      confident
    }
  } catch (err) {
    console.warn('[metadata] fetch failed:', err.message)
    return defaults
  }
}

module.exports = { fetch }
