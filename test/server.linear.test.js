import { test, before, after, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createServer } from '../daemon/server.js'
import { createLinear } from '../daemon/linear.js'
import { DEFAULTS } from '../daemon/config.js'

// The real Linear client, talking to a scripted fake GraphQL endpoint. Nothing
// here reaches api.linear.app, and the key is a dummy.
const KEY = 'dummy-key-for-tests'

const fake = {
  created: [], updates: [], failCreates: 0, failWith: 'getaddrinfo ENOTFOUND api.linear.app', active: [], projectsCalls: 0,
  reset() { this.created = []; this.updates = []; this.failCreates = 0; this.failWith = 'getaddrinfo ENOTFOUND api.linear.app'; this.active = []; this.projectsCalls = 0 },
}

async function fakeFetch(url, init) {
  const { query, variables } = JSON.parse(init.body)
  const ok = data => ({ ok: true, status: 200, json: async () => ({ data }) })
  if (query.includes('issueCreate')) {
    if (fake.failCreates > 0) { fake.failCreates--; throw new Error(fake.failWith) }
    const n = 100 + fake.created.length
    fake.created.push(variables.input)
    return ok({ issueCreate: { success: true, issue: { id: `iss-${n}`, identifier: `IBR-${n}`, url: `https://linear.app/x/IBR-${n}` } } })
  }
  if (query.includes('issueUpdate')) {
    fake.updates.push([variables.id, variables.stateId])
    return ok({ issueUpdate: { success: true } })
  }
  if (query.includes('active:')) return ok({ active: { nodes: fake.active }, linked: { nodes: [] } })
  if (query.includes('states {')) {
    return ok({ team: { states: { nodes: [
      { id: 's-todo', name: 'Todo', type: 'unstarted' }, { id: 's-done', name: 'Done', type: 'completed' },
      { id: 's-cancel', name: 'Canceled', type: 'canceled' },
    ] } } })
  }
  if (query.includes('projects')) {
    fake.projectsCalls++
    return ok({ team: { projects: { nodes: [{ id: 'p1', name: 'PCB Startup', state: 'started' }] } } })
  }
  throw new Error('unexpected query')
}

let tmp, handle, base
const errors = []
const realError = console.error

before(async () => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'focus-nudge-linear-'))
  console.error = (...a) => errors.push(a.join(' '))
  handle = createServer({
    config: { ...DEFAULTS, port: 0 },
    statePath: path.join(tmp, 'state.json'),
    logPath: path.join(tmp, 'log.jsonl'),
    quotesPath: path.join(tmp, 'quotes.txt'),
    configPath: path.join(tmp, 'config.json'),
    notify: () => {},
    openUrls: () => {},
    linear: createLinear({ apiKey: KEY, teamId: 'team-1', fetch: fakeFetch }),
  })
  base = `http://127.0.0.1:${await handle.listen(0)}`
  await handle.linearIdle()
})

after(() => {
  console.error = realError
  handle.close()
  fs.rmSync(tmp, { recursive: true, force: true })
})

beforeEach(async () => {
  await post('/tasks', { action: 'clear' })
  await handle.linearIdle()
  fake.reset()
  errors.length = 0
})

const get = async p => (await fetch(base + p)).text()
const post = async (p, body) =>
  (await fetch(base + p, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })).json()
const state = async () => JSON.parse(await get('/state'))

test('adding a task creates the Linear issue in the chosen project and links it', async () => {
  const v = await post('/tasks', { action: 'add', text: 'route the board', project: { id: 'p1', name: 'PCB Startup' } })
  assert.equal(v.linearEnabled, true)
  assert.equal(v.tasks[0].linearPending, true, 'the answer comes back before Linear does')
  await handle.linearIdle()
  assert.deepEqual(fake.created, [{ teamId: 'team-1', title: 'route the board', projectId: 'p1' }])
  const t = (await state()).tasks[0]
  assert.equal(t.linear.identifier, 'IBR-100')
  assert.equal(t.linearPending, false)
  assert.deepEqual(t.project, { id: 'p1', name: 'PCB Startup' })
})

