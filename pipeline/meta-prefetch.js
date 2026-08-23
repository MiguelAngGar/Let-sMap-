/**
 * pipeline/meta-prefetch.js
 * ─────────────────────────────────────────────────────────────────────────────
 * Resolves a song's metadata while the user is busy with something else.
 *
 * Reading tags is instant, but the online parts — the MusicBrainz query and the
 * cover art download — take a moment. Asking for them as soon as the file lands,
 * in parallel with the BPM analysis, means the answer is normally sitting here
 * before the user has finished checking the tempo, so pressing "Create Map"
 * costs nothing.
 *
 * One song at a time: a new drop replaces the previous entry. The stored promise
 * never rejects — a failed prefetch resolves to null and the caller just does
 * the work itself.
 */

const metaResolve = require('./meta-resolve')

let _entry = null      // { key, promise, startedAt }

/**
 * Begin resolving in the background. Progress messages are suppressed: the UI
 * is showing the analysis at this point, and nothing is waiting on this.
 *
 * @param {{ filePath: string, originalName?: string }} opts
 * @returns {?Promise<?object>} the same promise `get` would hand out
 */
function start({ filePath, originalName }) {
  if (!filePath) return null

  const startedAt = Date.now()

  // Started right here rather than on a later tick: the point is for the work
  // to be under way while the analysis runs.
  let work
  try {
    work = Promise.resolve(metaResolve.resolve({ filePath, originalName, send: () => {} }))
  } catch (err) {
    work = Promise.reject(err)
  }

  const promise = work
    .then(res => {
      console.log(`[prefetch] metadata ready in ${Date.now() - startedAt}ms ` +
                  `(source: ${res?.source})`)
      return res
    })
    .catch(err => {
      console.warn('[prefetch] metadata failed, will resolve on demand:', err.message)
      return null
    })

  _entry = { key: filePath, promise, startedAt }
  return promise
}

/**
 * The pending or finished result for this file, or null when there is none.
 * Kept after being read, so going back and forth in the UI does not re-run it.
 */
function get(filePath) {
  if (!_entry || !filePath || _entry.key !== filePath) return null
  return _entry.promise
}

/** Forget whatever is stored (new song, or a deliberate re-resolve). */
function clear() {
  _entry = null
}

module.exports = { start, get, clear }
