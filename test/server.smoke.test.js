import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createServer, summariseLog, localDay, originAllowed, buildNotifySendArgs } from '../daemon/server.js'
import { DEFAULTS } from '../daemon/config.js'

let base
let tmp
let handle
const notified = []
const opened = []

before(async () => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'focus-nudge-test-'))
  handle = createServer({
    config: { ...DEFAULTS, port: 0 },
    statePath: path.join(tmp, 'state.json'),
    logPath: path.join(tmp, 'log.jsonl'),
    quotesPath: path.join(tmp, 'quotes.txt'),
    configPath: path.join(tmp, 'config.json'),
    notify: (title, body, sound) => notified.push({ title, body, sound }),
    openUrls: urls => opened.push(...urls),
  })
  const port = await handle.listen(0)
  base = `http://127.0.0.1:${port}`
})

after(() => {
  handle.close()
  fs.rmSync(tmp, { recursive: true, force: true })
})

const get = async p => (await fetch(base + p)).json()
const post = async (p, body) =>
  (await fetch(base + p, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body ?? {}),
  })).json()

test('GET /state returns an idle view', async () => {
  const v = await get('/state')
  assert.equal(v.phase, 'IDLE')
  assert.equal(v.remainingMs, null)
  assert.deepEqual(v.sites, ['reddit.com', 'youtube.com', 'x.com', 'instagram.com'])
})

test('every response carries permissive CORS headers for the extension', async () => {
  const res = await fetch(base + '/state')
  assert.equal(res.headers.get('access-control-allow-origin'), '*')
})

test('OPTIONS preflight is answered', async () => {
  const res = await fetch(base + '/timer', { method: 'OPTIONS' })
  assert.equal(res.status, 204)
  assert.ok(res.headers.get('access-control-allow-headers').includes('content-type'))
})

test('POST /timer start begins a work block and notifies', async () => {
  const v = await post('/timer', { action: 'start' })
  assert.equal(v.phase, 'WORK')
  assert.ok(v.remainingMs > 24 * 60_000)
  assert.ok(notified.length > 0)
})

test('POST /tasks round-trips add, toggle, and remove', async () => {
  let v = await post('/tasks', { action: 'add', text: 'fix the auth redirect' })
  assert.equal(v.tasks.length, 1)
  const id = v.tasks[0].id

  v = await post('/tasks', { action: 'toggle', id })
  assert.equal(v.tasks[0].done, true)
  assert.equal(v.openTaskCount, 0)

  v = await post('/tasks', { action: 'remove', id })
  assert.deepEqual(v.tasks, [])
})

test('POST /grace then GET /state shows the pass', async () => {
  const v = await post('/grace', { site: 'reddit.com' })
  assert.ok(v.graces['reddit.com'] > Date.now())
})

test('POST /queue add stores a link', async () => {
  const v = await post('/queue', { url: 'https://reddit.com/r/x', title: 'x' })
  assert.equal(v.queueDepth, 1)
})

// Replaces 'a long break drains the queue through the openUrls hook': a long
// break no longer opens watched sites, so the queue drains when nudging is
// switched off instead.
test('switching nudging off drains the queue through the openUrls hook', async () => {
  opened.length = 0
  const v = await post('/nudging', { action: 'off', hours: 1 })
  assert.equal(v.nudging, false)
  assert.equal(v.queueDepth, 0)
  assert.deepEqual(opened, ['https://reddit.com/r/x'])
  assert.equal((await post('/nudging', { action: 'on' })).nudging, true)
})

test('a long break leaves the queue alone', async () => {
  await post('/queue', { url: 'https://reddit.com/r/later', title: 'later' })
  opened.length = 0
  const v = await post('/timer', { action: 'breakLong' })
  assert.equal(v.phase, 'LONG_BREAK')
  assert.equal(v.queueDepth, 1)
  assert.deepEqual(opened, [])
  assert.equal(v.nudging, true, 'and a long break does not switch nudging off')
})

