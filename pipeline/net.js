/**
 * pipeline/net.js
 * ─────────────────────────────────────────────────────────────────────────────
 * A one-line circuit breaker for the optional network steps (the metadata
 * lookup and the cover art).
 *
 * Without it, working offline means every song waits out one timeout after
 * another before falling back to what the file itself says. With it, the first
 * failure marks the network as unreachable and the remaining steps skip
 * instantly.
 *
 * The mark expires on its own, and any success clears it, so a passing hiccup
 * costs a couple of minutes of lookups rather than the rest of the session.
 */

const BACKOFF_MS = 2 * 60 * 1000

let _unreachableUntil = 0
let _announced = false

/** True while the network is presumed unreachable. */
function offline() {
  return Date.now() < _unreachableUntil
}

/**
 * Report a failed request. Only transport failures count: an HTTP error means
 * we reached the service, so the network is clearly fine.
 */
function noteFailure(err) {
  if (err && err.response) return          // the server answered, just not well
  _unreachableUntil = Date.now() + BACKOFF_MS
  if (!_announced) {
    console.log('[net] no connection — online steps are skipped for now')
    _announced = true
  }
}

/** Report a successful request: the network is back. */
function noteSuccess() {
  _unreachableUntil = 0
  _announced = false
}

/** Testing helper: forget everything we think we know. */
function reset() {
  _unreachableUntil = 0
  _announced = false
}

module.exports = { offline, noteFailure, noteSuccess, reset }
