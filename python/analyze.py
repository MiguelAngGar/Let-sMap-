#!/usr/bin/env python3
"""
analyze.py  v7
──────────────────────────────────────────────────────────────────────────────
Robust BPM + offset detection for any tempo (40 – 300 BPM).

Pipeline:
  1. Decode audio via ffmpeg → madmom Signal
  2. RNNBeatProcessor → beat activation function (cached, expensive step)
  3. TempoEstimationProcessor on activations → octave-correct anchor BPM
       (autocorrelation: stable octave, FPS-quantised in absolute value)
  4. DBNBeatTrackingProcessor with range CONSTRAINED around anchor
       (prevents half/double-time lock-in)
  5. Grid-snap linear regression on beat timestamps → precise period
       (handles dropped / inserted beats by re-indexing each beat to the
        nearest integer multiple of the current period estimate, then
        refitting; iterated 3× for stability)
  6. Octave correction: pick best multiplier of slope_bpm vs anchor_bpm
       so the precise BPM lands in the right octave.
  7. Confidence = function of r-value AND median residual / period.
  8. Downbeat phase via beat-activation strength on every k-th beat.
  9. First-onset detection (RNNOnsetProcessor) for lead-in calculation.
 10. Silence pad → ceil((onset + 1.5 s) / period) * period.

v7 PRECISION UPGRADES (ArrowVortex-class):
  A. Sub-frame beat refinement — DBN beats are quantised to the 10 ms
     activation frame grid (fps=100).  Each beat is re-localised to the
     parabolic-interpolated peak of the activation function → sub-frame
     (~1 ms) timing before regression.
  B. Weak-beat exclusion — DBN interpolates beats through quiet sections;
     those carry no timing information and only add regression noise.
     Beats with activation < 20 % of max are excluded from the fit
     (but kept in the returned beat list).
  C. Integer/half-integer BPM snap — produced music is almost always an
     exact integer (or x.5) BPM.  If the fitted BPM is within 0.4 % of
     one, re-fit the offset with the period FIXED at the snapped value
     and accept ONLY if the residual stays low across the whole song
     (start/end drift check).  A wrong snap drifts and is rejected.
  D. Grid-projected anchor — downbeat/offset times are projected onto the
     fitted grid (intercept + k·period) instead of using a raw quantised
     beat timestamp → silence pad accurate to ~1 ms, not ±5 ms.

WHY NOT plain median(diff(beats)) or naive linregress?
  - median(diff): inherits jitter from individual beat localisation.
  - naive linregress(idx, time): catastrophically fails when the DBN drops
    or inserts a single beat (subsequent indices shift by 1).
  Grid-snapping fixes both — every beat is re-mapped to its true index
  before fitting, error is averaged across the whole song.

WHY two-stage (anchor → constrained DBN)?
  - Wide DBN ranges (40–300) admit too many tempo states; the HMM can flip
    between octaves mid-song.
  - Autocorrelation gets the right octave reliably; using it to constrain
    the DBN keeps the beat tracker locked.
"""

import sys
import os
import json
import math
import types
import subprocess
import numpy as np
from scipy import stats

# ── pkg_resources shim (PyInstaller / no-setuptools envs) ─────────────────────
try:
    import pkg_resources  # noqa: F401
except ImportError:
    _pr = types.ModuleType('pkg_resources')
    _pr.get_distribution     = lambda n: type('D', (), {'version': '0.0.0', 'requires': lambda: []})()
    _pr.DistributionNotFound = Exception
    _pr.VersionConflict      = Exception
    sys.modules['pkg_resources'] = _pr

MIN_LEAD_IN  = 1.5
BPM_MIN      = 40.0
BPM_MAX      = 300.0
MADMOM_FPS   = 100
SAMPLE_RATE  = 44100

# Octave multipliers searched when correcting half/double-time.
OCTAVE_MULTIPLIERS = [0.25, 1/3, 0.5, 2/3, 1.0, 4/3, 1.5, 2.0, 3.0, 4.0]


# ── Audio loading ─────────────────────────────────────────────────────────────

