/**
 * bpm-view.js  v2
 * ─────────────────────────────────────────────────────────────────────────────
 * Manages state and interactions for the BPM validation screen.
 *
 * Responsibilities:
 *  • Owns BPM state (baseBpm, halfBeat toggle, double toggle)
 *  • Creates and wires AudioEngine + WaveformTimeline
 *  • Handles candidate selection, custom BPM input, modifier toggles
 *  • Delegates all audio timing to AudioEngine
 *  • Delegates all canvas rendering to WaveformTimeline
 *
 * Depends on (loaded before this script):
 *  audio-engine.js  → window.AudioEngine
 *  timeline.js      → window.WaveformTimeline
 */

/* global AudioEngine, WaveformTimeline */

const BpmView = (() => {

  // ── State ──────────────────────────────────────────────────────────────────
  let _engine       = null
  let _timeline     = null
  let _oggPath      = null
  let _originalPath = null
  let _analysis     = null
  let _candidates   = []
  let _originalName = ''

  let _baseBpm         = 120
  let _halfBeat        = false
  let _doubled         = false
  let _mainCandidates  = []   // [bpm/2, bpm, bpm×2]
  let _altCandidates   = []   // madmom extras

  let _onCreateMap  = null    // ({ outputDir }) => void
  let _onCancel     = null    // () => void
  let _onNeedMeta   = null    // ({ payload, meta, coverPath }) => void

  // ── DOM refs ───────────────────────────────────────────────────────────────
  const $ = id => document.getElementById(id)

  // ── Derived BPM ───────────────────────────────────────────────────────────
  function effectiveBpm() {
    return _doubled ? _baseBpm * 2 : _baseBpm
  }

  // ── Audio engine lifecycle ─────────────────────────────────────────────────
  // ── Loading messages ───────────────────────────────────────────────────────

  let _loadingTimer = null

  function _startLoadingMessages(el) {
    if (!el) return
    let pool = [...tArr('audio.msgs')].sort(() => Math.random() - 0.5)
    let idx  = 0

    function showNext() {
      if (idx >= pool.length) { pool = [...tArr('audio.msgs')].sort(() => Math.random() - 0.5); idx = 0 }
      el.textContent = pool[idx++]
      _loadingTimer  = setTimeout(showNext, 1800 + Math.random() * 2000)  // 1.8–3.8 s
    }

    el.textContent = tArr('audio.msgs')[0] || 'Loading audio…'
    _loadingTimer  = setTimeout(showNext, 1800)
  }

  function _stopLoadingMessages() {
    clearTimeout(_loadingTimer)
    _loadingTimer = null
  }

  // ── Volume helpers ─────────────────────────────────────────────────────────

  function _updateSliderFill(slider) {
    // Paint the left portion of the track in accent colour via inline gradient.
    // Uses --accent-rgb if defined; falls back to a hardcoded purple.
    const pct = slider.value + '%'
    slider.style.background =
      `linear-gradient(to right, var(--accent) 0%, var(--accent) ${pct}, var(--border) ${pct}, var(--border) 100%)`
  }

  function _readVolumes() {
    const sv = $('song-volume')
    const mv = $('metro-volume')
    return {
      song:  sv ? parseInt(sv.value)  / 100 : 0.75,
      metro: mv ? parseInt(mv.value) / 100 : 1.00
    }
  }

  // ── Audio engine lifecycle ─────────────────────────────────────────────────
  function _initEngine() {
    if (_engine) { _engine.destroy(); _engine = null }
    if (_timeline) { _timeline.deactivate(); _timeline = null }

    _engine = new AudioEngine()

    // Apply whatever the sliders currently show (persists across show() calls)
    const vols = _readVolumes()
    _engine.songVolume  = vols.song
    _engine.metroVolume = vols.metro

    _engine.onBeat = () => {
      const dot = $('beat-dot')
      if (!dot) return
      dot.classList.add('active')
      setTimeout(() => dot.classList.remove('active'), 90)
    }

    _engine.onEnd = () => {
      _renderPlayBtn(false)
    }
  }

  function _initTimeline() {
    const canvas  = $('waveform-canvas')
    const timeEl  = $('time-display')
    if (!canvas) return

    _timeline = new WaveformTimeline({
      canvas,
      engine: _engine,
      timeEl,
      onSeek: (t) => {
        _engine.seekTo(t)
        // If paused, the playhead will still update on next RAF frame
      }
    })
    _timeline.activate()
  }

  // ── Offset calculation (mirrors phase2.js calcSilencePad) ─────────────────

  function _computePad(bpm, halfBeat) {
    if (!_analysis) return null
    const anchor  = _analysis.downbeat_offset ?? _analysis.first_beat_time ?? 0
    const beatDur = 60.0 / bpm
    const MIN_LEAD = 1.5
    let n          = Math.ceil((anchor + MIN_LEAD) / beatDur)
    let total      = n * beatDur
    let pad        = total - anchor
    if (pad < MIN_LEAD) { n++; total = n * beatDur; pad = total - anchor }
    if (halfBeat) { pad += beatDur / 2; total += beatDur / 2 }
    return { pad, total, n, beatDur, halfBeat }
  }

  // ── Engine grid sync ───────────────────────────────────────────────────────
  //
  // The preview mirrors the exported map: leadIn = the silence that will be
  // prepended, anchor = where the downbeat lands after padding (n·beatDur,
  // half-beat shift included — _computePad handles it). The engine schedules
  // clicks only from the first grid beat that has audio.
  function _syncEngineGrid() {
    if (!_engine) return
    const bpm  = effectiveBpm()
    const data = _computePad(bpm, _halfBeat)
    if (data) {
      _engine.setGrid({ bpm, leadIn: data.pad, anchor: data.total })
    } else {
      _engine.setGrid({ bpm, leadIn: 0, anchor: 0 })
    }
  }

  // ── Render helpers ─────────────────────────────────────────────────────────

  function _renderBpmDisplay() {
    const el = $('bpm-value')
    if (el) el.textContent = effectiveBpm().toFixed(2)
  }

  function _makePill(bpm, isAlt = false) {
    const pill = document.createElement('button')
    const sel  = Math.round(bpm * 100) / 100 === Math.round(_baseBpm * 100) / 100
    pill.className   = 'candidate-pill' + (isAlt ? ' alt' : '') + (sel ? ' selected' : '')
    pill.textContent = bpm.toFixed(2)
    pill.setAttribute('aria-pressed', sel ? 'true' : 'false')
    pill.setAttribute('role', 'option')
    pill.addEventListener('click', () => _selectBpm(bpm))
    return pill
  }

  function _makeGroup(label, pills) {
    const wrap = document.createElement('div')
    wrap.className = 'candidates-group'
    if (label) {
      const lbl = document.createElement('span')
      lbl.className   = 'candidates-group-label'
      lbl.textContent = label
      wrap.appendChild(lbl)
    }
    const row = document.createElement('div')
    row.className = 'candidates-row'
    pills.forEach(p => row.appendChild(p))
    wrap.appendChild(row)
    return wrap
  }

  function _renderCandidates() {
    const container = $('candidates-list')
    if (!container) return
    container.innerHTML = ''

    // Main group: bpm/2 · bpm · bpm×2  (labeled only when alts exist)
    const hasAlts = _altCandidates.length > 0
    const mainLabel = hasAlts ? t('bpm.candidates.main') : null
    container.appendChild(
      _makeGroup(mainLabel, _mainCandidates.map(b => _makePill(b)))
    )

    // Alt group: madmom extras with their own label
    if (hasAlts) {
      container.appendChild(
        _makeGroup(t('bpm.candidates.alts'), _altCandidates.map(b => _makePill(b, true)))
      )
    }
  }

  function _renderPlayBtn(playing) {
    const btn = $('play-btn')
    if (!btn) return

    if (playing) {
      btn.innerHTML  = `<svg viewBox="0 0 20 20" fill="currentColor" aria-hidden="true"><rect x="5" y="4" width="3" height="12" rx="1"/><rect x="12" y="4" width="3" height="12" rx="1"/></svg><span data-i18n="bpm.pause">${t('bpm.pause')}</span>`
      btn.setAttribute('aria-label', t('bpm.pause'))
    } else {
      btn.innerHTML  = `<svg viewBox="0 0 20 20" fill="currentColor" aria-hidden="true"><path d="M6.3 2.84A1.5 1.5 0 004 4.11v11.78a1.5 1.5 0 002.3 1.27l9.344-5.891a1.5 1.5 0 000-2.538L6.3 2.84z"/></svg><span data-i18n="bpm.play">${t('bpm.play')}</span>`
      btn.setAttribute('aria-label', t('bpm.play'))
    }
  }

  function _renderToggles() {
    const hb = $('halfbeat-btn')
    const db = $('double-btn')

    if (hb) {
      hb.classList.toggle('active', _halfBeat)
      hb.setAttribute('aria-pressed', String(_halfBeat))
    }
    if (db) {
      db.classList.toggle('active', _doubled)
      db.setAttribute('aria-pressed', String(_doubled))
    }
  }

  function _renderCustomInput() {
    const inp = $('custom-bpm-input')
    if (inp) inp.value = ''   // clear after each selection
  }

  function _renderOffsetInfo() {
    const el = $('offset-info')
    if (!el) return

    const data = _computePad(effectiveBpm(), _halfBeat)
    if (!data) { el.innerHTML = ''; return }

    const fmt = ms => ms >= 1000
      ? `${(ms / 1000).toFixed(3)} s`
      : `${Math.round(ms)} ms`

    const padMs   = data.pad   * 1000
    const totalMs = data.total * 1000
    const beats   = data.halfBeat
      ? `${data.n} + ½`
      : String(data.n)

    el.innerHTML = `
      <span class="offset-stat">
        <span class="offset-stat-label">${t('offset.pad')}</span>
        <span class="offset-stat-value">${fmt(padMs)}</span>
      </span>
      <span class="offset-stat">
        <span class="offset-stat-label">${t('offset.beat1')}</span>
        <span class="offset-stat-value">${fmt(totalMs)}</span>
      </span>
      <span class="offset-stat">
        <span class="offset-stat-label">${t('offset.beats_added')}</span>
        <span class="offset-stat-value">${beats}</span>
      </span>
    `
  }

  function _render() {
    _renderBpmDisplay()
    _renderCandidates()
    _renderToggles()
    _renderOffsetInfo()
    _renderPlayBtn(_engine?.isPlaying ?? false)
  }

  // ── User actions ───────────────────────────────────────────────────────────

  function _selectBpm(bpm) {
    _baseBpm = Math.round(bpm * 100) / 100
    _doubled = false
    _syncEngineGrid()
    _render()
    _renderCustomInput()
  }

  function _applyCustomBpm() {
    const inp = $('custom-bpm-input')
    if (!inp) return

    const raw = inp.value.trim()
    if (!raw) return

    const val = parseFloat(raw)
    if (isNaN(val) || val < 60 || val > 320) {
      inp.classList.add('invalid')
      setTimeout(() => inp.classList.remove('invalid'), 700)
      return
    }

    const rounded = Math.round(val * 100) / 100

    // Add to main candidates if not already present
    if (!_mainCandidates.includes(rounded)) {
      _mainCandidates = [..._mainCandidates, rounded].sort((a, b) => a - b)
    }

    _selectBpm(rounded)
    inp.value = ''
    inp.blur()
  }

  function _toggleHalfBeat() {
    _halfBeat = !_halfBeat
    _syncEngineGrid()
    _renderToggles()
    _renderOffsetInfo()
  }

  function _toggleDouble() {
    _doubled = !_doubled
    _syncEngineGrid()
    _renderBpmDisplay()
    _renderToggles()
    _renderOffsetInfo()
  }

  function _togglePlay() {
    _engine.toggle()
    _renderPlayBtn(_engine.isPlaying)
  }

  async function _createMap() {
    _engine.stop()
    _renderPlayBtn(false)

    const btn      = $('create-map-btn')
    const statusEl = $('bpm-status')

    if (btn) { btn.disabled = true; btn.textContent = t('bpm.creating') }
    if (statusEl) statusEl.textContent = t('meta.fetching')

    const payload = {
      oggPath:       _oggPath,
      originalPath:  _originalPath,
      analysis:      _analysis,
      confirmedBpm:  effectiveBpm(),
      halfBeatShift: _halfBeat,
      originalName:  _originalName
    }

    // Look up metadata + cover first. Confident match → straight through.
    // Unsure → hand off to the confirmation screen (app.js shows MetaView).
    const metaRes = await window.api.fetchMeta(_originalName)

    if (!metaRes.confident) {
      if (btn) { btn.disabled = false; btn.textContent = t('bpm.create') }
      if (statusEl) statusEl.textContent = ''
      _onNeedMeta?.({
        payload,
        meta:      metaRes.meta      || { title: _originalName, artist: '' },
        coverPath: metaRes.coverPath || null
      })
      return
    }

    if (statusEl) statusEl.textContent = t('bpm.building')

    const result = await window.api.createMap({
      ...payload,
      meta:      metaRes.meta,
      coverPath: metaRes.coverPath
    })

    if (btn) { btn.disabled = false; btn.textContent = t('bpm.create') }

    if (result.success) {
      _onCreateMap?.(result.result)
    } else {
      if (statusEl) statusEl.textContent = `Error: ${result.error}`
    }
  }

  function _cancel() {
    _engine?.stop()
    _onCancel?.()
  }

  // ── Keyboard handling ──────────────────────────────────────────────────────

  function _onKeyDown(e) {
    // Only active when the BPM view is visible
    if (!$('view-bpm')?.classList.contains('active')) return

    // Never intercept Space while the custom BPM input (or any input) is focused
    if (document.activeElement?.tagName === 'INPUT') return

    if (e.code === 'Space') {
      e.preventDefault()
      _togglePlay()
    }
  }

  // ── Public API ─────────────────────────────────────────────────────────────

  /**
   * Called once at startup.
   * Binds all static DOM events and sets up the pipeline progress listener.
   */
  function init({ onCreateMap, onCancel, onNeedMeta }) {
    _onCreateMap = onCreateMap
    _onCancel    = onCancel
    _onNeedMeta  = onNeedMeta

    $('play-btn')    ?.addEventListener('click', _togglePlay)
    $('halfbeat-btn')?.addEventListener('click', _toggleHalfBeat)
    $('double-btn')  ?.addEventListener('click', _toggleDouble)
    $('create-map-btn')?.addEventListener('click', _createMap)
    $('bpm-cancel-btn')?.addEventListener('click', _cancel)

    // Custom BPM input
    const customInp = $('custom-bpm-input')
    if (customInp) {
      customInp.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') { e.preventDefault(); _applyCustomBpm() }
        if (e.key === 'Escape') { customInp.value = ''; customInp.blur() }
      })
      customInp.addEventListener('blur', () => {
        // Apply on blur only if there's a value waiting
        if (customInp.value.trim()) _applyCustomBpm()
      })
    }

    // Volume sliders — real-time, no restart needed
    const songVolSlider  = $('song-volume')
    const metroVolSlider = $('metro-volume')
    const songPctEl      = $('song-vol-pct')
    const metroPctEl     = $('metro-vol-pct')

    if (songVolSlider) {
      _updateSliderFill(songVolSlider)
      songVolSlider.addEventListener('input', () => {
        const v = parseInt(songVolSlider.value) / 100
        _engine?.setSongVolume(v)
        if (songPctEl) songPctEl.textContent = `${songVolSlider.value}%`
        _updateSliderFill(songVolSlider)
      })
      songVolSlider.addEventListener('change', () => {
        window.api.saveSettings({ songVolume: parseInt(songVolSlider.value) })
      })
    }

    if (metroVolSlider) {
      _updateSliderFill(metroVolSlider)
      metroVolSlider.addEventListener('input', () => {
        const v = parseInt(metroVolSlider.value) / 100
        _engine?.setMetroVolume(v)
        if (metroPctEl) metroPctEl.textContent = `${metroVolSlider.value}%`
        _updateSliderFill(metroVolSlider)
      })
      metroVolSlider.addEventListener('change', () => {
        window.api.saveSettings({ metroVolume: parseInt(metroVolSlider.value) })
      })
    }

    // Load persisted volume values
    window.api.getSettings().then(s => {
      if (songVolSlider && s.songVolume != null) {
        songVolSlider.value = s.songVolume
        if (songPctEl) songPctEl.textContent = `${s.songVolume}%`
        _updateSliderFill(songVolSlider)
      }
      if (metroVolSlider && s.metroVolume != null) {
        metroVolSlider.value = s.metroVolume
        if (metroPctEl) metroPctEl.textContent = `${s.metroVolume}%`
        _updateSliderFill(metroVolSlider)
      }
    })

    // Global space key
    document.addEventListener('keydown', _onKeyDown)

    // Pipeline progress updates while phase 2 runs (Create Map step)
    window.api.onProgress(({ step, msg }) => {
      if ($('view-bpm')?.classList.contains('active')) {
        const el = $('bpm-status')
        if (el) el.textContent = msg || step
      }
    })
  }

  /**
   * Populate state from fresh analysis and display the BPM validation view.
   * Loads audio in background — UI renders immediately without waiting.
   */
  async function show({ oggPath, originalPath, analysis, candidates, originalName }) {
    // Stop any loading animation from a previous call before starting fresh
    _stopLoadingMessages()

    _oggPath         = oggPath
    _originalPath    = originalPath || null
    _analysis        = analysis
    _originalName    = originalName
    _halfBeat        = false
    _doubled         = false

    // candidates is { main, alternatives } — round to 2dp to match pill values
    _mainCandidates  = (candidates.main         || []).map(b => Math.round(b * 100) / 100)
    _altCandidates   = (candidates.alternatives || []).map(b => Math.round(b * 100) / 100)

    // _baseBpm must match the rounded pill value so the selection highlights correctly
    _baseBpm = Math.round(analysis.bpm * 100) / 100

    _initEngine()
    // Preview grid = final map grid: lead-in silence + downbeat on n·beatDur.
    _syncEngineGrid()

    _render()

    const statusEl = $('bpm-status')
    _startLoadingMessages(statusEl)

    // Load the ogg file and set up the timeline
    try {
      await _engine.loadFile(oggPath)   // blocks until decoded + waveform built
      _stopLoadingMessages()

      // Timeline can only be created after engine has a buffer
      _initTimeline()

      if (statusEl) statusEl.textContent = t('bpm.status.ready')
    } catch (err) {
      _stopLoadingMessages()
      console.error('[bpm-view] audio load error:', err)
      if (statusEl) statusEl.textContent = t('bpm.status.audio_error', { msg: err.message })
    }
  }

  /** Stop audio and tear down the timeline. Called when returning to drop view. */
  function hide() {
    _engine?.stop()
    _timeline?.deactivate()
    _timeline = null
  }

  return { init, show, hide }

})()

window.BpmView = BpmView
