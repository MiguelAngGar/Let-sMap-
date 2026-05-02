#!/usr/bin/env python3
"""
analyze.py  v2
──────────────────────────────────────────────────────────────────────────────
BPM detection with grid-alignment refinement.

Pipeline:
  1. Initial BPM + beat timestamps  (librosa beat tracker)
  2. Local inter-beat BPM estimates  (60 / Δt for each consecutive pair)
  3. Median aggregation              (robust against missed / doubled beats)
  4. Grid alignment error            (evaluate N candidates against real beats)
  5. Smart integer rounding          (prefer clean integers when error is equal)
  6. Onset detection                 (first_beat_time in original audio)
  7. Silence calculation             (≥1.5s lead-in, beat-grid aligned)

Output: one JSON object on stdout.
Debug:  human-readable log on stderr.
"""

import sys
import json
import math
import numpy as np

MIN_LEAD_IN   = 1.5    # seconds of mandatory lead-in before first beat
MIN_BEAT_GAP  = 0.10   # ignore inter-beat intervals shorter than this (noise)
MAX_CANDIDATES = 16    # cap candidate list to keep evaluation fast


# ── Silence calculation ───────────────────────────────────────────────────────
# Mirrors pipeline/phase2.js  calcSilencePad() exactly.

def calc_silence_pad(first_beat_time, bpm):
    beat_dur     = 60.0 / bpm
    n            = math.ceil((first_beat_time + MIN_LEAD_IN) / beat_dur)
    total_offset = n * beat_dur
    silence_pad  = total_offset - first_beat_time
    if silence_pad < MIN_LEAD_IN:
        n           += 1
        total_offset = n * beat_dur
        silence_pad  = total_offset - first_beat_time
    return round(silence_pad, 6), round(total_offset, 6)


# ── Grid alignment error ──────────────────────────────────────────────────────

def grid_alignment_error(bpm, beat_times):
    """
    How well does `bpm` fit the sequence of detected beat timestamps?

    Algorithm
    ─────────
    Anchor the theoretical grid at beat_times[0]:
        grid(n) = t0 + n × (60 / bpm)

    For every detected beat t_i, project it onto the grid:
        n_i = round( (t_i − t0) / beat_dur )
        error_i = | t_i − grid(n_i) |

    Return the SUM of all errors (seconds).  Lower = better fit.

    Why this works: a correct BPM will have beat_times landing very close
    to grid positions throughout the whole track.  A wrong BPM accumulates
    error because each beat drifts further from the nearest grid line.
    """
    if bpm <= 0 or len(beat_times) < 2:
        return float('inf')

    beat_dur   = 60.0 / bpm
    t0         = beat_times[0]
    total_err  = 0.0

    for t in beat_times:
        n        = int(round((t - t0) / beat_dur))
        grid_t   = t0 + n * beat_dur
        total_err += abs(t - grid_t)

    return total_err


# ── BPM refinement ────────────────────────────────────────────────────────────

def refine_bpm(bpm_initial, beat_times):
    """
    Refine the initial librosa BPM estimate.

    Steps
    ──────
    1. Compute a local BPM for every consecutive beat pair:
           bpm_i = 60 / (t[i+1] − t[i])
       Filter extreme outliers (intervals that imply >2.5× or <0.4× the
       initial estimate) — these are artefacts of the beat tracker missing
       or doubling beats, not real tempo changes.

    2. Take the MEDIAN of the filtered local BPMs.
       Why median and not mean?
         • Mean is pulled towards outliers.  One badly tracked section can
           shift the mean by several BPM.
         • Median is the middle value: as long as >50% of beat intervals
           are tracked correctly the median converges to the true tempo,
           regardless of how wrong the outliers are.

    3. Build a candidate set from initial + median + their halves, doubles,
       and nearest integers.

    4. Evaluate each candidate with grid_alignment_error().  The candidate
       whose grid fits the actual beat timestamps most tightly wins.

    5. Smart rounding: if the winner is within ±0.5 of an integer BPM,
       prefer the integer unless it worsens the error by more than 5%.
       This handles the common "99.4 → 99" case without forcing bad rounding
       on genuinely fractional tempos.

    Returns (refined_bpm: float, debug: dict)
    """
    debug = {'bpm_initial': round(float(bpm_initial), 4)}

    # ── Step 1: local BPM estimates ──────────────────────────────────────────
    local_bpms = []
    for i in range(len(beat_times) - 1):
        dt = float(beat_times[i + 1]) - float(beat_times[i])
        if dt >= MIN_BEAT_GAP:
            local_bpms.append(60.0 / dt)

    # Filter: keep only values plausibly close to the initial estimate
    filtered = [b for b in local_bpms
                if bpm_initial * 0.4 <= b <= bpm_initial * 2.5]

    # ── Step 2: median BPM ───────────────────────────────────────────────────
    if len(filtered) >= 4:
        bpm_median = float(np.median(filtered))
    else:
        bpm_median = bpm_initial   # not enough data — fall back

    debug['bpm_median']         = round(bpm_median, 4)
    debug['beat_count']         = len(beat_times)
    debug['local_bpm_count']    = len(filtered)

    # ── Step 3: candidate set ────────────────────────────────────────────────
    raw = set()
    for base in (bpm_initial, bpm_median):
        raw.add(base)
        raw.add(float(round(base)))          # nearest integer
        half   = base / 2
        double = base * 2
        if 60 <= half   <= 320: raw.add(half);   raw.add(float(round(half)))
        if 60 <= double <= 320: raw.add(double); raw.add(float(round(double)))

    candidates = sorted({c for c in raw if 60.0 <= c <= 320.0})[:MAX_CANDIDATES]

    # ── Step 4: evaluate candidates ──────────────────────────────────────────
    scored = [(c, grid_alignment_error(c, beat_times)) for c in candidates]
    scored.sort(key=lambda x: x[1])

    best_bpm, best_err = scored[0]

    # ── Step 5: smart integer rounding ───────────────────────────────────────
    rounded = float(round(best_bpm))
    if abs(rounded - best_bpm) <= 0.5 and 60 <= rounded <= 320:
        err_rounded = grid_alignment_error(rounded, beat_times)
        # Accept rounding if it doesn't worsen the error by more than 5%
        if err_rounded <= best_err * 1.05:
            if rounded != best_bpm:
                debug['rounding_applied'] = f"{round(best_bpm, 4)} → {rounded}"
            best_bpm = rounded
            best_err = err_rounded

    debug['bpm_final']   = round(best_bpm, 4)
    debug['best_error']  = round(best_err, 6)
    debug['candidates']  = [
        {'bpm': round(c, 4), 'error': round(e, 6)}
        for c, e in scored[:8]     # top 8 for readability
    ]

    return best_bpm, debug