def load_signal(audio_path):
    """ffmpeg → float32 mono PCM → madmom Signal. Avoids soundfile OGG issue."""
    from madmom.audio.signal import Signal
    ffmpeg = os.environ.get('FFMPEG_PATH', 'ffmpeg')
    cmd = [ffmpeg, '-v', 'error', '-i', audio_path,
           '-f', 'f32le', '-ar', str(SAMPLE_RATE), '-ac', '1', 'pipe:1']
    result = subprocess.run(cmd, stdout=subprocess.PIPE, stderr=subprocess.PIPE)
    if result.returncode != 0:
        raise RuntimeError(
            f"ffmpeg decode failed: {result.stderr.decode(errors='replace').strip()}"
        )
    data = np.frombuffer(result.stdout, dtype=np.float32).copy()
    if data.size == 0:
        raise RuntimeError("ffmpeg produced no audio data")
    return Signal(data, sample_rate=SAMPLE_RATE, num_channels=1, dtype=np.float32)


# ── Silence padding ───────────────────────────────────────────────────────────

def calc_silence_pad(anchor_time, bpm):
    """Smallest pad that aligns anchor to a beat boundary AND gives ≥1.5 s lead-in."""
    beat_dur     = 60.0 / bpm
    n            = math.ceil((anchor_time + MIN_LEAD_IN) / beat_dur)
    total_offset = n * beat_dur
    silence_pad  = total_offset - anchor_time
    if silence_pad < MIN_LEAD_IN:
        n           += 1
        total_offset = n * beat_dur
        silence_pad  = total_offset - anchor_time
    return round(silence_pad, 6), round(total_offset, 6)


# ── Tempo anchor (autocorrelation) ────────────────────────────────────────────

def estimate_tempo_anchor(beat_act):
    """
    Top-strength tempo from TempoEstimationProcessor.

    Autocorrelation gives an octave-correct estimate but is FPS-discretised
    (resolution ≈ 60 / N at FPS=100, i.e. ~1 BPM near 120 BPM).
    We use it ONLY to:
      • constrain the DBN tempo range,
      • disambiguate the octave of the precise slope BPM at the end.

    Returns (anchor_bpm, all_candidates_list).
    """
    from madmom.features.tempo import TempoEstimationProcessor
    proc   = TempoEstimationProcessor(fps=MADMOM_FPS, min_bpm=BPM_MIN, max_bpm=BPM_MAX)
    tempos = proc(beat_act)
    if tempos is None or len(tempos) == 0:
        return None, []
    candidates = [(float(b), float(s)) for b, s in tempos]
    return candidates[0][0], candidates


# ── Grid-snapped linear regression ────────────────────────────────────────────

def precise_bpm(beat_times):
    """
    Robust BPM from beat timestamps via iterative grid snapping + linregress.

    Stage 0 : initial period = median of inter-beat intervals after trimming
              outliers (intervals > 1.3× / < 0.7× the raw median are likely
              caused by dropped or inserted beats).  This gives an estimate
              that is robust even when several beats are missing — far better
              than sequential-index linregress which compounds the error.
    Stage k : snap each beat to its nearest integer index given the current
              period estimate, refit a line through (snapped_index, time).
              After 2-3 iterations the snapped indices stabilise on the
              true beat grid even with dropped or inserted beats.

    Returns dict with bpm, r_value, period, intercept, residual_norm.
    """
    beats = np.asarray(beat_times, dtype=np.float64)
    n     = len(beats)
    if n < 4:
        raise ValueError(f"Too few beats for regression: {n}")

    # Stage 0 — robust initial period from MEAN of trimmed IBIs.
    # NOT median: when DBN beats are FPS-quantised (10 ms grid at fps=100),
    # the median of the diffs snaps to the nearest 10 ms quantum and
    # systematically biases the period toward the higher quantum
    # (e.g. true period 0.6061 s → median diff 0.61 s, mean 0.6060).
    # Trimming removes diffs that span gaps from dropped beats.
    diffs = np.diff(beats)
    med   = float(np.median(diffs))
    if med <= 0:
        seq = np.arange(n, dtype=np.float64)
        res = stats.linregress(seq, beats)
        period    = float(res.slope)
        intercept = float(res.intercept)
    else:
        mask = (diffs > med * 0.7) & (diffs < med * 1.3)
        good = diffs[mask] if np.any(mask) else diffs
        period    = float(np.mean(good))   # ← mean, not median
        intercept = float(beats[0])

    r_value = 0.0

    # Stages 1..4 — grid snap and refit
    for _ in range(4):
        if period <= 0:
            break
        idx = np.round((beats - intercept) / period).astype(np.int64)
        # If two beats snap to the same index, keep the first occurrence.
        _, unique_pos = np.unique(idx, return_index=True)
        unique_pos.sort()
        idx_u   = idx[unique_pos].astype(np.float64)
        beats_u = beats[unique_pos]
        if len(idx_u) < 4:
            break
        res2 = stats.linregress(idx_u, beats_u)
        new_period    = float(res2.slope)
        new_intercept = float(res2.intercept)
        r_value       = float(abs(res2.rvalue))
        # Convergence check
        if abs(new_period - period) < 1e-9:
            period, intercept = new_period, new_intercept
            break
        period, intercept = new_period, new_intercept

    # Residual quality (median |beat − predicted| normalised by period)
    final_idx    = np.round((beats - intercept) / period)
    pred         = intercept + final_idx * period
    median_resid = float(np.median(np.abs(beats - pred)))
    residual_norm = median_resid / period if period > 0 else 1.0

    bpm = 60.0 / period if period > 0 else 0.0
    return {
        'bpm':           bpm,
        'r_value':       r_value,
        'period':        period,
        'intercept':     intercept,
        'residual_norm': residual_norm,
    }


