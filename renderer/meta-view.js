/**
 * meta-view.js
 * ─────────────────────────────────────────────────────────────────────────────
 * Metadata confirmation screen. Shown ONLY when auto-detection isn't confident
 * about the song match (see song:fetch-meta in main.js).
 *
 * The user can:
 *   • edit title / artist (empty is fine — fill in later in the editor)
 *   • pick a local image as cover, drop one on the cover thumbnail, or
 *     remove the cover entirely
 *   • go back to the BPM view, or create the map with these values
 *
 * Depends on: i18n.js (t), preload api (selectCover, coverFromDrop, createMap,
 * fileUrl)
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
    const box   = $('meta-cover-box')

    // Empty, the box advertises itself with a dashed edge; full, it is a frame
    // and only the hover overlay offers to swap the image (see style.css).
    box?.classList.toggle('has-image', !!_coverPath)

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

  function _setBusy(busy, keepLabel = false) {
    const create = $('meta-create-btn')
    const back   = $('meta-back-btn')
    if (create) {
      create.disabled = busy
      if (!keepLabel || !busy) create.textContent = busy ? t('bpm.creating') : t('meta.create')
    }
    if (back) back.disabled = busy
    ;['meta-title', 'meta-artist', 'meta-cover-change', 'meta-cover-remove']
      .forEach(id => { const el = $(id); if (el) el.disabled = busy })
    // The box is not a <button>, so it cannot be disabled — it is marked busy
    // instead, which stops its click handler and hides its invitation.
    $('meta-cover-box')?.classList.toggle('busy', busy)
    if (!busy) _renderCover()   // restore remove-btn disabled state
  }

  // ── Actions ────────────────────────────────────────────────────────────────

  // ── Drag & drop a cover ────────────────────────────────────────────────────
  //
  // The cover thumbnail itself is the drop target, and it lights up while a
  // drag is over it. Files and images dragged straight out of a browser
  // (http / data URLs) both work.

  /** True when the drag carries something that could be an image. */
  function _canAccept(dt) {
    const types = Array.from(dt?.types || [])
    return types.includes('Files') || types.includes('text/uri-list')
  }

  /** The dropped payload as a path or URL string, or null if unusable. */
  function _dropSource(dt) {
    // Electron exposes the real path for anything dragged out of a file manager.
    // An image dragged out of a browser, Photos/Preview, or an iCloud file that
    // is not downloaded yet still produces a File — with an empty path. Those
    // must fall through to the URL below, which the pipeline already handles,
    // instead of failing outright.
    const file = dt?.files?.[0]
    if (file?.path) return file.path

    const raw = (dt?.getData('text/uri-list') || dt?.getData('text/plain') || '').trim()
    const first = raw.split(/[\r\n]+/).find(l => l && !l.startsWith('#'))
    return /^(https?:|file:|data:image\/)/i.test(first || '') ? first : null
  }

  function _setDragOver(on) {
    $('meta-cover-box')?.classList.toggle('drag-over', on)
  }

  async function _useDroppedCover(src) {
    const statusEl = $('meta-status')
    _setBusy(true, true)          // lock the buttons, keep their labels
    if (statusEl) statusEl.textContent = t('meta.cover.loading')

    const processed = await window.api.coverFromDrop(src)

    if (processed) _coverPath = processed
    _setBusy(false)                              // also re-renders the cover
    if (statusEl) statusEl.textContent = processed ? '' : t('meta.cover.error')
  }

  function _initDropZone() {
    const box = $('meta-cover-box')
    if (!box) return

    // Clicking the box opens the picker, exactly like clicking the song drop
    // zone on the first screen. The "Choose image…" button still works; this
    // just stops the box from looking droppable while being inert to a click.
    box.addEventListener('click', () => {
      if (box.classList.contains('busy')) return
      if ($('meta-create-btn')?.disabled) return
      _changeCover()
    })

    // It advertises itself as a button, so it has to answer to one.
    box.addEventListener('keydown', (e) => {
      if (e.key !== 'Enter' && e.key !== ' ' && e.code !== 'Space') return
      e.preventDefault()
      box.click()
    })

    box.addEventListener('dragenter', (e) => {
      if (!_canAccept(e.dataTransfer)) return
      e.preventDefault()
      _setDragOver(true)
    })

    box.addEventListener('dragover', (e) => {
      if (!_canAccept(e.dataTransfer)) return
      e.preventDefault()
      e.dataTransfer.dropEffect = 'copy'
      _setDragOver(true)
    })

    box.addEventListener('dragleave', (e) => {
      // Moving between the box's own children is not leaving it
      if (!box.contains(e.relatedTarget)) _setDragOver(false)
    })

    box.addEventListener('drop', async (e) => {
      if (!_canAccept(e.dataTransfer)) return
      e.preventDefault()
      _setDragOver(false)

      // Ignore drops while phase 2 is already building the map
      if ($('meta-create-btn')?.disabled) return

      const src = _dropSource(e.dataTransfer)
      if (!src) {
        const statusEl = $('meta-status')
        if (statusEl) statusEl.textContent = t('meta.cover.error')
        return
      }
      await _useDroppedCover(src)
    })
  }

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

    _initDropZone()

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
   * @param {string}  [data.source]  Where the metadata came from:
   *                                 'tags'       = the file's own tags (only the
   *                                                cover is missing)
   *                                 'tags-dupes' = tags with a repeated value
   *                                                that could not be confirmed
   *                                 anything else = not identified
   */
  function show({ payload, meta, coverPath, source }) {
    _payload   = payload
    _coverPath = coverPath || null

    // The subtitle explains why we are asking. When the file was properly
    // tagged there is nothing to second-guess — only artwork is missing.
    const subEl = document.querySelector('#view-meta .meta-subtitle')
    if (subEl) {
      const key = source === 'tags'       ? 'meta.subtitle_cover'
                : source === 'tags-dupes' ? 'meta.subtitle_dupes'
                :                           'meta.subtitle'
      subEl.setAttribute('data-i18n', key)   // keeps working on language change
      subEl.textContent = t(key)
    }

    const titleEl  = $('meta-title')
    const artistEl = $('meta-artist')
    if (titleEl)  titleEl.value  = meta?.title  || ''
    if (artistEl) artistEl.value = meta?.artist || ''

    const statusEl = $('meta-status')
    if (statusEl) statusEl.textContent = ''

    _setDragOver(false)
    _renderCover()
    _setBusy(false)
    titleEl?.focus()
    titleEl?.select()
  }

  return { init, show }

})()

window.MetaView = MetaView
