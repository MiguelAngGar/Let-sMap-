/**
 * timeline.js  v5
 * ─────────────────────────────────────────────────────────────────────────────
 * Canvas waveform with zoom, panning, beat grid, silence band and seeking.
 *
 * WHY ZOOM EXISTS
 * ───────────────
 * The whole song in ~900 px is ~230 ms per pixel: the silence we prepend is
 * three pixels wide and a beat at 225 BPM is barely one, so neither the padding
 * nor the grid can be judged by eye. Zoomed all the way in a pixel is about a
 * third of a millisecond, which is finer than the offset field can even be set.
 *
 * WHO MOVES THE VIEW
 * ──────────────────
 * Only the user: the scrollbar, the wheel, Alt-drag, or a zoom step (which keeps
 * the point of interest in place). Seeking never scrolls the view — re-centring
 * on every click made the waveform feel like it was fighting back. The two
 * exceptions both follow the mouse or the music: playback pages the window
 * forward when the playhead would leave it, and dragging the playhead into the
 * edge of the window scrolls in that direction.
 *
 * Panning is eased towards a target instead of jumping, so a wheel notch glides
 * rather than teleporting — at 60 fps the glide is ~100 ms.
 *
 * MOUSE / WHEEL
 * ─────────────
 *  • drag: puts the playhead exactly where you drag it, at every zoom level —
 *    the whole point of zooming in is placing it precisely
 *  • drag into the edge (zoomed): keeps scrolling while you hold there
 *  • Alt-drag or middle-drag: pans the view
 *  • wheel: pans (fitted, it is left to the page so the screen still scrolls)
 *  • Ctrl/⌘ + wheel: zooms around the cursor
 *  • double-click: back to the whole song
 *
 * WHAT IS DRAWN (back to front)
 * ─────────────────────────────
 *  • the silence around the music, as named bands — the whole beats added in
 *    front, the sub-beat offset that lands beat 1 on the grid, and the outro
 *    (always at least a visible sliver wide; hover one for its exact length)
 *  • the waveform of the window, peaks pulled from the engine's peak index
 *    (exact samples at the deepest zoom levels — see AudioEngine.peaksFor)
 *  • the map's beat grid from t = 0, thinned out automatically, with every
 *    fourth line drawn as a bar line
 *  • the line where the audio starts, and where the DETECTED first beat lands
 *  • the hovered time, and the playhead
 */

/* global AudioEngine */  // just for jsdoc; imported via <script> tag

const ZOOM_STEPS  = [1, 2, 4, 8, 16, 32, 64, 128, 256, 512]
const MIN_WINDOW  = 0.25  // seconds — deepest zoom shows at least this much
const MIN_BEAT_PX = 8     // beat lines need at least this much spacing (CSS px)
const MIN_BAR_PX  = 26    // …and bar-only lines at least this much
const EASE        = 0.24  // how fast the view catches up with a pan target
const EDGE_PX     = 16    // dragging this close to the edge scrolls the view
const FOLLOW_LEAD = 0.02  // where the playhead lands when playback pages over
// A mouse notch arrives as one big delta; a trackpad sends a stream of small
// ones. PRECISE_PX tells them apart: below it the input is fine-grained enough
// to apply straight away (easing a two-finger drag only adds lag), above it the
// jump is eased. PINCH_STEP is how much accumulated pinch makes a zoom step.
const PRECISE_PX  = 20
const PINCH_STEP  = 24
// Zoom gestures. A physical wheel notch is one event, sent when the user clicks
// the wheel. The OS-synthesised streams — a trackpad pinch, Cmd/Ctrl + two-finger
// scroll, and the inertia macOS keeps sending after the fingers lift — arrive at
// display refresh rate, so ~16 ms apart or less. NOTCH_GAP_MS separates the two:
// a delta that is both coarse AND arrived after a pause is a real notch and
// spends a level at once, exactly as before. Anything inside a stream is
// accumulated and rationed by ZOOM_COOLDOWN_MS, so a single flick can no longer
// burn the whole ZOOM_STEPS ladder.
const NOTCH_PX         = 40
const NOTCH_GAP_MS     = 45
const ZOOM_COOLDOWN_MS = 150
// This much quiet ends a gesture: accumulator and throttle both reset, so the
// next notch or pinch starts from a clean slate instead of inheriting inertia.
const GESTURE_GAP_MS   = 200

