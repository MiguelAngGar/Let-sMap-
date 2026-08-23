/**
 * audio-engine.js  v2
 * ─────────────────────────────────────────────────────────────────────────────
 * Web Audio API wrapper for BPM validation.
 *
 * GAIN TOPOLOGY
 * ─────────────
 *   AudioBufferSourceNode ──► songGain  (0.30) ──► destination
 *   OscillatorNodes       ──► metroGain (0.80) ──► destination
 *
 * Keeping the two signal paths separate means:
 *  • metronome is always clearly audible over the track
 *  • neither path can cause clipping from the other
 *  • volumes are independently adjustable in one place
 *
 * METRONOME SYNC — LOOKAHEAD SCHEDULER
 * ──────────────────────────────────────
 * Beats are scheduled using AudioContext.currentTime (hardware clock).
 * A setTimeout loop wakes every SCHEDULE_INTERVAL ms and pre-schedules
 * any beats within the next LOOKAHEAD seconds into the Web Audio graph.
 * This is sample-accurate and immune to main-thread jitter.
 *
 * SEEKING
 * ───────
 * seekTo(t) stops the current source, updates _pauseOffset, and re-calls
 * play(). Because play() recalculates _startTime from the new offset,
 * _startScheduler() automatically finds the correct next beat for the
 * new position — no manual re-sync needed.
 */

/* global AudioContext */

const LOOKAHEAD         = 0.12   // seconds to look ahead when scheduling
const SCHEDULE_INTERVAL = 20     // ms between scheduler wakeups
const WAVEFORM_POINTS   = 1400   // number of peak samples to store (overview)
// One peak per 256 samples (~5.8 ms at 44.1 kHz). This is the index the zoomed
// waveform is drawn from: a 3-minute song costs ~140 KB and any window can be
// aggregated out of it in a fraction of a millisecond. Below ~2 px per index
// entry peaksFor() reads the decoded samples directly instead, so the deepest
// zoom levels show the real shape of the transient rather than a 6 ms block.
const PEAK_STEP         = 256

// ── Preview playback speed ────────────────────────────────────────────────────
//
// Preview ONLY. Nothing here reaches the exported map: phase 2 pads and encodes
// the original file, and the rate is reset to 1 for every new song (see
// BpmView.show), so it can never be saved by accident.
//
// Slowing the preview down is how you hear whether a click sits exactly on a
// transient — at 0.3× a 20 ms error is obvious where at 1× it is a smear. It
// pitch-shifts the song (Web Audio resamples; there is no pitch-preserving
// stretch in the platform), which is fine for checking alignment.
const RATE_MIN  = 0.1
const RATE_MAX  = 1.5
const RATE_STEP = 0.1

class AudioEngine {
  constructor() {
    this._ctx          = null
    this._songGain     = null     // GainNode for song track
    this._metroGain    = null     // GainNode for metronome clicks
    this._source       = null     // current AudioBufferSourceNode
    this._buffer       = null     // decoded AudioBuffer
    this._isPlaying    = false
    this._startTime    = 0        // ctx.currentTime − pauseOffset at last play()
    this._pauseOffset  = 0        // audio position (seconds) at last pause
    this._nextBeatTime = 0        // next scheduled beat (ctx time)
    this._schedulerTimer = null

    // Configurable grid params — set by bpm-view via setGrid()
    this.bpm           = 120
    this.firstBeatTime = 0        // PREVIEW-time of beat 1 (downbeat), grid-aligned
    this.leadIn        = 0        // virtual silence before the audio (s) — the
                                  // same silence that will be prepended to the
                                  // exported song, so the preview mirrors the map
    // The lead-in is two things stuck together, and the waveform labels them
    // apart: whole beats of silence (the ± control) and, right up against the
    // music, the sub-beat slice that puts beat 1 on the grid — the offset.
    this.leadOffset    = 0        // sub-beat part of leadIn (s), 0 ≤ x ≤ leadIn
    // The outro, same idea at the other end: what the song already ends with,
    // and what the export tops it up by. tailPad is virtual — it is not in the
    // decoded buffer — so it extends `duration` but has nothing to play.
    this.tailOwn       = 0        // silence the song itself ends with (s)
    this.tailPad       = 0        // silence the export will add after it (s)

    this.rate          = 1        // preview speed, RATE_MIN…RATE_MAX. Preview only.
    this._endTimer     = null     // fires when the preview reaches its end

    // Volume levels (adjustable before or after init via setters below)
    this.songVolume    = 0.50     // 50% — leaves plenty of room for the clicks
    this.metroVolume   = 0.80     // 80% — clearly audible without being harsh
    this.metroSound    = 'click'  // one of METRO_SOUNDS

    // Preprocessed waveform — built once in loadFile
    this.waveformData  = null     // Float32Array of normalised peak amplitudes
    this.sampleRate    = 44100    // decoded buffer rate (updated in loadFile)
    this._peakIndex    = null     // Float32Array, one peak per PEAK_STEP samples
    this._peakMax      = 0        // global peak, used to normalise every window
    this._audioDuration = 0       // decoded buffer duration (s) — see duration getter

    // Callbacks
    this.onBeat = null            // () => void — fires ~on each beat (visual)
    this.onEnd  = null            // () => void — fires when playback ends naturally
  }

