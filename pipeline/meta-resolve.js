/**
 * pipeline/meta-resolve.js
 * ─────────────────────────────────────────────────────────────────────────────
 * Decides what title / artist / cover a map gets, in this order of trust:
 *
 *   1. THE FILE'S OWN TAGS. If the audio carries both a title and an artist,
 *      it was tagged on purpose — use it verbatim and never touch the network
 *      for metadata. (Cover art may still be fetched if the file has none.)
 *      Exception: if a tag held the same value twice ("Dimrain47;Dimrain47")
 *      then reading it meant rewriting it, so the lookup runs anyway to confirm
 *      the collapsed value. Confirmed → trusted; anything else → ask the user.
 *      A tag that says nothing — "unknow", "Various Artists", "Track 03" — is
 *      treated as an empty field (see tags.js), so those files behave like
 *      untagged ones instead of naming a map after a placeholder.
 *   2. AN ONLINE TEXT LOOKUP, but only when it is confident (see metadata.js).
 *      Any tag the file does have still wins over the lookup's version of it.
 *   3. THE FILE ITSELF. Whatever tags exist, plus the cleaned-up filename as
 *      the title (and the artist when it reads "Artist - Title"), plus the
 *      embedded cover. Marked unsure, so the confirmation screen opens
 *      prefilled with the file's own data instead of an online guess.
 *
 * A low-confidence lookup result is never written anywhere — that was the bug
 * testers hit: a file with perfectly good tags got someone else's song name.
 */

const path     = require('path')
const tags     = require('./tags')
const metadata = require('./metadata')
const cover    = require('./cover')
const text     = require('./text')

// ── Filename clean-up ────────────────────────────────────────────────────────

// Bracketed noise that download sites and rippers leave behind
const JUNK = /\b(official(\s+(music\s+)?video|\s+audio|\s+lyrics?)?|music\s+video|lyrics?(\s+video)?|audio|visuali[sz]er|full\s+album|hd|hq|4k|1080p|720p|remaster(ed)?(\s+\d{4})?|explicit|free\s+download|copyright\s+free|no\s+copyright|topic)\b/i

/**
 * Turn a raw filename (no extension) into something readable:
 * strips track numbers, bracketed noise and separator characters.
 */
function cleanFilename(raw) {
  let s = String(raw || '').trim()
  if (!s) return ''

  // "Artist_-_Title" and dotted.names.like.this → spaces
  s = s.replace(/_+/g, ' ')
  if (!/\s/.test(s) && (s.match(/\./g) || []).length >= 2) s = s.replace(/\./g, ' ')

  // Leading track number: "01 - ", "03.", "12)"
  s = s.replace(/^\s*\d{1,3}\s*[-._)\]]\s+/, '')

  // Bracketed / parenthesised noise — only when the content is actually noise
  s = s.replace(/[([{]([^)\]}]*)[)\]}]/g, (m, inner) => JUNK.test(inner) ? ' ' : m)

  // Trailing download-manager leftovers: " (1)", " copy", " - copia"
  s = s.replace(/\s*[-–]?\s*(copy|copia|\(\d+\))\s*$/i, '')

  return s.replace(/\s{2,}/g, ' ').trim()
}

/**
 * Best guess at { artist, title } from a filename.
 * "Artist - Title" is near-universal, so it is honoured; anything else becomes
 * the title as-is (the user can always fix it on the confirmation screen).
 */
function fromFilename(raw) {
  const clean = cleanFilename(raw)
  if (!clean) return { title: '', artist: '' }

  const m = /^(.{1,60}?)\s+[-–—]\s+(.+)$/.exec(clean)
  if (m && m[1].trim() && m[2].trim()) {
    return { artist: m[1].trim(), title: m[2].trim() }
  }

  // "track01", "audio", "new recording" — a filename that names nothing is
  // better left blank than prefilled into the map's title.
  if (tags.isPlaceholder(clean)) return { title: '', artist: '' }

  return { title: clean, artist: '' }
}

// ── Cover helpers ────────────────────────────────────────────────────────────

/** Embedded picture → 512×512 JPEG, or null. Never throws. */
async function _embeddedCover(filePath, hasCover) {
  if (!filePath || !hasCover) return null
  try {
    const raw = await tags.extractCover(filePath)
    return raw ? await cover.fromFile(raw) : null
  } catch (err) {
    console.warn('[meta] embedded cover failed:', err.message)
    return null
  }
}

