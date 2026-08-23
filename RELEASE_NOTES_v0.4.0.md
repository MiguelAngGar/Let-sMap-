# Let'sMap! v0.4.0

The feedback release. Everything here comes from mapping real songs: metadata that trusts the file, silence that is added only where it is missing, and a waveform you can actually judge the alignment on.

## ✨ New

- **Metadata from the file first.** Embedded tags (ID3 / Vorbis / MP4) and embedded cover art are used as they are. Online lookups only run when the file does not settle the question, and only a high-confidence answer is accepted — otherwise the confirmation screen opens, prefilled with the best the file can offer (its tags, the cleaned-up filename, its embedded artwork). A tag that says nothing ("unknow", "Track 03") counts as empty, and a value stored twice ("Dimrain47;Dimrain47") is verified online before it is trusted. Cover art fetched online is discarded unless it belongs to the same song, and you can drop an image on the thumbnail — a file, or one dragged straight out of a browser.
- **Works offline.** Every online step is optional: the first failed request marks the network as down, so the rest stand down instantly instead of waiting out timeouts. Metadata is also resolved *during* the analysis, so "Create Map" waits for nothing.
- **Silence is topped up, not stacked.** Whatever the song already carries counts towards the target at both ends, so a track that opens with a long intro gets the beat-grid alignment alone — often nothing at all.
- **Target silence is configurable** (intro and outro separately, ScoreSaber's 1.5 s / 2 s by default), and the app says when a value would leave the map unrankable — measured against the whole time before the first beat, music included, not just the silence.
- **Lead-in per song, in whole beats**: ± a beat at a time, so beat 1 always lands on a grid line. It can be taken all the way down to the alignment nudge alone, with a warning when that drops under the criteria, and it survives a BPM change or a Double BPM — what is preserved is where beat 1 lands, not the beat count.
- **Fine offset in milliseconds.** The field opens on the offset the app worked out to hit the grid (not on a meaningless zero), and typing over it means "use this one instead" — with one-click restore. This is what fixes a first beat the detector placed a few tens of milliseconds off, which no number of whole beats could.
- **A waveform you can work on.** Taller, and with zoom from the whole song down to a quarter of a second (~0.3 ms per pixel). It draws the map's beat grid with bar lines every four beats, shades the silence that will be prepended (with its length written in it), marks where the audio starts, and shows the time under the cursor to the millisecond. Drag places the playhead at every zoom level and scrolls the view when you push against the edge; pan with the scrollbar, the wheel, Alt-drag, or two fingers; pinch to zoom on a trackpad; Ctrl + wheel with a mouse.
- **Metronome you can hear over your song**: five voices (click, beep, tick, woodblock, low thump), picked in Settings and previewed as you choose. New default volumes — song 50 %, metronome 80 %.
- **The count-in clicks through the added silence**, so you can hear how much is in front of the music and whether the music lands on the grid when it starts.
- **The window fits the screen it is showing** instead of being sized for the worst case, so no panel is clipped and no screen is a mostly-empty box.

## 🐛 Fixes

- **Online metadata overwrote perfectly good file tags.** A low-confidence guess could rename a song that already carried its own title and artist; the file now wins by default.
- **The audio-quality setting never actually did anything.** It relied on `ffprobe`, which is not bundled — the source bitrate was read as "unknown" and every song was re-encoded at the ceiling. Stream info is now parsed from ffmpeg itself, so the setting works as the ceiling it claims to be (with a 96 kbps floor, never re-encoding a poor source bigger for nothing).
- **1.5 s of silence was added on top of the silence the song already had**, with no way to trim it. Fixed in all four places the calculation lived (JS engine, Python engine, pipeline, preview).
- **Half-beat shift did nothing audible.** The clicks moved with the music instead of against it; they now sit on the exported map's grid, which is what makes the shift usable for a beat detected on the off-beat.
- **The lead-in adjustment drifted when changing BPM** — 732 ms became 599 ms on a single Double BPM, because the default grid line does not simply double.
- **Duplicated tag values** (`Infernoplex;Infernoplex`) named maps wrongly.
- **WebP cover art could not be read** by the image processor; it is now transcoded first.
- Settings: the silence fields matched the rest of the panel's styling, and an out-of-range value is corrected visibly instead of silently.

## 📥 Downloads

- **Windows**: `Let'sMap! Setup 0.4.0.exe` (NSIS installer, x64)
- **macOS**: `Let'sMap!-0.4.0.dmg` (Apple Silicon / arm64)

## 🙏 Thanks

Huge thanks to **galaxymaster** on Discord for testing this on real maps and for the feedback behind almost everything above.

> The same song in different formats (WAV/FLAC/MP3/OGG) produces the same BPM; maps are always internally synced regardless of the input format.
