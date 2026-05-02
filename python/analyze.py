#!/usr/bin/env python3
"""
analyze.py  v4
──────────────────────────────────────────────────────────────────────────────
Direct beat-grid BPM optimization + downbeat detection.

Pipeline:
  1. Beat timestamps + activations  →  madmom RNNBeatProcessor + DBN
  2. Direct BPM optimization        →  vectorized grid alignment sweep
  3. Downbeat detection             →  phase analysis via beat activation strength
  4. First onset                    →  madmom onset detector, fallback to beats[0]
  5. Silence pad                    →  ≥1.5 s lead-in, anchored to downbeat

KEY DESIGN:
  BPM is an optimization variable, not a measurement.
  We find the BPM that minimizes Σ|t_i − nearest_grid(t_i)| across all
  detected beats. No KDE, no histograms, no local BPM distributions.
  Beat timestamps from madmom are treated as ground truth.

DOWNBEAT:
  Among the beat grid positions, we detect which phase (mod 4) consistently
  falls on the strongest rhythmic accents by scoring each phase against the
  madmom beat activation function. The winning phase is the musical "1".
  Silence is anchored to the downbeat so the grid starts on beat 1.
"""

import sys
import json
import math
import types
import numpy as np

# ── pkg_resources shim ────────────────────────────────────────────────────────
# madmom.__init__ imports pkg_resources only to read its own version string.
# Inject a minimal mock if setuptools is absent in this environment.
try:
    import pkg_resources
except ImportError:
    _pr = types.ModuleType('pkg_resources')
    _pr.get_distribution     = lambda n: type('D', (), {'version': '0.0.0', 'requires': lambda: []})()
    _pr.DistributionNotFound = Exception
    _pr.VersionConflict      = Exception
    sys.modules['pkg_resources'] = _pr

MIN_LEAD_IN  = 1.5     # mandatory seconds before the downbeat
BPM_MIN      = 60.0
BPM_MAX      = 220.0
BPM_STEP     = 0.01    # 0.01 BPM resolution → <0.01 s drift over 100 beats
MADMOM_FPS   = 100     # frames-per-second of madmom's RNN output


# ── Silence padding ───────────────────────────────────────────────────────────

def calc_silence_pad(anchor_time, bpm):
    """
    Compute how much silence to prepend so that `anchor_time` (the downbeat)
    falls on a beat-grid position at ≥ MIN_LEAD_IN seconds from the start.

        silence_pad + anchor_time  =  N × beat_dur   (N integer ≥ 1)
        silence_pad               ≥  MIN_LEAD_IN

    Mirrors pipeline/phase2.js calcSilencePad() exactly.
    """
    beat_dur     = 60.0 / bpm
    n            = math.ceil((anchor_time + MIN_LEAD_IN) / beat_dur)
    total_offset = n * beat_dur
    silence_pad  = total_offset - anchor_time
    if silence_pad < MIN_LEAD_IN:
        n           += 1
        total_offset = n * beat_dur
        silence_pad  = total_offset - anchor_time
    return round(silence_pad, 6), round(total_offset, 6)


# ── Direct BPM optimization ───────────────────────────────────────────────────

def optimize_bpm(beat_times):
    """
    Find the BPM that minimizes cumulative grid alignment error.

    Algorithm
    ─────────
    For every candidate BPM c in [BPM_MIN, BPM_MAX] with step BPM_STEP:

        beat_dur  = 60 / c
        t0        = beat_times[0]           ← grid anchor

        For each detected beat t_i:
            n_i     = round( (t_i − t0) / beat_dur )
            err_i   = | t_i − (t0 + n_i × beat_dur) |

        total_error(c)  =  Σ err_i

    We return the c that minimises total_error.

    Implementation is fully vectorised:
        offsets    = (beats[None, :] − t0) / beat_durs[:, None]   shape (M, N)
        errors     = | offsets − round(offsets) | × beat_durs      shape (M, N)
        total_err  = errors.sum(axis=1)                             shape (M,)

    Memory peak: ~(16000 × 400 × 8) bytes ≈ 50 MB — acceptable.

    Why this is better than KDE / local BPM distributions:
      The grid error is a direct, global measure of how well the BPM fits.
      Statistical intermediaries (KDE, median) smooth noise at the cost of
      introducing their own bias. Grid error has no bias: every beat contributes
      equally and drift is punished naturally as the track progresses.

    Returns (bpm, alignment_error, beat_offset)
    """
    beats      = np.array(beat_times, dtype=np.float64)
    t0         = float(beats[0])

    candidates = np.arange(BPM_MIN, BPM_MAX + BPM_STEP / 2, BPM_STEP)
    beat_durs  = 60.0 / candidates                              # (M,)

    offsets    = (beats[None, :] - t0) / beat_durs[:, None]    # (M, N)
    n_nearest  = np.round(offsets)
    deviations = np.abs(offsets - n_nearest) * beat_durs[:, None]  # seconds
    total_errs = deviations.sum(axis=1)                         # (M,)

    best_idx   = int(np.argmin(total_errs))
    best_bpm   = float(candidates[best_idx])
    best_err   = float(total_errs[best_idx])

    return best_bpm, best_err, t0


# ── Downbeat detection ────────────────────────────────────────────────────────

