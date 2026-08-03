// `focus doctor` — diagnostics for a machine where the daemon might be down,
// the unit might never have been installed, or the config might be missing
// entirely. Every check here must tolerate all three: this is exactly the
// state a new user is in when they reach for `doctor` in the first place.
//
// Pure, argument-only functions live at the top so they can be unit tested
// without a systemd user session, a listening daemon, or a real PATH. The
// I/O-performing checks below them are thin wrappers around these.

import fs from 'node:fs'
import net from 'node:net'
import path from 'node:path'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'

const execFileP = promisify(execFile)

// ---- pure helpers (unit tested directly) ----------------------------------

// Accepts "v22.1.0", "22.1.0", or garbage. Returns the major version number,
// or null if none could be found.
export function parseNodeMajor(versionString) {
  const m = String(versionString ?? '').match(/^v?(\d+)/)
  return m ? Number(m[1]) : null
}

export function satisfiesMinNode(versionString, minMajor = 22) {
  const major = parseNodeMajor(versionString)
  return { major, ok: major !== null && major >= minMajor }
}

// `systemctl --user is-enabled <unit>` prints the literal string "not-found"
// (with no stderr) when the unit file does not exist at all — that is how a
// "never installed" unit is told apart from one that is merely disabled.
// Any other non-empty state ("enabled", "disabled", "static", "masked", ...)
// means the unit file is present.
export function interpretIsEnabledOutput(stdout) {
  const state = String(stdout ?? '').trim()
  const installed = state !== 'not-found' && state !== ''
  return { state, installed }
}

export function classifyUnitEnabled(state) {
  return state === 'enabled' ? 'ok' : 'warn'
}

export function classifyUnitActive(state) {
  return state === 'active' ? 'ok' : 'fail'
}

// Resolves `name` against a PATH string by hand rather than shelling out to
// `which` (which is not guaranteed to exist), so this is a pure function of
// its inputs and testable against a scratch PATH and scratch directory.
export function resolveOnPath(name, pathEnv = process.env.PATH ?? '') {
  for (const dir of pathEnv.split(path.delimiter).filter(Boolean)) {
    const candidate = path.join(dir, name)
    try {
      fs.accessSync(candidate, fs.constants.X_OK)
      return candidate
    } catch {
      // not here, keep looking
    }
  }
  return null
}

const STATUS_TAG = { ok: ' ok ', warn: 'warn', fail: 'FAIL' }

export function formatLine(status, label, detail) {
  const tag = STATUS_TAG[status] ?? status
  const head = `[${tag}] ${label}`
  return detail ? `${head.padEnd(34)} ${detail}` : head
}

// ---- I/O-performing checks --------------------------------------------

async function checkSystemctlUser() {
  try {
    const { stdout } = await execFileP('systemctl', ['--user', 'is-system-running'], { encoding: 'utf8' })
    return { ok: true, detail: stdout.trim() || 'running' }
  } catch (err) {
    if (err.code === 'ENOENT') {
      return { ok: false, detail: 'systemctl not found on PATH — this tool needs Linux with systemd' }
    }
    const stderrText = String(err.stderr ?? '')
    if (/failed to connect to bus/i.test(stderrText) || /no such file or directory.*bus/i.test(stderrText)) {
      return { ok: false, detail: 'no systemd user session (Failed to connect to bus)' }
    }
    // is-system-running exits non-zero for "degraded"/"starting" too — that
    // still means systemctl --user itself works, just that some other user
    // unit somewhere is unhappy. Not this tool's problem to report.
    const stdoutText = String(err.stdout ?? '').trim()
    return { ok: true, detail: stdoutText || 'responded' }
  }
}

async function isEnabled(unit) {
  try {
    const { stdout } = await execFileP('systemctl', ['--user', 'is-enabled', unit], { encoding: 'utf8' })
    return interpretIsEnabledOutput(stdout)
  } catch (err) {
    return interpretIsEnabledOutput(err.stdout)
  }
}

async function isActive(unit) {
  try {
    const { stdout } = await execFileP('systemctl', ['--user', 'is-active', unit], { encoding: 'utf8' })
    return stdout.trim()
  } catch (err) {
    return String(err.stdout ?? '').trim()
  }
}

