# -*- mode: python ; coding: utf-8 -*-
# Let'sMap! analyzer freeze spec — ONEDIR layout.
# Output: python/dist/analyze/analyze[.exe]  (matches pipeline/analyzer.js)

from PyInstaller.utils.hooks import collect_data_files, collect_submodules

# madmom ships RNN/tempo model files under madmom/models/ — must be bundled
datas = collect_data_files('madmom')
# _socket/select/socket: needed by multiprocessing child procs (madmom Pool) on Windows
hiddenimports = (collect_submodules('madmom') + collect_submodules('scipy')
                 + ['_socket', 'select', 'socket', '_multiprocessing', '_queue'])

a = Analysis(
    ['analyze.py'],
    pathex=[],
    binaries=[],
    datas=datas,
    hiddenimports=hiddenimports,
    hookspath=[],
    hooksconfig={},
    runtime_hooks=[],
    excludes=[],
    noarchive=False,
    optimize=0,
)
pyz = PYZ(a.pure)

exe = EXE(
    pyz,
    a.scripts,
    [],
    exclude_binaries=True,      # onedir: libs/data collected below
    name='analyze',
    debug=False,
    bootloader_ignore_signals=False,
    strip=False,
    upx=False,                  # off: UPX can break madmom DLLs / trip antivirus
    console=True,
    disable_windowed_traceback=False,
    argv_emulation=False,
    target_arch=None,
    codesign_identity=None,
    entitlements_file=None,
)

coll = COLLECT(
    exe,
    a.binaries,
    a.datas,
    strip=False,
    upx=False,
    upx_exclude=[],
    name='analyze',             # -> dist/analyze/analyze[.exe]
)