test('with Linear unreachable the task is kept pending, and the next sync links it', async () => {
  fake.failCreates = 1
  await post('/tasks', { action: 'add', text: 'offline task' })
  await handle.linearIdle()
  let t = (await state()).tasks[0]
  assert.equal(t.text, 'offline task', 'the task is never lost')
  assert.equal(t.linearPending, true)
  assert.ok(errors.some(e => e.startsWith('focus-nudge: linear: ')), errors.join('\n'))

  await handle.linearSync()
  t = (await state()).tasks[0]
  assert.equal(t.linear.identifier, 'IBR-100')
  assert.equal(fake.created.length, 1, 'created once, not twice')
})

test('the same Linear error is reported once, not every minute', async () => {
  fake.failCreates = 3
  fake.failWith = 'connect ECONNREFUSED'
  await post('/tasks', { action: 'add', text: 'x' })
  await handle.linearIdle()
  await handle.linearSync()
  await handle.linearSync()
  assert.equal(errors.filter(e => e.includes('ECONNREFUSED')).length, 1)
})

test('ticking a linked task moves the issue to Done and back', async () => {
  const v = await post('/tasks', { action: 'add', text: 'tick me' })
  await handle.linearIdle()
  await post('/tasks', { action: 'toggle', id: v.tasks[0].id })
  await handle.linearIdle()
  await post('/tasks', { action: 'toggle', id: v.tasks[0].id })
  await handle.linearIdle()
  assert.deepEqual(fake.updates, [['iss-100', 's-done'], ['iss-100', 's-todo']])
})

test('removing a linked task cancels its issue in Linear', async () => {
  const v = await post('/tasks', { action: 'add', text: 'drop me' })
  await handle.linearIdle()
  await post('/tasks', { action: 'remove', id: v.tasks[0].id })
  await handle.linearIdle()
  assert.deepEqual(fake.updates, [['iss-100', 's-cancel']])
})

test('a sync pulls in active Linear issues as tasks', async () => {
  fake.active = [{ id: 'iss-17', identifier: 'IBR-17', url: 'u', title: 'from Linear', state: { type: 'started', name: 'In Progress' } }]
  await handle.linearSync()
  assert.deepEqual((await state()).tasks.map(t => [t.text, t.linear.identifier]), [['from Linear', 'IBR-17']])
})

test('GET /linear lists projects, is cached, and never contains the key', async () => {
  const raw = await get('/linear')
  assert.equal(raw.includes(KEY), false)
  assert.deepEqual(JSON.parse(raw), { enabled: true, projects: [{ id: 'p1', name: 'PCB Startup' }] })
  await get('/linear')
  assert.equal(fake.projectsCalls, 1, 'the second call is served from the cache')
})

test('a daemon with no Linear reports it disabled and never asks', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'focus-nudge-nolinear-'))
  const h = createServer({
    config: { ...DEFAULTS, port: 0 },
    statePath: path.join(dir, 'state.json'),
    logPath: path.join(dir, 'log.jsonl'),
    quotesPath: path.join(dir, 'quotes.txt'),
    configPath: path.join(dir, 'config.json'),
    notify: () => {},
    openUrls: () => {},
  })
  try {
    const b = `http://127.0.0.1:${await h.listen(0)}`
    assert.deepEqual(await (await fetch(b + '/linear')).json(), { enabled: false, projects: [] })
    const v = await (await fetch(b + '/tasks', { method: 'POST', body: JSON.stringify({ action: 'add', text: 'local' }) })).json()
    assert.equal(v.linearEnabled, false)
    assert.equal(v.tasks[0].linearPending, false)
  } finally {
    h.close()
    fs.rmSync(dir, { recursive: true, force: true })
  }
})
