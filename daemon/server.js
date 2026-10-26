import http from 'node:http'
import fs from 'node:fs'
import path from 'node:path'
import { spawn } from 'node:child_process'
import { loadConfig, saveConfig, writeAtomic, PATHS, mergeConfig } from './config.js'
import { initialState, reduce, settle, view, PHASE, LEGACY_SNOOZED, NUDGE_OUTCOMES } from './core.js'
import { createLinear, loadLinearKey } from './linear.js'

const LINEAR_TEAM_ID = '7c4547c3-9bfd-4235-9141-cb069ccb3762'
const LINEAR_SYNC_MS = 60_000
const LINEAR_PROJECTS_TTL_MS = 10 * 60_000

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

// Moved to stats.js with the insights summary; re-exported so existing callers
// and tests keep importing them from here.
export { summariseLog, localDay } from './stats.js'
import { summariseLog, insights } from './stats.js'

// The fields core.js iterates, indexes or spreads without checking first,
// because it is pure and trusts its caller to hand it a real state. Returns a
// reason string when the loaded object cannot safely be used, or null when it
// can. Deliberately narrow: rejecting good state would lose the task list on
// every restart, which is worse than the bug it guards.
// LEGACY_SNOOZED is accepted so a state.json from the old daemon is migrated by
// settle rather than quarantined along with the task list.
const KNOWN_PHASES = new Set([...Object.values(PHASE), LEGACY_SNOOZED])

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
  if (parsed.linearDismissed !== undefined && !Array.isArray(parsed.linearDismissed)) {
    return 'linearDismissed is not an array'
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
  // Linear is opt-in by construction: only the real daemon entry point below
  // builds a client from the key. A test that passes no `linear` can never reach
  // the real API, even when the repo's .env holds a key.
  const linear = opts.linear ?? null
  // What core.js sees. linearEnabled is not user config; it is whether a client exists.
  const coreConfig = () => ({ ...config, linearEnabled: Boolean(linear) })
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
      else if (e.type === 'linearCreate') linearJob(() => createFor(e.taskId, e.text, e.projectId))
      else if (e.type === 'linearSetDone') linearJob(() => linear.setDone(e.issueId, e.done))
      else if (e.type === 'linearCancel') linearJob(() => linear.cancel(e.issueId))
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
    const result = settle(state, now, coreConfig())
    if (result.effects.length || result.state !== state) {
      state = result.state
      runEffects(result.effects)
      persist()
    }
  }

  function dispatch(action, now = Date.now()) {
    tick(now)
    const result = reduce(state, action, now, coreConfig())
    state = result.state
    runEffects(result.effects)
    persist()
    return { ...view(state, now, coreConfig()), persisted: persistOk }
  }

  function currentView(now = Date.now()) {
    tick(now)
    return { ...view(state, now, coreConfig()), persisted: persistOk }
  }

  // --- Linear ------------------------------------------------------------------
  // Every Linear call runs on ONE promise chain. Serial is the point: a sync that
  // fetched the issue list while a create was still in flight would see the new
  // issue unlinked and add it a second time.
  let linearChain = Promise.resolve()
  const linearErrors = new Map()   // message -> when it was last printed
  const LINEAR_ERROR_QUIET_MS = 60 * 60_000

  function linearJob(job) {
    if (!linear) return linearChain
    linearChain = linearChain.then(job).catch(err => {
      // A network outage would otherwise print the same line every minute.
      const msg = String(err?.message ?? err).replace(/^linear:\s*/, '')
      const now = Date.now()
      if (now - (linearErrors.get(msg) ?? -Infinity) < LINEAR_ERROR_QUIET_MS) return
      linearErrors.set(msg, now)
      console.error(`focus-nudge: linear: ${msg}`)
    })
    return linearChain
  }

  async function createFor(taskId, text, projectId) {
    const still = state.tasks.find(t => t.id === taskId && t.text === text && t.linearPending)
    if (!still) return   // removed, or linked by an earlier attempt
    const issue = await linear.createIssue({ title: text, projectId })
    dispatch({ type: 'TASK_LINKED', taskId, text, linear: issue })
  }

  // Retries what never reached Linear, then pulls Linear's view back in.
  function linearSync() {
    if (!linear) return linearChain
    for (const t of state.tasks.filter(t => t.linearPending && !t.done)) {
      linearJob(() => createFor(t.id, t.text, t.project?.id ?? null))
    }
    return linearJob(async () => {
      const linkedIds = state.tasks.filter(t => t.linear).map(t => t.linear.id)
      const issues = await linear.activeIssues(linkedIds)
      dispatch({ type: 'LINEAR_SYNC', issues })
    })
  }

  let projectsCache = null   // { at, projects }
  async function linearProjects(now = Date.now()) {
    if (!linear) return { enabled: false, projects: [] }
    if (projectsCache && now - projectsCache.at < LINEAR_PROJECTS_TTL_MS) {
      return { enabled: true, projects: projectsCache.projects }
    }
    try {
      const projects = await linear.projects()
      projectsCache = { at: now, projects }
      return { enabled: true, projects }
    } catch (err) {
      // A stale list beats an empty picker; an empty one still lets a task be added.
      return { enabled: true, projects: projectsCache?.projects ?? [], error: String(err.message) }
    }
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
        if (route === '/linear') return send(200, await linearProjects())
        if (route === '/insights') {
          let text = ''
          try { text = fs.readFileSync(paths.log, 'utf8') } catch {}
          const days = Number(url.searchParams.get('days'))
          const since = Number.isFinite(days) && days > 0 ? Date.now() - days * 86_400_000 : null
          return send(200, { ...insights(text, { workMinutes: config.workMinutes, since }), workMinutes: config.workMinutes })
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
          case '/nudging': {
            if (body.action === 'on') return send(200, dispatch({ type: 'NUDGE_ON' }))
            if (body.action === 'off') {
              return send(200, dispatch({ type: 'NUDGE_OFF', hours: body.hours, indefinite: body.indefinite === true }))
            }
            return send(400, { error: 'unknown nudging action' })
          }
          case '/tasks': {
            const map = { add: 'TASK_ADD', toggle: 'TASK_TOGGLE', remove: 'TASK_REMOVE', clear: 'TASK_CLEAR', clearDone: 'TASK_CLEAR_DONE' }
            const type = map[body.action]
            if (!type) return send(400, { error: 'unknown task action' })
            return send(200, dispatch({ type, text: body.text, id: body.id, project: body.project }))
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
          case '/nudge':
            if (!NUDGE_OUTCOMES.has(body.outcome)) return send(400, { error: 'unknown nudge outcome' })
            return send(200, dispatch({ type: 'NUDGE_EVENT', site: body.site, outcome: body.outcome }))
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
  let syncInterval = null

  return {
    server,
    dispatch,
    currentView,
    linearSync,
    // Resolves once every Linear call queued so far has finished.
    linearIdle: () => linearChain,
    listen(port = config.port) {
      return new Promise((resolve, reject) => {
        server.once('error', reject)
        server.listen(port, '127.0.0.1', () => {
          interval = setInterval(() => tick(), 1000)
          if (linear) {
            linearSync()
            syncInterval = setInterval(linearSync, LINEAR_SYNC_MS)
          }
          resolve(server.address().port)
        })
      })
    },
    close() {
      if (interval) clearInterval(interval)
      if (syncInterval) clearInterval(syncInterval)
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
  const apiKey = loadLinearKey()
  const handle = createServer({
    linear: apiKey ? createLinear({ apiKey, teamId: LINEAR_TEAM_ID }) : null,
  })
  console.log(apiKey ? 'focus-nudge: Linear sync on' : 'focus-nudge: Linear sync off (no LINEAR_API_KEY)')
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
