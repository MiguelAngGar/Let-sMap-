/**
 * timeline.js
 * ─────────────────────────────────────────────────────────────────────────────
 * Canvas-based waveform display with playhead and click-to-seek.
 *
 * RENDERING APPROACH
 * ───────────────────
 * • The waveform is drawn fresh every animation frame (RAF loop).
 * • Each frame: two passes through the downsampled peak array —
 *   one for the "played" region (bright), one for "unplayed" (dim).
 *   The split index is derived from engine.currentTime each frame.
 * • With ~1400 points per pass this is <0.5 ms/frame on modern hardware.
 * • No offscreen canvas needed — the cost is trivially low.
 *
 * DPR-AWARE CANVAS
 * ─────────────────
 * Physical canvas dimensions = CSS dimensions × devicePixelRatio.
 * All drawing coordinates are in physical pixels.
 * Mouse events (in CSS pixels) are converted to ratios before use,
 * so they are DPR-agnostic.
 *
 * SEEK SYNC
 * ──────────
 * Click / drag fires onSeek(seconds) → caller calls engine.seekTo(t).
 * engine.seekTo() stops the source, updates _pauseOffset, and re-calls
 * play() if it was playing. play() recalculates _startTime, then
 * _startScheduler() finds the correct next beat automatically.
 * No extra sync step required here.
 */

/* global AudioEngine */  // just for jsdoc; imported via <script> tag

class WaveformTimeline {
  /**
   * @param {object}      opts
   * @param {HTMLCanvasElement} opts.canvas   Target canvas element
   * @param {AudioEngine} opts.engine         AudioEngine instance (must share lifetime)
   * @param {Function}    opts.onSeek         (seconds: number) => void
   * @param {HTMLElement} [opts.timeEl]       Element whose textContent shows "0:00 / 3:45"
   */
  constructor({ canvas, engine, onSeek, timeEl = null }) {
    this.canvas  = canvas
    this.engine  = engine
    this.onSeek  = onSeek
    this.timeEl  = timeEl

    this._ctx         = canvas.getContext('2d')
    this._active      = false
    this._raf         = null
    this._isDragging  = false

    // Physical pixel dimensions (updated in _resize)
    this._W = 0
    this._H = 0
    this._dpr = 1

    // Build colour scheme once — matches style.css tokens
    this._colors = WaveformTimeline._buildColors()

    // Bound event handler references (needed for removeEventListener)
    this._handlers = {}

    // ResizeObserver keeps the canvas crisp if the window is resized
    this._ro = new ResizeObserver(() => this._resize())
    this._ro.observe(canvas)
  }

  // ── Lifecycle ──────────────────────────────────────────────────────────────

  /** Start the animation loop and enable mouse interaction. */
  activate() {
    this._active = true
    this._resize()
    this._bindEvents()
    this._startRAF()
  }

  /** Stop the animation loop and remove event listeners. */
  deactivate() {
    this._active = false
    this._stopRAF()
    this._unbindEvents()
    this._ro.disconnect()
  }

  // ── Canvas sizing ──────────────────────────────────────────────────────────

