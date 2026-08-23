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
const metroSoundEl = document.getElementById('metro-sound')
const leadInEl     = document.getElementById('lead-in-seconds')
const coldEndEl    = document.getElementById('cold-end-seconds')
const silenceNoteEl = document.getElementById('silence-note')

// ScoreSaber ranking criteria: intro ≥ 1.5 s, outro > 2 s and < 15 s
const CRITERIA_LEAD_IN  = 1.5
const CRITERIA_COLD_END = 2.0
const SILENCE_MAX       = 15

/** Show one line of feedback under the two fields, or nothing. */
function _setSilenceNote(key, vars) {
  if (!silenceNoteEl) return
  if (!key) {
    silenceNoteEl.classList.add('hidden')
    silenceNoteEl.removeAttribute('data-i18n')
    silenceNoteEl.textContent = ''
    return
  }
  // Keep the key on the element so a language change re-renders it
  silenceNoteEl.setAttribute('data-i18n', key)
  silenceNoteEl.textContent = t(key, vars)
  silenceNoteEl.classList.remove('hidden')
}

/**
 * Explain whatever is off about the two values: out of range first (the app is
 * about to change what you typed), then the ranking criteria.
 *
 * With clamp = true the fields are rewritten to the value that will actually be
 * stored, so nothing is silently corrected behind the user's back on save.
 */
function syncSilenceNote({ clamp = false } = {}) {
  // Each field with the value it falls back to when left empty
  const fields = [[leadInEl, CRITERIA_LEAD_IN], [coldEndEl, CRITERIA_COLD_END]]
    .filter(([el]) => el)
  let outOfRange = false

  for (const [el, fallback] of fields) {
    // Mid-typing an empty field is fine; on the way out it gets its default
    // back, so what is stored is never different from what is on screen.
    if (el.value.trim() === '') {
      el.classList.remove('out-of-range')
      if (clamp) el.value = String(fallback)
      continue
    }

    const raw = parseFloat(el.value)
    const bad = !Number.isFinite(raw) || raw < 0 || raw > SILENCE_MAX
    el.classList.toggle('out-of-range', bad)
    if (!bad) continue
    outOfRange = true
    if (clamp) {
      const fixed = !Number.isFinite(raw) ? fallback : Math.min(SILENCE_MAX, Math.max(0, raw))
      el.value = String(Math.round(fixed * 100) / 100)
      el.classList.remove('out-of-range')
    }
  }

  // Explain the range whether we just corrected it or the user is still typing
  if (outOfRange) return _setSilenceNote('settings.silence_range', { max: SILENCE_MAX })

  const lead = parseFloat(leadInEl?.value)
  const cold = parseFloat(coldEndEl?.value)

  const below = (Number.isFinite(lead) && lead < CRITERIA_LEAD_IN) ||
                (Number.isFinite(cold) && cold < CRITERIA_COLD_END)
  _setSilenceNote(below ? 'settings.silence_warn' : null,
                  { lead: CRITERIA_LEAD_IN, cold: CRITERIA_COLD_END })
}
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
  fitWindow()
}

// ═══════════════════════════════════════════════════════════════════════════
// WINDOW AUTO-FIT
// ═══════════════════════════════════════════════════════════════════════════
//
// The screens are not the same height, and the BPM one changes as the criteria
// notes come and go. A window sized for the worst case is a mostly-empty box the
// rest of the time, so the renderer measures what the active view actually needs
// and the main process resizes to that (clamped, and dropped entirely once the
// user resizes by hand).
//
// The measurement is the sum of the visible children plus gaps and padding.
// Margins are deliberately left out: .bpm-actions has margin-top:auto, whose
// used value IS the leftover space we are trying to get rid of — counting it
// would make the window grow every time it was measured.

let _fitQueued = false

function fitWindow() {
  if (_fitQueued || !window.api?.fitHeight) return
  _fitQueued = true

  // Two frames: one for the class change, one for the layout it causes
  requestAnimationFrame(() => requestAnimationFrame(() => {
    _fitQueued = false

    const view = document.querySelector('.view.active')
    if (!view) return

    const cs  = getComputedStyle(view)
    const gap = parseFloat(cs.rowGap || cs.gap || '0') || 0
    let h = parseFloat(cs.paddingTop || 0) + parseFloat(cs.paddingBottom || 0)

    const kids = Array.from(view.children)
      .filter(el => getComputedStyle(el).display !== 'none')
    kids.forEach((el, i) => {
      h += el.getBoundingClientRect().height + (i ? gap : 0)
    })

    const header = document.getElementById('titlebar')
    const chrome = header ? header.getBoundingClientRect().height : 0

    window.api.fitHeight(Math.ceil(h + chrome + 6))   // 6 px of slack for margins
  }))
}

