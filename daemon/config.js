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
  // Kept equal to FALLBACK_SITES in extension/policy.js — see the note there.
  sites: ['reddit.com', 'youtube.com', 'x.com', 'instagram.com'],
  sounds: {
    enabled: true,
    workEnd: 'alarm-clock-elapsed',   // assertive: it is asking you to come back
    breakEnd: 'complete',             // softer: you are already at the desk
  },
}

export function mergeConfig(raw) {
  const out = { ...DEFAULTS }
  if (!raw || typeof raw !== 'object') return out
  for (const key of Object.keys(DEFAULTS)) {
    if (raw[key] !== undefined) out[key] = raw[key]
  }
  // `sounds` is nested config, not a flat scalar. The loop above just copied it
  // WHOLESALE if present — fine for `port`, wrong for `sounds`: a user who wrote
  // only `{ sounds: { enabled: false } }` to silence notifications would lose
  // workEnd/breakEnd entirely, since nothing else fills them back in. Shallow-merge
  // it against DEFAULTS.sounds instead, one known key at a time, exactly like this
  // function already does for the top level — a partial override should only
  // touch what it names, and a malformed value (not an object, an array, null)
  // falls back to the defaults wholesale rather than partially poisoning it.
  out.sounds = { ...DEFAULTS.sounds }
  if (raw.sounds && typeof raw.sounds === 'object' && !Array.isArray(raw.sounds)) {
    for (const key of Object.keys(DEFAULTS.sounds)) {
      if (raw.sounds[key] !== undefined) out.sounds[key] = raw.sounds[key]
    }
  }
  return out
}

// The path is a parameter so tests can point at a scratch directory. Real
// callers pass nothing and get ~/.config/focus-nudge/config.json.
export function loadConfig(configPath = PATHS.config) {
  try {
    return mergeConfig(JSON.parse(fs.readFileSync(configPath, 'utf8')))
  } catch (err) {
    // A missing file is the normal first run and says nothing. Anything else —
    // malformed json, a permissions problem — means the user's real settings are
    // being ignored, and falling back in total silence is how you end up watching
    // the default list without ever being told. Behaviour is unchanged: the
    // defaults are still used, they are just no longer used quietly.
    if (err.code !== 'ENOENT') {
      console.error(`focus-nudge: could not read ${configPath} (${err.message}); using defaults`)
    }
    return { ...DEFAULTS }
  }
}

export function saveConfig(cfg, configPath = PATHS.config) {
  fs.mkdirSync(path.dirname(configPath), { recursive: true })
  writeAtomic(configPath, JSON.stringify(cfg, null, 2))
}

export function writeAtomic(file, text) {
  const tmp = `${file}.tmp`
  fs.writeFileSync(tmp, text)
  fs.renameSync(tmp, file)
}