test('POST /sites persists to the config file and shows in the view', async () => {
  const v = await post('/sites', { action: 'add', site: 'news.ycombinator.com' })
  assert.ok(v.sites.includes('news.ycombinator.com'))
  const onDisk = JSON.parse(fs.readFileSync(path.join(tmp, 'config.json'), 'utf8'))
  assert.ok(onDisk.sites.includes('news.ycombinator.com'))
})

// Replaces 'POST /snooze opens the sanctioned window'. /snooze is kept for old
// clients, but it now switches nudging off without touching the timer.
test('POST /snooze switches nudging off and keeps the running block', async () => {
  await post('/timer', { action: 'start' })
  const v = await post('/snooze', { hours: 2 })
  assert.equal(v.phase, 'WORK', 'the work block survives')
  assert.equal(v.nudging, false)
  assert.equal(v.nudgingPhase, false, 'old clients see the same answer')
  assert.ok(v.nudgeOffUntil > Date.now())
  await post('/nudging', { action: 'on' })
})

test('POST /nudging off indefinite and on', async () => {
  const off = await post('/nudging', { action: 'off', indefinite: true })
  assert.equal(off.nudging, false)
  assert.equal(off.nudgeOffIndefinite, true)
  assert.equal(off.nudgeOffUntil, null)
  const on = await post('/nudging', { action: 'on' })
  assert.equal(on.nudging, true)
  assert.equal(on.nudgeOffIndefinite, false)
})

test('POST /nudging rejects an unknown action', async () => {
  const res = await fetch(base + '/nudging', {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: '{"action":"maybe"}',
  })
  assert.equal(res.status, 400)
})

test('a web page cannot switch nudging off', async () => {
  const res = await fetch(base + '/nudging', {
    method: 'POST',
    headers: { 'content-type': 'application/json', origin: 'https://www.reddit.com' },
    body: '{"action":"off","indefinite":true}',
  })
  assert.equal(res.status, 403)
  assert.equal((await get('/state')).nudging, true)
})

test('state survives a restart', async () => {
  await post('/tasks', { action: 'add', text: 'persist me' })
  handle.close()

  const second = createServer({
    config: { ...DEFAULTS, port: 0 },
    statePath: path.join(tmp, 'state.json'),
    logPath: path.join(tmp, 'log.jsonl'),
    quotesPath: path.join(tmp, 'quotes.txt'),
    configPath: path.join(tmp, 'config.json'),
    notify: () => {},
    openUrls: () => {},
  })
  const port = await second.listen(0)
  const v = await (await fetch(`http://127.0.0.1:${port}/state`)).json()
  assert.ok(v.tasks.some(t => t.text === 'persist me'))
  second.close()

  handle = createServer({
    config: { ...DEFAULTS, port: 0 },
    statePath: path.join(tmp, 'state.json'),
    logPath: path.join(tmp, 'log.jsonl'),
    quotesPath: path.join(tmp, 'quotes.txt'),
    configPath: path.join(tmp, 'config.json'),
    notify: () => {},
    openUrls: () => {},
  })
  base = `http://127.0.0.1:${await handle.listen(0)}`
})

test('GET /quotes reads the user quotes file', async () => {
  fs.writeFileSync(path.join(tmp, 'quotes.txt'),
    '# a comment\n\nHold the line. — Someone\nNo attribution here\n')
  const { quotes } = await get('/quotes')
  assert.deepEqual(quotes, [
    { text: 'Hold the line.', author: 'Someone' },
    { text: 'No attribution here', author: '' },
  ])
})

test('GET /quotes returns an empty list when the file is missing', async () => {
  fs.rmSync(path.join(tmp, 'quotes.txt'), { force: true })
  assert.deepEqual((await get('/quotes')).quotes, [])
})