# ── Sub-frame beat refinement (v7-A) ─────────────────────────────────────────

def refine_beat_times(beats, beat_act, window_s=0.04):
    """
    Re-localise each DBN beat to the parabolic-interpolated peak of the
    beat activation function within ±window_s.  DBN output is quantised
    to the frame grid (10 ms at fps=100); the activation peak's true
    position between frames is recovered with 3-point parabolic
    interpolation → ~1 ms precision.

    Returns (refined_times ndarray, strengths ndarray).
    """
    act = np.asarray(beat_act, dtype=np.float64)
    n   = len(act)
    w   = max(1, int(round(window_s * MADMOM_FPS)))
    refined, strengths = [], []
    for t in beats:
        c  = int(round(t * MADMOM_FPS))
        lo = max(1, c - w)
        hi = min(n - 2, c + w)
        if hi <= lo:
            refined.append(float(t))
            strengths.append(0.0)
            continue
        seg = act[lo:hi + 1]
        j   = lo + int(np.argmax(seg))
        y0, y1, y2 = act[j - 1], act[j], act[j + 1]
        denom = y0 - 2.0 * y1 + y2
        delta = 0.0
        if denom < -1e-12:                      # true local max
            delta = float(np.clip(0.5 * (y0 - y2) / denom, -0.5, 0.5))
        refined.append((j + delta) / MADMOM_FPS)
        strengths.append(float(y1))
    return np.asarray(refined, dtype=np.float64), np.asarray(strengths, dtype=np.float64)


def fit_beats(beats, beat_act):
    """
    Refine beats to sub-frame precision, exclude weak (interpolated)
    beats from the regression (v7-B), and fit.

    Returns (fit dict from precise_bpm, refined_all ndarray) or (None, refined_all).
    """
    if len(beats) < 4:
        return None, np.asarray(beats, dtype=np.float64)
    refined, strengths = refine_beat_times(beats, beat_act)
    smax = float(strengths.max()) if len(strengths) else 0.0
    if smax > 0:
        strong = refined[strengths >= 0.2 * smax]
    else:
        strong = refined
    # Need enough strong beats to be meaningful; else fit everything.
    if len(strong) < max(8, int(0.3 * len(refined))):
        strong = refined
    if len(strong) < 4:
        return None, refined
    return precise_bpm(strong), refined


# ── Fixed-period fit + BPM snapping (v7-C) ───────────────────────────────────

def fit_fixed_period(beats, period):
    """
    Best offset for a FIXED period (median of grid residuals, iterated).
    Returns (offset, residual_norm, residuals ndarray).
    """
    beats = np.asarray(beats, dtype=np.float64)
    idx = np.round((beats - beats[0]) / period)
    off = float(np.median(beats - idx * period))
    for _ in range(2):
        idx = np.round((beats - off) / period)
        off = float(np.median(beats - idx * period))
    pred  = off + idx * period
    resid = np.abs(beats - pred)
    return off, float(np.median(resid)) / period, resid