class WaveformTimeline {
  /**
   * @param {object}      opts
   * @param {HTMLCanvasElement} opts.canvas   Target canvas element
   * @param {AudioEngine} opts.engine         AudioEngine instance (must share lifetime)
   * @param {Function}    opts.onSeek         (seconds: number) => void
   * @param {HTMLElement} [opts.timeEl]       Element whose textContent shows "0:00.000 / 3:45.120"
   * @param {HTMLElement} [opts.scrollEl]     Scrollbar track (hidden while fitted)
   * @param {HTMLElement} [opts.thumbEl]      Scrollbar thumb
   * @param {Function}    [opts.onZoom]       ({zoom, atMin, atMax, fitted}) => void
   */
  constructor({ canvas, engine, onSeek, timeEl = null, scrollEl = null, thumbEl = null,
                onZoom = null }) {
    this.canvas   = canvas
    this.engine   = engine
    this.onSeek   = onSeek
    this.timeEl   = timeEl
    this.scrollEl = scrollEl
    this.thumbEl  = thumbEl
    this.onZoom   = onZoom

    this._ctx    = canvas.getContext('2d')
    this._active = false
    this._raf    = null

    this._zi     = 0        // index into ZOOM_STEPS — every song opens fitted
    this._start  = 0        // window start being drawn (seconds)
    this._target = 0        // where it is heading (see _settle)
    this._drag   = null     // in-flight canvas drag
    this._sdrag  = null     // in-flight scrollbar drag
    this._hoverX = null     // CSS px, for the hovered-time readout
    this._hoverRegion = null // silence band under the pointer, see _regions()
    this._pinch  = 0        // accumulated trackpad pinch, see the wheel handler
    // -Infinity, not 0: the first event of a gesture must read as "no previous
    // one", so it is never throttled against a timestamp that never happened.
    this._wheelAt = -Infinity  // last zoom wheel event (splits one gesture from the next)
    this._zoomAt  = -Infinity  // last level spent (throttles a synthesised stream)
    this._lastPx  = 0          // previous zoom delta — a repeat of it means a wheel

    this._W = 0
    this._H = 0
    this._dpr = 1

    this._colors   = WaveformTimeline._buildColors()
    this._handlers = {}

    this._ro = new ResizeObserver(() => this._resize())
    this._ro.observe(canvas)
  }

  // ── Lifecycle ──────────────────────────────────────────────────────────────

  activate() {
    this._active = true
    this._resize()
    this._bindEvents()
    this._startRAF()
    this._notifyZoom()
  }

  deactivate() {
    this._active = false
    this._stopRAF()
    this._unbindEvents()
    this._ro.disconnect()
  }

  // ── Zoom ───────────────────────────────────────────────────────────────────

  /** Deepest step that still shows MIN_WINDOW seconds. */
  _maxIndex() {
    const dur = this.engine.duration || 0
    const max = dur > MIN_WINDOW ? dur / MIN_WINDOW : 1
    let last = 0
    for (let i = 0; i < ZOOM_STEPS.length; i++) {
      if (ZOOM_STEPS[i] <= max + 1e-9) last = i
    }
    return last
  }

  get zoom()   { return ZOOM_STEPS[Math.min(this._zi, this._maxIndex())] }
  get fitted() { return this._win() >= (this.engine.duration || 0) - 1e-9 }

  zoomIn(anchor = null)  { this._setZoomIndex(this._zi + 1, anchor) }
  zoomOut(anchor = null) { this._setZoomIndex(this._zi - 1, anchor) }
  zoomFit() { this._zi = 0; this._setStart(0); this._notifyZoom() }

  /** Reset to "whole song, from the top" — what every new song opens on. */
  reset() { this.zoomFit() }

  /**
   * Zoom keeps a point of interest in place: the cursor when zooming with the
   * wheel, the middle of the window otherwise. Jumping the view somewhere else
   * on every step is the fastest way to lose your bearings.
   */
  _setZoomIndex(i, anchorTime = null) {
    const next = Math.max(0, Math.min(this._maxIndex(), i))
    if (next === this._zi) { this._notifyZoom(); return }

    const before = this._window()
    const at   = anchorTime == null ? before.start + before.win / 2 : anchorTime
    const frac = before.win > 0 ? (at - before.start) / before.win : 0.5

    this._zi = next
    this._setStart(at - frac * this._win())
    this._notifyZoom()
  }

  _notifyZoom() {
    this.onZoom?.({
      zoom:   this.zoom,
      atMin:  this._zi <= 0,
      atMax:  this._zi >= this._maxIndex(),
      fitted: this.fitted
    })
  }

  // ── View window ────────────────────────────────────────────────────────────

  _win() {
    const dur = this.engine.duration || 0
    return Math.min(dur, dur / this.zoom)
  }

  _clampStart(s) {
    const dur = this.engine.duration || 0
    return Math.max(0, Math.min(dur - this._win(), s))
  }

  /**
   * Move the view. `smooth` only sets the target and lets _settle ease into it,
   * which is what the wheel wants; anything that tracks the mouse (dragging the
   * scrollbar, dragging the waveform) must land immediately or it feels laggy.
   */
  _setStart(v, smooth = false) {
    this._target = this._clampStart(v)
    if (!smooth) this._start = this._target
  }

