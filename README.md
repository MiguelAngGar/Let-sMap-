# Let'sMap!

Automatic Beat Saber song prep. Drop in an audio file, get the BPM and offset detected in seconds, preview the beat grid with a metronome, and generate a ready-to-edit Beat Saber map — no manual tapping required.

Let'sMap! is a desktop app (Electron) with a built-in, pure-JavaScript audio analysis engine. Analysis takes ~2–4 seconds per song and needs no Python or external runtimes.

## Features

- **Fast, sample-accurate BPM detection** — implements the tempo estimation algorithm from Bram van de Wetering's paper *"Non-causal Beat Tracking for Rhythm Games"* (the approach popularised by rhythm-game chart editors), measuring the beat period at sample resolution. Typical accuracy is within ±0.01 BPM on fixed-tempo music, with exact integer snapping.
- **Downbeat & offset estimation** with grid-aligned silence padding.
- **Ranking-criteria-friendly audio**: exported songs get an intro of ≥ 1.5 s of silence before the first musical beat (ScoreSaber hot-start rule) and a topped-up outro so at least 2 s of silence follow the music (cold-end rule) — only the missing amount is ever added.
- **Interactive BPM validation view** — waveform timeline (including the silence that will be prepended), sample-accurate metronome preview, BPM candidates, half-beat shift and BPM doubling modifiers, custom BPM input.
- **Beat Saber install auto-detection** (Windows, Steam & Oculus) — the export folder points at `Beat Saber_Data\CustomWIPLevels` automatically until you pick a folder yourself. A re-detect button lives in Settings.
- **Metadata + cover art lookup**, with a confirmation screen when confidence is low.
- **Audio conversion to OGG** via bundled ffmpeg, matching the source bitrate by default.
- Configurable export folder, mapper name, OGG quality, volumes, and language (EN/ES/FR/DE/PT).

## Supported audio formats

MP3 · WAV · FLAC · OGG · M4A

## Download

Grab the latest installer from the [Releases](https://github.com/MiguelAngGar/Let-sMap-/releases) page.

- **Windows (x64)** — NSIS installer. On launch, SmartScreen may warn that the app is unsigned: *More info → Run anyway*.
- **macOS (Apple Silicon / arm64)** — open the `.dmg` and drag the app to Applications. Unsigned: if Gatekeeper blocks it, right-click → *Open*.

## Analysis engines

Two engines share the same JSON contract; the active one is selected in `pipeline/analyzer.js`:

```js
const ENGINE = process.env.LETSMAP_ENGINE || 'arrowvortex'
```

| Engine | Runtime | Speed | Notes |
|---|---|---|---|
| `arrowvortex` *(default)* | pure JS (`pipeline/av-engine/`), runs in a worker thread | ~2–4 s | Onset detection + interval-histogram tempo search. No Python needed. |
| `madmom` | Python sidecar (`python/analyze.py`), RNN + DBN beat tracking | ~30–90 s | Legacy engine, kept for comparison. Requires the Python setup below. |

Switch temporarily without editing code:

```powershell
$env:LETSMAP_ENGINE="madmom"; npm run dev
```

The JS engine's onset detector was ported using [AudioSync](https://github.com/Caeden117/AudioSync) (MIT, © Caeden Statia) as reference — see `pipeline/av-engine/THIRD-PARTY-NOTICES.md`.

## Development

Requirements: Node 18+.

```bash
npm install
npm start          # launch the app in dev mode  (npm run dev = with logging)
```

That's all for the default engine. Python is only needed if you want to run the legacy madmom engine.

<details>
<summary><b>Legacy Python engine setup (optional)</b></summary>

Requirements: Python 3.10 (x64). madmom needs an older NumPy and some care on modern Python:

```bash
python -m venv .venv
# Windows:  .\.venv\Scripts\python -m pip install ...
# macOS:    ./.venv/bin/python  -m pip install ...
pip install --upgrade "setuptools<81" wheel "Cython<3"
pip install -r python/requirements.txt
```

Notes:
- **Python 3.10** is recommended — madmom pins `numpy<1.24`, and NumPy 1.23 has no wheels for 3.12+.
- **`setuptools<81`** — madmom 0.16.1 imports `pkg_resources`, removed in setuptools 81.
- **`Cython<3`** — madmom 0.16.1 compiles its `.pyx` extensions with the 0.29 series.
- On **Python 3.10+** run `python patch_madmom.py` once (installs a `collections.abc` compatibility shim).

</details>

## Building

The app is packaged with electron-builder. The default engine ships as plain JS inside the app — nothing to freeze.

> The legacy madmom engine only works in a packaged build if you also freeze it with PyInstaller (`python/analyze.spec` → `python/dist/analyze/`). If `python/dist` is absent, the packaged app simply runs the default JS engine.

### Windows

```powershell
# from repo root, in PowerShell
npm run dist:win
```

(`build-win.ps1` additionally creates the Python venv and freezes the legacy analyzer before packaging — only needed if you want madmom available in the installer.)

### macOS

```bash
./release-mac.sh
```

Builds the arm64 `.dmg` and (with the GitHub CLI authenticated) publishes it to the release.

## Project structure

```
electron/     Main process, preload, IPC, Beat Saber install auto-detection
renderer/     UI (HTML/CSS/JS, i18n, waveform + metronome preview)
pipeline/     Node orchestration: analyze → convert → metadata → cover → output
  av-engine/  Default BPM+offset engine (pure JS, worker thread)
python/       Legacy analysis engine (analyze.py, madmom) + PyInstaller spec
build/        App icons
```

## Acknowledgements

- Bram van de Wetering — *Non-causal Beat Tracking for Rhythm Games* (the tempo detection algorithm).
- [AudioSync](https://github.com/Caeden117/AudioSync) by Caeden Statia (MIT) — reference for the onset detection port.
- [madmom](https://github.com/CPJKU/madmom) — the legacy engine's beat tracking.

## License

[MIT](LICENSE) © 2026 MiguelAngGar
