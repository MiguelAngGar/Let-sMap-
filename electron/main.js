const { app, BrowserWindow, ipcMain, dialog, Menu } = require('electron')
const path   = require('path')
const os     = require('os')
const Store  = require('electron-store')

const phase1   = require('../pipeline/phase1')
const phase2   = require('../pipeline/phase2')
const metadata = require('../pipeline/metadata')
const cover    = require('../pipeline/cover')

// ── Persistent settings ───────────────────────────────────────────────────────
// macOS: ~/Library/Application Support/lets-map/config.json
// Windows: %APPDATA%\lets-map\config.json
const store = new Store({
  name: 'config',
  defaults: {
    exportDir:   path.join(os.homedir(), 'Documents', 'BeatSaberMaps'),
    mapperName:  '',
    songVolume:  75,
    metroVolume: 100,
    language:    'system',
    oggQuality:  10,       // Vorbis VBR quality 0–10 for the exported song.ogg (10 = max)
    matchSourceQuality: true // Match the upload's bitrate instead of forcing q10 (keeps size/quality)
  }
})

// ── Window ────────────────────────────────────────────────────────────────────
let win

function createWindow() {
  win = new BrowserWindow({
    width:  820,
    height: 580,
    minWidth:  640,
    minHeight: 480,
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
})
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

// ── IPC: settings ─────────────────────────────────────────────────────────────

ipcMain.handle('settings:get', () => store.store)

ipcMain.handle('settings:save', (_e, data) => {
  if (typeof data.exportDir   === 'string') store.set('exportDir',   data.exportDir)
  if (typeof data.mapperName  === 'string') store.set('mapperName',  data.mapperName)
  if (typeof data.songVolume  === 'number') store.set('songVolume',  data.songVolume)
  if (typeof data.metroVolume === 'number') store.set('metroVolume', data.metroVolume)
  if (typeof data.language    === 'string') store.set('language',    data.language)
  if (typeof data.oggQuality  === 'number' && Number.isFinite(data.oggQuality)) {
    store.set('oggQuality', Math.min(10, Math.max(0, Math.round(data.oggQuality))))
  }
  if (typeof data.matchSourceQuality === 'boolean') store.set('matchSourceQuality', data.matchSourceQuality)
  return store.store
})

ipcMain.handle('settings:select-folder', async () => {
  const { canceled, filePaths } = await dialog.showOpenDialog(win, {
    title:       'Select export folder',
    properties:  ['openDirectory', 'createDirectory'],
    defaultPath: store.get('exportDir')
  })
  return canceled ? null : filePaths[0]
})

// ── IPC: pipeline — phase 1 (analyze only) ───────────────────────────────────

ipcMain.handle('song:analyze', async (event, filePath) => {
  const senderWin = BrowserWindow.fromWebContents(event.sender)
  const send = (step, msg) => senderWin?.webContents.send('pipeline-progress', { step, msg })

  try {
    send('convert', 'Converting audio…')
    const { oggPath, originalPath, analysis, originalName } = await phase1.run(filePath)
    const candidates = buildCandidates(analysis.bpm, analysis.tempo_candidates)

    return { success: true, oggPath, originalPath, analysis, candidates, originalName }
  } catch (err) {
    console.error('[main] song:analyze error:', err)
    return { success: false, error: err.message }
  }
})

// ── IPC: metadata lookup + confidence (between BPM view and map creation) ───

ipcMain.handle('song:fetch-meta', async (_e, originalName) => {
  const fallback = { title: originalName, artist: '', album: '' }
  try {
    const meta = await metadata.fetch(originalName)
    const coverPath = meta.found
      ? await cover.fetchRemote(meta.artist, meta.title)
      : null

    // Confident requires BOTH a confident metadata match AND a real cover —
    // otherwise show the confirmation screen so the user can fix things.
    return {
      success:   true,
      meta:      { title: meta.title, artist: meta.artist, album: meta.album },
      coverPath,
      confident: !!(meta.confident && coverPath)
    }
  } catch (err) {
    console.error('[main] song:fetch-meta error:', err)
    return { success: false, meta: fallback, coverPath: null, confident: false }
  }
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

ipcMain.handle('song:create-map', async (event, {
  oggPath,
  originalPath,
  analysis,
  confirmedBpm,
  halfBeatShift,
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
      originalName,
      meta,
      coverPath,
      exportDir:  store.get('exportDir'),
      mapperName: store.get('mapperName'),
      oggQuality: store.get('oggQuality'),
      matchSource: store.get('matchSourceQuality'),
      send
    })

    send('done', `Done → ${result.outputDir}`)
    return { success: true, result }
  } catch (err) {
    console.error('[main] song:create-map error:', err)
    return { success: false, error: err.message }
  }
})

