const { contextBridge, ipcRenderer } = require('electron')
const { pathToFileURL }              = require('url')

contextBridge.exposeInMainWorld('api', {

  // Runtime platform — renderer uses this for OS-specific styles
  platform: process.platform,

  // Convert an absolute filesystem path to a file:// URL.
  // Uses Node's pathToFileURL which handles Windows backslashes,
  // spaces, and other edge cases correctly.
  fileUrl: (absPath) => pathToFileURL(absPath).href,

  // ── Pipeline ──────────────────────────────────────────────────────────────

  // Phase 1: convert + analyze → returns oggPath, analysis, candidates
  analyzeSong: (filePath) => ipcRenderer.invoke('song:analyze', filePath),

  // Native file picker for the drop zone (click-to-browse) → path or null
  selectSongFile: () => ipcRenderer.invoke('song:select-file'),

  // Metadata resolution: embedded tags first, online lookup only as fallback
  // (runs after BPM confirmation). Pass { filePath, originalName }.
  fetchMeta: (data) => ipcRenderer.invoke('song:fetch-meta', data),

  // Open image picker → returns processed 512×512 cover path, or null
  selectCover: () => ipcRenderer.invoke('meta:select-cover'),

  // Dropped image (local path, file:// / http(s) / data: URL) → processed
  // 512×512 cover path, or null when it could not be read
  coverFromDrop: (src) => ipcRenderer.invoke('meta:cover-from-drop', src),

  // Phase 2: finalize with confirmed BPM + modifiers (+ optional meta/cover
  // overrides from the confirmation screen) → returns outputDir
  createMap: (data) => ipcRenderer.invoke('song:create-map', data),

  // Ask the window to be exactly as tall as the active view needs, so no screen
  // is a mostly-empty box (the BPM view changes height as notes appear)
  fitHeight: (px) => ipcRenderer.invoke('window:fit-height', px),

  // Step-by-step progress events from the pipeline
  onProgress: (cb) => ipcRenderer.on('pipeline-progress', (_e, d) => cb(d)),

  // Which analysis engine is active ('arrowvortex' | 'madmom') — used to pick
  // the themed loading messages.
  getEngine: () => ipcRenderer.invoke('app:get-engine'),

  // ── Settings ──────────────────────────────────────────────────────────────
  getSettings:  ()     => ipcRenderer.invoke('settings:get'),
  detectBeatSaber: ()  => ipcRenderer.invoke('settings:detect-beatsaber'),
  saveSettings: (data) => ipcRenderer.invoke('settings:save', data),
  selectFolder: ()     => ipcRenderer.invoke('settings:select-folder')
})
