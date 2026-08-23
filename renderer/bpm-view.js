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

  // Matches MAX_EXTRA_SECONDS in pipeline/phase2.js
  const MAX_EXTRA_SECONDS = 12
  // Fine offset: how far the detected first beat can be corrected by hand, and
  // in what steps. 250 ms is more than any plausible detection error (half a
  // beat at 120 BPM), and the whole-beat and half-beat controls cover the rest.
  const MAX_NUDGE_MS  = 250
  // ScoreSaber's rules, for the warnings under the readout
  const CRITERIA_LEAD_IN   = 1.5    // ≥ 1.5 s with no interactive objects
  const CRITERIA_OUTRO_MIN = 2      // > 2 s after the last object
  const CRITERIA_OUTRO_MAX = 15     // < 15 s after the last object

  // ── State ──────────────────────────────────────────────────────────────────
  let _engine       = null
  let _timeline     = null
  let _oggPath      = null
  let _originalPath = null
  let _minLead      = 1.5   // configured lead-in for this song (Settings)
  let _extraBeats   = 0     // whole beats of lead-in added or removed by the user
  let _nudgeMs      = 0     // fine offset correction (ms of silence, ±)
  let _nudgeTouched = false // once true the explanation stays on screen
  let _trailing     = 0     // silence the song already ends with (s)
  let _coldEnd      = 2     // trailing silence the export aims for (s)
  let _analysis     = null
  let _candidates   = []
  let _originalName = ''

  let _baseBpm         = 120
  let _halfBeat        = false
  let _doubled         = false
  let _mainCandidates  = []   // [bpm/2, bpm, bpm×2]
  let _altCandidates   = []   // madmom extras

  let _metroSound   = 'click' // metronome voice from Settings
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
    _engine.setMetroSound(_metroSound)

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
      engine:   _engine,
      timeEl,
      scrollEl: $('wave-scroll'),
      thumbEl:  $('wave-scroll-thumb'),
      onZoom:   _renderZoom,
      onSeek: (t) => {
        _engine.seekTo(t)
        // If paused, the playhead will still update on next RAF frame
      }
    })
    // Every song opens on the whole waveform, whatever the last one was left on
    _timeline.reset()
    _timeline.activate()
  }

  // ── Offset calculation (mirrors phase2.js calcSilencePad) ─────────────────

  function _computePad(bpm, halfBeat) {
    if (!_analysis) return null
    const anchor   = _analysis.downbeat_offset ?? _analysis.first_beat_time ?? 0
    const beatDur  = 60.0 / bpm
    // Where beat 1 must land at the earliest — configurable, 1.5 s by default
    const MIN_LEAD = Number.isFinite(_minLead) && _minLead >= 0 ? _minLead : 1.5
    const EPS      = 1e-6

    // Silence the song already has before its first beat counts towards the
    // lead-in, so pad can legitimately be 0 (see phase2.calcSilencePad)
    // Two grid lines matter (same maths as phase2.calcSilencePad): the one the
    // configured minimum asks for, and the earliest one that still leaves the
    // audio intact. The user's steps move between them, and up to
    // the cap beyond.
    const nFloor   = Math.ceil((anchor - EPS) / beatDur)
    const nDefault = Math.ceil((Math.max(anchor, MIN_LEAD) - EPS) / beatDur)
    const minExtra = Math.min(0, nFloor - nDefault)
    const maxExtra = Math.max(1, Math.floor(MAX_EXTRA_SECONDS / beatDur))

    // Whole beats only, so beat 1 always lands on a grid line
    const extra = Math.min(maxExtra, Math.max(minExtra, _extraBeats))
    let n     = nDefault + extra
    let total = n * beatDur
    let pad   = Math.max(0, total - anchor)

    if (halfBeat) { pad += beatDur / 2; total += beatDur / 2 }

    // Fine offset — milliseconds of silence on top of the aligned pad.
    //
    // The beat detector can be a few tens of milliseconds off, and no number of
    // whole beats fixes that. This moves the music against the grid by the
    // correction the mapper hears: on paper beat 1 stops sitting exactly on
    // n·beatDur, on the real audio it is now the true beat that does.
    //
    // It can never take away more silence than there is, so no audio is cut.
    const minNudgeMs = -Math.min(MAX_NUDGE_MS, pad * 1000)
    const nudgeMs    = Math.min(MAX_NUDGE_MS, Math.max(minNudgeMs, _nudgeMs))

    // What the field shows is not the correction, it is the OFFSET ITSELF: the
    // sub-beat slice of the silence, the part that actually puts the music on
    // the grid (the whole beats in front of it are the ± control next to it).
    // So it opens on the value the app worked out, not on a meaningless zero,
    // and typing over it means "use this offset instead".
    const beatMs  = beatDur * 1000
    const padMs   = pad * 1000
    const alignMs = padMs - Math.floor(padMs / beatMs + 1e-9) * beatMs

    pad   = Math.max(0, pad + nudgeMs / 1000)
    total = total + nudgeMs / 1000

    return { pad, total, n, beatDur, halfBeat, extra, minExtra, maxExtra, nDefault,
             nudgeMs, minNudgeMs, maxNudgeMs: MAX_NUDGE_MS,
             alignMs,
             fieldMs:  alignMs + nudgeMs,
             fieldMin: alignMs + minNudgeMs,
             fieldMax: alignMs + MAX_NUDGE_MS }
  }

  /**
   * Carry the user's lead-in over to a new tempo.
   *
   * What has to survive a BPM change is WHERE BEAT 1 LANDS, not how many extra
   * beats were clicked. Rescaling the beat count looks equivalent but is not:
   * the default grid line does not simply double (at 225 BPM the minimum lands
   * on beat 8, at 450 BPM on beat 15, not 16), so the silence would drift —
   * 732 ms turning into 599 ms on a single click of Double BPM.
   *
   * With nothing adjusted (extra 0) the new tempo's own default is the right
   * answer, so it is left alone.
   */
  function _keepLeadIn(prev) {
    if (!prev || prev.extra === 0) { _extraBeats = 0; return }

    const next = _computePad(effectiveBpm(), _halfBeat)
    if (!next) return

    // The closest grid line of the new tempo to where beat 1 was
    const targetN = Math.round((prev.n * prev.beatDur) / next.beatDur)
    _extraBeats = targetN - next.nDefault
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

  // ── Lead-in in beats ───────────────────────────────────────────────────────
  //
  // Whole beats are the only safe unit: a step moves beat 1 to the next grid
  // line instead of knocking it off the grid. Down to the alignment nudge alone
  // (no silence beyond what the grid needs), and up to the cap (12 s of added
  // silence, whatever the tempo) beyond the configured target.

  function _adjustLeadIn(delta) {
    const data = _computePad(effectiveBpm(), _halfBeat)
    if (!data) return

    const next = Math.min(data.maxExtra, Math.max(data.minExtra, data.extra + delta))
    if (next === data.extra) return
    _extraBeats = next

    // Everything that depends on the pad, in one go: the metronome grid and the
    // timeline (which reads the engine's leadIn), plus the readout itself
    _syncEngineGrid()
    _renderOffsetInfo()

    // Keep the button under the keyboard after the readout is rebuilt
    const id = delta < 0 ? 'leadin-minus' : 'leadin-plus'
    const btn = $(id)
    if (btn && !btn.disabled) btn.focus()
  }

  function _renderZoom(info) {
    const lvl = $('wave-zoom-level')
    if (lvl) lvl.textContent = '×' + (info?.zoom ?? 1)

    const out = $('wave-zoom-out')
    const inn = $('wave-zoom-in')
    const fit = $('wave-zoom-fit')
    if (out) out.disabled = !!info?.atMin
    if (fit) fit.disabled = !!info?.atMin
    if (inn) inn.disabled = !!info?.atMax
  }

  // ── Fine offset ────────────────────────────────────────────────────────────
  //
  // A plain number field in milliseconds (the arrows step by 5). Touching it at
  // all puts the explanation on screen and leaves it there: the offset is what
  // synchronises the map with the song, so a mapper who changes it should know
  // that is what they are changing.

  /**
   * @param {string|number} raw       what the field currently holds
   * @param {boolean} [commit=false]  true on change/blur: the field is rewritten
   *                                  with the accepted value, so a number out of
   *                                  range is visibly corrected instead of
   *                                  silently ignored. While typing it is left
   *                                  alone — rewriting mid-keystroke fights the
   *                                  caret.
   */
  function _applyNudge(raw, commit = false) {
    const data = _computePad(effectiveBpm(), _halfBeat)
    if (!data) return

    const shown = Math.round(data.fieldMs)
    const txt   = String(raw ?? '').trim()
    const num   = (txt === '' || txt === '-' || txt === '+') ? shown : Number(txt)
    if (!Number.isFinite(num)) {
      if (commit) _renderOffsetInfo()
      return
    }

    // The field is an absolute offset; the pipeline works in corrections, so the
    // difference against the app's own alignment is what gets stored. Typing the
    // value that is already displayed must change nothing at all — otherwise the
    // rounding in the readout would drift the real offset by half a millisecond.
    const target = Math.round(num) === shown
      ? data.nudgeMs
      : Math.round(num) - data.alignMs

    const next = Math.min(data.maxNudgeMs, Math.max(data.minNudgeMs, target))
    _nudgeTouched = true

    if (next !== data.nudgeMs) {
      _nudgeMs = next
      _syncEngineGrid()
    }
    _renderOffsetInfo()

    const inp = $('nudge-input')
    if (commit && inp) {
      const after = _computePad(effectiveBpm(), _halfBeat)
      inp.value = String(Math.round(after ? after.fieldMs : 0))
    }
  }

  /** Back to the offset the app worked out, dropping the manual correction. */
  function _resetNudge() {
    if (_nudgeMs !== 0) {
      _nudgeMs = 0
      _syncEngineGrid()
    }
    _renderOffsetInfo()
  }

  /**
   * Keep the field in step with the maths: the bounds move with the available
   * silence (it can never remove more than there is), and the value itself is
   * only rewritten when the field is not being typed into.
   */
  function _renderNudgeField(data) {
    const inp = $('nudge-input')
    if (!inp) return
    // Both bounds rounded the same way the value is: a min of −181 next to a
    // displayed −182 would have the browser clamp the field out from under us
    inp.min = String(Math.round(data.fieldMin))
    inp.max = String(Math.round(data.fieldMax))
    if (document.activeElement !== inp) inp.value = String(Math.round(data.fieldMs))

    const reset = $('nudge-reset')
    if (reset) reset.disabled = Math.round(data.nudgeMs) === 0
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

    // Two numbers, both in seconds: how much silence goes in front, and where
    // the first beat ends up. The ± belong to the silence, because that is what
    // they change. (The grid index of beat 1 used to be shown here too and only
    // caused confusion sitting next to a label reading "beat 1".)
    const nudgeMs = Math.round(data.nudgeMs)

    const atFloor = data.extra <= data.minExtra
    const atCap   = data.extra >= data.maxExtra
    const lessTip = atFloor ? t('bpm.leadin.none') : t('bpm.leadin.less')

    el.innerHTML = `
      <span class="offset-stat">
        <span class="offset-stat-label">${t('offset.pad')}</span>
        <span class="offset-step">
          <button type="button" id="leadin-minus" data-leadin="-1"
                  title="${lessTip}" aria-label="${lessTip}"
                  ${atFloor ? 'disabled' : ''}>−</button>
          <span class="offset-stat-value">${fmt(padMs)}</span>
          <button type="button" id="leadin-plus" data-leadin="1"
                  title="${t('bpm.leadin.more')}" aria-label="${t('bpm.leadin.more')}"
                  ${atCap ? 'disabled' : ''}>+</button>
        </span>
      </span>
      <span class="offset-stat">
        <span class="offset-stat-label">${t('offset.beat1')}</span>
        <span class="offset-stat-value">${fmt(totalMs)}</span>
      </span>
    `

    // The field lives outside this block (rebuilding it on every render would
    // steal the caret mid-typing), so it is updated on its own.
    _renderNudgeField(data)

    // The explanation is not a warning, it is context: it shows up the moment
    // the offset is touched and stays while it is off zero.
    const note = $('offset-nudge-note')
    if (note) {
      const showNote = _nudgeTouched || nudgeMs !== 0
      note.textContent = showNote ? t('offset.nudge_note') : ''
      note.classList.toggle('hidden', !showNote)
    }

    // ── Ranking-criteria notes ────────────────────────────────────────────
    //
    // The intro figure is the WHOLE time before the first detected beat — the
    // song's own intro plus whatever silence we add — because that is the window
    // the criteria talks about, and music counts towards it just as well as
    // silence. Nothing here blocks anything: the criteria asks for a period with
    // no interactive objects, which a mapper can always honour by starting
    // later, so these are notes, not verdicts.
    const notes = []

    if (data.total < CRITERIA_LEAD_IN - 1e-9) {
      notes.push(t('offset.criteria_intro', {
        secs: data.total.toFixed(2), min: CRITERIA_LEAD_IN
      }))
    }

    // The export tops the outro up to the target, so the result is whichever is
    // longer — and if the song itself ends with more than the criteria allows,
    // no amount of padding can fix it.
    const outro = Math.max(_trailing, _coldEnd)
    if (outro < CRITERIA_OUTRO_MIN - 1e-9) {
      notes.push(t('offset.criteria_outro', {
        secs: outro.toFixed(2), min: CRITERIA_OUTRO_MIN
      }))
    } else if (outro > CRITERIA_OUTRO_MAX + 1e-9) {
      notes.push(t('offset.criteria_long', {
        secs: outro.toFixed(1), max: CRITERIA_OUTRO_MAX
      }))
    }

    const warn = $('offset-warning')
    if (warn) {
      warn.textContent = notes.join('  ')
      warn.classList.toggle('hidden', notes.length === 0)
    }

    // Notes and the offset explanation change how tall this screen is
    window.fitWindow?.()
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
    const before = _computePad(effectiveBpm(), _halfBeat)
    _baseBpm = Math.round(bpm * 100) / 100
    _doubled = false
    _keepLeadIn(before)
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
    const before = _computePad(effectiveBpm(), _halfBeat)
    _doubled = !_doubled
    _keepLeadIn(before)
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
      extraBeats:    _extraBeats,
      offsetNudgeMs: _nudgeMs,
      originalName:  _originalName
    }

    // Resolve metadata + cover first: the file's own tags win, and the online
    // lookup only runs when the file has none. Confident → straight through;
    // unsure → hand off to the confirmation screen (app.js shows MetaView).
    const metaRes = await window.api.fetchMeta({
      filePath:     _originalPath,
      originalName: _originalName
    })

    if (!metaRes.confident) {
      if (btn) { btn.disabled = false; btn.textContent = t('bpm.create') }
      if (statusEl) statusEl.textContent = ''
      _onNeedMeta?.({
        payload,
        meta:      metaRes.meta      || { title: _originalName, artist: '' },
        coverPath: metaRes.coverPath || null,
        source:    metaRes.source    || 'file'
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

    // …and not from behind the Settings panel, which deliberately pauses playback
    if ($('modal-overlay') && !$('modal-overlay').classList.contains('hidden')) return

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
    // The readout is rebuilt on every change, so listen on its container
    $('offset-info')?.addEventListener('click', (e) => {
      const lead = e.target.closest?.('[data-leadin]')
      if (lead && !lead.disabled) _adjustLeadIn(parseInt(lead.dataset.leadin, 10))
    })

    // Fine offset field: live while typing, corrected visibly on commit
    const nudgeInp = $('nudge-input')
    if (nudgeInp) {
      nudgeInp.addEventListener('input',  () => _applyNudge(nudgeInp.value))
      nudgeInp.addEventListener('change', () => _applyNudge(nudgeInp.value, true))
      nudgeInp.addEventListener('blur',   () => _applyNudge(nudgeInp.value, true))
      $('nudge-reset')?.addEventListener('click', () => {
        _resetNudge()
        nudgeInp.blur()
      })
      nudgeInp.addEventListener('keydown', (e) => {
        if (e.key === 'Enter')  { e.preventDefault(); nudgeInp.blur() }
        if (e.key === 'Escape') { _resetNudge(); nudgeInp.blur() }
      })
    }

    // Waveform zoom (the timeline itself also zooms on wheel / double-click)
    $('wave-zoom-in') ?.addEventListener('click', () => _timeline?.zoomIn())
    $('wave-zoom-out')?.addEventListener('click', () => _timeline?.zoomOut())
    $('wave-zoom-fit')?.addEventListener('click', () => _timeline?.zoomFit())
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
      if (s.metroSound) setMetroSound(s.metroSound)
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
  async function show({ oggPath, originalPath, analysis, candidates, originalName,
                        minLead, trailingSilence, coldEnd }) {
    // Stop any loading animation from a previous call before starting fresh
    _stopLoadingMessages()

    _oggPath         = oggPath
    _originalPath    = originalPath || null
    _minLead         = Number.isFinite(minLead) && minLead >= 0 ? minLead : 1.5
    _extraBeats      = 0
    _nudgeMs         = 0
    _nudgeTouched    = false
    _trailing        = Number.isFinite(trailingSilence) && trailingSilence >= 0 ? trailingSilence : 0
    _coldEnd         = Number.isFinite(coldEnd) && coldEnd >= 0 ? coldEnd : 2
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

  /**
   * Metronome voice from Settings. Applies to the live engine too, so changing
   * it with a song already loaded is heard on the next beat.
   */
  function setMetroSound(name) {
    _metroSound = name
    _engine?.setMetroSound(name)
  }

  /**
   * One hit of a voice through the engine that is already running, so the
   * Settings preview never opens a second audio context on top of this one.
   * @returns {boolean} false when nothing is loaded — the caller falls back to
   *                    AudioEngine.previewSound()
   */
  function previewMetro(name) {
    return _engine ? _engine.previewSound(name) === true : false
  }

  // ── Playback while Settings is open ────────────────────────────────────────
  //
  // Settings is where the metronome voice is chosen, and picking one plays it.
  // Doing that over a song that is still running means two things sounding at
  // once for no reason, so the song is paused while the panel is open and picked
  // up again on the way out — with the new voice if it changed.

  let _resumeAfterSettings = false

  function suspendPlayback() {
    _resumeAfterSettings = !!_engine?.isPlaying
    if (_resumeAfterSettings) {
      _engine.pause()
      _renderPlayBtn(false)
    }
    return _resumeAfterSettings
  }

  function resumePlayback() {
    if (!_resumeAfterSettings) return false
    _resumeAfterSettings = false
    if (!_engine) return false
    _engine.play()
    _renderPlayBtn(true)
    return true
  }

  /** Stop audio and tear down the timeline. Called when returning to drop view. */
  function hide() {
    _engine?.stop()
    _timeline?.deactivate()
    _timeline = null
  }

  return { init, show, hide, setMetroSound, previewMetro, suspendPlayback, resumePlayback }

})()

window.BpmView = BpmView
