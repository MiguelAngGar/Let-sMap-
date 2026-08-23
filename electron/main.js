// `screen` is deliberately NOT destructured here: touching it at load time
// invokes its getter before app.whenReady(), which Electron documents as
// unsupported. It is required where it is used instead.
const { app, BrowserWindow, ipcMain, dialog, Menu } = require('electron')
const path   = require('path')
const os     = require('os')
const Store  = require('electron-store')

const bsDetect = require('./beatsaber-detect')

const phase1   = require('../pipeline/phase1')
const phase2   = require('../pipeline/phase2')
const metaResolve = require('../pipeline/meta-resolve')
const metaPrefetch = require('../pipeline/meta-prefetch')
const cover       = require('../pipeline/cover')

// ── Persistent settings ───────────────────────────────────────────────────────
// macOS: ~/Library/Application Support/lets-map/config.json
// Windows: %APPDATA%\lets-map\config.json
const store = new Store({
  name: 'config',
  defaults: {
    exportDir:   path.join(os.homedir(), 'Documents', 'BeatSaberMaps'),
    mapperName:  '',
    songVolume:  50,
    metroVolume: 80,
    metroSound:  'click',  // see METRO_SOUNDS in renderer/audio-engine.js
    exportDirUserSet: false,  // true once the user picks a folder manually
    language:    'system',
    oggQuality:  10,       // Vorbis quality CEILING 0–10 for the exported song.ogg
                           // (a source already poorer than this keeps its own bitrate)

    // Minimum silence the exported audio must END UP with, in seconds. Defaults
    // are the ScoreSaber ranking criteria (intro ≥ 1.5 s, outro > 2 s); the user
    // can change them and the Settings screen warns when they fall below.
    // Grid alignment is added on top of these, independently.
    leadInSeconds:  1.5,
    coldEndSeconds: 2.0
  }
})

// Metronome voices the renderer can synthesise (renderer/audio-engine.js owns
// the actual sounds; this list is only here to reject nonsense from settings).
const METRO_SOUNDS = ['click', 'beep', 'tick', 'block', 'thump']

// ── Window ────────────────────────────────────────────────────────────────────
let win

// Auto-fit state lives ON the window, not in module scope. _fitIgnoreUntil
// swallows the resize events our own setContentSize causes, so they are not
// mistaken for the user grabbing the edge; _userResized turns auto-fit off once
// they have. Per-window because on macOS the app outlives its window: Cmd+W then
// reopening builds a new one, and module-level flags would hand it the old
// window's "the user already resized me" and kill auto-fit for the whole session.
// The drop screen needs far less than this; keeping the floor at the starting
// height means the window only ever grows for the BPM screen and shrinks back,
// instead of collapsing to a letterbox every time you go back for another song.
const MIN_FIT_HEIGHT = 620

function createWindow() {
  win = new BrowserWindow({
    // Sized so the BPM screen fits without scrolling: the waveform is 150 px
    // tall now, and under it live the readout, both criteria notes, the volumes,
    // the tempo, the candidates and the buttons.
    // Height is not fixed: each view asks for exactly what it needs through
    // window:fit-height, so no screen is a mostly-empty box. This is the
    // starting size for the drop screen. useContentSize matters — without it
    // these numbers include the window frame, which on Windows ate ~39 px.
    useContentSize: true,
    width:  960,
    height: 620,
    minWidth:  780,
    minHeight: 520,
    titleBarStyle: process.platform === 'darwin' ? 'hiddenInset' : 'default',
    autoHideMenuBar: true,
    backgroundColor: '#0d0d0f',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false
    }
  })

  // Local alias so the listener below always talks about THIS window, even
  // after `win` has been reassigned by a later createWindow() on macOS.
  const w = win

  // Fresh window, fresh auto-fit state.
  w._fitIgnoreUntil = 0
  w._userResized    = false

  // Once the user resizes the window by hand, stop second-guessing them.
  // Resizes the window manager drives are not the user grabbing an edge, so
  // they must not latch it off: on macOS the green button, Split View, Stage
  // Manager and moving to a display of a different scale all fire resize.
  w.on('resize', () => {
    if (w.isDestroyed() || w.isFullScreen() || w.isMaximized()) return
    if (Date.now() > w._fitIgnoreUntil) w._userResized = true
  })

  win.loadFile(path.join(__dirname, '../renderer/index.html'))
  // win.webContents.openDevTools()
}