  _resize() {
    const rect   = this.canvas.getBoundingClientRect()
    this._dpr    = window.devicePixelRatio || 1
    this._W      = Math.round(rect.width  * this._dpr)
    this._H      = Math.round(rect.height * this._dpr)
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
    const ctx     = this._ctx
    const W       = this._W
    const H       = this._H
    const engine  = this.engine
    const colors  = this._colors

    // Background
    ctx.fillStyle = colors.bg
    ctx.fillRect(0, 0, W, H)

    const data = engine.waveformData

    // Loading state — no waveform data yet
    if (!data || engine.duration <= 0) {
      ctx.fillStyle = colors.unplayed
      ctx.font      = `${Math.round(11 * this._dpr)}px -apple-system, system-ui, sans-serif`
      ctx.textAlign = 'center'
      ctx.textBaseline = 'middle'
      ctx.fillText('Loading audio…', W / 2, H / 2)
      this._updateTimeDisplay(0, 0)
      return
    }

    const cur     = engine.currentTime
    const dur     = engine.duration
    const leadIn  = engine.leadIn || 0
    const ratio   = Math.min(cur / dur, 1)
    const headX   = ratio * W
    const mid     = H / 2
    const maxAmp  = H * 0.44    // bars fill 88% of total height (44% each side)

    // The waveform occupies only the audio region; the lead-in silence that
    // will be prepended to the exported song shows as a flat area before it.
    const leadX   = (leadIn / dur) * W
    const audioW  = Math.max(1, W - leadX)
    const barW    = audioW / data.length
    const audioRatio = Math.max(0, Math.min((cur - leadIn) / Math.max(dur - leadIn, 1e-9), 1))
    const splitI  = Math.floor(audioRatio * data.length)

    // Pass 1 — unplayed (dim)
    ctx.fillStyle = colors.unplayed
    for (let i = splitI; i < data.length; i++) {
      const x   = leadX + i * barW
      const amp = data[i] * maxAmp
      ctx.fillRect(x, mid - amp, Math.max(barW - 0.5, 0.5), Math.max(amp * 2, 1))
    }

    // Pass 2 — played (bright, accent colour)
    ctx.fillStyle = colors.played
    for (let i = 0; i < splitI; i++) {
      const x   = leadX + i * barW
      const amp = data[i] * maxAmp
      ctx.fillRect(x, mid - amp, Math.max(barW - 0.5, 0.5), Math.max(amp * 2, 1))
    }

    // Audio-start marker: a thin line where the prepended silence ends
    if (leadX > 0.5) {
      ctx.fillStyle = colors.unplayed
      ctx.fillRect(Math.round(leadX), Math.round(mid - maxAmp), Math.max(1, this._dpr), Math.round(maxAmp * 2))
    }

    // Playhead glow (subtle halo, drawn before the sharp line)
    ctx.fillStyle = colors.headGlow
    ctx.fillRect(headX - 4, 0, 8, H)

    // Playhead line (crisp 2-px, anti-aliased if sub-pixel)
    ctx.fillStyle = colors.head
    ctx.fillRect(Math.round(headX) - 1, 0, 2, H)

    // Update time display element
    this._updateTimeDisplay(cur, dur)
  }

  _updateTimeDisplay(cur, dur) {
    if (!this.timeEl) return
    this.timeEl.textContent = `${_fmt(cur)} / ${_fmt(dur)}`
  }

  // ── Mouse interaction ──────────────────────────────────────────────────────

  _bindEvents() {
    const cv = this.canvas

    this._handlers.mousedown = (e) => {
      this._isDragging = true
      cv.classList.add('dragging')
      this._seekFromEvent(e)
    }
    this._handlers.mousemove = (e) => {
      if (this._isDragging) this._seekFromEvent(e)
    }
    this._handlers.mouseup = () => {
      this._isDragging = false
      cv.classList.remove('dragging')
    }

    cv.addEventListener('mousedown', this._handlers.mousedown)
    window.addEventListener('mousemove', this._handlers.mousemove)
    window.addEventListener('mouseup',   this._handlers.mouseup)
  }

  _unbindEvents() {
    this.canvas.removeEventListener('mousedown', this._handlers.mousedown)
    window.removeEventListener('mousemove', this._handlers.mousemove)
    window.removeEventListener('mouseup',   this._handlers.mouseup)
  }

  /** Convert a mouse event (CSS-pixel coords) to a song position and fire onSeek. */
  _seekFromEvent(e) {
    if (!this.engine.duration) return
    const rect  = this.canvas.getBoundingClientRect()    // CSS pixels
    const ratio = Math.max(0, Math.min(1, (e.clientX - rect.left) / rect.width))
    this.onSeek(ratio * this.engine.duration)
  }

  // ── Colours ────────────────────────────────────────────────────────────────

  /**
   * Build the colour set once at class instantiation.
   * Matches the CSS token values in style.css for both light and dark modes.
   */
  static _buildColors() {
    const dark = window.matchMedia('(prefers-color-scheme: dark)').matches
    return dark ? {
      bg:        '#0e0e12',
      played:    'rgba(130, 110, 255, 0.82)',
      unplayed:  'rgba(255, 255, 255, 0.11)',
      head:      '#b0a0ff',
      headGlow:  'rgba(124, 106, 247, 0.22)'
    } : {
      bg:        '#f5f5fa',
      played:    'rgba(100, 80, 220, 0.72)',
      unplayed:  'rgba(0, 0, 40, 0.12)',
      head:      '#5a4bd1',
      headGlow:  'rgba(108, 92, 231, 0.18)'
    }
  }
}

/** Format seconds → "m:ss" */
function _fmt(s) {
  const m = Math.floor(s / 60)
  return `${m}:${String(Math.floor(s % 60)).padStart(2, '0')}`
}

window.WaveformTimeline = WaveformTimeline