  // ── Public API ─────────────────────────────────────────────────────────────

  /**
   * Decode the audio file at `filePath` and preprocess the waveform.
   * Must be called before play(). Safe to call multiple times (re-loads).
   */
  async loadFile(filePath) {
    this._ensureContext()
    const url = window.api.fileUrl(filePath)

    const response = await fetch(url)
    if (!response.ok) throw new Error(`HTTP ${response.status} loading audio`)

    const raw    = await response.arrayBuffer()
    this._buffer = await this._ctx.decodeAudioData(raw)

    this._audioDuration = this._buffer.duration
    this.sampleRate     = this._buffer.sampleRate
    this._peakIndex     = this._buildPeakIndex(this._buffer)
    this.waveformData   = this._buildWaveform(this._buffer)
    this._pauseOffset   = 0
  }

  get isPlaying() { return this._isPlaying }

  /** Total preview duration: lead-in silence + audio + the outro we will add. */
  get duration() { return this.leadIn + this._audioDuration + this.tailPad }

  /** Preview time at which the decoded audio runs out. */
  get audioEnd() { return this.leadIn + this._audioDuration }

  /**
   * Current playback position in seconds.
   * Works whether playing or paused.
   *
   * Preview time runs `rate` times faster than the audio clock, so the elapsed
   * ctx time is scaled back up. At rate 1 this is the identity it always was.
   */
  get currentTime() {
    if (!this._ctx || !this._buffer) return this._pauseOffset
    if (this._isPlaying) {
      const t = (this._ctx.currentTime - this._startTime) * this.rate
      return Math.max(0, Math.min(t, this.duration))
    }
    return this._pauseOffset
  }

  /** Start or resume playback + metronome. */
  play() {
    if (!this._buffer || this._isPlaying) return
    this._ensureContext()
    if (this._ctx.state === 'suspended') this._ctx.resume()

    // _pauseOffset is in PREVIEW time (lead-in silence + audio + outro pad).
    // _startTime maps ctx-time ↔ preview-time; dividing by rate is what makes
    // a preview second cost less than a second of wall clock.
    const offset    = this._pauseOffset
    this._startTime = this._ctx.currentTime - offset / this.rate

    // Positions inside the lead-in delay the buffer start; positions past it
    // seek into the buffer. Past the audio there is nothing to play at all —
    // that is the virtual outro — so no source is created and only the clock
    // and the metronome run.
    if (offset < this.audioEnd) {
      this._source        = this._ctx.createBufferSource()
      this._source.buffer = this._buffer
      this._source.playbackRate.value = this.rate
      this._source.connect(this._songGain)
      if (offset < this.leadIn) {
        this._source.start(this._ctx.currentTime + (this.leadIn - offset) / this.rate, 0)
      } else {
        this._source.start(0, offset - this.leadIn)
      }
      // The end of the preview is the end of the OUTRO, which is past the end
      // of the buffer, so the source finishing is not the end of playback.
      this._source.onended = null
    } else {
      this._source = null
    }

    this._isPlaying = true
    this._armEndTimer()
    this._startScheduler()
  }

