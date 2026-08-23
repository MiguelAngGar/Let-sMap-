# Let'sMap! v0.4.0

The feedback release: metadata that trusts the file, silence that is only topped up, and a waveform you can actually align on.

## ✨ New

- **Metadata from the file first.** Its tags and cover art win; online lookups only run when the file leaves the question open, and only a confident answer is taken. Junk tags ("unknow", "Track 03") count as empty and duplicated values are verified. Drop your own image on the cover.
- **Works offline** — every online step is optional, and metadata resolves during the analysis.
- **Silence is topped up, not stacked.** What the song already has counts towards the target, at both ends.
- **Configurable target silence** (intro/outro, ScoreSaber defaults) with a warning when a value would leave the map unrankable.
- **Lead-in per song in whole beats**, so beat 1 always lands on the grid — and it survives a BPM change.
- **Fine offset in ms**, prefilled with the value that hits the grid, with one-click restore. Fixes a first beat detected a few tens of ms off.
- **Waveform rework**: zoom from the whole song down to ~0.3 ms per pixel, beat and bar grid, visible silence band, ms clock and time under the cursor. Drag places the playhead at any zoom; pan with the scrollbar, wheel, two fingers or Alt-drag; pinch to zoom.
- **Five metronome voices**, picked in Settings and previewed as you choose. New defaults: song 50 %, metronome 80 %.
- **The window fits each screen** instead of being sized for the worst case.

## 🐛 Fixes

- Online metadata could overwrite perfectly good file tags.
- The audio-quality setting did nothing (it needed `ffprobe`, which is not bundled) — it works as a real ceiling now.
- 1.5 s of silence was added on top of the silence the song already had.
- Half-beat shift did nothing audible: the clicks moved with the music instead of against it.
- The lead-in drifted on Double BPM (732 ms became 599 ms).
- Duplicated tags (`Infernoplex;Infernoplex`) named maps wrongly; WebP covers could not be read.

## 📥 Downloads

- **Windows**: `Let'sMap! Setup 0.4.0.exe` (NSIS, x64)
- **macOS**: `Let'sMap!-0.4.0.dmg` (Apple Silicon)

Thanks to **galaxymaster** on Discord for testing this on real maps — almost everything above came from his feedback.