def detect_downbeat(beat_times, beat_act, time_sig=4):
    """
    Find which phase within the beat cycle is the musical downbeat (beat 1).

    The madmom RNN beat activation function captures rhythmic strength: values
    are higher where beats land on strong metrical positions. Beat 1 of a bar
    in common time (4/4) consistently has higher activation than beats 2–4.

    We try all `time_sig` starting phases and pick the one whose beats score
    highest on average against the beat activation:

        phase k → beats at indices k, k+4, k+8, ...
        score(k) = mean( beat_act[ frame_of(beats[j]) ] for j in phase_k )

    The phase with the highest score is treated as beat 1.

    Why this works:
      The RNN was trained to distinguish downbeats from offbeats implicitly —
      downbeats tend to coincide with stronger spectral events (kick, chord
      changes) which produce higher activation. The phase that consistently
      aligns with these strong positions is the musical "1".

    Returns:
      downbeat_offset  — time (s) of the first downbeat in the original audio
      phase            — index within beat_times of that downbeat
    """
    if len(beat_times) < time_sig:
        return float(beat_times[0]) if len(beat_times) > 0 else 0.0, 0

    # Look up activation strength at each beat's frame
    strengths = np.array([
        float(beat_act[max(0, min(int(round(t * MADMOM_FPS)), len(beat_act) - 1))])
        for t in beat_times
    ])

    best_phase = 0
    best_score = -1.0

    for k in range(time_sig):
        indices = list(range(k, len(beat_times), time_sig))
        if not indices:
            continue
        score = float(np.mean(strengths[indices]))
        if score > best_score:
            best_score = score
            best_phase = k

    downbeat_offset = float(beat_times[best_phase])
    return downbeat_offset, best_phase


# ── First onset detection ─────────────────────────────────────────────────────

def detect_first_onset(audio_path, beat_times):
    """
    Detect the first strong transient using madmom's onset processor.
    Kept for informational purposes — silence is now anchored to downbeat_offset.
    """
    try:
        from madmom.features.onsets import RNNOnsetProcessor, OnsetPeakPickingProcessor
        onset_act = RNNOnsetProcessor()(audio_path)
        onsets    = OnsetPeakPickingProcessor(fps=100, threshold=0.3)(onset_act)
        for t in onsets:
            if float(t) > 0.05:
                return float(t)
    except Exception as e:
        print(f"[analyze] onset fallback: {e}", file=sys.stderr)
    return float(beat_times[0]) if len(beat_times) > 0 else 0.0


# ── Main ──────────────────────────────────────────────────────────────────────

def analyze(audio_path):
    from madmom.features.beats import RNNBeatProcessor, DBNBeatTrackingProcessor

    # ── Beat tracking ─────────────────────────────────────────────────────────
    print("[analyze] running madmom beat tracker…", file=sys.stderr)
    beat_act   = RNNBeatProcessor()(audio_path)            # RNN activation curve
    beats      = DBNBeatTrackingProcessor(fps=100)(beat_act)  # DBN beat timestamps
    beat_times = [float(t) for t in beats]

    if len(beat_times) < 4:
        raise ValueError(f"Too few beats detected: {len(beat_times)}")

    # ── Direct BPM optimization ───────────────────────────────────────────────
    print("[analyze] optimizing BPM over beat grid…", file=sys.stderr)
    bpm, alignment_error, beat_offset = optimize_bpm(beat_times)

    # ── Downbeat detection ────────────────────────────────────────────────────
    downbeat_offset, downbeat_phase = detect_downbeat(beat_times, beat_act)

    # ── First onset (informational) ───────────────────────────────────────────
    first_beat_time = detect_first_onset(audio_path, beat_times)

    # ── Silence: anchored to downbeat, not just first onset ───────────────────
    # This ensures the musical "1" falls on the beat grid after the silence.
    silence_pad, total_offset = calc_silence_pad(downbeat_offset, bpm)
    beat_dur = 60.0 / bpm

    # ── Debug ─────────────────────────────────────────────────────────────────
    print(f"[analyze] beats detected    : {len(beat_times)}", file=sys.stderr)
    print(f"[analyze] BPM (optimized)   : {bpm:.4f}  (Σerror={alignment_error:.6f}s)", file=sys.stderr)
    print(f"[analyze] beat_offset       : {beat_offset:.4f}s  (grid anchor = beats[0])", file=sys.stderr)
    print(f"[analyze] downbeat_offset   : {downbeat_offset:.4f}s  (phase {downbeat_phase} / 4)", file=sys.stderr)
    print(f"[analyze] first onset       : {first_beat_time:.4f}s", file=sys.stderr)
    print(f"[analyze] silence pad       : {silence_pad:.6f}s  (anchored to downbeat)", file=sys.stderr)
    print(f"[analyze] total offset      : {total_offset:.6f}s  (downbeat position in padded audio)", file=sys.stderr)

    return {
        'bpm':             round(bpm, 4),
        'beat_offset':     round(beat_offset, 6),
        'downbeat_offset': round(downbeat_offset, 6),
        'beat_duration':   round(beat_dur, 6),
        'alignment_error': round(alignment_error, 6),
        'first_beat_time': round(first_beat_time, 4),   # kept for compatibility
        'silence_pad':     round(silence_pad, 6),
        'final_offset':    round(total_offset, 6),
        'debug': {
            'beat_count':     len(beat_times),
            'downbeat_phase': downbeat_phase,
            'bpm_range':      f"{BPM_MIN}–{BPM_MAX}",
            'bpm_step':       BPM_STEP,
        }
    }


if __name__ == '__main__':
    if len(sys.argv) < 2:
        print(json.dumps({'error': 'No audio path provided'}), file=sys.stderr)
        sys.exit(1)
    try:
        result = analyze(sys.argv[1])
        print(json.dumps(result))
    except Exception as exc:
        import traceback
        traceback.print_exc(file=sys.stderr)
        print(json.dumps({'error': str(exc)}), file=sys.stderr)
        sys.exit(1)