app.whenReady().then(() => {
  // Hide the File/Edit/View/Window/Help bar on Windows/Linux only.
  // On macOS the menu lives in the system bar and holds standard shortcuts
  // (Cmd+Q/C/V/W) — removing it there would break them.
  if (process.platform !== 'darwin') Menu.setApplicationMenu(null)
  createWindow()
  app.on('activate', () => { if (BrowserWindow.getAllWindows().length === 0) createWindow() })

  // Auto-point the export folder at the Beat Saber install (CustomWIPLevels)
  // as long as the user has never chosen a folder manually. Runs on every
  // launch so a moved/reinstalled game is picked up — but NEVER overrides a
  // folder the user picked themselves.
  autoDetectExportDir()
})

async function autoDetectExportDir() {
  try {
    if (store.get('exportDirUserSet')) return
    const install = await bsDetect.detectBeatSaber()
    if (!install) return
    const wip = bsDetect.wipLevelsFolder(install)
    if (wip && wip !== store.get('exportDir')) {
      store.set('exportDir', wip)
      console.log('[main] export folder auto-detected:', wip)
    }
  } catch (err) {
    console.error('[main] Beat Saber auto-detect failed:', err)
  }
}
app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit() })

// ── Helpers ───────────────────────────────────────────────────────────────────

const round2 = b => Math.round(b * 100) / 100

/**
 * Build structured BPM candidates.
 *
 * Returns:
 *   main         — [bpm/2, bpm, bpm×2] always shown as the primary group
 *   alternatives — up to 2 madmom-ranked tempos that aren't multiples of main
 */
function buildCandidates(bpm, tempoCandidates = []) {
  const main = [bpm / 2, bpm, bpm * 2]
    .map(round2)
    .filter(b => b >= 60 && b <= 350)

  const alternatives = tempoCandidates
    .map(round2)
    .filter(b => b >= 60 && b <= 350 && !main.includes(b))
    .slice(0, 2)

  return { main, alternatives }
}

// ── IPC: misc ─────────────────────────────────────────────────────────────────

// Analysis engine selected in pipeline/analyzer.js ('arrowvortex' | 'madmom')
ipcMain.handle('app:get-engine', () => {
  try { return require('../pipeline/analyzer').ENGINE || 'arrowvortex' }
  catch { return 'arrowvortex' }
})

// ── IPC: settings ─────────────────────────────────────────────────────────────

ipcMain.handle('settings:get', () => store.store)

ipcMain.handle('settings:save', (_e, data) => {
  if (typeof data.exportDir === 'string' && data.exportDir) {
    // A changed folder marks the setting as user-chosen — unless the value
    // came from the Auto-detect button, which must keep tracking enabled.
    if (data.exportDir !== store.get('exportDir')) {
      store.set('exportDirUserSet', data.exportDirAuto !== true)
    }
    store.set('exportDir', data.exportDir)
  }
  if (typeof data.mapperName  === 'string') store.set('mapperName',  data.mapperName)
  if (typeof data.songVolume  === 'number') store.set('songVolume',  data.songVolume)
  if (typeof data.metroVolume === 'number') store.set('metroVolume', data.metroVolume)
  if (typeof data.language    === 'string') store.set('language',    data.language)
  if (typeof data.metroSound  === 'string' && METRO_SOUNDS.includes(data.metroSound)) {
    store.set('metroSound', data.metroSound)
  }
  if (typeof data.oggQuality  === 'number' && Number.isFinite(data.oggQuality)) {
    store.set('oggQuality', Math.min(10, Math.max(0, Math.round(data.oggQuality))))
  }
  for (const key of ['leadInSeconds', 'coldEndSeconds']) {
    const v = Number(data[key])
    // 15 s is the outro ceiling in the criteria; nothing sensible goes past it
    if (Number.isFinite(v) && v >= 0) store.set(key, Math.min(15, Math.round(v * 100) / 100))
  }
  return store.store
})

