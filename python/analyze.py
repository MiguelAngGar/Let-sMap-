#!/usr/bin/env python3
"""
analyze.py — BPM detection + first beat onset + silence calculation
Usage:  python3 analyze.py /path/to/audio.ogg
Output: single JSON object to stdout
"""

import sys
import json
import math

def analyze(audio_path: str) -> dict:
    import numpy as np
    import librosa

    # Load audio as mono, keep native sample rate
    y, sr = librosa.load(audio_path, sr=None, mono=True)

    # ── BPM detection ────────────────────────────────────────────────────────
    # beat_track returns (tempo, beat_frames); request time units directly
    tempo, beat_times = librosa.beat.beat_track(y=y, sr=sr, units='time')
    bpm = float(np.atleast_1d(tempo)[0])

    # Guard against bad BPM (sometimes librosa returns 0 or absurd values)
    if bpm < 40 or bpm > 400:
        # Retry with a wider range
        tempo, beat_times = librosa.beat.beat_track(
            y=y, sr=sr, units='time',
            start_bpm=120, tightness=100
        )
        bpm = float(np.atleast_1d(tempo)[0])

    # ── First strong beat via onset detection ────────────────────────────────
    onset_env = librosa.onset.onset_strength(y=y, sr=sr)
    onset_times = librosa.onset.onset_detect(
        onset_envelope=onset_env,
        sr=sr,
        units='time',
        backtrack=True,    # snap to the true transient, not the rise
        pre_max=3,
        post_max=3,
        pre_avg=3,
        post_avg=5,
        delta=0.15,
        wait=10            # min 10 frames (~230ms at 22050/512) between onsets
    )

    # Pick the first onset after 50ms (ignore pre-roll / DC artifacts)
    first_beat_time = 0.0
    for t in onset_times:
        if t > 0.05:
            first_beat_time = float(t)
            break

    # Fallback: use first beat from beat_track
    if first_beat_time == 0.0 and len(beat_times) > 0:
        first_beat_time = float(beat_times[0])

    # ── Silence calculation ──────────────────────────────────────────────────
    #
    # Goal: add silence_pad seconds at the start of the audio so that:
    #   1. silence_pad + first_beat_time >= 1.5s  (at least 1.5s lead-in)
    #   2. silence_pad + first_beat_time  is an exact multiple of beat_duration
    #
    # This ensures beat 1 lands precisely on the BPM grid and the mapper
    # starts in a comfortable position.
    #
    # Algorithm:
    #   total_offset = N × beat_dur   (the grid-aligned target time)
    #   N = ceil((first_beat_time + 1.5) / beat_dur)
    #   silence_pad = total_offset - first_beat_time
    #
    MIN_LEAD_IN = 1.5   # seconds
    beat_dur    = 60.0 / bpm

    n            = math.ceil((first_beat_time + MIN_LEAD_IN) / beat_dur)
    total_offset = n * beat_dur
    silence_pad  = total_offset - first_beat_time

    # Safety: silence_pad should always be >= MIN_LEAD_IN here, but clamp
    if silence_pad < MIN_LEAD_IN:
        n           += 1
        total_offset = n * beat_dur
        silence_pad  = total_offset - first_beat_time

    return {
        'bpm':             round(bpm, 4),
        'first_beat_time': round(first_beat_time, 4),
        'silence_pad':     round(silence_pad, 4),
        'final_offset':    round(total_offset, 4),   # goes into Info.dat reference (informational)
        'beat_duration':   round(beat_dur, 6)
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
