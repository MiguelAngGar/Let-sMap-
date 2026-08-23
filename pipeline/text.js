/**
 * pipeline/text.js
 * ─────────────────────────────────────────────────────────────────────────────
 * Shared text comparison for metadata. Song titles arrive spelled every which
 * way — "Camellia" vs "かめりあ (Camellia)", "Déjà Vu" vs "Deja Vu", "Ghost!"
 * vs "Ghost" — so every comparison happens on a normalised form: lowercase,
 * no diacritics, alphanumerics only.
 */

/** lowercase, strip diacritics, keep alphanumerics only */
function normalize(s) {
  return (s || '')
    .toLowerCase()
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim()
}

/** Normalised tokens of a string. */
function tokens(s) {
  return normalize(s).split(' ').filter(Boolean)
}

/** True if every token of `needle` appears as a token of `hay`. */
function containsAll(hay, needle) {
  const hayTokens = new Set(tokens(hay))
  const parts     = tokens(needle)
  if (!parts.length) return false
  return parts.every(t => hayTokens.has(t))
}

/** True when both strings name the same thing. */
function sameText(a, b) {
  const x = normalize(a), y = normalize(b)
  return !!x && x === y
}

/**
 * True when two names plausibly refer to the same thing: either they match, or
 * one contains all the tokens of the other. Tolerates the extras real catalogue
 * entries carry — "Ghost" vs "Ghost (Extended Mix)", or one artist of a collab.
 */
function looselyMatches(a, b) {
  if (sameText(a, b)) return true
  return containsAll(a, b) || containsAll(b, a)
}

module.exports = { normalize, tokens, containsAll, sameText, looselyMatches }
