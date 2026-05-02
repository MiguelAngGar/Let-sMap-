const fs = require('fs')
const path = require('path')
const os = require('os')

const SETTINGS_PATH = path.join(os.homedir(), '.letsmap', 'settings.json')

function load() {
  try {
    return JSON.parse(fs.readFileSync(SETTINGS_PATH, 'utf8'))
  } catch {
    return {}
  }
}

function get(key) {
  return load()[key]
}

function set(key, value) {
  const data = load()
  data[key] = value
  fs.mkdirSync(path.dirname(SETTINGS_PATH), { recursive: true })
  fs.writeFileSync(SETTINGS_PATH, JSON.stringify(data, null, 2))
}

module.exports = { get, set }