// Detect the Beat Saber install and return its CustomWIPLevels folder (or null)
ipcMain.handle('settings:detect-beatsaber', async () => {
  const install = await bsDetect.detectBeatSaber()
  return install ? bsDetect.wipLevelsFolder(install) : null
})

ipcMain.handle('settings:select-folder', async () => {
  const { canceled, filePaths } = await dialog.showOpenDialog(win, {
    title:       'Select export folder',
    properties:  ['openDirectory', 'createDirectory'],
    defaultPath: store.get('exportDir')
  })
  return canceled ? null : filePaths[0]
})

// Native file picker for the drop zone (click-to-browse)
ipcMain.handle('song:select-file', async () => {
  const { canceled, filePaths } = await dialog.showOpenDialog(win, {
    title:      'Select song',
    properties: ['openFile'],
    filters: [
      { name: 'Audio', extensions: ['mp3', 'wav', 'flac', 'ogg', 'm4a', 'aif', 'aiff'] }
    ]
  })
  return canceled ? null : filePaths[0]
})

// ── IPC: pipeline — phase 1 (analyze only) ───────────────────────────────────

ipcMain.handle('song:analyze', async (event, filePath) => {
  const senderWin = BrowserWindow.fromWebContents(event.sender)
  const send = (step, msg) => senderWin?.webContents.send('pipeline-progress', { step, msg })

  try {
    send('convert', 'Converting audio…')

    // Resolve the metadata alongside the analysis: by the time the user has
    // checked the BPM, the answer (lookup, artwork) is already in.
    metaPrefetch.start({
      filePath,
      originalName: path.basename(filePath, path.extname(filePath))
    })

    const { oggPath, originalPath, analysis, originalName, trailingSilence } =
      await phase1.run(filePath)
    const candidates = buildCandidates(analysis.bpm, analysis.tempo_candidates)

    return {
      success: true, oggPath, originalPath, analysis, candidates, originalName,
      trailingSilence,
      // What the export will aim for, so the view can show the real outro
      coldEnd: store.get('coldEndSeconds')
    }
  } catch (err) {
    console.error('[main] song:analyze error:', err)
    return { success: false, error: err.message }
  }
})

// ── IPC: metadata lookup + confidence (between BPM view and map creation) ───

ipcMain.handle('song:fetch-meta', async (_e, arg) => {
  // The renderer sends { filePath, originalName }. A bare string (older
  // renderer) still works, it just has no file to read tags from.
  const { filePath, originalName } = (typeof arg === 'string')
    ? { filePath: null, originalName: arg }
    : (arg || {})

  // Even a total failure should reach the confirmation screen with the best
  // guess available, rather than an empty form.
  const guess    = metaResolve.fromFilename(originalName || '')
  const fallback = { title: guess.title, artist: guess.artist, album: '' }

  try {
    // The file's own tags come first; the online lookup only runs when the
    // file has nothing usable (see pipeline/meta-resolve.js). Normally this was
    // already resolved during the analysis, so there is nothing to wait for.
    const pending = metaPrefetch.get(filePath)
    let res = pending ? await pending : null
    if (res) console.log('[main] metadata came from the prefetch')
    if (!res) res = await metaResolve.resolve({ filePath, originalName })
    console.log('[main] metadata from ' + res.source +
                ' (confident=' + res.confident + ', cover=' + !!res.coverPath + ')')

    return {
      success:   true,
      meta:      res.meta,
      coverPath: res.coverPath,
      confident: res.confident,
      source:    res.source
    }
  } catch (err) {
    console.error('[main] song:fetch-meta error:', err)
    return { success: false, meta: fallback, coverPath: null, confident: false, source: 'file' }
  }
})