  /** Ease the drawn position towards the target — called once per frame. */
  _settle() {
    const d = this._target - this._start
    if (Math.abs(d) < 1e-4) { this._start = this._target; return }
    this._start += d * EASE
  }

  /** @returns {{start:number, end:number, win:number}} */
  _window() {
    const dur = this.engine.duration || 0
    if (!(dur > 0)) return { start: 0, end: 1, win: 1 }
    const win = this._win()
    if (win >= dur - 1e-9) return { start: 0, end: dur, win: dur }
    const start = this._clampStart(this._start)
    return { start, end: start + win, win }
  }

  /**
   * Page the window forward while playing, so the playhead cannot walk out of
   * frame. Only while playing, and only when it actually leaves.
   *
   * The new window starts (almost) AT the playhead, not a chunk behind it: with
   * a lead-in of 15% the page was already a sixth spent when it appeared, which
   * at deep zoom made it look like it was flipping over and over.
   */
  _followPlayhead() {
    if (this._drag || this._sdrag) return
    if (!this.engine.isPlaying) return
    const { start, win } = this._window()
    if (win >= (this.engine.duration || 0) - 1e-9) return

    const cur = this.engine.currentTime
    if (cur < start || cur > start + win * 0.98) {
      this._setStart(cur - win * FOLLOW_LEAD)
    }
  }

  /**
   * Dragging the playhead against the edge of the window scrolls the view, so a
   * scrub can leave the visible slice without letting go. Speed grows with how
   * far past the edge the mouse is, the way a text selection does.
   */
  _edgePan() {
    const d = this._drag
    if (!d || d.mode !== 'seek' || this.fitted) return

    const w = this._cssWidth()
    if (!(w > 0)) return

    let dir = 0
    if (d.x < EDGE_PX)      dir = -1
    else if (d.x > w - EDGE_PX) dir = 1
    if (!dir) return

    const over  = Math.min(dir < 0 ? EDGE_PX - d.x : d.x - (w - EDGE_PX), 80)
    const speed = 0.004 + (over / 80) * 0.026        // window fraction per frame
    const { win } = this._window()

    this._setStart(this._start + dir * win * speed)
    const now = this._window()
    this.onSeek(dir < 0 ? now.start : now.end)
  }

  // ── Canvas sizing ──────────────────────────────────────────────────────────

  _cssWidth() { return this.canvas.getBoundingClientRect().width }

  _resize() {
    const rect = this.canvas.getBoundingClientRect()
    this._dpr  = window.devicePixelRatio || 1
    this._W    = Math.round(rect.width  * this._dpr)
    this._H    = Math.round(rect.height * this._dpr)
    this.canvas.width  = this._W
    this.canvas.height = this._H
  }

  // ── Animation loop ─────────────────────────────────────────────────────────

  _startRAF() {
    const frame = () => {
      if (!this._active) return
      this._draw()
      this._raf = requestAnimationFrame(frame)
    }
    this._raf = requestAnimationFrame(frame)
  }

  _stopRAF() {
    if (this._raf !== null) {
      cancelAnimationFrame(this._raf)
      this._raf = null
    }
  }

  // ── Drawing ────────────────────────────────────────────────────────────────

  _draw() {
    const ctx    = this._ctx
    const W      = this._W
    const H      = this._H
    const engine = this.engine
    const colors = this._colors

    ctx.fillStyle = colors.bg
    ctx.fillRect(0, 0, W, H)

    if (!engine.waveformData || engine.duration <= 0) {
      ctx.fillStyle = colors.unplayed
      ctx.font      = `${Math.round(11 * this._dpr)}px -apple-system, system-ui, sans-serif`
      ctx.textAlign = 'center'
      ctx.textBaseline = 'middle'
      ctx.fillText('Loading audio…', W / 2, H / 2)
      this._updateTimeDisplay(0, 0)
      this._updateScrollbar()
      return
    }

    this._edgePan()
    this._followPlayhead()
    this._settle()

    const { start, end, win } = this._window()
    const cur    = engine.currentTime
    const leadIn = engine.leadIn || 0
    // The scrollbar floats over the bottom edge, so when it is there the drawing
    // area stops above it instead of being half-covered by it
    const HD     = H - (this._scrollVisible() ? Math.round(13 * this._dpr) : 0)
    const mid    = HD / 2
    const maxAmp = HD * 0.42
    const toX    = t => ((t - start) / win) * W

    this._drawRegions(ctx, toX, mid, maxAmp, HD)
    this._drawWave(ctx, start, end, win, leadIn, cur, mid, maxAmp)
    this._drawGrid(ctx, toX, start, end, win, HD)
    this._drawMarkers(ctx, toX, leadIn, HD, mid, maxAmp)
    this._drawHover(ctx, start, win, HD)
    this._drawHead(ctx, toX(cur), HD)
    // Last, so the hovered band's numbers are never covered by anything.
    this._drawRegionInfo(ctx, toX)

    this._updateTimeDisplay(cur, engine.duration)
    this._updateScrollbar()
  }

