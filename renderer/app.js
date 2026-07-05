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
const langSelectEl = document.getElementById('lang-select')

// ── File extension guard ──────────────────────────────────────────────────
const ALLOWED_EXT = new Set(['.mp3', '.wav', '.flac', '.ogg', '.m4a', '.aif', '.aiff'])

// ── Analysis loading messages ─────────────────────────────────────────────

let _analysisTimer = null

function startAnalysisMessages(filename) {
  // Clear any previously running timer before starting a new sequence
  clearTimeout(_analysisTimer)

  let pool = [...tArr('analysis.msgs')].sort(() => Math.random() - 0.5)
  let idx  = 0

  function showNext() {
    if (idx >= pool.length) { pool = [...tArr('analysis.msgs')].sort(() => Math.random() - 0.5); idx = 0 }
    setDropState('processing', pool[idx++])
    _analysisTimer = setTimeout(showNext, 1800 + Math.random() * 2000)
  }

  setDropState('processing', `Analyzing "${filename}"…`)
  _analysisTimer = setTimeout(showNext, 1600)
}

function stopAnalysisMessages() {
  clearTimeout(_analysisTimer)
  _analysisTimer = null
}

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

  startAnalysisMessages(file.name)

  // Phase 1: convert + detect BPM (fast — doesn't fetch anything yet)
  const res = await window.api.analyzeSong(file.path)
  stopAnalysisMessages()

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
    originalPath: res.originalPath,
    analysis:     res.analysis,
    candidates:   res.candidates,
    originalName: res.originalName
  })
})

// Pipeline progress (phase 2 steps reach bpm-view via its own listener)

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
  savedSettings      = await window.api.getSettings()
  exportDirEl.value  = savedSettings.exportDir  || ''
  mapperNameEl.value = savedSettings.mapperName || ''
  // Apply persisted language
  const lang = savedSettings.language || 'system'
  window.i18n.setLang(lang)
  if (langSelectEl) langSelectEl.value = lang
}

function openSettings() {
  exportDirEl.value  = savedSettings.exportDir  || ''
  mapperNameEl.value = savedSettings.mapperName || ''
  if (langSelectEl)  langSelectEl.value = savedSettings.language || 'system'
  modalOverlay.classList.remove('hidden')
  mapperNameEl.focus()
}

function closeSettings() {
  modalOverlay.classList.add('hidden')
}

async function saveSettings() {
  const newLang = langSelectEl ? langSelectEl.value : 'system'
  savedSettings = await window.api.saveSettings({
    exportDir:  exportDirEl.value.trim(),
    mapperName: mapperNameEl.value.trim(),
    language:   newLang
  })
  window.i18n.setLang(newLang)
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