def snap_bpm(final_bpm, mult, beats, base_resid_norm):
    """
    Try snapping final_bpm to the nearest integer or half-integer.

    The beat grid lives in the SLOPE domain (final_bpm = slope_bpm × mult),
    so a candidate final BPM is verified with slope period 60·mult/cand.

    Acceptance requires BOTH:
      • overall residual no worse than the free fit (+ small margin), and
      • low residual in the first AND last third of the song — a wrong
        snap accumulates drift and blows up the end-of-song residual.

    Returns (snapped_bpm, offset, resid_norm) or None.
    """
    if final_bpm <= 0 or len(beats) < 8:
        return None
    cands = {float(round(final_bpm)), round(final_bpm * 2.0) / 2.0}
    best = None
    for cand in sorted(cands):
        if not (BPM_MIN <= cand <= BPM_MAX):
            continue
        if abs(cand - final_bpm) / final_bpm > 0.004:
            continue
        slope_period = 60.0 * mult / cand
        off, resid_norm, resid = fit_fixed_period(beats, slope_period)
        third = len(beats) // 3
        drift_ok = True
        if third >= 4:
            r_start = float(np.median(resid[:third]))  / slope_period
            r_end   = float(np.median(resid[-third:])) / slope_period
            drift_ok = (r_start < 0.06 and r_end < 0.06)
        if resid_norm <= base_resid_norm * 1.25 + 0.01 and drift_ok:
            if best is None or resid_norm < best[2]:
                best = (cand, off, resid_norm)
    return best


def project_to_grid(t, intercept, period):
    """Nearest grid point to t on grid intercept + k·period (k ≥ 0)."""
    if period <= 0:
        return float(t)
    k = round((t - intercept) / period)
    g = intercept + k * period
    while g < 0:
        g += period
    return float(g)


# ── Octave correction ─────────────────────────────────────────────────────────

def correct_octave(slope_bpm, anchor_bpm):
    """
    Find multiplier m ∈ OCTAVE_MULTIPLIERS such that slope_bpm * m best
    matches the autocorrelation anchor.  Keeps slope_bpm precision while
    fixing half/double/triple-time DBN errors.
    """
    if anchor_bpm is None or anchor_bpm <= 0 or slope_bpm <= 0:
        return slope_bpm, 1.0

    def err(m):
        return abs(slope_bpm * m - anchor_bpm) / anchor_bpm

    best_m = min(OCTAVE_MULTIPLIERS, key=err)
    out    = slope_bpm * best_m
    out    = max(BPM_MIN, min(BPM_MAX, out))
    return out, best_m


# ── Confidence scoring ────────────────────────────────────────────────────────

def score_confidence(r_value, residual_norm, coverage=1.0):
    """
    Confidence in the BPM result.  Coverage < 0.7 means the chosen DBN
    track misses many activation peaks — likely octave/phase issue or
    irregular tempo — force at most 'medium' regardless of fit metrics.
    """
    if coverage < 0.5:
        return 'low'
    if r_value > 0.99999 and residual_norm < 0.02 and coverage > 0.85:
        return 'high'
    if r_value > 0.9999  and residual_norm < 0.05 and coverage > 0.70:
        return 'medium'
    return 'low'


# ── Downbeat detection ────────────────────────────────────────────────────────

def detect_downbeat(beat_times, beat_act, time_sig=4):
    """
    Pick the phase k ∈ [0, time_sig) that maximises mean beat-activation
    strength among beats[k::time_sig].  Returns (downbeat_time, phase).
    """
    if len(beat_times) < time_sig:
        return float(beat_times[0]) if len(beat_times) > 0 else 0.0, 0

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

    return float(beat_times[best_phase]), best_phase


# ── First-onset detection ─────────────────────────────────────────────────────

def detect_first_onset(sig, beat_times):
    try:
        from madmom.features.onsets import RNNOnsetProcessor, OnsetPeakPickingProcessor
        onset_act = RNNOnsetProcessor()(sig)
        onsets    = OnsetPeakPickingProcessor(fps=MADMOM_FPS, threshold=0.3)(onset_act)
        for t in onsets:
            if float(t) > 0.05:
                return float(t)
    except Exception as e:
        print(f"[analyze] onset fallback: {e}", file=sys.stderr)
    return float(beat_times[0]) if len(beat_times) > 0 else 0.0


# ── DBN with constrained range + fallback ─────────────────────────────────────

