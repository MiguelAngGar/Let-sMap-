# Let'sMap! - Windows build (x64). Run from the repo root in PowerShell:
#     .\build-win.ps1
#
# Prereqs:
#   - Node 18+                (node -v)
#   - Python 3.10 x64         (py -3.10 --version)   <- madmom pins numpy<1.24
#   - Visual C++ Build Tools  ("Desktop development with C++") to compile madmom
#   - git
#
# Produces: dist\Let'sMap! Setup <version>.exe  (NSIS installer)

$ErrorActionPreference = "Stop"
$root = $PSScriptRoot
Set-Location $root

Write-Host ">> 1/6  Node dependencies" -ForegroundColor Cyan
npm install

Write-Host ">> 2/6  Python venv" -ForegroundColor Cyan
if (-Not (Test-Path ".venv")) { py -3.10 -m venv .venv }
$py = ".\.venv\Scripts\python.exe"

Write-Host ">> 3/6  Build toolchain (madmom needs setuptools<81, Cython<3)" -ForegroundColor Cyan
# setuptools<81  : madmom 0.16.1 imports pkg_resources (removed in setuptools 81)
# Cython<3       : madmom 0.16.1 compiles its .pyx with the 0.29 series
& $py -m pip install --upgrade pip
& $py -m pip install "setuptools<81" wheel "Cython<3"

Write-Host ">> 4/6  Python deps (pinned to what madmom needs)" -ForegroundColor Cyan
# Install numpy/scipy wheels FIRST so the madmom source build finds numpy headers.
& $py -m pip install "numpy==1.23.5" "scipy==1.10.1" "mido>=1.2.8"
# madmom has no cp310 wheel -> compile from source, without build isolation so it
# uses the venv's Cython/numpy (isolated builds fail: "No module named Cython").
& $py -m pip install --force-reinstall --no-deps --no-build-isolation --no-binary :all: "madmom==0.16.1"
# Re-pin numpy in case anything nudged it.
& $py -m pip install --no-deps --force-reinstall "numpy==1.23.5"
& $py -m pip install pyinstaller

Write-Host ">> 5/6  Patch madmom for Python 3.10 + freeze analyzer" -ForegroundColor Cyan
# madmom imports `from collections import MutableSequence` (moved to collections.abc in 3.10)
& $py patch_madmom.py
Push-Location python
& "..\.venv\Scripts\pyinstaller.exe" analyze.spec --clean --noconfirm
Pop-Location
if (-Not (Test-Path "python\dist\analyze\analyze.exe")) {
    throw "PyInstaller failed: python\dist\analyze\analyze.exe missing"
}

Write-Host ">> 6/6  Build NSIS installer" -ForegroundColor Cyan
npm run dist:win

Write-Host ">> Done. Installer is in dist\" -ForegroundColor Green
