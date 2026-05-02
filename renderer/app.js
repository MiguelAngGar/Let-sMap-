/**
 * app.js — entry point
 * ─────────────────────────────────────────────────────────────────────────────
 * Owns:
 *   • View switching (drop ↔ BPM validation)
 *   • Drop zone interactions
 *   • Settings modal
 *
 * Delegates audio + metronome to BpmView (bpm-view.js / audio-engine.js).
 */

/* global BpmView */

// ── Platform ──────────────────────────────────────────────────────────────
if (window.api.platform === 'darwin') {
  document.body.classList.add('macos')
}

// ── DOM refs ──────────────────────────────────────────────────────────────
const viewDrop     = document.getElementById('view-drop')
const viewBpm      = document.getElementById('view-bpm')
const dropZone     = document.getElementById('drop-zone')
const statusBar    = document.getElementById('status-bar')

const settingsBtn  = document.getElementById('settings-btn')
const modalOverlay = document.getElementById('modal-overlay')
const modalClose   = document.getElementById('modal-close')
const browseBtn    = document.getElementById('browse-btn')
const cancelBtn    = document.getElementById('cancel-btn')
const saveBtn      = document.getElementById('save-btn')
const exportDirEl  = document.getElementById('export-dir')
const mapperNameEl = document.getElementById('mapper-name')

// ── File extension guard ──────────────────────────────────────────────────
const ALLOWED_EXT = new Set(['.mp3', '.wav', '.flac', '.ogg', '.m4a', '.aif', '.aiff'])

function extOf(filename) {
  const i = filename.lastIndexOf('.')
  return i !== -1 ? filename.slice(i).toLowerCase() : ''
}

// ═══════════════════════════════════════════════════════════════════════════
// VIEW SWITCHING
// ═══════════════════════════════════════════════════════════════════════════

function showView(name) {
  viewDrop.classList.toggle('active', name === 'drop')
  viewBpm.classList.toggle('active',  name === 'bpm')
}

// ═══════════════════════════════════════════════════════════════════════════
// DROP ZONE
// ═══════════════════════════════════════════════════════════════════════════

function setDropState(state, message = '') {
  dropZone.className    = state || ''
  statusBar.textContent = message
}

// Prevent browser from hijacking file drops
document.addEventListener('dragover', e => e.preventDefault())
document.addEventListener('drop',     e => e.preventDefault())

dropZone.addEventListener('dragenter', (e) => {
  e.preventDefault()
  setDropState('drag-over')
})

dropZone.addEventListener('dragleave', (e) => {
  if (!dropZone.contains(e.relatedTarget)) setDropState('')
})

dropZone.addEventListener('dragover', (e) => {
  e.preventDefault()
  e.dataTransfer.dropEffect = 'copy'
})

dropZone.addEventListener('drop', async (e) => {
  e.preventDefault()

  const file = e.dataTransfer.files[0]
  if (!file) return

  const ext = extOf(file.name)
  if (!ALLOWED_EXT.has(ext)) {
    setDropState('error', `Unsupported format: ${ext || '(unknown)'}`)
    setTimeout(() => setDropState(''), 3500)
    return
  }

  setDropState('processing', `Analyzing "${file.name}"…`)

  // Phase 1: convert + detect BPM (fast — doesn't fetch anything yet)
  const res = await window.api.analyzeSong(file.path)

  if (!res.success) {
    setDropState('error', `Error: ${res.error}`)
    setTimeout(() => setDropState(''), 5000)
    return
  }

  // Switch to BPM validation view
  setDropState('')
  showView('bpm')
  await BpmView.show({
    oggPath:      res.oggPath,
    analysis:     res.analysis,
    candidates:   res.candidates,
    originalName: res.originalName
  })
})

// Pipeline progress while in the drop view (phase 1 steps)
window.api.onProgress(({ step, msg }) => {
  if (viewDrop.classList.contains('active')) {
    statusBar.textContent = msg || step
  }
})

// ═══════════════════════════════════════════════════════════════════════════
// BPM VIEW — callbacks
// ═══════════════════════════════════════════════════════════════════════════

BpmView.init({
  // User clicked "Create Map" — phase 2 completed successfully
  onCreateMap: (result) => {
    showView('drop')
    setDropState('success', `✓ Ready — ${result.outputDir}`)
    setTimeout(() => setDropState(''), 8000)
  },

  // User clicked "Cancel" — return to drop zone
  onCancel: () => {
    BpmView.hide()
    showView('drop')
    setDropState('')
  }
})

// ═══════════════════════════════════════════════════════════════════════════
// SETTINGS MODAL
// ═══════════════════════════════════════════════════════════════════════════

let savedSettings = {}

async function loadSettings() {
  savedSettings          = await window.api.getSettings()
  exportDirEl.value      = savedSettings.exportDir  || ''
  mapperNameEl.value     = savedSettings.mapperName || ''
}

function openSettings() {
  exportDirEl.value  = savedSettings.exportDir  || ''
  mapperNameEl.value = savedSettings.mapperName || ''
  modalOverlay.classList.remove('hidden')
  mapperNameEl.focus()
}

function closeSettings() {
  modalOverlay.classList.add('hidden')
}

async function saveSettings() {
  savedSettings = await window.api.saveSettings({
    exportDir:  exportDirEl.value.trim(),
    mapperName: mapperNameEl.value.trim()
  })
  closeSettings()
}

settingsBtn .addEventListener('click', openSettings)
modalClose  .addEventListener('click', closeSettings)
cancelBtn   .addEventListener('click', closeSettings)
saveBtn     .addEventListener('click', saveSettings)
browseBtn   .addEventListener('click', async () => {
  const chosen = await window.api.selectFolder()
  if (chosen) exportDirEl.value = chosen
})

modalOverlay.addEventListener('click', (e) => {
  if (e.target === modalOverlay) closeSettings()
})

document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && !modalOverlay.classList.contains('hidden')) closeSettings()
})

mapperNameEl.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') saveSettings()
})

// ═══════════════════════════════════════════════════════════════════════════
// INIT
// ═══════════════════════════════════════════════════════════════════════════
loadSettings()
showView('drop')
