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
const WAVEFORM_POINTS   = 1400   // number of peak samples to store

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

    // Configurable BPM params — set by bpm-view
    this.bpm           = 120
    this.firstBeatTime = 0        // onset time of first beat in original audio (s)
    this.halfBeatShift = false

    // Volume levels (adjustable before or after init via setters below)
    this.songVolume    = 0.75     // 75% — prominent but leaves room for metronome
    this.metroVolume   = 1.00     // 100% — always clearly audible

    // Preprocessed waveform — built once in loadFile
    this.waveformData  = null     // Float32Array of normalised peak amplitudes
    this.duration      = 0        // total duration in seconds

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

    this.duration     = this._buffer.duration
    this.waveformData = this._buildWaveform(this._buffer)
    this._pauseOffset = 0
  }

  get isPlaying() { return this._isPlaying }

  /**
   * Current playback position in seconds.
   * Works whether playing or paused.
   */
  get currentTime() {
    if (!this._ctx || !this._buffer) return this._pauseOffset
    if (this._isPlaying) {
      const t = this._ctx.currentTime - this._startTime
      return Math.max(0, Math.min(t, this._buffer.duration))
    }
    return this._pauseOffset
  }

  /** Start or resume playback + metronome. */
  play() {
    if (!this._buffer || this._isPlaying) return
    this._ensureContext()
    if (this._ctx.state === 'suspended') this._ctx.resume()

    this._source        = this._ctx.createBufferSource()
    this._source.buffer = this._buffer
    this._source.connect(this._songGain)

    const offset    = this._pauseOffset
    this._startTime = this._ctx.currentTime - offset
    this._source.start(0, offset)

    this._source.onended = () => {
      // Only treat this as a natural end if we didn't manually stop
      if (this._isPlaying) {
        this._isPlaying   = false
        this._pauseOffset = 0
        this._stopScheduler()
        this.onEnd?.()
      }
    }

    this._isPlaying = true
    this._startScheduler()
  }

  /** Pause playback and metronome. Remembers current position. */
  pause() {
    if (!this._isPlaying) return

    // Snapshot current audio position before stopping
    this._pauseOffset = Math.max(
      0,
      Math.min(this._ctx.currentTime - this._startTime, this._buffer.duration)
    )
    this._source.onended = null   // prevent spurious onEnd callback
    this._source.stop()
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
      this._source.onended = null
      this._source.stop()
      this._stopScheduler()
      this._isPlaying = false
    }

    this._pauseOffset = Math.max(0, Math.min(seconds, this._buffer?.duration ?? 0))

    if (wasPlaying) this.play()   // play() recalculates _startTime and _startScheduler()
  }

  /** Update BPM. Re-initialises the scheduler if currently playing. */
  setBPM(bpm) {
    this.bpm = bpm
    if (this._isPlaying) {
      this._stopScheduler()
      this._startScheduler()
    }
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

  /** Toggle half-beat grid shift. Re-syncs scheduler immediately. */
  setHalfBeatShift(enabled) {
    this.halfBeatShift = enabled
    if (this._isPlaying) {
      this._stopScheduler()
      this._startScheduler()
    }
  }

  /** Stop playback, rewind to zero. */
  stop() {
    if (this._isPlaying) this.pause()
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

  // ── Metronome scheduler ────────────────────────────────────────────────────

  /**
   * Compute the ctx-time of the first beat and seed _nextBeatTime,
   * then kick off the scheduling loop.
   *
   * KEY RELATIONSHIP
   * ─────────────────
   *   _startTime  maps audio-time ↔ ctx-time:
   *     ctx_time_of_audio_position_T  =  _startTime + T
   *
   *   Beat 1 occurs at audio position `firstBeatTime` (from Python analysis).
   *   After applying optional half-beat shift, beat 1's ctx-time is:
   *     firstBeatCtx = _startTime + firstBeatTime + halfShift
   *
   *   Beat N ctx-time = firstBeatCtx + N × beatDur
   *
   * After seeking, _startTime is updated by play(), so this formula
   * automatically yields the correct next beat for the new position.
   */
  _startScheduler() {
    const beatDur      = 60 / this.bpm
    const halfShift    = this.halfBeatShift ? beatDur / 2 : 0
    const firstBeatCtx = this._startTime + this.firstBeatTime + halfShift

    // Find the next beat index that hasn't fired yet
    const elapsed = this._ctx.currentTime - firstBeatCtx
    const nextN   = Math.max(0, Math.ceil(elapsed / beatDur))
    this._nextBeatTime = firstBeatCtx + nextN * beatDur

    // Advance past any floating-point edge where we're still exactly on currentTime
    while (this._nextBeatTime <= this._ctx.currentTime) {
      this._nextBeatTime += beatDur
    }

    this._schedule()
  }

  _schedule() {
    const beatDur = 60 / this.bpm

    while (this._nextBeatTime < this._ctx.currentTime + LOOKAHEAD) {
      this._scheduleClick(this._nextBeatTime)
      this._scheduleFlash(this._nextBeatTime)
      this._nextBeatTime += beatDur
    }

    this._schedulerTimer = setTimeout(() => this._schedule(), SCHEDULE_INTERVAL)
  }

  _stopScheduler() {
    clearTimeout(this._schedulerTimer)
    this._schedulerTimer = null
  }

  // ── Click synthesis ────────────────────────────────────────────────────────

  /**
   * Schedule a click at `time` (AudioContext absolute time).
   * Uses a triangle oscillator: cleaner attack than sine, less harsh than square.
   * Connects to _metroGain, which is independent of _songGain — no crosstalk.
   */
  _scheduleClick(time) {
    if (time < this._ctx.currentTime - 0.01) return   // skip missed beats

    const osc  = this._ctx.createOscillator()
    const gain = this._ctx.createGain()
    osc.connect(gain)
    gain.connect(this._metroGain)

    osc.type            = 'triangle'
    osc.frequency.value = 1200

    // Very fast attack (4 ms), sharp exponential decay (55 ms total)
    gain.gain.setValueAtTime(0,    time)
    gain.gain.linearRampToValueAtTime(1.0, time + 0.004)
    gain.gain.exponentialRampToValueAtTime(0.001, time + 0.058)

    osc.start(time)
    osc.stop(time + 0.065)
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

window.AudioEngine = AudioEngine