/** Remote artwork by artist+title, or null. Never throws. */
async function _remoteCover(artist, title) {
  if (!artist && !title) return null
  try {
    return await cover.fetchRemote(artist, title)
  } catch (err) {
    console.warn('[meta] remote cover failed:', err.message)
    return null
  }
}

// ── Resolver ─────────────────────────────────────────────────────────────────

/**
 * @param {object}   opts
 * @param {string}   opts.filePath      Original audio file (source of tags)
 * @param {string}   [opts.originalName] Filename without extension
 * @param {Function} [opts.send]        Progress callback (step, message)
 * @returns {Promise<{
 *   meta:      { title, artist, album },
 *   coverPath: ?string,
 *   confident: boolean,
 *   source:    'tags' | 'tags-dupes' | 'lookup' | 'file'
 * }>}
 */
async function resolve({ filePath, originalName, send = () => {} }) {
  const base = originalName ||
    (filePath ? path.basename(filePath, path.extname(filePath)) : '')

  const fileGuess = fromFilename(base)

  // 1. What does the file itself say?
  send('metadata', 'Reading song metadata…')
  const t = await tags.read(filePath).catch(() => null) || {}
  const tagTitle  = (t.title  || '').trim()
  const tagArtist = (t.artist || t.albumArtist || '').trim()
  const tagAlbum  = (t.album  || '').trim()

  const embedded = await _embeddedCover(filePath, t.hasCover)

  // Did reading a tag mean rewriting it? (a repeated value was collapsed)
  const rewritten = (t.duplicated || [])
    .some(f => f === 'title' || f === 'artist' || f === 'albumArtist')

  // ── Case 1: the file is properly tagged → trust it, skip the lookup ───────
  if (tagTitle && tagArtist && !rewritten) {
    const coverPath = embedded || await _remoteCover(tagArtist, tagTitle)
    return {
      meta:      { title: tagTitle, artist: tagArtist, album: tagAlbum },
      coverPath,
      // Only the artwork can still be missing — that alone is worth one screen.
      confident: !!coverPath,
      source:    'tags'
    }
  }

  // ── Case 1b: tagged, but a value was repeated → confirm it online ─────────
  //
  // "Dimrain47;Dimrain47" almost certainly means one artist written twice, but
  // it could be a name that really contains a semicolon, so the collapsed value
  // is checked instead of assumed. Agreement earns the same trust as a clean
  // tag; a mismatch (or no answer at all) sends it to the confirmation screen
  // with the file's own values prefilled.
  if (tagTitle && tagArtist) {
    send('metadata', 'Confirming song metadata…')
    const check = await metadata.fetch(`${tagArtist} ${tagTitle}`, {
      durationSec: t.durationSec || 0
    })

    const agrees = check.found && check.confident &&
                   text.sameText(check.title,  tagTitle) &&
                   text.sameText(check.artist, tagArtist)

    const meta      = { title: tagTitle, artist: tagArtist, album: tagAlbum }
    const coverPath = embedded || await _remoteCover(tagArtist, tagTitle)

    return {
      meta,
      coverPath,
      confident: agrees && !!coverPath,
      source:    agrees ? 'tags' : 'tags-dupes'
    }
  }

  // ── Case 2: not enough in the file → ask MusicBrainz, but demand certainty ─
  const query = [tagArtist || fileGuess.artist, tagTitle || fileGuess.title]
    .filter(Boolean).join(' ').trim() || base

  send('metadata', 'Looking up song metadata…')
  const look = await metadata.fetch(query, { durationSec: t.durationSec || 0 })

  if (look.found && look.confident) {
    // Tags still win field by field — the lookup only fills the gaps.
    const meta = {
      title:  tagTitle  || look.title  || fileGuess.title,
      artist: tagArtist || look.artist || fileGuess.artist,
      album:  tagAlbum  || look.album  || ''
    }
    const coverPath = embedded || await _remoteCover(meta.artist, meta.title)
    return { meta, coverPath, confident: !!coverPath, source: 'lookup' }
  }

  // ── Case 3: unsure → the file's own data, never the online guess ──────────
  const meta = {
    title:  tagTitle  || fileGuess.title,
    artist: tagArtist || fileGuess.artist,
    album:  tagAlbum  || ''
  }
  // Artwork is searched from the file's own name, so what the user reviews on
  // screen matches the file rather than a rejected match.
  const coverPath = embedded || await _remoteCover(meta.artist, meta.title)

  return { meta, coverPath, confident: false, source: 'file' }
}

module.exports = { resolve, cleanFilename, fromFilename }