def run_dbn(beat_act, dbn_min, dbn_max):
    from madmom.features.beats import DBNBeatTrackingProcessor
    proc  = DBNBeatTrackingProcessor(min_bpm=dbn_min, max_bpm=dbn_max, fps=MADMOM_FPS)
    beats = proc(beat_act)
    return [float(t) for t in beats]


def constrained_beats(beat_act, anchor_bpm):
    """
    Run the DBN with a tight tempo range around the anchor.  If that fails
    (too few beats), fall back to a wider range.
    """
    if anchor_bpm and anchor_bpm > 0:
        # ±30 % around anchor — wide enough to absorb autocorr discretisation
        # error but tight enough to stop octave switching.
        dbn_min = max(BPM_MIN, anchor_bpm * 0.70)
        dbn_max = min(BPM_MAX, anchor_bpm * 1.30)
        beats   = run_dbn(beat_act, dbn_min, dbn_max)
        if len(beats) >= 4:
            return beats, dbn_min, dbn_max

    # Fallback — wide DBN
    beats = run_dbn(beat_act, BPM_MIN, BPM_MAX)
    return beats, BPM_MIN, BPM_MAX


def select_anchor_candidates(tempo_candidates, max_anchors=4):
    """
    Filter the autocorrelation candidates down to a tractable list of
    plausible DBN anchors.

    Strategy (in priority order):
      1. The top peak is always included.
      2. Any candidate that sits at an octave multiple of the top
         (×0.5, ×2, ×3, ÷3) is added, even if its strength is low.
         Fast songs frequently put their true tempo at rank ≥ 3
         because subharmonics autocorrelate just as strongly as the
         beat itself (e.g. Kobaryo @ 244 BPM lands top at 122).
      3. Any other candidate whose strength ≥ 50 % of the top is added.
      4. Capped at `max_anchors`.

    Each chosen anchor will trigger a DBN run; we pick the run with
    the lowest grid-snap residual, which is what tells us which
    octave was right.
    """
    if not tempo_candidates:
        return []
    top_bpm, top_strength = tempo_candidates[0]
    threshold = top_strength * 0.5

    def near(a, b):
        return abs(a - b) / b < 0.05

    chosen = [top_bpm]

    # Priority: octave-related candidates (capture half/double/triple-time)
    octave_targets = [top_bpm * 2, top_bpm * 0.5, top_bpm * 3, top_bpm / 3.0]
    for bpm, _strength in tempo_candidates[1:]:
        for target in octave_targets:
            if BPM_MIN <= target <= BPM_MAX and near(bpm, target):
                if not any(near(bpm, c) for c in chosen):
                    chosen.append(bpm)
                break
        if len(chosen) >= max_anchors:
            return chosen[:max_anchors]

    # Then: any other strong candidate (covers half/double twin peaks not picked above)
    for bpm, strength in tempo_candidates:
        if strength < threshold:
            continue
        if any(near(bpm, c) for c in chosen):
            continue
        chosen.append(bpm)
        if len(chosen) >= max_anchors:
            break

    return chosen[:max_anchors]


def beat_activation_coverage(beats, beat_act, tol_s=0.05):
    """
    Fraction of strong beat-activation peaks that have a DBN beat within
    ±tol_s seconds.  This is THE octave discriminator: a half-time lock
    leaves every other activation peak unmatched, so coverage drops to
    ~0.5 even though the DBN beats themselves are perfectly periodic
    (and therefore have a near-zero linregress residual).

    Peaks are picked by simple local-max + threshold above 0.4 of the
    activation max, with a refractory window proportional to the median
    beat interval.
    """
    if len(beat_act) == 0 or len(beats) < 2:
        return 0.0
    act = np.asarray(beat_act, dtype=np.float64)
    threshold = 0.4 * float(act.max())
    if threshold <= 0:
        return 0.0
    median_beat_interval = float(np.median(np.diff(beats)))
    refractory = max(1, int(round(median_beat_interval * MADMOM_FPS * 0.4)))

    # Local-max + threshold + refractory
    peaks = []
    last_peak = -refractory
    for i in range(1, len(act) - 1):
        if act[i] >= threshold and act[i] >= act[i-1] and act[i] >= act[i+1]:
            if i - last_peak >= refractory:
                peaks.append(i)
                last_peak = i
    if not peaks:
        return 0.0

    peaks_t  = np.asarray(peaks, dtype=np.float64) / MADMOM_FPS
    beats_arr = np.asarray(beats, dtype=np.float64)
    # Vectorised: for each peak, find min |distance to a DBN beat|
    matched = 0
    for p in peaks_t:
        if np.min(np.abs(beats_arr - p)) <= tol_s:
            matched += 1
    return matched / len(peaks_t)


