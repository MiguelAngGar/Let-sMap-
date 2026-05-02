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
  let _analysis     = null
  let _candidates   = []
  let _originalName = ''

  let _baseBpm      = 120
  let _halfBeat     = false
  let _doubled      = false

  let _onCreateMap  = null    // ({ outputDir }) => void
  let _onCancel     = null    // () => void

  // ── DOM refs ───────────────────────────────────────────────────────────────
  const $ = id => document.getElementById(id)

  // ── Derived BPM ───────────────────────────────────────────────────────────
  function effectiveBpm() {
    return _doubled ? _baseBpm * 2 : _baseBpm
  }

  // ── Audio engine lifecycle ─────────────────────────────────────────────────
  function _initEngine() {
    if (_engine) { _engine.destroy(); _engine = null }
    if (_timeline) { _timeline.deactivate(); _timeline = null }

    _engine = new AudioEngine()

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

  // ── Render helpers ─────────────────────────────────────────────────────────

  function _renderBpmDisplay() {
    const el = $('bpm-value')
    if (el) el.textContent = effectiveBpm().toFixed(2)
  }

  function _renderCandidates() {
    const container = $('candidates-list')
    if (!container) return
    container.innerHTML = ''

    _candidates.forEach(bpm => {
      const pill = document.createElement('button')
      pill.className   = 'candidate-pill' + (bpm === _baseBpm ? ' selected' : '')
      pill.textContent  = bpm.toFixed(2)
      pill.setAttribute('aria-pressed', bpm === _baseBpm ? 'true' : 'false')
      pill.setAttribute('role', 'option')
      pill.addEventListener('click', () => _selectBpm(bpm))
      container.appendChild(pill)
    })
  }

  function _renderPlayBtn(playing) {
    const btn = $('play-btn')
    if (!btn) return

    if (playing) {
      btn.innerHTML  = `<svg viewBox="0 0 20 20" fill="currentColor" aria-hidden="true"><rect x="5" y="4" width="3" height="12" rx="1"/><rect x="12" y="4" width="3" height="12" rx="1"/></svg>Pause`
      btn.setAttribute('aria-label', 'Pause')
    } else {
      btn.innerHTML  = `<svg viewBox="0 0 20 20" fill="currentColor" aria-hidden="true"><path d="M6.3 2.84A1.5 1.5 0 004 4.11v11.78a1.5 1.5 0 002.3 1.27l9.344-5.891a1.5 1.5 0 000-2.538L6.3 2.84z"/></svg>Play`
      btn.setAttribute('aria-label', 'Play')
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

  function _render() {
    _renderBpmDisplay()
    _renderCandidates()
    _renderToggles()
    _renderPlayBtn(_engine?.isPlaying ?? false)
  }

  // ── User actions ───────────────────────────────────────────────────────────

  function _selectBpm(bpm) {
    _baseBpm = bpm
    _doubled = false          // reset double — selecting a new candidate is explicit
    _engine.setBPM(effectiveBpm())
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

    // Add custom value to candidates list if not already there
    if (!_candidates.includes(rounded)) {
      _candidates = [..._candidates, rounded].sort((a, b) => a - b)
    }

    _selectBpm(rounded)
    inp.value = ''
    inp.blur()
  }

  function _toggleHalfBeat() {
    _halfBeat = !_halfBeat
    _engine.setHalfBeatShift(_halfBeat)
    _renderToggles()
  }

  function _toggleDouble() {
    _doubled = !_doubled
    _engine.setBPM(effectiveBpm())
    _renderBpmDisplay()
    _renderToggles()
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

    if (btn) { btn.disabled = true; btn.textContent = 'Creating…' }
    if (statusEl) statusEl.textContent = 'Building Beat Saber folder…'

    const result = await window.api.createMap({
      oggPath:       _oggPath,
      analysis:      _analysis,
      confirmedBpm:  effectiveBpm(),
      halfBeatShift: _halfBeat,
      originalName:  _originalName
    })

    if (btn) { btn.disabled = false; btn.textContent = 'Create Map →' }

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
  function init({ onCreateMap, onCancel }) {
    _onCreateMap = onCreateMap
    _onCancel    = onCancel

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
  async function show({ oggPath, analysis, candidates, originalName }) {
    _oggPath      = oggPath
    _analysis     = analysis
    _candidates   = [...candidates]
    _originalName = originalName
    _baseBpm      = analysis.bpm
    _halfBeat     = false
    _doubled      = false

    _initEngine()
    _engine.firstBeatTime = analysis.first_beat_time
    _engine.setBPM(effectiveBpm())

    _render()

    const statusEl = $('bpm-status')
    if (statusEl) statusEl.textContent = 'Loading audio…'

    // Load the ogg file and set up the timeline
    try {
      await _engine.loadFile(oggPath)   // blocks until decoded + waveform built

      // Timeline can only be created after engine has a buffer
      _initTimeline()

      if (statusEl) statusEl.textContent = 'Press Play or Space to preview with metronome'
    } catch (err) {
      console.error('[bpm-view] audio load error:', err)
      if (statusEl) statusEl.textContent = `Audio error: ${err.message}`
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