  /**
   * One timer owns "the preview ended", instead of the buffer's onended event:
   * the buffer now stops before the preview does (the outro is virtual), and
   * it does not exist at all when playback starts inside that outro.
   */
  _armEndTimer() {
    clearTimeout(this._endTimer)
    const left = (this.duration - this._pauseOffset) / this.rate
    this._endTimer = setTimeout(() => {
      if (!this._isPlaying) return
      this._isPlaying   = false
      this._pauseOffset = 0
      this._source      = null
      this._stopScheduler()
      this.onEnd?.()
    }, Math.max(0, left * 1000))
  }

  /** Pause playback and metronome. Remembers current position. */
  pause() {
    if (!this._isPlaying) return

    // Snapshot current preview position before stopping
    this._pauseOffset = Math.max(
      0,
      Math.min((this._ctx.currentTime - this._startTime) * this.rate, this.duration)
    )
    clearTimeout(this._endTimer)
    this._endTimer = null
    if (this._source) {
      this._source.onended = null   // prevent spurious onEnd callback
      this._source.stop()
      this._source = null
    }
    this._stopScheduler()
    this._isPlaying = false
  }

  /** Toggle play / pause. */
  toggle() {
    if (this._isPlaying) this.pause()
    else this.play()
  }

  /**
   * Seek to `seconds` in the audio.
   * If currently playing, resumes playback from the new position.
   * Metronome scheduler re-initialises from the new position automatically.
   */
  seekTo(seconds) {
    const wasPlaying = this._isPlaying

    if (this._isPlaying) {
      clearTimeout(this._endTimer)
      this._endTimer = null
      if (this._source) {
        this._source.onended = null
        this._source.stop()
        this._source = null
      }
      this._stopScheduler()
      this._isPlaying = false
    }

    this._pauseOffset = Math.max(0, Math.min(seconds, this.duration))

    if (wasPlaying) this.play()   // play() recalculates _startTime and _startScheduler()
  }

  /**
   * Update the whole preview grid in one call.
   * @param {object} g
   * @param {number} g.bpm     Effective BPM (doubling already applied)
   * @param {number} g.leadIn  Silence that will be prepended to the export (s)
   * @param {number} g.anchor  PREVIEW-time of beat 1 (downbeat), half-beat
   *                           shift included. Informational only: the click
   *                           grid comes from bpm + leadIn (see _startScheduler)
   * @param {number} [g.leadOffset]  Sub-beat part of leadIn — the offset. Only
   *                           the waveform reads it, to label the two bands apart.
   * @param {number} [g.tailOwn]     Silence the song itself ends with (s).
   * @param {number} [g.tailPad]     Silence the export will add after it (s).
   *
   * The current position is preserved in AUDIO terms: if the lead-in length
   * changes, the playhead keeps pointing at the same music.
   */
  setGrid({ bpm, leadIn, anchor, leadOffset, tailOwn, tailPad }) {
    const wasPlaying = this._isPlaying
    const oldLeadIn  = this.leadIn
    const pos        = this.currentTime

    if (wasPlaying) this.pause()

    this.bpm           = bpm
    this.leadIn        = leadIn
    this.firstBeatTime = anchor
    if (leadOffset !== undefined) {
      this.leadOffset = Math.max(0, Math.min(leadOffset, leadIn))
    }
    if (tailOwn !== undefined) this.tailOwn = Math.max(0, tailOwn)
    if (tailPad !== undefined) this.tailPad = Math.max(0, tailPad)

    // Re-map the playhead into the new preview timeline
    if (pos > oldLeadIn) {
      this._pauseOffset = (pos - oldLeadIn) + leadIn        // inside the audio
    } else if (oldLeadIn > 0) {
      this._pauseOffset = (pos / oldLeadIn) * leadIn        // inside the silence
    } // else: pos 0 with no previous lead-in → stay at 0

    if (wasPlaying) this.play()
  }