// Image dropped on the confirmation screen → processed to 512×512 JPEG.
// One entry point for every shape a drag can take: a local path, a file:// URL
// (dropped from a file manager), an http(s) URL or a data: URL (dragged
// straight out of a browser). Returns null on anything unreadable.
ipcMain.handle('meta:cover-from-drop', async (_e, src) => {
  const result = await cover.fromDrop(src)
  if (!result) console.warn('[main] dropped cover could not be used:', String(src).slice(0, 120))
  return result
})

// User picks a local image as cover → processed to 512×512 JPEG
ipcMain.handle('meta:select-cover', async () => {
  const { canceled, filePaths } = await dialog.showOpenDialog(win, {
    title:      'Select cover image',
    properties: ['openFile'],
    filters:    [{ name: 'Images', extensions: ['png', 'jpg', 'jpeg', 'bmp', 'tiff', 'gif'] }]
  })
  if (canceled || !filePaths[0]) return null

  try {
    return await cover.fromFile(filePaths[0])
  } catch (err) {
    console.error('[main] meta:select-cover error:', err)
    return null
  }
})

// ── IPC: pipeline — phase 2 (finalize with confirmed BPM) ────────────────────

/**
 * Make the window exactly as tall as the renderer says the active view needs.
 * Clamped to the display it is on, never below the minimum, and ignored once
 * the user has resized the window themselves.
 */
ipcMain.handle('window:fit-height', (event, height) => {
  const w = BrowserWindow.fromWebContents(event.sender)
  if (!w || w.isDestroyed() || w._userResized || w.isMaximized() || w.isFullScreen()) return

  // Required lazily: the screen module is only usable after the ready event.
  const { screen } = require('electron')
  const area     = screen.getDisplayMatching(w.getBounds()).workArea
  const [cw, ch] = w.getContentSize()
  const target   = Math.max(MIN_FIT_HEIGHT,
                            Math.min(Math.round(Number(height) || 0), area.height - 80))
  if (!Number.isFinite(target) || Math.abs(target - ch) < 8) return

  w._fitIgnoreUntil = Date.now() + 600
  w.setContentSize(cw, target, false)

  // Growing must not push the window off the bottom of the screen
  const b = w.getBounds()
  if (b.y + b.height > area.y + area.height) {
    w.setPosition(b.x, Math.max(area.y, area.y + area.height - b.height))
  }
})

ipcMain.handle('song:create-map', async (event, {
  oggPath,
  originalPath,
  analysis,
  confirmedBpm,
  halfBeatShift,
  extraBeats,
  offsetNudgeMs,
  originalName,
  meta,
  coverPath
}) => {
  const senderWin = BrowserWindow.fromWebContents(event.sender)
  const send = (step, msg) => {
    console.log(`[${step}] ${msg}`)
    senderWin?.webContents.send('pipeline-progress', { step, msg })
  }

  try {
    const result = await phase2.run({
      oggPath,
      originalPath,
      analysis,
      confirmedBpm,
      halfBeatShift,
      extraBeats,
      offsetNudgeMs,
      originalName,
      meta,
      coverPath,
      exportDir:  store.get('exportDir'),
      mapperName: store.get('mapperName'),
      oggQuality: store.get('oggQuality'),
      leadIn:     store.get('leadInSeconds'),
      coldEnd:    store.get('coldEndSeconds'),
      send
    })

    send('done', `Done → ${result.outputDir}`)
    return { success: true, result }
  } catch (err) {
    console.error('[main] song:create-map error:', err)
    return { success: false, error: err.message }
  }
})

