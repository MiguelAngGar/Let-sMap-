const path = require('path')
const os   = require('os')

const converter = require('./converter')
const analyzer  = require('./analyzer')
const metaResolve = require('./meta-resolve')
const cover       = require('./cover')
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

  // 4 + 5. Metadata + cover: the file's own tags first, online lookup only
  // when the file has nothing usable.
  const songName = path.basename(inputPath, path.extname(inputPath))
  const resolved = await metaResolve.resolve({
    filePath:     inputPath,
    originalName: songName,
    send
  })
  const meta      = resolved.meta
  // No confirmation screen on this path, so never end up with no artwork.
  const coverPath = resolved.coverPath || await cover.placeholder()

  // 6. Write Beat Saber folder
  send('output', 'Generating Beat Saber folder…')
  const result = await output.generate({ audioPath: paddedPath, coverPath, meta, analysis, exportDir, mapperName })

  send('done', `Done → ${result.outputDir}`)
  return result
}

module.exports = { run }