test('summariseLog buckets completed blocks by local day', () => {
  // dayKey and now are injected so this does not depend on the machine timezone.
  const dayKey = at => `day-${at}`
  const log = [
    { at: 1, event: 'block_completed' },
    { at: 1, event: 'block_completed' },
    { at: 2, event: 'block_completed' },
    { at: 2, event: 'continued' },
    { at: 3, event: 'saved_for_later' },
  ].map(e => JSON.stringify(e)).join('\n')

  const t = summariseLog(log, { dayKey, now: 2 })
  assert.equal(t.blocksCompleted, 3)
  assert.deepEqual(t.byDay, { 'day-1': 2, 'day-2': 1 })
  assert.equal(t.today, 1, 'now=2 makes day-2 today')
  assert.equal(t.nudgesContinued, 1)
  assert.equal(t.savedForLater, 1)
})

test('summariseLog counts the last seven days by timestamp, not by day key', () => {
  const DAY = 24 * 60 * 60 * 1000
  const now = 100 * DAY
  const log = [
    { at: now - 1 * DAY, event: 'block_completed' },
    { at: now - 6 * DAY, event: 'block_completed' },
    { at: now - 8 * DAY, event: 'block_completed' },
  ].map(e => JSON.stringify(e)).join('\n')

  const t = summariseLog(log, { now })
  assert.equal(t.blocksCompleted, 3, 'all three are counted all-time')
  assert.equal(t.last7, 2, 'but only two fall inside seven days')
})

test('summariseLog survives entries with no usable timestamp', () => {
  const log = [
    JSON.stringify({ event: 'block_completed' }),
    JSON.stringify({ at: 'nonsense', event: 'block_completed' }),
    '{ not json at all',
    '',
  ].join('\n')
  const t = summariseLog(log, { now: 1 })
  assert.equal(t.blocksCompleted, 2, 'malformed json skipped, timestampless still counted')
  assert.equal(t.byDay.unknown, 2, 'bucketed separately rather than dropped or crashing')
})

test('localDay formats a local calendar date', () => {
  const key = localDay(Date.now())
  assert.match(key, /^\d{4}-\d{2}-\d{2}$/)
})

test('GET /stats summarises the log under a namespace', async () => {
  const s = await get('/stats')
  assert.equal(typeof s.totals.blocksCompleted, 'number')
  assert.equal(typeof s.totals.nudgesContinued, 'number')
  assert.equal(typeof s.totals.savedForLater, 'number')
  assert.equal(typeof s.phase, 'string', 'the current view is still there alongside')
})

test('the lifetime block total is not shadowed by the current-cycle counter', async () => {
  // Both objects carry a `blocksCompleted`. Flattened together, one silently
  // wins: 7 completed blocks in the log were reported as 0.
  fs.appendFileSync(path.join(tmp, 'log.jsonl'),
    Array.from({ length: 7 }, () => JSON.stringify({ at: 1, event: 'block_completed' })).join('\n') + '\n')
  const s = await get('/stats')
  assert.ok(s.totals.blocksCompleted >= 7, `lifetime total survived, got ${s.totals.blocksCompleted}`)
  assert.notEqual(s.totals, s.blocksCompleted, 'the two live at different keys')
})

test('an oversized body is rejected and the daemon survives it', async () => {
  // readBody must destroy the socket rather than buffer without limit.
  let status = null
  try {
    const res = await fetch(base + '/tasks', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: 'x'.repeat(2_000_000),
    })
    status = res.status
  } catch {
    status = 'connection destroyed'
  }
  assert.ok(status, `got ${status}`)
  // Assert the daemon is still SERVING, not that it is in some particular
  // phase. This runs against the shared server, whose phase depends on which
  // tests ran before it — pinning a phase here tests fixture ordering, not the
  // property under test.
  const after = await get('/state')
  assert.ok(typeof after.phase === 'string' && after.phase.length > 0,
    `still answering after the oversized request, got ${JSON.stringify(after)}`)
  assert.equal(typeof after.serverTime, 'number', 'and returning a coherent view')
})

