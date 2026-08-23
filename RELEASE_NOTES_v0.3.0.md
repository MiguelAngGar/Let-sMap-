# Let'sMap! v0.3.0

The new-engine release: analysis in seconds, a much lighter installer, and exported audio that meets ScoreSaber's ranking criteria.

## ✨ New

- **New BPM & offset detection engine**, written in pure JavaScript (implements the algorithm from Bram van de Wetering's paper *"Non-causal Beat Tracking for Rhythm Games"*). Analysis goes from 30–90 s down to **~2–4 s per song**, with sample-accurate precision (±0.01 BPM on fixed-tempo music, exact on integer BPMs). No Python required anymore.
- **Much lighter installer**: the Python/madmom runtime is no longer bundled. The old engine remains in the repo as a *legacy* engine for development (`LETSMAP_ENGINE=madmom`).
- **Beat Saber install auto-detection** (Windows, Steam & Oculus): the export folder automatically points at `Beat Saber_Data\CustomWIPLevels` until you pick a folder yourself. New "Auto-detect" button in Settings, and the path field can now also be typed manually.
- **Cold end**: exported audio guarantees ≥ 2 s of silence after the music (ScoreSaber's outro rule), adding only the missing amount. Together with the ≥ 1.5 s lead-in, the map audio meets both the intro and outro criteria.
- **Preview mirrors the final map**: the validation view now shows the silence that will be prepended, and the metronome clicks from the first beat that has audio.
- **Click to browse**: the drop zone also opens a file picker on click.
- **New icon**, waveform-styled with the beat highlighted.

## 🐛 Fixes

- The metronome started clicking several beats late (it anchored on beat 1 of the measure instead of the first audible beat).
- Settings were cut off at the default window size; the window now opens larger and the panel scrolls internally, so it never clips.
- Selecting text in Settings and releasing the mouse outside the panel no longer closes it.
- The scrollbar no longer overlaps the credits text.
- Clearer Settings copy, with auto-detect feedback shown next to its button (all 5 languages).

## 📥 Downloads

- **Windows**: `Let'sMap! Setup 0.3.0.exe` (NSIS installer, x64)
- **macOS**: `Let'sMap!-0.3.0.dmg` (Apple Silicon / arm64)

> The same song in different formats (WAV/FLAC/MP3/OGG) produces the same BPM; maps are always internally synced regardless of the input format.