def best_dbn_fit(beat_act, candidates):
    """
    Two-stage DBN selection:

      A. TRUST AUTOCORR TOP.  Run DBN around the top autocorrelation
         candidate.  If the resulting fit has high coverage AND
         reasonable residual, return immediately — autocorr top is the
         "perceived" tempo (the foot-tap rate the listener hears) and
         should not be overruled when it explains the activations well.

         This is what stops the algorithm from pushing reggaeton at 99
         BPM up to 198 BPM (eighth-note subdivisions match more peaks
         mathematically, but 99 is the musical tempo).

      B. MULTI-ANCHOR FALLBACK.  Only when (A) fails — top coverage
         too low (half-time lock) or residual too high (DBN couldn't
         settle) — try the other candidates and pick the lowest score:

             score = residual_norm + (1 − coverage) · 0.5

         This catches the genuinely-wrong-octave cases like Kobaryo
         at 244 BPM, where autocorr top is 122 (half-time) with
         coverage near 0.5.

    Returns (beats, dbn_min, dbn_max, fit, chosen_anchor).
    """
    TRUST_TOP_COVERAGE = 0.85
    TRUST_TOP_RESID    = 0.15
    COVERAGE_WEIGHT    = 0.5

    if not candidates:
        beats, dbn_min, dbn_max = constrained_beats(beat_act, None)
        fit, beats = fit_beats(beats, beat_act)
        return beats, dbn_min, dbn_max, fit, None

    # ── Stage A: trust autocorr top if it fits well ─────────────────────────
    top = candidates[0]
    try:
        beats_top, min_top, max_top = constrained_beats(beat_act, top)
    except Exception as e:
        beats_top, min_top, max_top = [], BPM_MIN, BPM_MAX
        print(f"[analyze]   anchor {top:6.2f}: DBN failed ({e})", file=sys.stderr)

    fit_top, beats_top = fit_beats(beats_top, beat_act)
    cov_top = beat_activation_coverage(beats_top, beat_act) if fit_top else 0.0
    score_top = (fit_top['residual_norm'] + (1.0 - cov_top) * COVERAGE_WEIGHT) if fit_top else float('inf')

    if fit_top:
        print(f"[analyze]   anchor {top:6.2f}: DBN [{min_top:5.1f}–{max_top:5.1f}] → "
              f"{len(beats_top):3d} beats, slope={fit_top['bpm']:7.3f}, "
              f"resid={fit_top['residual_norm']:.4f}, cov={cov_top:.3f}, "
              f"score={score_top:.4f}  [TOP]", file=sys.stderr)

    if (fit_top and cov_top >= TRUST_TOP_COVERAGE
        and fit_top['residual_norm'] <= TRUST_TOP_RESID):
        print(f"[analyze]   trusting autocorr top (cov ≥ {TRUST_TOP_COVERAGE}, "
              f"resid ≤ {TRUST_TOP_RESID})", file=sys.stderr)
        return beats_top, min_top, max_top, fit_top, top

    # ── Stage B: multi-anchor fallback ──────────────────────────────────────
    print(f"[analyze]   top fit not strong enough → trying alternative anchors",
          file=sys.stderr)
    best       = (beats_top, min_top, max_top, fit_top, top) if fit_top else None
    best_score = score_top if fit_top else float('inf')

    for anchor in candidates[1:]:
        try:
            beats, dbn_min, dbn_max = constrained_beats(beat_act, anchor)
        except Exception as e:
            print(f"[analyze]   anchor {anchor:6.2f}: DBN failed ({e})", file=sys.stderr)
            continue
        if len(beats) < 4:
            print(f"[analyze]   anchor {anchor:6.2f}: only {len(beats)} beats — skip",
                  file=sys.stderr)
            continue
        fit, beats = fit_beats(beats, beat_act)
        if fit is None:
            continue
        coverage = beat_activation_coverage(beats, beat_act)
        score    = fit['residual_norm'] + (1.0 - coverage) * COVERAGE_WEIGHT
        print(f"[analyze]   anchor {anchor:6.2f}: DBN [{dbn_min:5.1f}–{dbn_max:5.1f}] → "
              f"{len(beats):3d} beats, slope={fit['bpm']:7.3f}, "
              f"resid={fit['residual_norm']:.4f}, cov={coverage:.3f}, "
              f"score={score:.4f}", file=sys.stderr)
        if score < best_score - 1e-4 or (
            abs(score - best_score) <= 1e-4
            and best is not None and fit['bpm'] > best[3]['bpm']
        ):
            best_score = score
            best = (beats, dbn_min, dbn_max, fit, anchor)

    if best is None:
        beats, dbn_min, dbn_max = constrained_beats(beat_act, None)
        fit, beats = fit_beats(beats, beat_act)
        return beats, dbn_min, dbn_max, fit, None
    return best