  /**
   * Set the PREVIEW playback speed. Never touches the export — phase 2 pads and
   * encodes the original file and knows nothing about this — and BpmView.show
   * puts it back to 1 for every new song, so it cannot be carried over.
   *
   * @param {number} r  clamped to RATE_MIN…RATE_MAX and snapped to RATE_STEP
   * @returns {number}  the rate actually applied
   */
  setRate(r) {
    const snapped = Math.round(Number(r) / RATE_STEP) * RATE_STEP
    const next    = Math.min(RATE_MAX, Math.max(RATE_MIN, snapped))
    // Floating point: 0.7000000000000001 would fail the === below and restart
    // playback on every keypress that changes nothing.
    const clean   = Math.round(next * 1000) / 1000
    if (clean === this.rate) return this.rate

    // Restarting is what re-reads the rate: playbackRate is settable live, but
    // _startTime and every beat already queued in the scheduler assume the old
    // one, so the clean way is to pause and play from the same position.
    const wasPlaying = this._isPlaying
    const pos        = this.currentTime
    if (wasPlaying) this.pause()
    this.rate         = clean
    this._pauseOffset = pos
    if (wasPlaying) this.play()
    return this.rate
  }

  /** Step the preview speed by ±RATE_STEP. @returns {number} the new rate */
  nudgeRate(steps) {
    return this.setRate(this.rate + steps * RATE_STEP)
  }

  /**
   * Set song playback volume in real time.
   * @param {number} v  0.0 – 1.0
   */
  setSongVolume(v) {
    this.songVolume = v
    if (this._songGain) this._songGain.gain.value = v
  }

  /**
   * Set metronome click volume in real time.
   * @param {number} v  0.0 – 1.0
   */
  setMetroVolume(v) {
    this.metroVolume = v
    if (this._metroGain) this._metroGain.gain.value = v
  }

  /**
   * Pick the metronome voice. Takes effect on the next scheduled beat, so it can
   * be changed mid-playback.
   * @param {string} name  one of METRO_SOUNDS
   */
  setMetroSound(name) {
    this.metroSound = METRO_SOUNDS.includes(name) ? name : 'click'
  }

  /**
   * Play one hit on THIS engine's context, at the metronome's own volume.
   *
   * Previewing through a second AudioContext while this one is running is what
   * made the old sound cut out and the audio misbehave — two contexts fighting
   * over the same output device. When a song is loaded, the preview belongs here.
   *
   * @param {string} name
   * @returns {boolean} false when there is no context yet (nothing loaded)
   */
  previewSound(name) {
    if (!this._ctx || !this._metroGain) return false
    if (this._ctx.state === 'suspended') this._ctx.resume()
    _renderClick(this._ctx, this._metroGain, this._ctx.currentTime + 0.02,
                 METRO_SOUNDS.includes(name) ? name : 'click')
    return true
  }

  /**
   * Play one hit of a voice on its own, for the Settings preview. Uses a lazy
   * context of its own so it works with no song loaded.
   * @param {string} name
   * @param {number} [volume=0.8]
   */
  static previewSound(name, volume = 0.8) {
    _previewCtx = _previewCtx || new AudioContext()
    if (_previewCtx.state === 'suspended') _previewCtx.resume()

    const gain = _previewCtx.createGain()
    gain.gain.value = Math.max(0, Math.min(1, volume))
    gain.connect(_previewCtx.destination)

    _renderClick(_previewCtx, gain, _previewCtx.currentTime + 0.02,
                 METRO_SOUNDS.includes(name) ? name : 'click')

    // Let go of the audio device once the hit has rung out; the next preview
    // resumes it. Holding a second context open is asking for trouble on
    // Windows, where drivers can take the output exclusively.
    clearTimeout(_previewIdle)
    _previewIdle = setTimeout(() => { _previewCtx?.suspend?.() }, 600)
  }

  /** Stop playback, rewind to zero. */
  stop() {
    if (this._isPlaying) this.pause()
    clearTimeout(this._endTimer)
    this._endTimer    = null
    this._pauseOffset = 0
  }

  /** Release all Web Audio resources. */
  destroy() {
    this.stop()
    this._ctx?.close()
    this._ctx = this._songGain = this._metroGain = null
  }

  // ── Waveform preprocessing ─────────────────────────────────────────────────