window.fitWindow = fitWindow

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
    originalName: res.originalName,
    // The preview must show the same silence the export will add
    minLead:      savedSettings?.leadInSeconds ?? 1.5,
    // For the outro read-out: what the song already has, and what we aim for
    trailingSilence: res.trailingSilence ?? 0,
    coldEnd:         res.coldEnd ?? savedSettings?.coldEndSeconds ?? 2
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
  if (metroSoundEl)  metroSoundEl.value = savedSettings.metroSound || 'click'
  if (leadInEl)      leadInEl.value  = String(savedSettings.leadInSeconds  ?? 1.5)
  if (coldEndEl)     coldEndEl.value = String(savedSettings.coldEndSeconds ?? 2)
  syncSilenceNote()
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
  if (metroSoundEl)  metroSoundEl.value = savedSettings.metroSound || 'click'
  if (leadInEl)      leadInEl.value  = String(savedSettings.leadInSeconds  ?? 1.5)
  if (coldEndEl)     coldEndEl.value = String(savedSettings.coldEndSeconds ?? 2)
  syncSilenceNote()
  if (langSelectEl)  langSelectEl.value = savedSettings.language || 'system'
  // Choosing a metronome voice plays it, so a song running behind the panel
  // would be competing with the preview: pause it and pick it up on the way out
  window.BpmView?.suspendPlayback?.()
  modalOverlay.classList.remove('hidden')
  mapperNameEl.focus()
}

function closeSettings() {
  modalOverlay.classList.add('hidden')
  // Back to playing, with whatever voice is now configured
  window.BpmView?.resumePlayback?.()
}

async function saveSettings() {
  // Bring any out-of-range value into range in the visible field first
  syncSilenceNote({ clamp: true })
  const newLang = langSelectEl ? langSelectEl.value : 'system'
  savedSettings = await window.api.saveSettings({
    exportDir:  exportDirEl.value.trim(),
    exportDirAuto: exportDirFromAuto,
    mapperName: mapperNameEl.value.trim(),
    oggQuality: oggQualityEl ? parseInt(oggQualityEl.value, 10) : 10,
    metroSound: metroSoundEl ? metroSoundEl.value : 'click',
    leadInSeconds:  leadInEl  ? parseFloat(leadInEl.value)  : 1.5,
    coldEndSeconds: coldEndEl ? parseFloat(coldEndEl.value) : 2,
    language:   newLang
  })
  window.i18n.setLang(newLang)
  // A song may already be loaded behind the modal — switch its voice live
  window.BpmView?.setMetroSound?.(savedSettings.metroSound || 'click')
  closeSettings()
}

settingsBtn .addEventListener('click', openSettings)
modalClose  .addEventListener('click', closeSettings)
cancelBtn   .addEventListener('click', closeSettings)
saveBtn     .addEventListener('click', saveSettings)
// Picking a metronome voice plays it — choosing a sound you cannot hear is
// pointless, and the preview needs no song loaded (see AudioEngine.previewSound)
metroSoundEl?.addEventListener('change', () => {
  const sound = metroSoundEl.value
  // Prefer the loaded song's own audio context; only fall back to a standalone
  // one when there is nothing loaded (no song = no context to borrow)
  try {
    if (window.BpmView?.previewMetro?.(sound)) return
    const vol = (savedSettings.metroVolume ?? 80) / 100
    window.AudioEngine?.previewSound?.(sound, vol)
  } catch (_) {}
})
leadInEl   ?.addEventListener('input',  () => syncSilenceNote())
coldEndEl  ?.addEventListener('input',  () => syncSilenceNote())
leadInEl   ?.addEventListener('change', () => syncSilenceNote({ clamp: true }))
coldEndEl  ?.addEventListener('change', () => syncSilenceNote({ clamp: true }))
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
