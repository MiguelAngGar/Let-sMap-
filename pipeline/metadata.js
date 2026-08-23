const axios = require('axios')
const text  = require('./text')
const net   = require('./net')

const MB_URL     = 'https://musicbrainz.org/ws/2/recording/'
const USER_AGENT = 'LetsMap/0.3 (https://github.com/MiguelAngGar/Let-sMap-)'

// ── Confidence heuristics ────────────────────────────────────────────────────
//
// This lookup only runs when the audio file itself has no usable tags
// (see meta-resolve.js), so its answer is a guess about an unknown file — the
// bar to accept it without asking the user is deliberately high.
//
// A match is "confident" only if ALL of these hold:
//   1. the query has real substance (≥ MIN_QUERY_TOKENS tokens, ≥ 6 chars), AND
//   2. MusicBrainz relevance score ≥ MIN_SCORE, AND
//   3. every token of the matched TITLE appears in the query, AND
//   4. an artist was found AND every token of the ARTIST appears in the query, AND
//   5. if both the recording length and the audio duration are known, they
//      agree within MAX_DUR_DIFF seconds.
//
// Conservative on purpose: a false "confident" silently writes wrong metadata,
// a false "unsure" merely shows the confirmation screen.

const MIN_SCORE        = 95
const MIN_QUERY_TOKENS = 2
const MAX_DUR_DIFF     = 6      // seconds
const CANDIDATES       = 5      // how many MB results to consider

const _norm     = text.normalize
const _contains = text.containsAll

/** Extract the fields we care about from a MusicBrainz recording object. */
function _shape(rec, fallbackTitle) {
  return {
    title:    rec.title || fallbackTitle,
    artist:   rec['artist-credit']?.[0]?.artist?.name || '',
    album:    rec.releases?.[0]?.title || '',
    score:    typeof rec.score  === 'number' ? rec.score  : 0,
    lengthMs: typeof rec.length === 'number' ? rec.length : 0
  }
}

/**
 * Duration agreement: true = matches, false = contradicts, null = unknown.
 * A contradiction is a hard veto; "unknown" never blocks on its own.
 */
function _durationVerdict(lengthMs, durationSec) {
  if (!lengthMs || !durationSec) return null
  return Math.abs(lengthMs / 1000 - durationSec) <= MAX_DUR_DIFF
}

/**
 * Look up song title + artist on MusicBrainz.
 * Returns partial data on failure — never throws.
 *
 * @param {string} query                 Free-text query (cleaned filename / tags)
 * @param {object} [opts]
 * @param {number} [opts.durationSec]    Audio duration, used to veto bad matches
 * @returns {Promise<{ title, artist, album, found, confident, score }>}
 */
async function fetch(query, opts = {}) {
  const { durationSec = 0 } = opts
  const defaults = {
    title: query, artist: '', album: '',
    found: false, confident: false, score: 0
  }

  const queryTokens = text.tokens(query)
  if (!queryTokens.length) return defaults
  if (net.offline()) return defaults

  try {
    const res = await axios.get(MB_URL, {
      params:  { query, limit: CANDIDATES, fmt: 'json' },
      headers: { 'User-Agent': USER_AGENT },
      timeout: 6000
    })

    net.noteSuccess()

    const recs = res.data?.recordings || []
    if (!recs.length) return defaults

    const substantial = queryTokens.length >= MIN_QUERY_TOKENS &&
                        _norm(query).replace(/ /g, '').length >= 6

    // Score every candidate, then take the best confident one. Falling back to
    // the top result keeps a suggestion available for the confirmation screen.
    let best = null
    for (const rec of recs) {
      const cand    = _shape(rec, defaults.title)
      const durOk   = _durationVerdict(cand.lengthMs, durationSec)
      const matches = cand.score >= MIN_SCORE &&
                      _contains(query, cand.title) &&
                      !!cand.artist &&
                      _contains(query, cand.artist) &&
                      durOk !== false

      if (substantial && matches) {
        // A confirmed duration match is the strongest signal available —
        // take it immediately; otherwise keep looking for one.
        if (durOk === true) return { ...cand, found: true, confident: true }
        if (!best?.confident) best = { ...cand, found: true, confident: true }
      } else if (!best) {
        best = { ...cand, found: true, confident: false }
      }
    }

    return best || defaults
  } catch (err) {
    net.noteFailure(err)
    console.warn('[metadata] fetch failed:', err.message)
    return defaults
  }
}

module.exports = { fetch }