# ── First-beat onset detection ────────────────────────────────────────────────

def detect_first_beat(y, sr, beat_times):
    """
    Find the first strong transient after 50ms.
    Uses onset detection with backtracking to snap to the true attack.
    Falls back to the first librosa beat if no onset is found.
    """
    import librosa

    onset_env   = librosa.onset.onset_strength(y=y, sr=sr)
    onset_times = librosa.onset.onset_detect(
        onset_envelope=onset_env,
        sr=sr,
        units='time',
        backtrack=True,
        pre_max=3, post_max=3,
        pre_avg=3, post_avg=5,
        delta=0.15,
        wait=10
    )

    for t in onset_times:
        if float(t) > 0.05:
            return float(t)

    if len(beat_times) > 0:
        return float(beat_times[0])

    return 0.0


# ── Main entry point ──────────────────────────────────────────────────────────

def analyze(audio_path):
    import librosa

    # Load as mono at native sample rate
    y, sr = librosa.load(audio_path, sr=None, mono=True)

    # Initial beat tracking
    tempo, beat_frames = librosa.beat.beat_track(y=y, sr=sr, units='time')
    bpm_initial = float(np.atleast_1d(tempo)[0])

    # Sanity check: retry with fixed start_bpm if result is implausible
    if not (40 <= bpm_initial <= 400):
        tempo, beat_frames = librosa.beat.beat_track(
            y=y, sr=sr, units='time', start_bpm=120, tightness=100
        )
        bpm_initial = float(np.atleast_1d(tempo)[0])

    beat_times = [float(t) for t in beat_frames]

    # Refine BPM
    refined_bpm, debug = refine_bpm(bpm_initial, beat_times)

    # First beat time in original audio
    first_beat_time = detect_first_beat(y, sr, beat_times)

    # Silence needed using refined BPM
    silence_pad, total_offset = calc_silence_pad(first_beat_time, refined_bpm)
    beat_dur = 60.0 / refined_bpm

    # ── Debug log to stderr ───────────────────────────────────────────────────
    print(f"[analyze] initial BPM  : {debug['bpm_initial']}", file=sys.stderr)
    print(f"[analyze] median BPM   : {debug['bpm_median']}  "
          f"(from {debug['local_bpm_count']} intervals, {debug['beat_count']} beats)",
          file=sys.stderr)
    if 'rounding_applied' in debug:
        print(f"[analyze] rounding     : {debug['rounding_applied']}", file=sys.stderr)
    print(f"[analyze] final BPM    : {debug['bpm_final']}  "
          f"(error={debug['best_error']:.4f}s)",
          file=sys.stderr)
    print(f"[analyze] first beat   : {first_beat_time:.4f}s", file=sys.stderr)
    print(f"[analyze] silence pad  : {silence_pad:.4f}s", file=sys.stderr)
    print("[analyze] top candidates:", file=sys.stderr)
    for c in debug['candidates'][:5]:
        marker = " ← selected" if abs(c['bpm'] - debug['bpm_final']) < 0.001 else ""
        print(f"           {c['bpm']:>9.4f} BPM  error={c['error']:.4f}s{marker}",
              file=sys.stderr)

    return {
        'bpm':             round(refined_bpm, 4),
        'first_beat_time': round(first_beat_time, 4),
        'silence_pad':     round(silence_pad, 6),
        'final_offset':    round(total_offset, 6),
        'beat_duration':   round(beat_dur, 6),
        'debug':           debug
    }


if __name__ == '__main__':
    if len(sys.argv) < 2:
        print(json.dumps({'error': 'No audio path provided'}), file=sys.stderr)
        sys.exit(1)
    try:
        result = analyze(sys.argv[1])
        print(json.dumps(result))
    except Exception as exc:
        print(json.dumps({'error': str(exc)}), file=sys.stderr)
        sys.exit(1)
