import os from 'node:os'
import path from 'node:path'
import fs from 'node:fs'

export const CONFIG_DIR = path.join(os.homedir(), '.config', 'focus-nudge')

export const PATHS = {
  config: path.join(CONFIG_DIR, 'config.json'),
  state: path.join(CONFIG_DIR, 'state.json'),
  quotes: path.join(CONFIG_DIR, 'quotes.txt'),
  log: path.join(CONFIG_DIR, 'log.jsonl'),
}

export const DEFAULTS = {
  port: 7373,
  workMinutes: 25,
  shortBreakMinutes: 5,
  longBreakMinutes: 20,
  blocksPerCycle: 4,
  graceMinutes: 5,
  countdownSeconds: 10,
  sites: ['reddit.com', 'youtube.com'],
}

export function mergeConfig(raw) {
  const out = { ...DEFAULTS }
  if (!raw || typeof raw !== 'object') return out
  for (const key of Object.keys(DEFAULTS)) {
    if (raw[key] !== undefined) out[key] = raw[key]
  }
  return out
}

export function loadConfig() {
  try {
    return mergeConfig(JSON.parse(fs.readFileSync(PATHS.config, 'utf8')))
  } catch {
    return { ...DEFAULTS }
  }
}

export function saveConfig(cfg) {
  fs.mkdirSync(CONFIG_DIR, { recursive: true })
  writeAtomic(PATHS.config, JSON.stringify(cfg, null, 2))
}

export function writeAtomic(file, text) {
  const tmp = `${file}.tmp`
  fs.writeFileSync(tmp, text)
  fs.renameSync(tmp, file)
}
