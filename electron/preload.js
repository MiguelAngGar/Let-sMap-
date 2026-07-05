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

  // Phase 2: finalize with confirmed BPM + modifiers → returns outputDir
  createMap: (data) => ipcRenderer.invoke('song:create-map', data),

  // Step-by-step progress events from the pipeline
  onProgress: (cb) => ipcRenderer.on('pipeline-progress', (_e, d) => cb(d)),

  // ── Settings ──────────────────────────────────────────────────────────────
  getSettings:  ()     => ipcRenderer.invoke('settings:get'),
  saveSettings: (data) => ipcRenderer.invoke('settings:save', data),
  selectFolder: ()     => ipcRenderer.invoke('settings:select-folder')
})
