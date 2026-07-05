/**
 * meta-view.js
 * ─────────────────────────────────────────────────────────────────────────────
 * Metadata confirmation screen. Shown ONLY when auto-detection isn't confident
 * about the song match (see song:fetch-meta in main.js).
 *
 * The user can:
 *   • edit title / artist (empty is fine — fill in later in the editor)
 *   • pick a local image as cover, or remove the cover entirely
 *   • go back to the BPM view, or create the map with these values
 *
 * Depends on: i18n.js (t), preload api (selectCover, createMap, fileUrl)
 */

const MetaView = (() => {

  // ── State ──────────────────────────────────────────────────────────────────
  let _payload   = null   // { oggPath, originalPath, analysis, confirmedBpm, halfBeatShift, originalName }
  let _coverPath = null   // processed 512×512 jpg path, or null = no cover
  let _onCreated = null   // ({ outputDir }) => void
  let _onBack    = null   // () => void

  const $ = id => document.getElementById(id)

  // ── Render ─────────────────────────────────────────────────────────────────

  function _renderCover() {
    const img   = $('meta-cover-img')
    const empty = $('meta-cover-empty')
    const rm    = $('meta-cover-remove')

    if (_coverPath) {
      // Cache-bust: tmp cover paths are unique per fetch, but be safe
      if (img) {
        img.src = window.api.fileUrl(_coverPath)
        img.classList.remove('hidden')
      }
      empty?.classList.add('hidden')
      if (rm) rm.disabled = false
    } else {
      if (img) { img.removeAttribute('src'); img.classList.add('hidden') }
      empty?.classList.remove('hidden')
      if (rm) rm.disabled = true
    }
  }

  function _setBusy(busy) {
    const create = $('meta-create-btn')
    const back   = $('meta-back-btn')
    if (create) {
      create.disabled = busy
      create.textContent = busy ? t('bpm.creating') : t('meta.create')
    }
    if (back) back.disabled = busy
    ;['meta-title', 'meta-artist', 'meta-cover-change', 'meta-cover-remove']
      .forEach(id => { const el = $(id); if (el) el.disabled = busy })
    if (!busy) _renderCover()   // restore remove-btn disabled state
  }

  // ── Actions ────────────────────────────────────────────────────────────────

  async function _changeCover() {
    const chosen = await window.api.selectCover()
    if (chosen) {
      _coverPath = chosen
      _renderCover()
    }
  }

  function _removeCover() {
    _coverPath = null
    _renderCover()
  }

  async function _create() {
    const statusEl = $('meta-status')
    _setBusy(true)
    if (statusEl) statusEl.textContent = t('bpm.building')

    const result = await window.api.createMap({
      ..._payload,
      meta: {
        title:  $('meta-title') ?.value.trim() ?? '',
        artist: $('meta-artist')?.value.trim() ?? '',
        album:  ''
      },
      coverPath: _coverPath
    })

    _setBusy(false)

    if (result.success) {
      if (statusEl) statusEl.textContent = ''
      _onCreated?.(result.result)
    } else {
      if (statusEl) statusEl.textContent = `Error: ${result.error}`
    }
  }

  // ── Public API ─────────────────────────────────────────────────────────────

  function init({ onCreated, onBack }) {
    _onCreated = onCreated
    _onBack    = onBack

    $('meta-cover-change')?.addEventListener('click', _changeCover)
    $('meta-cover-remove')?.addEventListener('click', _removeCover)
    $('meta-create-btn')  ?.addEventListener('click', _create)
    $('meta-back-btn')    ?.addEventListener('click', () => _onBack?.())

    // Enter in either field = create
    ;['meta-title', 'meta-artist'].forEach(id => {
      $(id)?.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') { e.preventDefault(); _create() }
      })
    })

    // Phase-2 progress while this view is active
    window.api.onProgress(({ step, msg }) => {
      if ($('view-meta')?.classList.contains('active')) {
        const el = $('meta-status')
        if (el) el.textContent = msg || step
      }
    })
  }

  /**
   * @param {object} data
   * @param {object}  data.payload   Everything song:create-map needs (minus meta)
   * @param {object}  data.meta      Best-guess { title, artist } to prefill
   * @param {?string} data.coverPath Fetched cover (may be null)
   */
  function show({ payload, meta, coverPath }) {
    _payload   = payload
    _coverPath = coverPath || null

    const titleEl  = $('meta-title')
    const artistEl = $('meta-artist')
    if (titleEl)  titleEl.value  = meta?.title  || ''
    if (artistEl) artistEl.value = meta?.artist || ''

    const statusEl = $('meta-status')
    if (statusEl) statusEl.textContent = ''

    _renderCover()
    _setBusy(false)
    titleEl?.focus()
    titleEl?.select()
  }

  return { init, show }

})()

window.MetaView = MetaView
