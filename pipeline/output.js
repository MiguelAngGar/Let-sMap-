const fs   = require('fs')
const path = require('path')

/** Strip characters illegal in folder names */
function sanitize(name) {
  return (name || 'Unknown').replace(/[<>:"/\\|?*\x00-\x1f]/g, '_').trim() || 'Unknown'
}

/** Find a non-conflicting output path: "Name", "Name (2)", "Name (3)", … */
function uniqueDir(base) {
  if (!fs.existsSync(base)) return base
  let n = 2
  while (fs.existsSync(`${base} (${n})`)) n++
  return `${base} (${n})`
}

/**
 * Write final Beat Saber project folder.
 * Contents: Info.dat, song.ogg, cover.jpg
 *
 * @param {object} opts
 * @param {string} opts.audioPath
 * @param {string} opts.coverPath
 * @param {{ title, artist, album }} opts.meta
 * @param {{ bpm, final_offset }} opts.analysis
 * @param {string} opts.exportDir
 * @param {string} opts.mapperName
 * @returns {{ outputDir: string }}
 */
async function generate({ audioPath, coverPath, meta, analysis, exportDir, mapperName }) {
  // Build a clean folder name: "Artist - Title" or just "Title"
  const parts = [meta.artist, meta.title].filter(Boolean).map(sanitize)
  const folderName = parts.length > 1 ? parts.join(' - ') : (parts[0] || 'Unknown Song')
  const outputDir  = uniqueDir(path.join(exportDir, folderName))

  fs.mkdirSync(outputDir, { recursive: true })

  // ── song.ogg ──────────────────────────────────────────────────────────────
  fs.copyFileSync(audioPath, path.join(outputDir, 'song.ogg'))

  // ── cover.jpg ─────────────────────────────────────────────────────────────
  if (coverPath && fs.existsSync(coverPath)) {
    fs.copyFileSync(coverPath, path.join(outputDir, 'cover.jpg'))
  }

  // ── Info.dat ──────────────────────────────────────────────────────────────
  // Beat Saber v2.1.0 format. No difficulty sets — user will add those.
  const info = {
    _version:             '2.1.0',
    _songName:            meta.title  || '',
    _songSubName:         '',
    _songAuthorName:      meta.artist || '',
    _levelAuthorName:     mapperName  || '',
    _beatsPerMinute:      analysis.bpm,
    _shuffle:             0,
    _shufflePeriod:       0.5,
    _previewStartTime:    12,
    _previewDuration:     10,
    _songFilename:        'song.ogg',
    _coverImageFilename:  coverPath ? 'cover.jpg' : '',
    _environmentName:     'DefaultEnvironment',
    _allDirectionsEnvironmentName: 'GlassDesertEnvironment',
    _songTimeOffset:      0,
    _customData: {
      _contributors: [],
      _editors: {
        LetsMap: { version: '0.1.0' }
      }
    },
    _difficultyBeatmapSets: []
  }

  fs.writeFileSync(
    path.join(outputDir, 'Info.dat'),
    JSON.stringify(info, null, 2),
    'utf8'
  )

  return { outputDir }
}

module.exports = { generate }