  /**
   * The silence around the music, as named bands.
   *
   * There are three, and they are separate on purpose — one shaded block
   * labelled with a single total could not answer "why is it that long":
   *
   *   added   whole beats of silence in front, the ± control's doing. Always a
   *           round number of beats, so beat 1 lands on a grid line.
   *   offset  the sub-beat sliver right up against the music — the offset. This
   *           is the part that actually puts the first beat ON the beat, and it
   *           is usually tens of milliseconds, so at ×1 it is thinner than a
   *           pixel. Hovering is how you read it.
   *   outro   the silence the map will end with: what the song already ends with
   *           plus what the export tops it up by, as one figure, because the
   *           criteria talks about the total.
   *
   * @returns {Array<{key: string, t0: number, t1: number}>} in preview time
   */
  _regions() {
    const e    = this.engine
    const out  = []
    const lead = e.leadIn || 0
    // Clamped, not trusted: leadOffset is only ever a slice OF the lead-in.
    const off  = Math.max(0, Math.min(e.leadOffset || 0, lead))
    const beats = lead - off

    if (beats > 0) out.push({ key: 'added',  t0: 0,     t1: beats })
    if (off   > 0) out.push({ key: 'offset', t0: beats, t1: lead  })

    // One band for the whole outro. Its two halves are the silence already in
    // the audio and the virtual pad past the end of it, and their sum is the
    // figure the criteria talks about: the export TOPS the outro up rather than
    // stacking, so tailPad is already max(0, target − tailOwn).
    const audioEnd = e.audioEnd ?? e.duration ?? 0
    const own      = Math.max(0, e.tailOwn || 0)
    const pad      = Math.max(0, e.tailPad || 0)
    if (own + pad > 0) out.push({ key: 'outro', t0: audioEnd - own, t1: audioEnd + pad })

    return out
  }

  /** Which band the pointer is inside, or null. Narrow bands get a grab margin. */
  _regionAt(cssX) {
    if (cssX == null) return null
    const { start, win } = this._window()
    const x   = cssX * this._dpr
    // A 40 ms offset band at ×1 is a fraction of a pixel; without a margin it
    // would be unhoverable, which would defeat the point of labelling it.
    const grab = 3 * this._dpr
    let best = null
    let bestDist = Infinity
    for (const r of this._regions()) {
      const x0 = ((r.t0 - start) / win) * this._W
      const x1 = ((r.t1 - start) / win) * this._W
      if (x >= x0 - grab && x <= x1 + grab) {
        // Overlapping grab margins: the nearest band centre wins, so the
        // boundary between `added` and `offset` picks one and not both.
        const d = Math.abs(x - (x0 + x1) / 2) - (x1 - x0) / 2
        if (d < bestDist) { bestDist = d; best = r }
      }
    }
    return best
  }

  /** Length of a band in words: milliseconds or seconds, plus whole beats. */
  _regionText(r) {
    // Rounded to the microsecond first: the band edges come out of a chain of
    // subtractions, so an exact 2 beats can arrive as 0.9374999999999999 and
    // print as 937 ms where the honest answer is 938.
    const len = Math.max(0, Math.round((r.t1 - r.t0) * 1e6) / 1e6)
    const dur = len >= 1 ? `${len.toFixed(3)} s` : `${Math.round(len * 1000)} ms`

    const bpm = this.engine.bpm
    if (!(bpm > 0)) return dur
    const beats = len / (60 / bpm)
    // Only when it IS a round number of beats. "4 beats" next to a length that
    // is really 4.03 beats would be a lie, and the whole point of the added
    // band is that it is exact.
    if (Math.abs(beats - Math.round(beats)) > 0.01 || Math.round(beats) < 1) return dur
    const n = Math.round(beats)
    const word = n === 1 ? (window.t?.('wave.beat') || 'beat')
                         : (window.t?.('wave.beats') || 'beats')
    return `${dur} · ${n} ${word}`
  }

  _regionName(r) {
    return window.t?.(`wave.band.${r.key}`) || r.key
  }

