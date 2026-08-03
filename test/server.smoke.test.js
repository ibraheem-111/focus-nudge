import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createServer } from '../daemon/server.js'
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
    notify: (title, body) => notified.push({ title, body }),
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
  assert.deepEqual(v.sites, ['reddit.com', 'youtube.com'])
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

test('a long break drains the queue through the openUrls hook', async () => {
  opened.length = 0
  const v = await post('/timer', { action: 'breakLong' })
  assert.equal(v.phase, 'LONG_BREAK')
  assert.equal(v.queueDepth, 0)
  assert.deepEqual(opened, ['https://reddit.com/r/x'])
})

test('POST /sites persists to the config file and shows in the view', async () => {
  const v = await post('/sites', { action: 'add', site: 'news.ycombinator.com' })
  assert.ok(v.sites.includes('news.ycombinator.com'))
  const onDisk = JSON.parse(fs.readFileSync(path.join(tmp, 'config.json'), 'utf8'))
  assert.ok(onDisk.sites.includes('news.ycombinator.com'))
})

test('POST /snooze opens the sanctioned window', async () => {
  const v = await post('/snooze', { hours: 2 })
  assert.equal(v.phase, 'SNOOZED')
  assert.equal(v.nudgingPhase, false)
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

test('GET /stats summarises the log', async () => {
  const s = await get('/stats')
  assert.equal(typeof s.blocksCompleted, 'number')
  assert.equal(typeof s.nudgesContinued, 'number')
  assert.equal(typeof s.savedForLater, 'number')
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