  /**
   * Downsample the decoded PCM into WAVEFORM_POINTS normalised peak values.
   *
   * Algorithm:
   *  1. Average left + right channels (or mono) for each sample.
   *  2. Divide the signal into N equal windows.
   *  3. Record the peak absolute value within each window.
   *  4. Normalise by the global maximum so the display always fills the canvas.
   *
   * This runs once on load and is O(n) in the number of samples.
   */
  _buildWaveform(buffer) {
    const n    = buffer.length
    const pts  = Math.min(WAVEFORM_POINTS, n)
    const step = Math.max(1, Math.floor(n / pts))
    const data = new Float32Array(pts)

    const ch0 = buffer.getChannelData(0)
    const ch1 = buffer.numberOfChannels > 1 ? buffer.getChannelData(1) : ch0

    let globalMax = 0

    for (let i = 0; i < pts; i++) {
      let peak  = 0
      const end = Math.min(i * step + step, n)
      for (let j = i * step; j < end; j++) {
        const abs = Math.abs((ch0[j] + ch1[j]) * 0.5)
        if (abs > peak) peak = abs
      }
      data[i] = peak
      if (peak > globalMax) globalMax = peak
    }

    // Normalise → [0, 1] so any song fills the full waveform height
    if (globalMax > 0) {
      for (let i = 0; i < pts; i++) data[i] /= globalMax
    }

    return data
  }

  /**
   * Peak envelope for an arbitrary window of AUDIO time, one value per column.
   *
   * @param {number} startSec  window start in audio time (may be negative —
   *                           those columns come back as 0, which is what the
   *                           prepended silence looks like)
   * @param {number} endSec    window end in audio time
   * @param {number} points    number of columns to fill
   * @returns {Float32Array}   peaks in [0, 1], normalised by the GLOBAL peak so
   *                           a quiet passage still looks quiet when zoomed in
   *
   * Cheap enough to call every animation frame: the whole song is ~36 k index
   * entries, and the exact-sample path only ever runs on windows of a couple of
   * seconds (~90 k samples).
   */
  peaksFor(startSec, endSec, points) {
    const n   = Math.max(1, Math.floor(points))
    const out = new Float32Array(n)
    if (!this._buffer || !(endSec > startSec)) return out

    const sr   = this.sampleRate
    const dur  = this._audioDuration
    const span = endSec - startSec
    // Exact samples once a column covers less than two index entries
    const exact = (span * sr / n) < PEAK_STEP * 2
    const idx   = this._peakIndex

    const ch0 = exact ? this._buffer.getChannelData(0) : null
    const ch1 = exact
      ? (this._buffer.numberOfChannels > 1 ? this._buffer.getChannelData(1) : ch0)
      : null

    for (let i = 0; i < n; i++) {
      const t0 = Math.max(0, startSec + (span * i) / n)
      const t1 = Math.min(dur, startSec + (span * (i + 1)) / n)
      if (t1 <= t0) continue

      let peak = 0
      if (exact) {
        const s0 = Math.floor(t0 * sr)
        const s1 = Math.max(s0 + 1, Math.ceil(t1 * sr))
        const end = Math.min(s1, ch0.length)
        for (let j = s0; j < end; j++) {
          const abs = Math.abs((ch0[j] + ch1[j]) * 0.5)
          if (abs > peak) peak = abs
        }
      } else {
        const e0  = Math.floor((t0 * sr) / PEAK_STEP)
        const e1  = Math.max(e0 + 1, Math.ceil((t1 * sr) / PEAK_STEP))
        const end = Math.min(e1, idx.length)
        for (let j = e0; j < end; j++) {
          if (idx[j] > peak) peak = idx[j]
        }
      }
      out[i] = this._peakMax > 0 ? peak / this._peakMax : 0
    }

    return out
  }

  /**
   * One peak per PEAK_STEP samples, plus the global peak used to normalise.
   * Raw (un-normalised) values are stored so peaksFor can normalise itself.
   */
  _buildPeakIndex(buffer) {
    const n     = buffer.length
    const count = Math.max(1, Math.ceil(n / PEAK_STEP))
    const idx   = new Float32Array(count)

    const ch0 = buffer.getChannelData(0)
    const ch1 = buffer.numberOfChannels > 1 ? buffer.getChannelData(1) : ch0

    let globalMax = 0
    for (let i = 0; i < count; i++) {
      let peak  = 0
      const end = Math.min(i * PEAK_STEP + PEAK_STEP, n)
      for (let j = i * PEAK_STEP; j < end; j++) {
        const abs = Math.abs((ch0[j] + ch1[j]) * 0.5)
        if (abs > peak) peak = abs
      }
      idx[i] = peak
      if (peak > globalMax) globalMax = peak
    }

    this._peakMax = globalMax
    return idx
  }