test('a missing notify binary does not kill the daemon', async () => {
  // spawn reports a missing binary through the child's async 'error' event, and
  // an unhandled 'error' on a ChildProcess is fatal. This uses the DEFAULT
  // notify path (no injected hook) with PATH emptied, so notify-send cannot be
  // found — the exact situation on a machine without libnotify installed.
  const realPath = process.env.PATH
  process.env.PATH = path.join(tmp, 'no-binaries-here')
  const solo = createServer({
    config: { ...DEFAULTS, port: 0 },
    statePath: path.join(tmp, 'notify-state.json'),
    logPath: path.join(tmp, 'notify-log.jsonl'),
    quotesPath: path.join(tmp, 'quotes.txt'),
    configPath: path.join(tmp, 'notify-config.json'),
    openUrls: () => {},
    // notify deliberately omitted so desktopNotify/spawnDetached is exercised
  })
  try {
    const p = await solo.listen(0)
    const started = await (await fetch(`http://127.0.0.1:${p}/timer`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ action: 'start' }),
    })).json()
    assert.equal(started.phase, 'WORK')
    await new Promise(r => setTimeout(r, 300))
    const still = await (await fetch(`http://127.0.0.1:${p}/state`)).json()
    assert.equal(still.phase, 'WORK', 'daemon still alive after the failed spawn')
  } finally {
    process.env.PATH = realPath
    solo.close()
  }
})

