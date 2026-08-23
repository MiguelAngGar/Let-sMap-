# Let'sMap! v0.4.0

The feedback release: metadata that trusts the file, silence you can dial in at both ends, and a waveform you can actually align on.

## ✨ New

- **Metadata from the file first.** Its tags and cover art win; online lookups only run when the file leaves the question open, and only a confident answer is taken. Junk tags ("unknow", "Track 03") count as empty and duplicated values are verified.
- **Works offline** — every online step is optional, and metadata resolves during the analysis.
- **The cover art takes a drop or a click.** Same dashed frame and the same icon as the song drop zone on the first screen, so it looks like what it is. Files, images dragged straight out of a browser, and Photos or Preview all work.
- **Silence is topped up, not stacked.** What the song already has counts towards the target, at both ends.
- **Configurable target silence** (intro/outro, ScoreSaber defaults) with a warning when a value would leave the map unrankable.
- **Lead-in per song in whole beats**, so beat 1 always lands on the grid — and it survives a BPM change.
- **Outro per song in half seconds.** The readout shows the silence that will be *appended*, starting at whatever is missing to reach your configured seconds after the last audible beat — nothing at all when the song already carries them. 0 leaves the ending exactly as it is, the ceiling is the criteria's 15 s, and a ↺ goes back to the amount the app worked out.
- **Fine offset in ms**, prefilled with the value that hits the grid, with one-click restore. Fixes a first beat detected a few tens of ms off.
- **The silence is named on the waveform**: the whole beats added in front, the sub-beat offset that lands beat 1 on the grid, and the outro that will be appended — each labelled in place with its length and, where it is exact, its beat count.
- **Waveform rework**: zoom from the whole song down to ~0.07 ms per pixel — a couple of audio samples — with a beat and bar grid, a ms clock and the time under the cursor. Drag places the playhead at any zoom; pan with the scrollbar, wheel, two fingers or Alt-drag; pinch to zoom. The steps are coarse while you are still finding your way around and get finer as the view closes in, so one gesture crosses the range you do not care about and lands with control where you do.
- **Preview speed**: `+` and `−` in tenths from 0.1× to 1.5×, `0` back to normal. The clicks stay on the map's own grid, so a slow pass is how you hear whether one really sits on a transient. Preview only — the exported map always keeps the original speed, and every new song starts at 1×.
- **Five metronome voices**, picked in Settings and previewed as you choose. New defaults: song 50 %, metronome 80 %.
- **The window fits each screen** instead of being sized for the worst case.

## 🐛 Fixes

- Online metadata could overwrite perfectly good file tags.
- The audio-quality setting did nothing (it needed `ffprobe`, which is not bundled) — it works as a real ceiling now.
- 1.5 s of silence was added on top of the silence the song already had.
- The outro readout showed the total the map ends with, so a song that fades out looked like it was ignoring the setting: 2 s configured, 3.160 s reported, and nothing actually being added. It shows what gets appended now, and it can be changed without leaving the screen.
- Half-beat shift did nothing audible: the clicks moved with the music instead of against it.
- The lead-in drifted on Double BPM (732 ms became 599 ms).
- Duplicated tags (`Infernoplex;Infernoplex`) named maps wrongly; WebP covers could not be read.
- `Info.dat` stamped the editor version as 0.2.0. It comes from one place now.
- Zoom stopped short of ×512 on anything under about two minutes.
- **macOS:** a trackpad pinch flew through the whole zoom range in a single flick; the automatic window height stopped working for the rest of the session after ⌘W, fullscreen, Split View or a move to another display; images dragged out of Safari, Photos or iCloud were rejected; and the shortcut hints asked for a Ctrl key a Mac does not have.

## 📥 Downloads

- **Windows**: `Let'sMap! Setup 0.4.0.exe` (NSIS, x64)
- **macOS**: `Let'sMap!-0.4.0.dmg` (Apple Silicon)

The macOS build is not notarized yet, so the first launch needs right-click → Open.

Thanks to **galaxymaster** on Discord for testing this on real maps — almost everything above came from his feedback.
