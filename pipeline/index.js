const path = require('path')
const os   = require('os')

const converter = require('./converter')
const analyzer  = require('./analyzer')
const metadata  = require('./metadata')
const cover     = require('./cover')
const output    = require('./output')

/**
 * Full pipeline: input file → Beat Saber ready folder.
 *
 * @param {string}        inputPath        Absolute path to the dropped audio file
 * @param {BrowserWindow} win              Electron window for progress events (optional)
 * @param {object}        settings
 * @param {string}        settings.exportDir   Where to save the output folder
 * @param {string}        settings.mapperName  Mapper name written into Info.dat
 * @returns {Promise<{ outputDir: string }>}
 */
async function run(inputPath, win, settings = {}) {
  const exportDir  = settings.exportDir  || path.join(os.homedir(), 'Documents', 'BeatSaberMaps')
  const mapperName = settings.mapperName || ''

  const send = (step, message) => {
    console.log(`[${step}] ${message}`)
    if (win) win.webContents.send('pipeline-progress', { step, message })
  }

  // 1. Convert to .ogg
  send('convert', 'Converting audio to .ogg…')
  const oggPath = await converter.toOgg(inputPath)

  // 2. Analyse (Python) → BPM + first beat + silence amount
  send('analyze', 'Detecting BPM and first beat…')
  const analysis = await analyzer.analyze(oggPath)

  // 3. Prepend silence so beat 1 lands on grid and has ≥1.5s lead-in
  send('silence', `Adding ${analysis.silence_pad.toFixed(3)}s silence…`)
  const paddedPath = await converter.addSilence(oggPath, analysis.silence_pad)

  // 4. Fetch metadata
  send('metadata', 'Fetching song metadata…')
  const songName = path.basename(inputPath, path.extname(inputPath))
  const meta = await metadata.fetch(songName)

  // 5. Fetch + resize cover
  send('cover', 'Fetching cover image…')
  const coverPath = await cover.fetch(meta.artist, meta.title)

  // 6. Write Beat Saber folder
  send('output', 'Generating Beat Saber folder…')
  const result = await output.generate({ audioPath: paddedPath, coverPath, meta, analysis, exportDir, mapperName })

  send('done', `Done → ${result.outputDir}`)
  return result
}

module.exports = { run }