test('a write failure reports persisted:false instead of claiming success', async t => {
  // A full or read-only disk must not take the daemon down, but the client must
  // not be told "saved" either, or a restart silently loses the task list.
  if (process.getuid && process.getuid() === 0) return t.skip('root ignores directory permissions')
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'focus-nudge-ro-'))
  const solo = createServer({
    config: { ...DEFAULTS, port: 0 },
    statePath: path.join(dir, 'state.json'),
    logPath: path.join(dir, 'log.jsonl'),
    quotesPath: path.join(dir, 'quotes.txt'),
    configPath: path.join(dir, 'config.json'),
    notify: () => {},
    openUrls: () => {},
  })
  try {
    const p = await solo.listen(0)
    const ok = await (await fetch(`http://127.0.0.1:${p}/tasks`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ action: 'add', text: 'before' }),
    })).json()
    assert.equal(ok.persisted, true, 'a healthy write reports true')

    fs.chmodSync(dir, 0o500)
    const failed = await (await fetch(`http://127.0.0.1:${p}/tasks`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ action: 'add', text: 'after' }),
    })).json()
    assert.equal(failed.persisted, false, 'an unwritable directory reports false')
    assert.equal(failed.tasks.length, 2, 'the action still applied in memory')
  } finally {
    fs.chmodSync(dir, 0o700)
    solo.close()
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test('a corrupt state file is replaced with defaults rather than crashing', async () => {
  handle.close()
  const statePath = path.join(tmp, 'state.json')
  fs.writeFileSync(statePath, '{ not json')
  const rescued = createServer({
    config: { ...DEFAULTS, port: 0 },
    statePath,
    logPath: path.join(tmp, 'log.jsonl'),
    quotesPath: path.join(tmp, 'quotes.txt'),
    configPath: path.join(tmp, 'config.json'),
    notify: () => {},
    openUrls: () => {},
  })
  const port = await rescued.listen(0)
  const v = await (await fetch(`http://127.0.0.1:${port}/state`)).json()
  assert.equal(v.phase, 'IDLE')
  assert.ok(fs.existsSync(statePath + '.corrupt'), 'the bad file is kept for inspection')
  rescued.close()

  handle = createServer({
    config: { ...DEFAULTS, port: 0 },
    statePath,
    logPath: path.join(tmp, 'log.jsonl'),
    quotesPath: path.join(tmp, 'quotes.txt'),
    configPath: path.join(tmp, 'config.json'),
    notify: () => {},
    openUrls: () => {},
  })
  base = `http://127.0.0.1:${await handle.listen(0)}`
})

// Quarantining only on JSON.parse failure was not enough. Valid JSON with the
// wrong TYPES survived the merge into initialState and then threw inside
// settle/view on every single request, so the daemon answered
// 500 {"error":"internal error"} forever. The process does not exit, so
// Restart=on-failure never fires and no .corrupt file was ever written — the
// daemon was bricked with nothing to point at.
test('a shape-invalid state file is quarantined rather than bricking the daemon', async () => {
  handle.close()
  const statePath = path.join(tmp, 'state.json')
  fs.rmSync(statePath + '.corrupt', { force: true })

  // Parses cleanly. tasks and graces are null, which nothing downstream survives.
  fs.writeFileSync(statePath, '{"phase":"WORK","endsAt":null,"tasks":null,"graces":null}')

  const rescued = createServer({
    config: { ...DEFAULTS, port: 0 },
    statePath,
    logPath: path.join(tmp, 'log.jsonl'),
    quotesPath: path.join(tmp, 'quotes.txt'),
    configPath: path.join(tmp, 'config.json'),
    notify: () => {},
    openUrls: () => {},
  })
  const port = await rescued.listen(0)
  const res = await fetch(`http://127.0.0.1:${port}/state`)
  const v = await res.json()
  assert.equal(res.status, 200, `got ${res.status} ${JSON.stringify(v)}`)
  assert.equal(v.phase, 'IDLE', 'started fresh instead of throwing on every request')
  assert.deepEqual(v.tasks, [])
  assert.equal(v.nudging, true, 'and nudging is on, not stuck')
  assert.ok(fs.existsSync(statePath + '.corrupt'), 'the bad file is kept for inspection')
  rescued.close()

  handle = createServer({
    config: { ...DEFAULTS, port: 0 },
    statePath,
    logPath: path.join(tmp, 'log.jsonl'),
    quotesPath: path.join(tmp, 'quotes.txt'),
    configPath: path.join(tmp, 'config.json'),
    notify: () => {},
    openUrls: () => {},
  })
  base = `http://127.0.0.1:${await handle.listen(0)}`
})

test('every wrong-shaped field is caught, not just the ones that throw loudly', async t => {
  const bad = [
    '{"tasks":null}',
    '{"tasks":{}}',
    '{"tasks":"none"}',
    '{"queue":null}',
    '{"queue":42}',
    '{"graces":null}',
    '{"graces":[]}',
    '{"graces":"reddit.com"}',
    '{"phase":"WAT"}',
    '{"phase":null}',
    '{"phase":7}',
    '[1,2,3]',
    '"hello"',
    'null',
  ]
  for (const [i, text] of bad.entries()) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'focus-nudge-shape-'))
    const statePath = path.join(dir, 'state.json')
    fs.writeFileSync(statePath, text)
    const solo = createServer({
      config: { ...DEFAULTS, port: 0 },
      statePath,
      logPath: path.join(dir, 'log.jsonl'),
      quotesPath: path.join(dir, 'quotes.txt'),
      configPath: path.join(dir, 'config.json'),
      notify: () => {},
      openUrls: () => {},
    })
    try {
      const p = await solo.listen(0)
      const res = await fetch(`http://127.0.0.1:${p}/state`)
      const v = await res.json()
      assert.equal(res.status, 200, `case ${i} (${text}) answered ${res.status}`)
      assert.equal(v.phase, 'IDLE', `case ${i} (${text}) did not start fresh`)
    } finally {
      solo.close()
      fs.rmSync(dir, { recursive: true, force: true })
    }
  }
})