function checkPortListening(port, timeoutMs = 1000) {
  return new Promise(resolve => {
    const socket = net.createConnection({ port, host: '127.0.0.1' })
    const finish = ok => { socket.destroy(); resolve(ok) }
    socket.setTimeout(timeoutMs)
    socket.once('connect', () => finish(true))
    socket.once('timeout', () => finish(false))
    socket.once('error', () => finish(false))
  })
}

async function checkStateEndpoint(port) {
  try {
    const res = await fetch(`http://127.0.0.1:${port}/state`, { signal: AbortSignal.timeout(1500) })
    return res.ok
      ? { ok: true, detail: `HTTP ${res.status}` }
      : { ok: false, detail: `HTTP ${res.status}` }
  } catch (err) {
    return { ok: false, detail: err.message }
  }
}

// ---- orchestration ---------------------------------------------------

// `config` and `repoRoot` are passed in rather than recomputed so this reads
// the port through the exact same `loadConfig()` call the rest of the CLI
// already made — no second, possibly-divergent read of the config file.
export async function runDoctor({ config, repoRoot, paths, log = console.log }) {
  let failed = false
  const report = (status, label, detail) => {
    if (status === 'fail') failed = true
    log(formatLine(status, label, detail))
  }

  // node version
  const node = satisfiesMinNode(process.version)
  report(node.ok ? 'ok' : 'fail', 'node version', `${process.version} (need >= 22)`)

  // systemctl --user itself
  const sys = await checkSystemctlUser()
  report(sys.ok ? 'ok' : 'fail', 'systemctl --user', sys.detail)

  // the unit's enabled/active state — only meaningful if systemctl --user works
  if (sys.ok) {
    const unit = 'focus-nudge.service'
    const enabled = await isEnabled(unit)
    if (!enabled.installed) {
      report('warn', 'systemd unit installed', `not installed — run ./install.sh (looked for ${unit})`)
    } else {
      report(classifyUnitEnabled(enabled.state), 'systemd unit enabled', enabled.state)
      const active = await isActive(unit)
      report(classifyUnitActive(active), 'systemd unit active', active)
    }
  } else {
    report('fail', 'systemd unit enabled', 'skipped — systemctl --user is not usable')
    report('fail', 'systemd unit active', 'skipped — systemctl --user is not usable')
  }

  // the daemon on its configured port
  const port = config.port
  const listening = await checkPortListening(port)
  report(listening ? 'ok' : 'fail', 'port listening', `127.0.0.1:${port}`)
  const state = await checkStateEndpoint(port)
  report(state.ok ? 'ok' : 'fail', 'GET /state', state.detail)

  // the config dir and its files — a missing dir/file is normal on a fresh
  // checkout and must never throw, only report.
  const dirExists = fs.existsSync(paths.dir)
  report(dirExists ? 'ok' : 'warn', 'config dir', `${paths.dir}${dirExists ? '' : ' (missing — created on first run)'}`)
  for (const [name, file] of Object.entries(paths.files)) {
    const exists = fs.existsSync(file)
    report(exists ? 'ok' : 'warn', `  ${name}`, file)
  }

  // `focus` on PATH, and whether it points at this checkout
  const expectedCli = path.join(repoRoot, 'cli', 'focus')
  const resolved = resolveOnPath('focus')
  if (!resolved) {
    report('warn', 'focus on PATH', 'not found — run ./install.sh, or invoke ./cli/focus directly')
  } else {
    let real, expectedReal
    try { real = fs.realpathSync(resolved) } catch { real = resolved }
    try { expectedReal = fs.realpathSync(expectedCli) } catch { expectedReal = expectedCli }
    if (real === expectedReal) {
      report('ok', 'focus on PATH', resolved)
    } else {
      report('fail', 'focus on PATH', `${resolved} -> ${real} — not this checkout (${expectedReal}); stale install? re-run ./install.sh`)
    }
  }

  // notify-send
  const notify = resolveOnPath('notify-send')
  report(notify ? 'ok' : 'warn', 'notify-send', notify ?? 'not found — desktop notifications are silently skipped')

  // the extension cannot be probed from a shell at all
  report('warn', 'extension', 'cannot be verified from a shell — check manually: chrome://extensions -> Developer mode -> Load unpacked -> ' + path.join(repoRoot, 'extension'))

  return failed ? 1 : 0
}
