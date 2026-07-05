# Let'sMap!

Automatic Beat Saber song prep. Drop in an audio file, detect the BPM, and generate the map skeleton — no manual tapping required.

Let'sMap! is a desktop app (Electron) that runs a Python audio-analysis pipeline (beat/tempo tracking with [madmom](https://github.com/CPJKU/madmom)) to estimate BPM and the first downbeat, then builds a ready-to-edit Beat Saber map with the audio converted and metadata/cover filled in.

## Features

- Automatic BPM detection with octave correction and a multi-anchor DBN beat tracker.
- Downbeat / offset estimation and silence padding.
- Audio conversion to OGG via bundled ffmpeg.
- Metadata + cover art lookup, with a confirmation screen when confidence is low.
- Configurable export folder, mapper name, song/metronome volumes, and language (i18n).

## Supported audio formats

MP3 · WAV · FLAC · OGG · M4A

## Download

Grab the latest installer from the [Releases](https://github.com/MiguelAngGar/Let-sMap-/releases) page.

- **Windows (x64)** — `Let'sMap! Setup 0.1.0.exe` (NSIS installer). On launch, SmartScreen may warn that the app is unsigned: *More info → Run anyway*.
- **macOS (Apple Silicon / arm64)** — `Let'sMap! 0.1.0.dmg`. Open the `.dmg` and drag the app to Applications. Unsigned: if Gatekeeper blocks it, right-click → *Open*.

## Development

Requirements: Node 18+, Python 3.10 (x64).

```bash
npm install
npm start          # launch the app in dev mode
```

In dev mode the analyzer runs from the Python virtual environment (or system Python). See below to create it.

### Python environment

The analyzer depends on madmom, which needs an older NumPy and some care on modern Python:

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
- On **Python 3.10+** run `python patch_madmom.py` once. madmom imports `from collections import MutableSequence`, which moved to `collections.abc` in 3.10; the script installs a compatibility shim in the installed madmom package.

## Building

The analyzer is frozen into a standalone binary with PyInstaller (`python/analyze.spec`, onedir layout → `python/dist/analyze/analyze[.exe]`), then the whole app is packaged with electron-builder.

### Windows

Requirements: Node 18+, Python 3.10 (x64), and **Visual C++ Build Tools** (Desktop development with C++) to compile madmom.

```powershell
# from repo root, in PowerShell
.\build-win.ps1
```

This creates the venv, installs deps, freezes the analyzer, and builds the NSIS installer into `dist\`. See `build-win.ps1` for the individual steps.

### macOS

```bash
./release-mac.sh
```

Builds the arm64 `.dmg` and (with the GitHub CLI authenticated) publishes it to the release.

## Project structure

```
electron/     Main process, preload, IPC
renderer/     UI (HTML/CSS/JS, i18n)
pipeline/     Node orchestration: analyze → convert → metadata → cover → output
python/       Audio analysis (analyze.py) + PyInstaller spec
build/        App icons
```

## License

[MIT](LICENSE) © 2026 MiguelAngGar
