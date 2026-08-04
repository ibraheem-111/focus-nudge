import http from 'node:http'
import fs from 'node:fs'
import path from 'node:path'
import { spawn } from 'node:child_process'
import { loadConfig, saveConfig, writeAtomic, PATHS, mergeConfig } from './config.js'
import { initialState, reduce, settle, view, PHASE } from './core.js'

const TIMER_ACTIONS = {
  start: 'START',
  skip: 'ADVANCE',
  next: 'ADVANCE',
  pause: 'PAUSE',
  stop: 'STOP',
  breakLong: 'BREAK_LONG',
}

export function parseQuotes(text) {
  return String(text)
    .split('\n')
    .map(line => line.trim())
    .filter(line => line && !line.startsWith('#'))
    .map(line => {
      // Accept an em dash or a double hyphen as the author separator.
      const m = line.match(/^(.*?)\s+(?:—|--)\s+(.+)$/)
      return m ? { text: m[1].trim(), author: m[2].trim() } : { text: line, author: '' }
    })
}

// Local calendar day, not UTC: "blocks today" has to mean the user's today.
// Built from the local getters rather than a locale format so it cannot drift
// with locale settings.
export function localDay(at) {
  const d = new Date(at)
  const pad = n => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`
}

// `dayKey` and `now` are injectable so the day-bucketing can be tested without
// depending on the machine's timezone.
export function summariseLog(text, { dayKey = localDay, now = Date.now() } = {}) {
  const stats = {
    blocksCompleted: 0, nudgesContinued: 0, savedForLater: 0, queueDrained: 0,
    byDay: {}, today: 0, last7: 0,
  }
  const todayKey = dayKey(now)
  const sevenDaysAgo = now - 7 * 24 * 60 * 60 * 1000

  for (const line of String(text).split('\n')) {
    if (!line.trim()) continue
    let entry
    try { entry = JSON.parse(line) } catch { continue }

    if (entry.event === 'block_completed') {
      stats.blocksCompleted++
      const key = Number.isFinite(entry.at) ? dayKey(entry.at) : 'unknown'
      stats.byDay[key] = (stats.byDay[key] ?? 0) + 1
      if (key === todayKey) stats.today++
      if (Number.isFinite(entry.at) && entry.at >= sevenDaysAgo) stats.last7++
    }
    else if (entry.event === 'continued') stats.nudgesContinued++
    else if (entry.event === 'saved_for_later') stats.savedForLater++
    else if (entry.event === 'queue_drained') stats.queueDrained++
  }
  return stats
}

// The fields core.js iterates, indexes or spreads without checking first,
// because it is pure and trusts its caller to hand it a real state. Returns a
// reason string when the loaded object cannot safely be used, or null when it
// can. Deliberately narrow: rejecting good state would lose the task list on
// every restart, which is worse than the bug it guards.
const KNOWN_PHASES = new Set(Object.values(PHASE))

function shapeProblem(parsed) {
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return 'not a json object'
  }
  if (parsed.tasks !== undefined && !Array.isArray(parsed.tasks)) return 'tasks is not an array'
  if (parsed.queue !== undefined && !Array.isArray(parsed.queue)) return 'queue is not an array'
  if (parsed.graces !== undefined &&
      (parsed.graces === null || typeof parsed.graces !== 'object' || Array.isArray(parsed.graces))) {
    return 'graces is not an object'
  }
  if (parsed.phase !== undefined && !KNOWN_PHASES.has(parsed.phase)) {
    return `unknown phase ${JSON.stringify(parsed.phase)}`
  }
  return null
}

// Only the extension may drive the daemon from a browser. Any page the user
// visits can reach 127.0.0.1, and every mutating route was wide open: reddit.com
// itself could POST /snooze to switch nudging off, POST /grace to buy a pass, or
// POST /sites {remove} to unwatch itself. A tool that exists to be hard to
// switch off cannot leave that open.
//
// An ABSENT Origin is allowed: curl, the CLI and any other local script send
// none, and they are not the threat — a page cannot suppress its own Origin.
// Everything else must be a chrome-extension: URL. The id is not checked because
// it differs per install; anything that can forge an extension origin already has
// more privilege than this guard could withhold.
export function originAllowed(origin) {
  if (origin === undefined) return true
  try {
    return new URL(origin).protocol === 'chrome-extension:'
  } catch {
    return false   // 'null', '', or junk: fail closed
  }
}

export function createServer(opts = {}) {
  const paths = {
    state: opts.statePath ?? PATHS.state,
    log: opts.logPath ?? PATHS.log,
    quotes: opts.quotesPath ?? PATHS.quotes,
    config: opts.configPath ?? PATHS.config,
  }
  let config = opts.config ?? loadConfig()
  const notify = opts.notify ?? desktopNotify
  const openUrls = opts.openUrls ?? (urls => urls.forEach(u => spawnDetached('xdg-open', [u])))

  fs.mkdirSync(path.dirname(paths.state), { recursive: true })
  let state = readState(paths.state)

  function readState(file) {
    let raw
    try {
      raw = fs.readFileSync(file, 'utf8')
    } catch (err) {
      if (err.code === 'ENOENT') return initialState()   // normal first run
      return quarantine(file, err.message)
    }

    let parsed
    try {
      parsed = JSON.parse(raw)
    } catch (err) {
      return quarantine(file, err.message)
    }

    // Parsing is not enough. Valid JSON with the wrong TYPES survived the merge
    // below and then threw inside settle/view on every request, so the daemon
    // answered 500 forever. It never exits, so systemd's Restart=on-failure
    // cannot rescue it, and nothing was quarantined to point the user at. Hand
    // editing, a half-written file, or a future schema change all reach here.
    const problem = shapeProblem(parsed)
    if (problem) return quarantine(file, problem)

    return { ...initialState(), ...parsed }
  }

  function quarantine(file, why) {
    try { fs.renameSync(file, file + '.corrupt') } catch {}
    console.error(`focus-nudge: unusable state file (${why}), starting fresh (kept at ${file}.corrupt)`)
    return initialState()
  }

  // Tracks whether the last write reached disk. A full or read-only disk must
  // not take the daemon down, but the client must not be told "saved" either —
  // otherwise a restart silently loses the task list.
  let persistOk = true

  function persist() {
    try {
      writeAtomic(paths.state, JSON.stringify(state, null, 2))
      persistOk = true
    } catch (err) {
      persistOk = false
      console.error('focus-nudge: could not write state:', err.message)
    }
    return persistOk
  }

  function runEffects(effects) {
    for (const e of effects) {
      if (e.type === 'notify') notify(e.title, e.body, e.sound)
      else if (e.type === 'log') appendLog(e.event, e.data)
      else if (e.type === 'openUrls') openUrls(e.urls)
      else if (e.type === 'setSites') {
        config = mergeConfig({ ...config, sites: e.sites })
        // saveConfig rather than a local mkdir + writeAtomic: this was the second
        // copy of that pair, and the two could drift. It takes the path, so the
        // smoke test's scratch configPath still works.
        try {
          saveConfig(config, paths.config)
        } catch (err) {
          console.error('focus-nudge: could not write config:', err.message)
        }
      }
    }
  }

  function appendLog(event, data) {
    try {
      fs.appendFileSync(paths.log, JSON.stringify({ at: Date.now(), event, ...data }) + '\n')
    } catch {}
  }

  // Applies time-driven changes. Called before every request and once a second.
  function tick(now = Date.now()) {
    const result = settle(state, now, config)
    if (result.effects.length || result.state !== state) {
      state = result.state
      runEffects(result.effects)
      persist()
    }
  }

  function dispatch(action, now = Date.now()) {
    tick(now)
    const result = reduce(state, action, now, config)
    state = result.state
    runEffects(result.effects)
    persist()
    return { ...view(state, now, config), persisted: persistOk }
  }

  function currentView(now = Date.now()) {
    tick(now)
    return { ...view(state, now, config), persisted: persistOk }
  }

  const server = http.createServer(async (req, res) => {
    const send = (status, body) => {
      res.writeHead(status, {
        'content-type': 'application/json',
        'access-control-allow-origin': '*',
        'access-control-allow-headers': 'content-type',
        'access-control-allow-methods': 'GET, POST, OPTIONS',
        'cache-control': 'no-store',
      })
      res.end(JSON.stringify(body))
    }

    // Before any routing, and before the body is read: a page that is not
    // allowed to act gets no chance to. Applies to GET too — /state and /stats
    // are the user's own activity history.
    if (!originAllowed(req.headers.origin)) {
      return send(403, { error: 'only the focus-nudge extension may call this daemon from a browser' })
    }

    if (req.method === 'OPTIONS') {
      res.writeHead(204, {
        'access-control-allow-origin': '*',
        'access-control-allow-headers': 'content-type',
        'access-control-allow-methods': 'GET, POST, OPTIONS',
      })
      return res.end()
    }

    const url = new URL(req.url, 'http://127.0.0.1')
    const route = url.pathname

    try {
      if (req.method === 'GET') {
        if (route === '/state') return send(200, currentView())
        if (route === '/quotes') {
          let quotes = []
          try { quotes = parseQuotes(fs.readFileSync(paths.quotes, 'utf8')) } catch {}
          return send(200, { quotes })
        }
        if (route === '/stats') {
          let text = ''
          try { text = fs.readFileSync(paths.log, 'utf8') } catch {}
          // Namespaced deliberately. `blocksCompleted` exists in BOTH the log
          // summary (lifetime total) and the view (current-cycle counter), so
          // spreading them into one flat object silently shadows whichever
          // comes first — reporting ~0 blocks no matter the real history.
          return send(200, { ...currentView(), totals: summariseLog(text) })
        }
        return send(404, { error: 'not found' })
      }

      if (req.method === 'POST') {
        let body = {}
        const raw = await readBody(req)
        if (raw.trim()) {
          try { body = JSON.parse(raw) } catch { return send(400, { error: 'malformed json' }) }
        }

        switch (route) {
          case '/timer': {
            const type = TIMER_ACTIONS[body.action]
            if (!type) return send(400, { error: 'unknown timer action' })
            return send(200, dispatch({ type }))
          }
          case '/snooze':
            return send(200, dispatch({ type: 'SNOOZE', hours: body.hours }))
          case '/tasks': {
            const map = { add: 'TASK_ADD', toggle: 'TASK_TOGGLE', remove: 'TASK_REMOVE', clear: 'TASK_CLEAR', clearDone: 'TASK_CLEAR_DONE' }
            const type = map[body.action]
            if (!type) return send(400, { error: 'unknown task action' })
            return send(200, dispatch({ type, text: body.text, id: body.id }))
          }
          case '/sites': {
            const map = { add: 'SITE_ADD', remove: 'SITE_REMOVE' }
            const type = map[body.action]
            if (!type) return send(400, { error: 'unknown site action' })
            return send(200, dispatch({ type, site: body.site }))
          }
          case '/queue': {
            if (body.drain) return send(200, dispatch({ type: 'QUEUE_DRAIN' }))
            return send(200, dispatch({ type: 'QUEUE_ADD', url: body.url, title: body.title }))
          }
          case '/grace':
            return send(200, dispatch({ type: 'GRACE', site: body.site }))
          default:
            return send(404, { error: 'not found' })
        }
      }

      return send(405, { error: 'method not allowed' })
    } catch (err) {
      console.error('focus-nudge: request failed:', err)
      return send(500, { error: 'internal error' })
    }
  })

  let interval = null

  return {
    server,
    dispatch,
    currentView,
    listen(port = config.port) {
      return new Promise((resolve, reject) => {
        server.once('error', reject)
        server.listen(port, '127.0.0.1', () => {
          interval = setInterval(() => tick(), 1000)
          resolve(server.address().port)
        })
      })
    },
    close() {
      if (interval) clearInterval(interval)
      server.close()
    },
  }
}

// Reads a POST body with two guards the naive `data`/`end` pairing misses:
// a size cap so a runaway body can't grow the buffer without limit (the
// socket is destroyed the instant the cap is crossed, not just the promise
// rejected — otherwise bytes already in flight keep arriving and piling up
// in `data` even though nothing is listening anymore), and a `close`
// listener so a client that disconnects mid-body (or a socket Node kills via
// its own request/header timeouts) always settles the promise instead of
// leaving the request handler awaiting forever.
function readBody(req) {
  return new Promise((resolve, reject) => {
    let data = ''
    let settled = false

    const cleanup = () => {
      req.removeListener('data', onData)
      req.removeListener('end', onEnd)
      req.removeListener('error', onError)
      req.removeListener('close', onClose)
    }
    const finish = (fn, arg) => {
      if (settled) return
      settled = true
      cleanup()
      fn(arg)
    }
    const onData = chunk => {
      data += chunk
      if (data.length > 1e6) {
        req.destroy()
        finish(reject, new Error('body too large'))
      }
    }
    const onEnd = () => finish(resolve, data)
    const onError = err => finish(reject, err)
    const onClose = () => finish(reject, new Error('request closed before body was fully read'))

    req.on('data', onData)
    req.on('end', onEnd)
    req.on('error', onError)
    req.on('close', onClose)
  })
}

const warnedCommands = new Set()
function warnOnce(cmd, message) {
  if (warnedCommands.has(cmd)) return
  warnedCommands.add(cmd)
  console.error(`focus-nudge: could not run ${cmd}: ${message}`)
}

// `spawn` reports a missing executable asynchronously via an 'error' event on
// the returned child, not by throwing — a try/catch around the spawn() call
// alone does not see it, and an unhandled 'error' event crashes the process.
// Both the synchronous throw (e.g. EACCES on the parent lookup in some
// environments) and the async ENOENT case are handled here so a missing
// notify-send/xdg-open is logged once and otherwise ignored, never fatal.
function spawnDetached(cmd, args) {
  try {
    const child = spawn(cmd, args, { detached: true, stdio: 'ignore' })
    child.on('error', err => warnOnce(cmd, err.message))
    child.unref()
  } catch (err) {
    warnOnce(cmd, err.message)
  }
}

// Pure argv builder, split out from desktopNotify so the --hint syntax can be
// checked without spawning a real notify-send or depending on one being
// installed. The GNOME notification daemon's `sound` capability plays this
// through the existing notification — no second audio process, so system
// volume, mute and Do Not Disturb are all honoured for free. A sound name is
// only added when one is given: every other notify (a click at the keyboard)
// omits it and stays silent.
export function buildNotifySendArgs(title, body, sound) {
  const args = ['--app-name=focus-nudge', '--icon=appointment-soon']
  if (sound) args.push(`--hint=string:sound-name:${sound}`)
  args.push(title, body)
  return args
}

function desktopNotify(title, body, sound) {
  spawnDetached('notify-send', buildNotifySendArgs(title, body, sound))
}

// Started directly rather than imported by a test.
if (import.meta.url === `file://${process.argv[1]}`) {
  const handle = createServer()
  const cfg = loadConfig()
  handle.listen(cfg.port).then(
    port => console.log(`focus-nudge listening on http://127.0.0.1:${port}`),
    err => {
      if (err.code === 'EADDRINUSE') {
        console.error(`focus-nudge: port ${cfg.port} is already in use. Another daemon is probably running:`)
        console.error('  systemctl --user status focus-nudge')
      } else {
        console.error('focus-nudge: could not start:', err.message)
      }
      process.exit(1)
    }
  )
  for (const sig of ['SIGINT', 'SIGTERM']) {
    process.on(sig, () => { handle.close(); process.exit(0) })
  }
}