  // ── Metronome scheduler ────────────────────────────────────────────────────

  /**
   * The gap between two clicks in CTX time. The grid is fixed in PREVIEW time —
   * beat n at n·60/bpm, wherever the music ends up — so at half speed the beats
   * are still the same beats, they just take twice as long to arrive. That is
   * what keeps a slowed-down preview honest: the clicks stay on the map's grid
   * instead of drifting off it.
   */
  _beatStep() {
    return (60 / this.bpm) / this.rate
  }

  /**
   * Seed _nextBeatTime on the map's beat grid, then start the scheduling loop.
   *
   * KEY RELATIONSHIP
   * ─────────────────
   *   _startTime maps preview-time ↔ ctx-time:
   *     ctx_time_of_preview_position_T  =  _startTime + T / rate
   *   rate is 1 unless the preview speed was changed, so this is normally just
   *   _startTime + T. _beatStep above is that same division, per beat.
   *
   *   The clicks sit on the grid of the EXPORTED map: beat K is at
   *   K × beatDur from preview-time 0 (the start of the padded audio), which is
   *   exactly where Beat Saber will put its beats.
   *
   *   That is what makes the half-beat button audible. It changes how much
   *   silence goes in front of the music, so the music moves against this fixed
   *   grid: with the shift on, the clicks land on what were the off-beats. If
   *   the clicks came from the detected beat instead, both would move together
   *   and toggling the button would sound like nothing happened.
   *
   * After seeking, _startTime is updated by play(), so this automatically
   * yields the correct next beat for the new position.
   */
  _startScheduler() {
    const step = this._beatStep()

    // Clicks run through the lead-in silence too, as a count-in: those beats
    // exist in the exported map, and hearing them is how you tell how much
    // silence is in front of the music — and whether the music lands on the
    // grid when it starts.
    const minN = 0

    // Find the next grid line that hasn't fired yet
    const elapsed = this._ctx.currentTime - this._startTime
    const nextN   = Math.max(minN, Math.ceil(elapsed / step))
    this._nextBeatTime = this._startTime + nextN * step

    // Advance past any floating-point edge where we're still exactly on currentTime
    while (this._nextBeatTime <= this._ctx.currentTime) {
      this._nextBeatTime += step
    }

    this._schedule()
  }

  _schedule() {
    const step = this._beatStep()

    while (this._nextBeatTime < this._ctx.currentTime + LOOKAHEAD) {
      this._scheduleClick(this._nextBeatTime)
      this._scheduleFlash(this._nextBeatTime)
      this._nextBeatTime += step
    }

    this._schedulerTimer = setTimeout(() => this._schedule(), SCHEDULE_INTERVAL)
  }

  _stopScheduler() {
    clearTimeout(this._schedulerTimer)
    this._schedulerTimer = null
  }

  // ── Click synthesis ────────────────────────────────────────────────────────

  /**
   * Schedule one beat at `time` (AudioContext absolute time) using the chosen
   * voice. Connects to _metroGain, which is independent of _songGain — no
   * crosstalk between the click and the song.
   */
  _scheduleClick(time) {
    if (time < this._ctx.currentTime - 0.01) return   // skip missed beats
    _renderClick(this._ctx, this._metroGain, time, this.metroSound)
  }

  /**
   * Fire the onBeat visual callback approximately when the click plays.
   * Uses setTimeout from ctx time — accurate to ~1–5 ms, enough for a flash.
   */
  _scheduleFlash(time) {
    const delay = Math.max(0, (time - this._ctx.currentTime) * 1000)
    setTimeout(() => { this.onBeat?.() }, delay)
  }

  // ── Internal setup ─────────────────────────────────────────────────────────