  /** The bands themselves, behind the waveform. The hovered one is lit up. */
  _drawRegions(ctx, toX, mid, maxAmp, H) {
    const hovered = this._drag ? null : this._regionAt(this._hoverX)
    this._hoverRegion = hovered

    for (const r of this._regions()) {
      const x0 = toX(r.t0)
      const x1 = toX(r.t1)
      // Never let it vanish: at ×1 a band can be a fraction of a pixel wide,
      // and "the silence is not visible" was exactly the complaint.
      const w  = Math.max(x1 - x0, 2 * this._dpr)
      const on = hovered && hovered.key === r.key

      ctx.fillStyle = on ? this._colors.silenceOn : this._colors.silence
      ctx.fillRect(x0, 0, w, H)

      if (on) {
        // Edges, so a band narrower than its own label still reads as a region
        // with a start and an end rather than a smudge.
        const lw = Math.max(1, Math.round(this._dpr))
        ctx.fillStyle = this._colors.silenceEdge
        ctx.fillRect(Math.round(x0), 0, lw, H)
        ctx.fillRect(Math.round(x0 + w) - lw, 0, lw, H)
      }

      // Centre the label on the VISIBLE part of the band: zoomed in, a band
      // usually starts off-screen to the left, and centring on its true middle
      // would put the text outside the canvas.
      const visX0 = Math.max(x0, 0)
      const visX1 = Math.min(x0 + w, this._W)
      if (on || visX1 - visX0 < 46 * this._dpr) continue

      ctx.fillStyle    = this._colors.silenceText
      ctx.font         = `${Math.round(10 * this._dpr)}px -apple-system, system-ui, sans-serif`
      ctx.textAlign    = 'center'
      ctx.textBaseline = 'middle'
      // Vertically centred, which is the only band of the canvas that is free:
      // the zoom tools float over the top-right corner and the hovered-band box
      // sits along the bottom. There is no waveform behind a silence band to
      // compete with anyway.
      const cx = (visX0 + visX1) / 2
      ctx.fillText(this._regionName(r), cx, mid - 7 * this._dpr)
      ctx.fillText(this._regionText(r), cx, mid + 7 * this._dpr)
    }
  }

  /**
   * The hovered band's name and length, as a box.
   *
   * Drawn on top rather than inside the band because the band that most needs
   * reading is the offset one, which is far too thin to hold text.
   */
  _drawRegionInfo(ctx, toX) {
    const r = this._hoverRegion
    if (!r) return

    const name = this._regionName(r).toUpperCase()
    const text = this._regionText(r)
    const fs   = Math.round(10 * this._dpr)
    ctx.font   = `${fs}px -apple-system, system-ui, sans-serif`
    const wName = ctx.measureText(name).width
    const wText = ctx.measureText(text).width

    const padX = 6 * this._dpr
    const boxW = Math.max(wName, wText) + padX * 2
    const boxH = 30 * this._dpr

    const x0  = toX(r.t0)
    const x1  = toX(r.t1)
    const mid = (Math.max(x0, 0) + Math.min(x1, this._W)) / 2
    const bx  = Math.min(Math.max(mid - boxW / 2, 0), Math.max(0, this._W - boxW))
    const by  = this._H - boxH - 16 * this._dpr

    ctx.fillStyle = this._colors.hoverBg
    ctx.fillRect(bx, by, boxW, boxH)
    // Outlined, so it reads as a box over a dark waveform rather than a smudge
    const lw = Math.max(1, Math.round(this._dpr))
    ctx.fillStyle = this._colors.silenceEdge
    ctx.fillRect(bx, by, boxW, lw)
    ctx.fillRect(bx, by + boxH - lw, boxW, lw)
    ctx.fillRect(bx, by, lw, boxH)
    ctx.fillRect(bx + boxW - lw, by, lw, boxH)

    ctx.textAlign    = 'left'
    ctx.textBaseline = 'top'
    ctx.fillStyle    = this._colors.silenceText
    ctx.fillText(name, bx + padX, by + 5 * this._dpr)
    ctx.fillStyle    = this._colors.hoverText
    ctx.fillText(text, bx + padX, by + 17 * this._dpr)
  }

  /** Peaks for the visible window, split into played / unplayed at the playhead. */
  _drawWave(ctx, start, end, win, leadIn, cur, mid, maxAmp) {
    const W    = this._W
    const step = Math.max(1, Math.round(2 * this._dpr))   // one bar per ~1 CSS px
    const cols = Math.max(1, Math.floor(W / step))

    const peaks = this.engine.peaksFor(start - leadIn, end - leadIn, cols)
    const split = Math.round(((cur - start) / win) * cols)
    const barW  = Math.max(step - 0.5, 0.5)

    ctx.fillStyle = this._colors.unplayed
    for (let i = Math.max(0, split); i < cols; i++) {
      const amp = peaks[i] * maxAmp
      ctx.fillRect(i * step, mid - amp, barW, Math.max(amp * 2, 1))
    }

    ctx.fillStyle = this._colors.played
    for (let i = 0; i < Math.min(split, cols); i++) {
      const amp = peaks[i] * maxAmp
      ctx.fillRect(i * step, mid - amp, barW, Math.max(amp * 2, 1))
    }
  }

