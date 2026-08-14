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

/* global BpmView, MetaView */

// ── Platform ──────────────────────────────────────────────────────────────
if (window.api.platform === 'darwin') {
  document.body.classList.add('macos')
}

// ── DOM refs ──────────────────────────────────────────────────────────────
const viewDrop     = document.getElementById('view-drop')
const viewBpm      = document.getElementById('view-bpm')
const viewMeta     = document.getElementById('view-meta')
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
const oggQualityEl = document.getElementById('ogg-quality')
const matchQualEl  = document.getElementById('match-quality')
const detectBtn    = document.getElementById('detect-btn')
const detectHintEl = document.getElementById('detect-hint')

// Beat Saber auto-detection is Windows-only (Steam/Oculus registry)
if (window.api.platform !== 'win32' && detectBtn) detectBtn.classList.add('hidden')

// True while the export-dir field holds a value coming from auto-detection —
// saving it then must NOT mark the folder as user-chosen, so future app
// launches keep tracking the Beat Saber install until the user picks a
// folder manually.
let exportDirFromAuto = false

function hideDetectHint() {
  if (!detectHintEl) return
  detectHintEl.classList.add('hidden')
  detectHintEl.classList.remove('ok', 'err')
}

// Grey out the fixed-quality dropdown while "keep original quality" is on
function syncQualityToggle() {
  if (oggQualityEl && matchQualEl) oggQualityEl.disabled = matchQualEl.checked
}

// ── File extension guard ──────────────────────────────────────────────────
const ALLOWED_EXT = new Set(['.mp3', '.wav', '.flac', '.ogg', '.m4a', '.aif', '.aiff'])

// ── Analysis loading messages ─────────────────────────────────────────────

// Loading messages are themed per analysis engine: the legacy Python engine
// jokes about madmom/neural networks; the JS engine gets its own set.
let _analysisMsgsKey = 'analysis.msgs_av'
window.api.getEngine?.().then(engine => {
  _analysisMsgsKey = engine === 'madmom' ? 'analysis.msgs' : 'analysis.msgs_av'
}).catch(() => {})

let _analysisTimer = null

function startAnalysisMessages(filename) {
  // Clear any previously running timer before starting a new sequence
  clearTimeout(_analysisTimer)

  let pool = [...tArr(_analysisMsgsKey)].sort(() => Math.random() - 0.5)
  let idx  = 0

  function showNext() {
    if (idx >= pool.length) { pool = [...tArr(_analysisMsgsKey)].sort(() => Math.random() - 0.5); idx = 0 }
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
  viewMeta?.classList.toggle('active', name === 'meta')
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

// Shared analysis flow for both entry points (drop + file picker)
async function processSongFile(filePath, fileName) {
  startAnalysisMessages(fileName)

  // Phase 1: convert + detect BPM (fast — doesn't fetch anything yet)
  const res = await window.api.analyzeSong(filePath)
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
}

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

  await processSongFile(file.path, file.name)
})

// Click on the drop zone → native file picker (same flow as dropping)
dropZone.addEventListener('click', async () => {
  if (dropZone.classList.contains('processing')) return
  const filePath = await window.api.selectSongFile()
  if (!filePath) return
  const fileName = filePath.split(/[\\/]/).pop()
  await processSongFile(filePath, fileName)
})

// Pipeline progress (phase 2 steps reach bpm-view via its own listener)

// ═══════════════════════════════════════════════════════════════════════════
// BPM VIEW — callbacks
// ═══════════════════════════════════════════════════════════════════════════

// Shared success handler — map folder generated
function onMapCreated(result) {
  BpmView.hide()
  showView('drop')
  setDropState('success', `✓ Ready — ${result.outputDir}`)
  setTimeout(() => setDropState(''), 8000)
}

BpmView.init({
  // User clicked "Create Map" — confident match, phase 2 completed
  onCreateMap: onMapCreated,

  // User clicked "Cancel" — return to drop zone
  onCancel: () => {
    BpmView.hide()
    showView('drop')
    setDropState('')
  },

  // Auto-detection unsure — show metadata confirmation screen
  onNeedMeta: (data) => {
    showView('meta')
    MetaView.show(data)
  }
})

MetaView.init({
  // Map created from the confirmation screen
  onCreated: onMapCreated,

  // Back to BPM view (engine state is untouched — view was only hidden)
  onBack: () => showView('bpm')
})

// ═══════════════════════════════════════════════════════════════════════════
// SETTINGS MODAL
// ═══════════════════════════════════════════════════════════════════════════

let savedSettings = {}

async function loadSettings() {
  savedSettings      = await window.api.getSettings()
  exportDirEl.value  = savedSettings.exportDir  || ''
  exportDirEl.title  = exportDirEl.value
  mapperNameEl.value = savedSettings.mapperName || ''
  if (oggQualityEl)  oggQualityEl.value = String(savedSettings.oggQuality ?? 10)
  if (matchQualEl)   matchQualEl.checked = savedSettings.matchSourceQuality ?? true
  syncQualityToggle()
  // Apply persisted language
  const lang = savedSettings.language || 'system'
  window.i18n.setLang(lang)
  if (langSelectEl) langSelectEl.value = lang
}

async function openSettings() {
  exportDirFromAuto = false
  hideDetectHint()
  // Re-fetch: the main process may have auto-detected a new export folder
  // after the initial loadSettings() (it runs async on boot).
  savedSettings = await window.api.getSettings()
  exportDirEl.value  = savedSettings.exportDir  || ''
  exportDirEl.title  = exportDirEl.value
  mapperNameEl.value = savedSettings.mapperName || ''
  if (oggQualityEl)  oggQualityEl.value = String(savedSettings.oggQuality ?? 10)
  if (matchQualEl)   matchQualEl.checked = savedSettings.matchSourceQuality ?? true
  syncQualityToggle()
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
    exportDirAuto: exportDirFromAuto,
    mapperName: mapperNameEl.value.trim(),
    oggQuality: oggQualityEl ? parseInt(oggQualityEl.value, 10) : 10,
    matchSourceQuality: matchQualEl ? matchQualEl.checked : true,
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
  if (chosen) {
    exportDirEl.value = chosen
    exportDirEl.title = chosen
    exportDirFromAuto = false
    hideDetectHint()
  }
})

// The path can also be typed manually — typing makes it a user choice
exportDirEl.addEventListener('input', () => {
  exportDirFromAuto = false
  exportDirEl.title = exportDirEl.value
  hideDetectHint()
})

detectBtn?.addEventListener('click', async () => {
  detectBtn.disabled = true
  const found = await window.api.detectBeatSaber()
  detectBtn.disabled = false
  if (!detectHintEl) return
  detectHintEl.classList.remove('hidden', 'ok', 'err')
  if (found) {
    exportDirEl.value = found
    exportDirEl.title = found
    exportDirFromAuto = true
    detectHintEl.textContent = t('settings.autodetect_found')
    detectHintEl.classList.add('ok')
  } else {
    detectHintEl.textContent = t('settings.autodetect_none')
    detectHintEl.classList.add('err')
  }
})
if (matchQualEl) matchQualEl.addEventListener('change', syncQualityToggle)

// Close on overlay click — but only if the press STARTED on the overlay.
// Otherwise selecting text inside the panel and releasing the mouse outside
// it (mousedown inside → mouseup on the overlay) would close the settings.
let _overlayPressed = false
modalOverlay.addEventListener('mousedown', (e) => {
  _overlayPressed = (e.target === modalOverlay)
})
modalOverlay.addEventListener('click', (e) => {
  if (e.target === modalOverlay && _overlayPressed) closeSettings()
  _overlayPressed = false
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
