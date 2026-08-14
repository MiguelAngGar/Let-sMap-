'use strict'
/**
 * beatsaber-detect.js — auto-detect the local Beat Saber installation.
 *
 * Detection strategy mirrors ChroMapper's FirstBootMenu (Windows only):
 *
 *  Steam:
 *   1. HKLM\SOFTWARE\Microsoft\Windows\CurrentVersion\Uninstall\Steam App 620980
 *      → InstallLocation  (exists on fresh installs)
 *   2. HKLM\SOFTWARE\Wow6432Node\Valve\Steam → InstallPath, then walk every
 *      Steam library in steamapps/libraryfolders.vdf looking for
 *      appmanifest_620980.acf → steamapps/common/<installdir>
 *
 *  Oculus/Meta:
 *   3. HKLM\SOFTWARE\WOW6432Node\Oculus VR, LLC\Oculus\Config → InitialAppLibrary
 *      → Software\hyperbolic-magnetism-beat-saber
 *   4. HKLM\SOFTWARE\WOW6432Node\Oculus VR, LLC\Oculus → Base
 *      → Software\Software\hyperbolic-magnetism-beat-saber
 *   5. HKCU\Software\Oculus VR, LLC\Oculus\Libraries\<guid> → OriginalPath
 *      → Software\hyperbolic-magnetism-beat-saber
 *
 * Registry is read via `reg query` (no native modules needed).
 */

const { execFile } = require('child_process')
const path = require('path')
const fs = require('fs')

const STEAM_APP_ID = '620980'
const OCULUS_BS_FOLDER = 'hyperbolic-magnetism-beat-saber'

// ── reg query helpers ─────────────────────────────────────────────────────────

/** Read a single registry value. Resolves to string or null. */
function regValue(key, value) {
  return new Promise(resolve => {
    execFile('reg', ['query', key, '/v', value], { windowsHide: true }, (err, stdout) => {
      if (err || !stdout) return resolve(null)
      // Output line: "    InstallLocation    REG_SZ    C:\...\Beat Saber"
      const m = stdout.match(/REG_(?:EXPAND_)?SZ\s+(.+)/)
      resolve(m ? m[1].trim() : null)
    })
  })
}

/** List subkey names of a registry key. Resolves to string[] (may be empty). */
function regSubKeys(key) {
  return new Promise(resolve => {
    execFile('reg', ['query', key], { windowsHide: true }, (err, stdout) => {
      if (err || !stdout) return resolve([])
      const keys = stdout.split(/\r?\n/)
        .map(l => l.trim())
        .filter(l => l.toUpperCase().startsWith('HKEY_'))
        .filter(l => l.length > key.length)
      resolve(keys)
    })
  })
}

// ── Validation ────────────────────────────────────────────────────────────────

/** A directory counts as a Beat Saber install if the game files are there. */
function isBeatSaberDir(dir) {
  try {
    if (!dir || !fs.existsSync(dir)) return false
    return fs.existsSync(path.join(dir, 'Beat Saber.exe')) ||
           fs.existsSync(path.join(dir, 'Beat Saber_Data'))
  } catch {
    return false
  }
}

// ── Steam ─────────────────────────────────────────────────────────────────────

async function detectSteamSimple() {
  const dir = await regValue(
    `HKLM\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\Steam App ${STEAM_APP_ID}`,
    'InstallLocation'
  )
  return isBeatSaberDir(dir) ? dir : null
}

async function detectSteamLibraries() {
  const steamRoot = await regValue('HKLM\\SOFTWARE\\Wow6432Node\\Valve\\Steam', 'InstallPath')
  if (!steamRoot) return null

  const libraries = [steamRoot]
  const vdfPath = path.join(steamRoot, 'steamapps', 'libraryfolders.vdf')
  try {
    const vdf = fs.readFileSync(vdfPath, 'utf8')
    // Old format:  "1"    "D:\\SteamLibrary"   ·   New format:  "path"  "D:\\SteamLibrary"
    const re = /"(?:\d+|path)"\s+"([^"]+)"/gi
    let m
    while ((m = re.exec(vdf)) !== null) {
      const lib = m[1].replace(/\\\\/g, '\\')
      if (fs.existsSync(lib) && !libraries.includes(lib)) libraries.push(lib)
    }
  } catch { /* no extra libraries */ }

  for (const lib of libraries) {
    const manifest = path.join(lib, 'steamapps', `appmanifest_${STEAM_APP_ID}.acf`)
    try {
      const acf = fs.readFileSync(manifest, 'utf8')
      const m = acf.match(/"installdir"\s+"([^"]+)"/i)
      if (!m) continue
      const dir = path.join(lib, 'steamapps', 'common', m[1])
      if (isBeatSaberDir(dir)) return dir
    } catch { /* not in this library */ }
  }
  return null
}

// ── Oculus ────────────────────────────────────────────────────────────────────

const OCULUS_KEY = 'HKLM\\SOFTWARE\\WOW6432Node\\Oculus VR, LLC\\Oculus'

async function detectOculus() {
  // Older installs: InitialAppLibrary
  const initial = await regValue(`${OCULUS_KEY}\\Config`, 'InitialAppLibrary')
  if (initial) {
    const dir = path.join(initial, 'Software', OCULUS_BS_FOLDER)
    if (isBeatSaberDir(dir)) return dir
  }

  // Newer installs: Base → Software\Software\<app>
  const base = await regValue(OCULUS_KEY, 'Base')
  if (base) {
    const dir = path.join(base, 'Software', 'Software', OCULUS_BS_FOLDER)
    if (isBeatSaberDir(dir)) return dir
  }

  // Any additional Oculus library locations
  const libKeys = await regSubKeys('HKCU\\Software\\Oculus VR, LLC\\Oculus\\Libraries')
  for (const key of libKeys) {
    const orig = await regValue(key, 'OriginalPath')
    if (!orig) continue
    const dir = path.join(orig, 'Software', OCULUS_BS_FOLDER)
    if (isBeatSaberDir(dir)) return dir
  }
  return null
}

// ── Public API ────────────────────────────────────────────────────────────────

/**
 * Detect the Beat Saber installation directory.
 * @returns {Promise<string|null>} install dir, or null if not found / not Windows
 */
async function detectBeatSaber() {
  if (process.platform !== 'win32') return null
  try {
    return (await detectSteamSimple()) ||
           (await detectSteamLibraries()) ||
           (await detectOculus())
  } catch (err) {
    console.error('[beatsaber-detect]', err)
    return null
  }
}

/**
 * The folder where WIP maps should be exported for a given install.
 * Created if missing. Returns null if it can't be created.
 * @param {string} installDir
 * @returns {string|null}
 */
function wipLevelsFolder(installDir) {
  const wip = path.join(installDir, 'Beat Saber_Data', 'CustomWIPLevels')
  try {
    fs.mkdirSync(wip, { recursive: true })
    return wip
  } catch {
    return null
  }
}

module.exports = { detectBeatSaber, wipLevelsFolder }