  /**
   * The exported map's beat grid: beat K sits at K × beatDur from preview time 0,
   * the same lines the metronome clicks on. Every beat while they are far enough
   * apart to read, bar lines only when they are not, and nothing at all when even
   * those would be a picket fence — zoomed out the grid says nothing anyway.
   */
  _drawGrid(ctx, toX, start, end, win, H) {
    const bpm = this.engine.bpm
    if (!(bpm > 0)) return

    const beatDur   = 60 / bpm
    const pxPerBeat = (beatDur / win) * (this._W / this._dpr)

    const stride = pxPerBeat >= MIN_BEAT_PX    ? 1
                 : pxPerBeat * 4 >= MIN_BAR_PX ? 4
                 : 0
    if (!stride) return

    const first = Math.max(0, Math.ceil(start / beatDur))
    const last  = Math.floor(end / beatDur)
    const lineW = Math.max(1, Math.round(this._dpr))
    const top   = Math.round(H * 0.14)

    // Every fourth line drawn is the strong one, whatever the thinning — with
    // one line per bar already, marking every multiple of 4 beats would make
    // every single line a strong one.
    const barEvery = Math.max(4, stride * 4)

    for (let n = first; n <= last; n++) {
      if (n % stride !== 0) continue
      const isBar = n % barEvery === 0
      ctx.fillStyle = isBar ? this._colors.gridBar : this._colors.grid
      const x = Math.round(toX(n * beatDur))
      if (isBar) ctx.fillRect(x, 0, lineW, H)
      else       ctx.fillRect(x, top, lineW, H - top * 2)
    }
  }

  /**
   * Where the audio starts — the end of the silence we prepend.
   *
   * There used to be a marker for the DETECTED first beat here as well. It was
   * removed on purpose: it marks where the detector thought the beat was, so
   * once the offset is corrected it drifts off the grid while the real transient
   * lands on it, which reads backwards. The waveform against the grid lines is
   * the honest reference, and that is what is left.
   */
  _drawMarkers(ctx, toX, leadIn, H, mid, maxAmp) {
    if (leadIn <= 0) return
    ctx.fillStyle = this._colors.audioStart
    ctx.fillRect(Math.round(toX(leadIn)), Math.round(mid - maxAmp),
                 Math.max(1, Math.round(this._dpr)), Math.round(maxAmp * 2))
  }

  /** Faint line and timestamp under the mouse — the offset work needs numbers. */
  _drawHover(ctx, start, win, H) {
    if (this._hoverX == null || this._drag) return
    const x = this._hoverX * this._dpr
    if (x < 0 || x > this._W) return

    const t = start + (x / this._W) * win
    ctx.fillStyle = this._colors.hover
    ctx.fillRect(Math.round(x), 0, Math.max(1, Math.round(this._dpr)), H)

    const label = _fmt(t)
    ctx.font         = `${Math.round(10 * this._dpr)}px -apple-system, system-ui, sans-serif`
    ctx.textBaseline = 'top'
    const pad = 4 * this._dpr
    const w   = ctx.measureText(label).width + pad * 2
    const bx  = Math.min(Math.max(x - w / 2, 0), this._W - w)

    ctx.fillStyle = this._colors.hoverBg
    ctx.fillRect(bx, 0, w, 14 * this._dpr)
    ctx.fillStyle = this._colors.hoverText
    ctx.textAlign = 'left'
    ctx.fillText(label, bx + pad, 2.5 * this._dpr)
  }

  _drawHead(ctx, headX, H) {
    ctx.fillStyle = this._colors.headGlow
    ctx.fillRect(headX - 4, 0, 8, H)
    ctx.fillStyle = this._colors.head
    ctx.fillRect(Math.round(headX) - 1, 0, 2, H)
  }

  _updateTimeDisplay(cur, dur) {
    if (!this.timeEl) return
    this.timeEl.textContent = `${_fmt(cur)} / ${_fmt(dur)}`
  }

  /** Whether there is anything to scroll — the bar only exists when there is. */
  _scrollVisible() {
    if (!this.scrollEl) return false
    const dur = this.engine.duration || 0
    return dur > 0 && this._win() < dur - 1e-9
  }

  _updateScrollbar() {
    if (!this.scrollEl) return
    const dur = this.engine.duration || 0
    const { start, win } = this._window()
    const hide = !this._scrollVisible()

    this.scrollEl.classList.toggle('hidden', hide)
    if (hide || !this.thumbEl) return

    this.thumbEl.style.left  = `${(start / dur) * 100}%`
    this.thumbEl.style.width = `${Math.max((win / dur) * 100, 3)}%`
  }

  // ── Mouse interaction ──────────────────────────────────────────────────────

  _localX(e) {
    return e.clientX - this.canvas.getBoundingClientRect().left
  }