  _ensureContext() {
    if (this._ctx) return

    this._ctx       = new AudioContext()
    this._songGain  = this._ctx.createGain()
    this._metroGain = this._ctx.createGain()

    this._songGain.gain.value  = this.songVolume
    this._metroGain.gain.value = this.metroVolume

    this._songGain.connect(this._ctx.destination)
    this._metroGain.connect(this._ctx.destination)
  }
}

// ── Metronome voices ─────────────────────────────────────────────────────────
//
// Five deliberately different sounds, because "audible over the song" depends
// entirely on the song: a bright click disappears into busy highs, and a low
// thump sits under the music instead of fighting it.
//
//   click  triangle 1200 Hz  — the original: sharp, cuts through most things
//   beep   sine 880 Hz       — softer and rounder, easier on long sessions
//   tick   filtered noise    — very dry, no pitch to clash with the music
//   block  square 2000 Hz    — woodblock-ish, brightest of the set
//   thump  sine 150→60 Hz    — a kick you feel rather than hear
//
// One shared renderer so the Settings preview and the scheduler cannot drift.

const METRO_SOUNDS = ['click', 'beep', 'tick', 'block', 'thump']

let _previewCtx = null              // lazy context for Settings previews
let _previewIdle = null             // timer that suspends it when idle
const _noiseCache = new WeakMap()   // one noise buffer per AudioContext

/** 120 ms of white noise, reused for every `tick`. */
function _noise(ctx) {
  let buf = _noiseCache.get(ctx)
  if (buf) return buf
  const len  = Math.floor(ctx.sampleRate * 0.12)
  buf = ctx.createBuffer(1, len, ctx.sampleRate)
  const data = buf.getChannelData(0)
  for (let i = 0; i < len; i++) data[i] = Math.random() * 2 - 1
  _noiseCache.set(ctx, buf)
  return buf
}

/**
 * Render one metronome hit into `dest` at `time`.
 * @param {AudioContext} ctx
 * @param {AudioNode}    dest
 * @param {number}       time  absolute ctx time
 * @param {string}       sound one of METRO_SOUNDS
 */
function _renderClick(ctx, dest, time, sound) {
  const gain = ctx.createGain()
  gain.connect(dest)

  if (sound === 'tick') {
    // Noise through a high-pass: a dry transient with no pitch of its own
    const src = ctx.createBufferSource()
    src.buffer = _noise(ctx)
    const hp = ctx.createBiquadFilter()
    hp.type = 'highpass'
    hp.frequency.value = 2500
    src.connect(hp)
    hp.connect(gain)

    gain.gain.setValueAtTime(0, time)
    gain.gain.linearRampToValueAtTime(0.9, time + 0.002)
    gain.gain.exponentialRampToValueAtTime(0.001, time + 0.03)

    src.start(time)
    src.stop(time + 0.04)
    return
  }

  const osc = ctx.createOscillator()
  osc.connect(gain)

  let peak = 1.0
  let tail = 0.06

  switch (sound) {
    case 'beep':
      osc.type = 'sine'
      osc.frequency.value = 880
      tail = 0.09
      break
    case 'block':
      osc.type = 'square'
      osc.frequency.value = 2000
      peak = 0.55            // square waves are much louder for the same peak
      tail = 0.035
      break
    case 'thump':
      osc.type = 'sine'
      osc.frequency.setValueAtTime(150, time)
      osc.frequency.exponentialRampToValueAtTime(60, time + 0.08)
      tail = 0.11
      break
    default:                 // 'click'
      osc.type = 'triangle'
      osc.frequency.value = 1200
      tail = 0.058
  }

  // Very fast attack, sharp exponential decay: the attack is what you hear as
  // "the beat", so it has to be immediate at any tempo
  gain.gain.setValueAtTime(0, time)
  gain.gain.linearRampToValueAtTime(peak, time + 0.004)
  gain.gain.exponentialRampToValueAtTime(0.001, time + tail)

  osc.start(time)
  osc.stop(time + tail + 0.01)
}

AudioEngine.METRO_SOUNDS = METRO_SOUNDS
AudioEngine.RATE_MIN     = RATE_MIN
AudioEngine.RATE_MAX     = RATE_MAX
AudioEngine.RATE_STEP    = RATE_STEP

window.AudioEngine = AudioEngine