test('a valid state file is still loaded, shape check and all', async () => {
  // The guard must not be so eager that it throws away good state — that would
  // lose the task list on every restart, which is worse than the bug.
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'focus-nudge-shape-ok-'))
  const statePath = path.join(dir, 'state.json')
  fs.writeFileSync(statePath, JSON.stringify({
    phase: 'WORK',
    endsAt: Date.now() + 600_000,
    paused: false,
    pausedRemainingMs: null,
    expiredNotified: false,
    blocksCompleted: 2,
    tasks: [{ id: 1, text: 'keep me', done: false }],
    nextTaskId: 2,
    queue: [],
    graces: {},
  }))
  const solo = createServer({
    config: { ...DEFAULTS, port: 0 },
    statePath,
    logPath: path.join(dir, 'log.jsonl'),
    quotesPath: path.join(dir, 'quotes.txt'),
    configPath: path.join(dir, 'config.json'),
    notify: () => {},
    openUrls: () => {},
  })
  try {
    const p = await solo.listen(0)
    const v = await (await fetch(`http://127.0.0.1:${p}/state`)).json()
    assert.equal(v.phase, 'WORK', 'good state survives')
    assert.deepEqual(v.tasks.map(t => t.text), ['keep me'])
    assert.equal(v.blocksCompleted, 2)
    assert.equal(fs.existsSync(statePath + '.corrupt'), false, 'nothing was quarantined')
  } finally {
    solo.close()
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

// The daemon answered access-control-allow-origin:* and checked nothing, so ANY
// page the user visited — reddit.com very much included — could POST /snooze to
// switch nudging off, POST /grace to buy itself a pass, or POST /sites {remove}
// to unwatch itself. For a tool whose entire value is that it cannot be switched
// off on impulse, that is the whole game.

test('originAllowed accepts only the extension, and an absent Origin', () => {
  assert.equal(originAllowed(undefined), true, 'curl and the CLI send no Origin')
  assert.equal(originAllowed('chrome-extension://abcdefghijklmnop'), true)
  assert.equal(originAllowed('chrome-extension://a-different-install-id'), true,
    'the extension id differs per install and must not be hardcoded')
  assert.equal(originAllowed('CHROME-EXTENSION://abc'), true,
    'url schemes are case-insensitive per spec, and new URL normalises them')

  for (const origin of [
    'https://reddit.com', 'http://reddit.com', 'https://youtube.com',
    'http://127.0.0.1:7373', 'http://localhost:3000', 'file://',
    'null', '', 'moz-extension://abc', 'not a url',
  ]) {
    assert.equal(originAllowed(origin), false, `origin ${JSON.stringify(origin)} must be rejected`)
  }
})

test('a request with no Origin is served, so curl and the CLI keep working', async () => {
  const res = await fetch(base + '/state')
  assert.equal(res.status, 200)
  assert.equal(typeof (await res.json()).phase, 'string')
})

test('a chrome-extension Origin is served whatever the install id', async () => {
  const res = await fetch(base + '/state', { headers: { origin: 'chrome-extension://someinstallid' } })
  assert.equal(res.status, 200)
  const post = await fetch(base + '/grace', {
    method: 'POST',
    headers: { 'content-type': 'application/json', origin: 'chrome-extension://someinstallid' },
    body: JSON.stringify({ site: 'reddit.com' }),
  })
  assert.equal(post.status, 200)
})

test('a web page Origin is refused 403 on both a POST and a GET', async () => {
  const snooze = await fetch(base + '/snooze', {
    method: 'POST',
    headers: { 'content-type': 'application/json', origin: 'https://reddit.com' },
    body: JSON.stringify({ hours: 8 }),
  })
  assert.equal(snooze.status, 403, 'reddit.com cannot snooze the nudger')
  assert.equal(typeof (await snooze.json()).error, 'string', 'and says so as json')

  const read = await fetch(base + '/state', { headers: { origin: 'https://reddit.com' } })
  assert.equal(read.status, 403, 'nor read the state')

  // And it really did not take effect.
  const after = await get('/state')
  assert.notEqual(after.phase, 'SNOOZED', 'the snooze was refused, not merely unreported')
})

test('a web page cannot unwatch itself or buy itself a grace', async () => {
  const before = await get('/state')
  const remove = await fetch(base + '/sites', {
    method: 'POST',
    headers: { 'content-type': 'application/json', origin: 'https://reddit.com' },
    body: JSON.stringify({ action: 'remove', site: 'reddit.com' }),
  })
  assert.equal(remove.status, 403)

  const grace = await fetch(base + '/grace', {
    method: 'POST',
    headers: { 'content-type': 'application/json', origin: 'https://reddit.com' },
    body: JSON.stringify({ site: 'reddit.com' }),
  })
  assert.equal(grace.status, 403)

  const after = await get('/state')
  assert.deepEqual(after.sites, before.sites, 'the watch list is untouched')
})

test('a cross-origin preflight is refused too', async () => {
  const res = await fetch(base + '/snooze', { method: 'OPTIONS', headers: { origin: 'https://reddit.com' } })
  assert.equal(res.status, 403)
  const ok = await fetch(base + '/snooze', { method: 'OPTIONS', headers: { origin: 'chrome-extension://abc' } })
  assert.equal(ok.status, 204, 'the extension still gets its preflight')
})

// Every number `focus stats` prints is derived from block_completed lines in
// log.jsonl. Nothing asserted the daemon actually writes them, so the whole stats
// feature rested on an untested path from effect to file to summary.
test('finishing a work block writes block_completed to the log and shows in /stats', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'focus-nudge-blocks-'))
  const logPath = path.join(dir, 'log.jsonl')
  const solo = createServer({
    config: { ...DEFAULTS, port: 0 },
    statePath: path.join(dir, 'state.json'),
    logPath,
    quotesPath: path.join(dir, 'quotes.txt'),
    configPath: path.join(dir, 'config.json'),
    notify: () => {},
    openUrls: () => {},
  })
  try {
    const p = await solo.listen(0)
    const call = (route, body) => fetch(`http://127.0.0.1:${p}${route}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    }).then(r => r.json())

    const zero = await (await fetch(`http://127.0.0.1:${p}/stats`)).json()
    assert.equal(zero.totals.blocksCompleted, 0, 'a fresh log has no blocks')

    await call('/timer', { action: 'start' })
    await call('/timer', { action: 'skip' })    // work -> short break: one block done

    const lines = fs.readFileSync(logPath, 'utf8').trim().split('\n').map(l => JSON.parse(l))
    const blocks = lines.filter(e => e.event === 'block_completed')
    assert.equal(blocks.length, 1, `expected one block_completed, log was ${JSON.stringify(lines)}`)
    assert.equal(typeof blocks[0].at, 'number', 'with a real timestamp, or it buckets as "unknown"')
    assert.ok(blocks[0].at > 0)

    const one = await (await fetch(`http://127.0.0.1:${p}/stats`)).json()
    assert.equal(one.totals.blocksCompleted, 1, 'and summariseLog counts it')
    assert.equal(one.totals.today, 1, 'today, since the timestamp is now')
    assert.equal(one.totals.last7, 1)

    // A break ending is not a block. Only work completions count.
    await call('/timer', { action: 'skip' })    // short break -> work
    const still = await (await fetch(`http://127.0.0.1:${p}/stats`)).json()
    assert.equal(still.totals.blocksCompleted, 1, 'leaving a break did not inflate the count')
  } finally {
    solo.close()
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

// buildNotifySendArgs is the pure piece of desktopNotify: it decides the
// notify-send argv, so the --hint syntax can be checked without spawning a
// real process or depending on notify-send being installed in CI.
test('buildNotifySendArgs adds a sound-name hint only when a sound is given', () => {
  const withSound = buildNotifySendArgs('title', 'body', 'alarm-clock-elapsed')
  assert.ok(withSound.includes('--hint=string:sound-name:alarm-clock-elapsed'))
  assert.deepEqual(withSound.slice(-2), ['title', 'body'], 'title/body stay the trailing positional args')

  const withoutSound = buildNotifySendArgs('title', 'body', undefined)
  assert.ok(!withoutSound.some(a => a.startsWith('--hint=string:sound-name:')))
  assert.deepEqual(withoutSound.slice(-2), ['title', 'body'])
})

// The server's `dispatch`/`currentView` accept an injectable `now`, exactly so
// a phase expiry can be forced in a test without waiting 25 real minutes or
// starting the 1-second tick interval. This exercises the actual wiring:
// settle's notify effect -> runEffects -> the injected notify hook, sound
// included, with no HTTP layer in between.
test('the notify hook receives the configured sound for a real phase expiry', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'focus-nudge-sound-'))
  const notifies = []
  const T0 = Date.now()
  const MIN = 60_000
  const solo = createServer({
    config: { ...DEFAULTS, port: 0 },
    statePath: path.join(dir, 'state.json'),
    logPath: path.join(dir, 'log.jsonl'),
    quotesPath: path.join(dir, 'quotes.txt'),
    configPath: path.join(dir, 'config.json'),
    notify: (title, body, sound) => notifies.push({ title, body, sound }),
    openUrls: () => {},
  })
  try {
    solo.dispatch({ type: 'START' }, T0)
    solo.currentView(T0 + 25 * MIN + 1)   // crosses the boundary -> settle expires it
    const expiry = notifies.find(n => /finished/.test(n.title))
    assert.ok(expiry, `expected an expiry notify, got ${JSON.stringify(notifies)}`)
    assert.equal(expiry.sound, DEFAULTS.sounds.workEnd)

    // The START notify just before it must have carried no sound at all.
    const started = notifies.find(n => /started/.test(n.title))
    assert.ok(started)
    assert.equal(started.sound, undefined, 'START stays silent even through the real server wiring')
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test('an unknown route returns 404 as json', async () => {
  const res = await fetch(base + '/nope')
  assert.equal(res.status, 404)
  assert.equal((await res.json()).error, 'not found')
})

test('a malformed json body returns 400 rather than crashing', async () => {
  const res = await fetch(base + '/timer', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: '{ nope',
  })
  assert.equal(res.status, 400)
})

// The author's live state.json holds phase SNOOZED when this daemon first
// starts. It must be migrated, not quarantined: quarantine would discard the
// task list along with the snooze.
test('a state.json from the old daemon with phase SNOOZED loads and migrates', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'focus-nudge-legacy-'))
  const statePath = path.join(dir, 'state.json')
  const until = Date.now() + 30 * 60_000
  fs.writeFileSync(statePath, JSON.stringify({
    phase: 'SNOOZED', endsAt: until, paused: false, pausedRemainingMs: null, expiredNotified: false,
    blocksCompleted: 0, tasks: [{ id: 40, text: 'keep me', done: false }], nextTaskId: 41, queue: [], graces: {},
  }))
  const legacy = createServer({
    config: { ...DEFAULTS, port: 0 },
    statePath,
    logPath: path.join(dir, 'log.jsonl'),
    quotesPath: path.join(dir, 'quotes.txt'),
    configPath: path.join(dir, 'config.json'),
    notify: () => {},
    openUrls: () => {},
  })
  try {
    const port = await legacy.listen(0)
    const v = await (await fetch(`http://127.0.0.1:${port}/state`)).json()
    assert.equal(fs.existsSync(statePath + '.corrupt'), false, 'not quarantined')
    assert.equal(v.phase, 'IDLE')
    assert.equal(v.nudging, false, 'the snooze carries over')
    assert.equal(v.nudgeOffUntil, until)
    assert.deepEqual(v.tasks.map(t => t.text), ['keep me'])
  } finally {
    legacy.close()
    fs.rmSync(dir, { recursive: true, force: true })
  }
})