  _bindEvents() {
    const cv = this.canvas

    this._handlers.mousedown = (e) => {
      // Dragging places the playhead — at every zoom level, because placing it
      // precisely is the whole reason for zooming in. Panning by hand is the
      // modifier gesture (Alt or the middle button), on top of the scrollbar
      // and the wheel.
      const pan = !this.fitted && (e.altKey || e.button === 1)
      this._drag = {
        mode: pan ? 'pan' : 'seek',
        x0: e.clientX, x: this._localX(e),
        start0: this._window().start, moved: false
      }
      cv.classList.toggle('panning', pan)
      if (!pan) this._seekFromEvent(e)
    }

    this._handlers.mousemove = (e) => {
      const d = this._drag
      if (!d) { this._hoverX = this._localX(e); return }

      d.x = this._localX(e)
      if (Math.abs(e.clientX - d.x0) > 2) d.moved = true

      if (d.mode === 'seek') { this._seekFromEvent(e); return }
      this._setStart(d.start0 - ((e.clientX - d.x0) / this._cssWidth()) * this._window().win)
    }

    this._handlers.mouseup = () => {
      if (!this._drag) return
      this._drag = null
      cv.classList.remove('panning')
    }

    this._handlers.mouseleave = () => { this._hoverX = null }

    this._handlers.wheel = (e) => {
      const raw = Math.abs(e.deltaX) > Math.abs(e.deltaY) ? e.deltaX : e.deltaY
      const px  = e.deltaMode === 1 ? raw * 16 : raw        // some mice report lines

      // Zoom. Two very different inputs land here as the same event:
      //  • a physical wheel notch with Ctrl/Cmd held — one coarse delta, sent
      //    only when the user clicks the wheel. One notch, one level, at once.
      //  • an OS-synthesised stream — a trackpad pinch, Cmd/Ctrl + two-finger
      //    scroll, or the inertia macOS keeps sending after the fingers lift.
      //    Dozens of events per gesture, at display refresh rate, and on macOS
      //    each delta can be far bigger than PINCH_STEP. Treating those like
      //    notches spent one level per event and flew ×1 → ×512 in one flick,
      //    so they are accumulated and then rationed in time instead.
      if (e.ctrlKey || e.metaKey) {
        e.preventDefault()
        const { start, win } = this._window()
        const at = start + (this._localX(e) / this._cssWidth()) * win

        const now = e.timeStamp || performance.now()
        const gap = now - this._wheelAt
        const prev = this._lastPx
        this._wheelAt = now
        this._lastPx  = px
        // A pause means the previous gesture is over: drop its leftovers so
        // trailing inertia cannot spend a level on the next deliberate one, and
        // clear the throttle so the new gesture's first level lands at once.
        if (gap > GESTURE_GAP_MS) { this._pinch = 0; this._zoomAt = -Infinity }

        // A wheel notch is coarse AND repeats at exactly the same magnitude
        // (the hardware sends one fixed step per detent), so a fast spin still
        // counts every notch even though the events crowd together. A synthesised
        // stream ramps up and decays, so consecutive deltas never match.
        const coarse  = Math.abs(px) >= NOTCH_PX
        const uniform = gap <= GESTURE_GAP_MS &&
                        Math.abs(Math.abs(px) - Math.abs(prev)) < 0.5
        let step = 0
        if (coarse && (gap >= NOTCH_GAP_MS || uniform)) {
          // Real wheel notch. Unchanged behaviour: one notch, one level, at once.
          step = Math.sign(px)
          this._pinch = 0
        } else {
          this._pinch += px
          if (Math.abs(this._pinch) >= PINCH_STEP) {
            // Inside a stream, so ration the levels. Without this a fast pinch
            // (or its inertia) crosses the threshold on nearly every frame.
            if (now - this._zoomAt >= ZOOM_COOLDOWN_MS) {
              step = Math.sign(this._pinch)
              this._zoomAt = now
            }
            this._pinch = 0
          }
        }
        if (step < 0) this.zoomIn(at)
        else if (step > 0) this.zoomOut(at)
        return
      }

      // Panning only makes sense zoomed in; fitted, the wheel belongs to the
      // page so the rest of the screen still scrolls normally.
      if (this.fitted) return
      e.preventDefault()

      // Proportional to the real delta, so two fingers move the waveform by as
      // much as they moved. Fine-grained input lands immediately (a trackpad is
      // already smooth, easing it would just feel late); a coarse mouse notch is
      // eased so it glides instead of teleporting.
      const { win } = this._window()
      const smooth  = Math.abs(px) >= PRECISE_PX
      this._setStart(this._target + (px / this._cssWidth()) * win, smooth)
    }

    this._handlers.dblclick = () => this.zoomFit()

    cv.addEventListener('mousedown',  this._handlers.mousedown)
    cv.addEventListener('mouseleave', this._handlers.mouseleave)
    cv.addEventListener('wheel',      this._handlers.wheel, { passive: false })
    cv.addEventListener('dblclick',   this._handlers.dblclick)
    window.addEventListener('mousemove', this._handlers.mousemove)
    window.addEventListener('mouseup',   this._handlers.mouseup)

    // ── Scrollbar ───────────────────────────────────────────────────────────
    if (this.scrollEl) {
      this._handlers.sdown = (e) => {
        const dur  = this.engine.duration || 0
        const rect = this.scrollEl.getBoundingClientRect()
        const win  = this._window().win
        if (!(this.thumbEl && e.target === this.thumbEl)) {
          // Clicking the track jumps there, centred on the click
          this._setStart(((e.clientX - rect.left) / rect.width) * dur - win / 2)
        }
        this._sdrag = { x0: e.clientX, start0: this._window().start, rect }
        this.scrollEl.classList.add('dragging')
      }
      this._handlers.smove = (e) => {
        const s = this._sdrag
        if (!s) return
        const dur = this.engine.duration || 0
        this._setStart(s.start0 + ((e.clientX - s.x0) / s.rect.width) * dur)
      }
      this._handlers.sup = () => {
        if (!this._sdrag) return
        this._sdrag = null
        this.scrollEl.classList.remove('dragging')
      }

      this.scrollEl.addEventListener('mousedown', this._handlers.sdown)
      window.addEventListener('mousemove', this._handlers.smove)
      window.addEventListener('mouseup',   this._handlers.sup)
    }
  }