# ── Main ──────────────────────────────────────────────────────────────────────

def analyze(audio_path):
    from madmom.features.beats import RNNBeatProcessor

    # 1. Audio
    print("[analyze] loading audio…", file=sys.stderr)
    sig = load_signal(audio_path)

    # 2. Beat activation (cached and reused for tempo + DBN + downbeat)
    print("[analyze] running RNN beat activation…", file=sys.stderr)
    beat_act = RNNBeatProcessor()(sig)

    # 3. Tempo anchor (octave-correct, autocorr-based)
    print("[analyze] estimating tempo anchor…", file=sys.stderr)
    anchor_bpm, tempo_candidates = estimate_tempo_anchor(beat_act)
    print(f"[analyze] anchor bpm        : {anchor_bpm}", file=sys.stderr)
    print(f"[analyze] tempo candidates  : {[(round(b,2), round(s,3)) for b,s in tempo_candidates[:6]]}",
          file=sys.stderr)

    # 4. Multi-anchor DBN: try top candidates, pick the one with lowest residual.
    print("[analyze] running DBN beat tracker (multi-anchor search)…", file=sys.stderr)
    anchor_list = select_anchor_candidates(tempo_candidates, max_anchors=3)
    if not anchor_list and anchor_bpm:
        anchor_list = [anchor_bpm]
    print(f"[analyze] anchors to try    : {[round(a,2) for a in anchor_list]}", file=sys.stderr)

    beat_times, dbn_min, dbn_max, fit, chosen_anchor = best_dbn_fit(beat_act, anchor_list)
    print(f"[analyze] chosen anchor     : {chosen_anchor}", file=sys.stderr)
    print(f"[analyze] DBN range used    : {dbn_min:.1f} – {dbn_max:.1f} BPM", file=sys.stderr)
    print(f"[analyze] beats detected    : {len(beat_times)}", file=sys.stderr)

    if len(beat_times) < 4 or fit is None:
        raise ValueError(f"Too few beats detected: {len(beat_times)}")

    # 5. Precise BPM via grid-snapped linear regression (already in fit)
    slope_bpm = fit['bpm']
    r_value   = fit['r_value']
    resid     = fit['residual_norm']
    print(f"[analyze] slope BPM (raw)   : {slope_bpm:.4f}  r={r_value:.6f}  resid_norm={resid:.4f}",
          file=sys.stderr)

    # 6. Octave correction against the CHOSEN anchor (the one that won the
    # multi-anchor search, not the autocorr top — they may differ).
    octave_anchor = chosen_anchor if chosen_anchor else anchor_bpm
    final_bpm, mult = correct_octave(slope_bpm, octave_anchor)
    if abs(mult - 1.0) > 1e-6:
        print(f"[analyze] octave correction : slope×{mult} → {final_bpm:.4f} (anchor {octave_anchor:.2f})",
              file=sys.stderr)

    # 6b. Integer / half-integer BPM snap with drift verification (v7-C)
    snap_applied = False
    snapped = snap_bpm(final_bpm, mult, beat_times, fit['residual_norm'])
    if snapped:
        snap_val, _snap_off, snap_resid = snapped
        print(f"[analyze] BPM snap          : {final_bpm:.4f} → {snap_val:g} "
              f"(snap resid {snap_resid:.4f})", file=sys.stderr)
        final_bpm    = snap_val
        snap_applied = True

    # 6c. Final grid in the slope (beat-track) domain — used to project all
    # offsets onto the tempo grid with sub-frame precision (v7-D).
    slope_period_final = 60.0 * mult / final_bpm
    grid_intercept, grid_resid, _ = fit_fixed_period(beat_times, slope_period_final)
    print(f"[analyze] final grid        : intercept={grid_intercept:.4f}s "
          f"period={slope_period_final:.6f}s resid={grid_resid:.4f}", file=sys.stderr)

    # 7. Coverage of the WINNING DBN track + confidence
    # Judge confidence on the FINAL grid residual, not the free-fit one:
    # syncopated genres jitter individual beat localisation (high free resid)
    # while the snapped grid still fits the whole song near-perfectly.
    coverage        = beat_activation_coverage(beat_times, beat_act)
    effective_resid = grid_resid if snap_applied else resid
    confidence      = score_confidence(r_value, effective_resid, coverage)
    print(f"[analyze] coverage          : {coverage:.3f}", file=sys.stderr)

    # Alt candidates for UI (half / double / triple suggestions, dedup)
    alt_set = set()
    alt = []
    for m in [0.5, 2.0, 1/3, 3.0, 2/3, 4/3]:
        cand = round(final_bpm * m, 2)
        if BPM_MIN <= cand <= BPM_MAX and cand != round(final_bpm, 2) and cand not in alt_set:
            alt_set.add(cand)
            alt.append(cand)
        if len(alt) >= 3:
            break

    # 8. Downbeat — detect phase, then project onto the fitted grid (v7-D)
    downbeat_raw, downbeat_phase = detect_downbeat(beat_times, beat_act)
    downbeat_offset = project_to_grid(downbeat_raw, grid_intercept, slope_period_final)
    if abs(downbeat_offset - downbeat_raw) > 1e-4:
        print(f"[analyze] downbeat projected: {downbeat_raw:.4f} → {downbeat_offset:.6f}",
              file=sys.stderr)

    # 9. First onset (informational only)
    first_beat_time = detect_first_onset(sig, beat_times)

    # 10. Silence pad
    silence_pad, total_offset = calc_silence_pad(downbeat_offset, final_bpm)
    beat_dur = 60.0 / final_bpm

    # Debug
    print(f"[analyze] BPM (final)       : {final_bpm:.4f}  confidence={confidence}",
          file=sys.stderr)
    print(f"[analyze] downbeat_offset   : {downbeat_offset:.4f}s  (phase {downbeat_phase}/4)",
          file=sys.stderr)
    print(f"[analyze] silence pad       : {silence_pad:.6f}s", file=sys.stderr)
    print(f"[analyze] total offset      : {total_offset:.6f}s", file=sys.stderr)

    if confidence == 'low':
        print(f"[analyze] WARNING: low confidence — r={r_value:.4f} resid_norm={resid:.4f}",
              file=sys.stderr)
        print(f"[analyze] beats[0:10]       : {[round(t,3) for t in beat_times[:10]]}",
              file=sys.stderr)

    return {
        'bpm':              round(final_bpm, 4),
        'tempo_candidates': alt,
        'beat_offset':      round(float(beat_times[0]), 6),
        'downbeat_offset':  round(downbeat_offset, 6),
        'beat_duration':    round(beat_dur, 6),
        'first_beat_time':  round(first_beat_time, 4),
        'silence_pad':      round(silence_pad, 6),
        'final_offset':     round(total_offset, 6),
        'debug': {
            'beat_count':      len(beat_times),
            'downbeat_phase':  downbeat_phase,
            'r_value':         round(r_value, 6),
            'residual_norm':   round(resid, 6),
            'coverage':        round(coverage, 4),
            'confidence':      confidence,
            'anchor_bpm':      round(anchor_bpm, 2) if anchor_bpm else None,
            'chosen_anchor':   round(chosen_anchor, 2) if chosen_anchor else None,
            'octave_multiplier': mult,
            'dbn_range':       [round(dbn_min, 1), round(dbn_max, 1)],
            'slope_bpm_raw':   round(slope_bpm, 4),
            'bpm_snapped':     snap_applied,
            'grid_intercept':  round(grid_intercept, 6),
            'grid_resid':      round(grid_resid, 6),
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