  _unbindEvents() {
    const cv = this.canvas
    cv.removeEventListener('mousedown',  this._handlers.mousedown)
    cv.removeEventListener('mouseleave', this._handlers.mouseleave)
    cv.removeEventListener('wheel',      this._handlers.wheel)
    cv.removeEventListener('dblclick',   this._handlers.dblclick)
    window.removeEventListener('mousemove', this._handlers.mousemove)
    window.removeEventListener('mouseup',   this._handlers.mouseup)

    if (this.scrollEl) {
      this.scrollEl.removeEventListener('mousedown', this._handlers.sdown)
      window.removeEventListener('mousemove', this._handlers.smove)
      window.removeEventListener('mouseup',   this._handlers.sup)
    }
  }

  /** Convert a mouse event (CSS-pixel coords) to a song position and fire onSeek. */
  _seekFromEvent(e) {
    if (!this.engine.duration) return
    const rect  = this.canvas.getBoundingClientRect()    // CSS pixels
    const ratio = Math.max(0, Math.min(1, (e.clientX - rect.left) / rect.width))
    const { start, win } = this._window()
    this.onSeek(start + ratio * win)
  }

  // ── Colours ────────────────────────────────────────────────────────────────

  static _buildColors() {
    const dark = window.matchMedia('(prefers-color-scheme: dark)').matches
    return dark ? {
      bg:          '#0e0e12',
      played:      'rgba(130, 110, 255, 0.82)',
      unplayed:    'rgba(255, 255, 255, 0.11)',
      head:        '#b0a0ff',
      headGlow:    'rgba(124, 106, 247, 0.22)',
      silence:     'rgba(255, 255, 255, 0.07)',
      silenceOn:   'rgba(150, 132, 255, 0.16)',
      silenceEdge: 'rgba(160, 145, 255, 0.55)',
      silenceText: 'rgba(255, 255, 255, 0.45)',
      grid:        'rgba(255, 255, 255, 0.10)',
      gridBar:     'rgba(255, 255, 255, 0.22)',
      audioStart:  'rgba(255, 255, 255, 0.35)',
      hover:       'rgba(255, 255, 255, 0.28)',
      hoverBg:     'rgba(20, 20, 28, 0.85)',
      hoverText:   'rgba(255, 255, 255, 0.72)'
    } : {
      bg:          '#f5f5fa',
      played:      'rgba(100, 80, 220, 0.72)',
      unplayed:    'rgba(0, 0, 40, 0.12)',
      head:        '#5a4bd1',
      headGlow:    'rgba(108, 92, 231, 0.18)',
      silence:     'rgba(0, 0, 40, 0.06)',
      silenceOn:   'rgba(100, 80, 220, 0.13)',
      silenceEdge: 'rgba(90, 75, 209, 0.5)',
      silenceText: 'rgba(0, 0, 40, 0.45)',
      grid:        'rgba(0, 0, 40, 0.11)',
      gridBar:     'rgba(0, 0, 40, 0.24)',
      audioStart:  'rgba(0, 0, 40, 0.38)',
      hover:       'rgba(0, 0, 40, 0.30)',
      hoverBg:     'rgba(255, 255, 255, 0.9)',
      hoverText:   'rgba(0, 0, 40, 0.7)'
    }
  }
}

/** Format seconds → "m:ss.mmm" — milliseconds matter at this zoom. */
function _fmt(s) {
  const t  = Math.max(0, s)
  const m  = Math.floor(t / 60)
  const ss = Math.floor(t % 60)
  const ms = Math.round((t - Math.floor(t)) * 1000)
  return `${m}:${String(ss).padStart(2, '0')}.${String(ms === 1000 ? 999 : ms).padStart(3, '0')}`
}

window.WaveformTimeline = WaveformTimeline
